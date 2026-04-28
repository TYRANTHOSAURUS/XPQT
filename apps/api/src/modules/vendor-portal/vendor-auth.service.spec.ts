import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditOutboxService } from '../privacy-compliance/audit-outbox.service';
import { VendorAuthService } from './vendor-auth.service';
import type { VendorMailer } from './vendor-mailer.service';

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const VENDOR = 'b2c3d4e5-f6a7-4b89-8cde-f0123456789a';
const ADMIN = 'c3d4e5f6-a7b8-4c9d-9ef0-123456789abc';
const VENDOR_USER = 'd4e5f6a7-b8c9-4d0e-8f01-23456789abcd';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface FakeOptions {
  /** Existing vendor user returned by tx selects (or null). */
  existingUser?: Record<string, unknown> | null;
  /** What the magic link redemption claim returns; null = invalid. */
  magicLinkClaim?: { id: string; vendor_user_id: string; expires_at: string } | null;
  /** Whether the user is locked / inactive. */
  userActive?: boolean;
  userFirstLoginAt?: string | null;
  /** Vendor existence for the invite() pre-flight tenant-vendor check. */
  vendorBelongsToTenant?: boolean;
}

function makeFakeMailer() {
  const calls: Array<Parameters<VendorMailer['sendMagicLink']>[0]> = [];
  const mailer: VendorMailer = {
    async sendMagicLink(input) {
      calls.push(input);
      return { messageId: 'test-id', acceptedAt: new Date().toISOString() };
    },
  };
  return Object.assign(mailer, { calls });
}

function makeFakeDb(opts: FakeOptions = {}) {
  const captured: Array<{ sql: string; params?: unknown[]; tx?: boolean }> = [];

  const userRow = opts.existingUser !== null ? {
    id: VENDOR_USER,
    tenant_id: TENANT,
    vendor_id: VENDOR,
    email: 'kitchen@acme.example',
    display_name: 'Kitchen',
    role: 'fulfiller',
    active: opts.userActive ?? true,
    invited_at: new Date().toISOString(),
    invited_by_user_id: ADMIN,
    first_login_at: opts.userFirstLoginAt ?? null,
    last_login_at: null,
    failed_login_count: 0,
    locked_until: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...(opts.existingUser ?? {}),
  } : null;

  const txClient = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params, tx: true });

      if (sql.includes('insert into vendor_users')) {
        return { rows: [userRow], rowCount: userRow ? 1 : 0 };
      }
      if (sql.includes('select * from vendor_users where tenant_id') ||
          sql.includes('select * from vendor_users where id')) {
        return { rows: userRow ? [userRow] : [], rowCount: userRow ? 1 : 0 };
      }
      if (sql.includes('insert into vendor_user_magic_links')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('update vendor_user_magic_links') && sql.includes('redeemed_at = now()') && sql.includes('expires_at > now()')) {
        return {
          rows: opts.magicLinkClaim ? [opts.magicLinkClaim] : [],
          rowCount: opts.magicLinkClaim ? 1 : 0,
        };
      }
      if (sql.includes('update vendor_user_magic_links') && sql.includes('id != $2')) {
        // invalidate-other-pending-links pass
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('insert into vendor_user_sessions')) {
        return {
          rows: [{
            id: 'sess-1',
            vendor_user_id: VENDOR_USER,
            tenant_id: TENANT,
            vendor_id: VENDOR,
            session_token_hash: params?.[3],
            expires_at: params?.[4],
            ip_hash: params?.[5],
            user_agent_hash: params?.[6],
            created_at: new Date().toISOString(),
            revoked_at: null,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('update vendor_users')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('insert into audit_outbox')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };

  return {
    captured,
    txClient,
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      // recordFailedLogin returning UPDATE
      if (sql.includes('update vendor_users') && sql.includes('failed_login_count')) {
        return { rows: [{ id: VENDOR_USER, tenant_id: TENANT, vendor_id: VENDOR, failed_login_count: 1, locked_until: null }], rowCount: 1 };
      }
      // revoke() returning UPDATE
      if (sql.includes('update vendor_user_sessions') && sql.includes('revoked_at = now()')) {
        return { rows: [], rowCount: 0 };
      }
      // touch() UPDATE
      if (sql.includes('update vendor_user_sessions') && sql.includes('expires_at = $2')) {
        return { rows: [], rowCount: 1 };
      }
      // audit_outbox emit (non-tx)
      if (sql.includes('insert into audit_outbox')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    queryOne: jest.fn(async (sql: string, _params?: unknown[]) => {
      captured.push({ sql, params: _params });
      // invite() pre-flight: vendor belongs to tenant?
      if (sql.includes('select id, name from vendors')) {
        return opts.vendorBelongsToTenant === false ? null : { id: VENDOR, name: 'Acme Catering' };
      }
      // validate() lookup
      if (sql.includes('from vendor_user_sessions s') && sql.includes('join vendor_users vu')) {
        return null;                                  // override per-test if needed
      }
      return null;
    }),
    queryMany: jest.fn(async () => []),
    rpc: jest.fn(),
    tx: jest.fn(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient)),
  };
}

function buildSvc(opts: FakeOptions = {}) {
  const db = makeFakeDb(opts);
  const mailer = makeFakeMailer();
  const svc = new VendorAuthService(
    db as never,
    new AuditOutboxService(db as never),
    mailer,
  );
  return { db, mailer, svc };
}

// =====================================================================
// invite()
// =====================================================================

describe('VendorAuthService.invite', () => {
  it('rejects implausible emails', async () => {
    const { svc } = buildSvc();
    await expect(
      svc.invite({ tenantId: TENANT, vendorId: VENDOR, email: 'not-an-email', invitedByUserId: ADMIN }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unknown role', async () => {
    const { svc } = buildSvc();
    await expect(
      svc.invite({
        tenantId: TENANT, vendorId: VENDOR, email: 'kitchen@acme.example',
        role: 'super_admin' as never, invitedByUserId: ADMIN,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when vendor does not belong to tenant', async () => {
    const { svc } = buildSvc({ vendorBelongsToTenant: false });
    await expect(
      svc.invite({ tenantId: TENANT, vendorId: VENDOR, email: 'a@b.example', invitedByUserId: ADMIN }),
    ).rejects.toThrow(/does not belong to tenant/);
  });

  it('writes a vendor_user + magic link + audit + dispatches mailer (no raw token in result)', async () => {
    const { svc, db, mailer } = buildSvc();
    const result = await svc.invite({
      tenantId: TENANT, vendorId: VENDOR, email: 'KITCHEN@Acme.Example',
      invitedByUserId: ADMIN,
    });
    expect(result.vendorUser.id).toBe(VENDOR_USER);
    expect(result).not.toHaveProperty('magicLinkToken');                 // codex fix #3 — never returned

    const txSqls = db.captured.filter((c) => c.tx).map((c) => c.sql);
    expect(txSqls.some((s) => s.includes('insert into vendor_users'))).toBe(true);
    expect(txSqls.some((s) => s.includes('insert into vendor_user_magic_links'))).toBe(true);
    expect(txSqls.some((s) => s.includes('insert into audit_outbox'))).toBe(true);

    expect(mailer.calls).toHaveLength(1);
    expect(mailer.calls[0].rawToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(mailer.calls[0].reason).toBe('invited');
  });

  it('lowercases the email before insert', async () => {
    const { svc, db } = buildSvc();
    await svc.invite({
      tenantId: TENANT, vendorId: VENDOR, email: 'KITCHEN@Acme.Example',
      invitedByUserId: ADMIN,
    });
    const insert = db.captured.find((c) => c.sql.includes('insert into vendor_users'));
    expect(insert?.params?.[2]).toBe('kitchen@acme.example');
  });
});

// =====================================================================
// redeem()
// =====================================================================

describe('VendorAuthService.redeem', () => {
  it('throws Unauthorized when token is invalid / expired / already redeemed', async () => {
    const { svc } = buildSvc({ magicLinkClaim: null });
    await expect(svc.redeem({ token: 'not-real' })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws Unauthorized when the vendor_user is inactive', async () => {
    const { svc } = buildSvc({
      magicLinkClaim: { id: 'ml-1', vendor_user_id: VENDOR_USER, expires_at: new Date().toISOString() },
      userActive: false,
    });
    await expect(svc.redeem({ token: 'a-token' })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('mints a session, marks first_login on the first redeem, returns raw token only', async () => {
    const { svc, db } = buildSvc({
      magicLinkClaim: { id: 'ml-1', vendor_user_id: VENDOR_USER, expires_at: new Date().toISOString() },
      userFirstLoginAt: null,
    });
    const result = await svc.redeem({ token: 'a-magic-token' });

    expect(result.isFirstLogin).toBe(true);
    expect(result.sessionToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(result.session.session_token_hash).toBe(sha256(result.sessionToken));

    const txSqls = db.captured.filter((c) => c.tx).map((c) => c.sql);
    expect(txSqls.some((s) => s.includes('insert into vendor_user_sessions'))).toBe(true);
    expect(txSqls.some((s) => s.includes('first_login_at = coalesce'))).toBe(true);
  });

  it('emits the recurring login event when first_login_at is already set', async () => {
    const { svc, db } = buildSvc({
      magicLinkClaim: { id: 'ml-1', vendor_user_id: VENDOR_USER, expires_at: new Date().toISOString() },
      userFirstLoginAt: '2026-01-01T00:00:00Z',
    });
    const result = await svc.redeem({ token: 'a-magic-token' });
    expect(result.isFirstLogin).toBe(false);

    const auditEmits = db.captured.filter(
      (c) => c.tx && c.sql.includes('insert into audit_outbox'),
    );
    expect(auditEmits[0]?.params?.[1]).toBe('vendor_user.login');
  });

  it('atomically claims the magic link via UPDATE-with-RETURNING', async () => {
    const { svc, db } = buildSvc({
      magicLinkClaim: { id: 'ml-1', vendor_user_id: VENDOR_USER, expires_at: new Date().toISOString() },
    });
    await svc.redeem({ token: 'a-magic-token' });

    const claim = db.captured.find(
      (c) => c.tx && c.sql.includes('update vendor_user_magic_links') && c.sql.includes('redeemed_at = now()'),
    );
    expect(claim).toBeDefined();
    expect(claim?.sql).toContain('redeemed_at is null');
    expect(claim?.sql).toContain('expires_at > now()');
  });
});

// =====================================================================
// validate() / touch() / revoke() / recordFailedLogin()
// =====================================================================

describe('VendorAuthService.validate', () => {
  it('hashes the raw token + sources scope from vendor_users (vu.tenant_id, vu.vendor_id)', async () => {
    const { svc, db } = buildSvc();
    await svc.validate('the-raw-token');
    const lookup = db.captured.find((c) => c.sql.includes('from vendor_user_sessions s') && c.sql.includes('join vendor_users vu'));
    expect(lookup).toBeDefined();
    // Codex fix #2: scope must come from vu, not s.
    expect(lookup?.sql).toContain('vu.tenant_id  as tenant_id');
    expect(lookup?.sql).toContain('vu.vendor_id  as vendor_id');
    expect(lookup?.params?.[0]).toBe(sha256('the-raw-token'));
  });
});

describe('VendorAuthService.touch', () => {
  it('extends expires_at with a 60s threshold (idempotent under high-traffic)', async () => {
    const { svc, db } = buildSvc();
    await svc.touch('the-raw-token');
    const update = db.captured.find((c) => c.sql.includes('update vendor_user_sessions') && c.sql.includes('expires_at = $2'));
    expect(update).toBeDefined();
    expect(update?.sql).toContain("interval '60 seconds'");
  });
});

describe('VendorAuthService.revoke', () => {
  it('is idempotent — no audit when no row updated', async () => {
    const { svc, db } = buildSvc();
    await svc.revoke({ sessionToken: 'unknown' });
    const auditEmits = db.captured.filter((c) => !c.tx && c.sql.includes('insert into audit_outbox'));
    expect(auditEmits).toHaveLength(0);
  });
});

describe('VendorAuthService.recordFailedLogin', () => {
  it('emits a login_failed audit on every failure', async () => {
    const { svc, db } = buildSvc();
    await svc.recordFailedLogin(VENDOR_USER, 'bad_token');

    const audit = db.captured.find((c) => !c.tx && c.sql.includes('insert into audit_outbox'));
    expect(audit).toBeDefined();
    // event_type is param 2 of the audit insert
    expect(audit?.params?.[1]).toBe('vendor_user.login_failed');
  });
});
