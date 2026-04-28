import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DbService } from '../../common/db/db.service';
import { AuditOutboxService } from '../privacy-compliance/audit-outbox.service';
import { VendorPortalEventType } from './event-types';

/**
 * Magic-link auth for vendor portal users.
 *
 * Sprint 1 surface:
 *   - invite()         create vendor_user + first magic link + audit
 *   - issueMagicLink() resend (admin-driven; rate-limit Sprint 4)
 *   - redeem()         validate token + mint session + audit first/return login
 *   - validate()       look up an active session by raw token
 *   - revoke()         single-session logout
 *   - revokeAll()      vendor-user-wide revocation (used by deactivate)
 *
 * Sprint 4 will wire actual email delivery; today we return the plaintext
 * token in the invite/issue response so admins can copy it during dev. The
 * stored hash is sha256(token) so a DB read leaks nothing.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md §4.
 */
@Injectable()
export class VendorAuthService {
  // Defaults from the spec; env knobs ready for Sprint 4 hardening.
  private readonly magicLinkTtlMs = Number(process.env.VENDOR_MAGIC_LINK_TTL_MS ?? 15 * 60 * 1000);
  private readonly sessionTtlMs   = Number(process.env.VENDOR_SESSION_TTL_MS ?? 30 * 24 * 60 * 60 * 1000);
  private readonly maxFailedLogins = Number(process.env.VENDOR_MAX_FAILED_LOGINS ?? 5);
  private readonly lockoutMs       = Number(process.env.VENDOR_LOCKOUT_MS ?? 15 * 60 * 1000);

  constructor(
    private readonly db: DbService,
    private readonly auditOutbox: AuditOutboxService,
  ) {}

  // -------------------- Invite + magic link issuance --------------------

  /**
   * Tenant admin invites a new vendor user. Creates the row + first magic
   * link in one transaction. Idempotent on (tenant, vendor, email) — if
   * the user already exists, returns it (with a fresh magic link). Caller
   * decides whether to surface that as "already invited" or "resent."
   */
  async invite(input: InviteInput): Promise<InviteResult> {
    if (!isPlausibleEmail(input.email)) {
      throw new BadRequestException('email looks invalid');
    }
    if (input.role && !['fulfiller', 'manager'].includes(input.role)) {
      throw new BadRequestException('role must be fulfiller or manager');
    }

    return this.db.tx(async (client) => {
      // Upsert by (tenant, vendor, lower(email)). Re-inviting a deactivated
      // user reactivates them — admin intent.
      const upsert = await client.query<VendorUserRow>(
        `insert into vendor_users
           (tenant_id, vendor_id, email, display_name, role, invited_by_user_id)
         values ($1, $2, $3, $4, coalesce($5, 'fulfiller'), $6)
         on conflict (tenant_id, vendor_id, email) do update
            set display_name        = coalesce(excluded.display_name, vendor_users.display_name),
                role                = excluded.role,
                active              = true,
                invited_at          = now(),
                invited_by_user_id  = excluded.invited_by_user_id,
                failed_login_count  = 0,
                locked_until        = null
         returning *`,
        [
          input.tenantId,
          input.vendorId,
          input.email.trim().toLowerCase(),
          input.displayName ?? null,
          input.role ?? null,
          input.invitedByUserId,
        ],
      );
      const vendorUser = upsert.rows[0];
      if (!vendorUser) throw new BadRequestException('Failed to create vendor user');

      const link = await this.issueLinkInner(client, vendorUser.id);

      await this.auditOutbox.emitTx(client, {
        tenantId: input.tenantId,
        eventType: VendorPortalEventType.VendorInvited,
        entityType: 'vendor_users',
        entityId: vendorUser.id,
        actorUserId: input.invitedByUserId,
        details: {
          vendor_id: input.vendorId,
          email: input.email.trim().toLowerCase(),
          role: vendorUser.role,
          magic_link_expires_at: link.expiresAt,
        },
      });

      return {
        vendorUser,
        magicLinkToken: link.token,
        magicLinkExpiresAt: link.expiresAt,
      };
    });
  }

  /**
   * Resend a magic link to an existing vendor user (admin-driven). Returns
   * the plaintext token (Sprint 4 wires email delivery). Rate-limit + abuse
   * guards land in Sprint 4.
   */
  async issueMagicLink(input: IssueMagicLinkInput): Promise<IssueMagicLinkResult> {
    return this.db.tx(async (client) => {
      const vu = await client.query<VendorUserRow>(
        `select * from vendor_users where tenant_id = $1 and id = $2`,
        [input.tenantId, input.vendorUserId],
      );
      const vendorUser = vu.rows[0];
      if (!vendorUser) throw new NotFoundException('Vendor user not found');
      if (!vendorUser.active) {
        throw new BadRequestException('Vendor user is deactivated');
      }

      const link = await this.issueLinkInner(client, vendorUser.id);

      await this.auditOutbox.emitTx(client, {
        tenantId: input.tenantId,
        eventType: VendorPortalEventType.VendorInviteResent,
        entityType: 'vendor_users',
        entityId: vendorUser.id,
        actorUserId: input.actorUserId ?? null,
        details: { magic_link_expires_at: link.expiresAt },
      });

      return { magicLinkToken: link.token, magicLinkExpiresAt: link.expiresAt };
    });
  }

  // -------------------- Redemption --------------------

  /**
   * Redeem a magic link, mint a session JWT-equivalent (raw token returned
   * to the client). The session token is itself stored hashed; the raw
   * token lives client-side in an HttpOnly cookie set by the controller.
   *
   * Concurrency: the (token_hash, redeemed_at IS NULL) UPDATE-with-RETURNING
   * pattern guarantees exactly-once redemption even under retries.
   */
  async redeem(input: RedeemInput): Promise<RedeemResult> {
    const tokenHash = sha256Hex(input.token);

    return this.db.tx(async (client) => {
      // Atomically claim the magic link.
      const claim = await client.query<{ id: string; vendor_user_id: string; expires_at: string }>(
        `update vendor_user_magic_links
            set redeemed_at = now()
          where token_hash = $1
            and redeemed_at is null
            and expires_at > now()
          returning id, vendor_user_id, expires_at`,
        [tokenHash],
      );
      if (claim.rowCount === 0) {
        throw new UnauthorizedException('Magic link invalid, expired, or already redeemed');
      }
      const { vendor_user_id: vendorUserId } = claim.rows[0];

      // Pull the vendor user + lockout check.
      const vu = await client.query<VendorUserRow>(
        `select * from vendor_users where id = $1`,
        [vendorUserId],
      );
      const vendorUser = vu.rows[0];
      if (!vendorUser) throw new UnauthorizedException('Vendor user missing');
      if (!vendorUser.active) {
        throw new UnauthorizedException('Vendor user is deactivated');
      }
      if (vendorUser.locked_until && new Date(vendorUser.locked_until) > new Date()) {
        throw new UnauthorizedException('Vendor user is temporarily locked');
      }

      // Invalidate any other unredeemed magic links for the same user — a
      // successful redemption rotates everything.
      await client.query(
        `update vendor_user_magic_links
            set redeemed_at = now()
          where vendor_user_id = $1
            and id != $2
            and redeemed_at is null`,
        [vendorUserId, claim.rows[0].id],
      );

      // Mint a session.
      const sessionToken = generateRawToken();
      const sessionTokenHash = sha256Hex(sessionToken);
      const sessionExpiresAt = new Date(Date.now() + this.sessionTtlMs);

      const sessionInsert = await client.query<VendorUserSessionRow>(
        `insert into vendor_user_sessions
           (vendor_user_id, tenant_id, vendor_id, session_token_hash,
            expires_at, ip_hash, user_agent_hash)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning *`,
        [
          vendorUserId,
          vendorUser.tenant_id,
          vendorUser.vendor_id,
          sessionTokenHash,
          sessionExpiresAt.toISOString(),
          input.ipHash ?? null,
          input.userAgentHash ?? null,
        ],
      );
      const session = sessionInsert.rows[0];

      // Stamp first/last login timestamps.
      const isFirstLogin = vendorUser.first_login_at === null;
      await client.query(
        `update vendor_users
            set last_login_at = now(),
                first_login_at = coalesce(first_login_at, now()),
                failed_login_count = 0,
                locked_until = null,
                updated_at = now()
          where id = $1`,
        [vendorUserId],
      );

      await this.auditOutbox.emitTx(client, {
        tenantId: vendorUser.tenant_id,
        eventType: isFirstLogin
          ? VendorPortalEventType.VendorUserFirstLogin
          : VendorPortalEventType.VendorUserLogin,
        entityType: 'vendor_users',
        entityId: vendorUserId,
        details: {
          vendor_id: vendorUser.vendor_id,
          session_id: session.id,
          session_expires_at: session.expires_at,
        },
      });

      return {
        vendorUser,
        session,
        sessionToken,
        sessionExpiresAt: session.expires_at,
        isFirstLogin,
      };
    });
  }

  // -------------------- Session validation + revocation --------------------

  /**
   * Look up an active session by raw token. Returns null if expired,
   * revoked, or unknown. Caller (Sprint 2 portal guard) attaches the
   * vendor user to the request for downstream services.
   */
  async validate(rawSessionToken: string): Promise<ActiveSessionLookup | null> {
    const tokenHash = sha256Hex(rawSessionToken);
    const row = await this.db.queryOne<ActiveSessionLookup>(
      `select s.id, s.vendor_user_id, s.tenant_id, s.vendor_id, s.expires_at,
              vu.email, vu.display_name, vu.role, vu.active
         from vendor_user_sessions s
         join vendor_users vu on vu.id = s.vendor_user_id
        where s.session_token_hash = $1
          and s.revoked_at is null
          and s.expires_at > now()
          and vu.active = true`,
      [tokenHash],
    );
    return row;
  }

  /** Revoke a single session (logout). Idempotent. */
  async revoke(input: RevokeInput): Promise<void> {
    const tokenHash = sha256Hex(input.sessionToken);
    const r = await this.db.query<VendorUserSessionRow>(
      `update vendor_user_sessions
          set revoked_at = now()
        where session_token_hash = $1
          and revoked_at is null
        returning *`,
      [tokenHash],
    );
    const session = r.rows[0];
    if (!session) return;                       // already revoked or unknown — no-op

    await this.auditOutbox.emit({
      tenantId: session.tenant_id,
      eventType: VendorPortalEventType.VendorUserLogout,
      entityType: 'vendor_users',
      entityId: session.vendor_user_id,
      details: { session_id: session.id, reason: input.reason ?? 'user_initiated' },
    });
  }

  /** Revoke all active sessions for a vendor user (deactivate). */
  async revokeAllSessions(vendorUserId: string): Promise<void> {
    await this.db.query(
      `update vendor_user_sessions
          set revoked_at = now()
        where vendor_user_id = $1 and revoked_at is null`,
      [vendorUserId],
    );
  }

  // -------------------- Failed-login lockout --------------------

  /**
   * Record a failed redemption for a known email. Increments the failed
   * counter; locks the user after maxFailedLogins for lockoutMs. Called by
   * the Sprint 2 controller before redeem() if it can identify the target
   * vendor_user from the request.
   */
  async recordFailedLogin(vendorUserId: string): Promise<void> {
    await this.db.query(
      `update vendor_users
          set failed_login_count = failed_login_count + 1,
              locked_until = case
                when failed_login_count + 1 >= $2
                  then now() + ($3 || ' milliseconds')::interval
                else locked_until
              end
        where id = $1`,
      [vendorUserId, this.maxFailedLogins, this.lockoutMs.toString()],
    );
  }

  // -------------------- private helpers --------------------

  private async issueLinkInner(
    client: import('pg').PoolClient,
    vendorUserId: string,
  ): Promise<{ token: string; tokenHash: string; expiresAt: string }> {
    const token = generateRawToken();
    const tokenHash = sha256Hex(token);
    const expiresAt = new Date(Date.now() + this.magicLinkTtlMs).toISOString();

    await client.query(
      `insert into vendor_user_magic_links
         (vendor_user_id, token_hash, expires_at)
       values ($1, $2, $3)`,
      [vendorUserId, tokenHash, expiresAt],
    );
    return { token, tokenHash, expiresAt };
  }
}

// =====================================================================
// Helpers
// =====================================================================

/** 32 random bytes → URL-safe base64 (no padding). 256-bit entropy. */
function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function isPlausibleEmail(s: string | null | undefined): boolean {
  if (!s) return false;
  // Cheap sanity check; full RFC 5322 isn't worth it. Real validation is
  // in the email-deliverability pipeline (Sprint 4).
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

// =====================================================================
// Types
// =====================================================================

export interface InviteInput {
  tenantId: string;
  vendorId: string;
  email: string;
  displayName?: string | null;
  role?: 'fulfiller' | 'manager' | null;
  invitedByUserId: string;
}

export interface InviteResult {
  vendorUser: VendorUserRow;
  /** Raw plaintext magic-link token. Only returned by invite/issue once — never readable from DB. */
  magicLinkToken: string;
  magicLinkExpiresAt: string;
}

export interface IssueMagicLinkInput {
  tenantId: string;
  vendorUserId: string;
  actorUserId?: string | null;
}

export interface IssueMagicLinkResult {
  magicLinkToken: string;
  magicLinkExpiresAt: string;
}

export interface RedeemInput {
  token: string;
  ipHash?: string | null;
  userAgentHash?: string | null;
}

export interface RedeemResult {
  vendorUser: VendorUserRow;
  session: VendorUserSessionRow;
  /** Raw session token — set by controller as an HttpOnly cookie. */
  sessionToken: string;
  sessionExpiresAt: string;
  isFirstLogin: boolean;
}

export interface RevokeInput {
  sessionToken: string;
  reason?: 'user_initiated' | 'admin_revoked' | 'ttl';
}

export interface VendorUserRow {
  id: string;
  tenant_id: string;
  vendor_id: string;
  email: string;
  display_name: string | null;
  role: 'fulfiller' | 'manager';
  active: boolean;
  invited_at: string;
  invited_by_user_id: string | null;
  first_login_at: string | null;
  last_login_at: string | null;
  failed_login_count: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface VendorUserSessionRow {
  id: string;
  vendor_user_id: string;
  tenant_id: string;
  vendor_id: string;
  session_token_hash: string;
  expires_at: string;
  ip_hash: string | null;
  user_agent_hash: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface ActiveSessionLookup {
  id: string;
  vendor_user_id: string;
  tenant_id: string;
  vendor_id: string;
  expires_at: string;
  email: string;
  display_name: string | null;
  role: 'fulfiller' | 'manager';
  active: boolean;
}
