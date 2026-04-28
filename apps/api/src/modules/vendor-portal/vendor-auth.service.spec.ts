import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditOutboxService } from '../privacy-compliance/audit-outbox.service';
import { VendorAuthService } from './vendor-auth.service';

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
      if (sql.includes('update vendor_user_magic_links') && sql.includes('redeemed_at = now()')) {
        return {
          rows: opts.magicLinkClaim ? [opts.magicLinkClaim] : [],
          rowCount: opts.magicLinkClaim ? 1 : 0,
        };
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
      return { rows: [], rowCount: 0 };
    }),
    queryOne: jest.fn(async () => null),
    queryMany: jest.fn(async () => []),
    rpc: jest.fn(),
    tx: jest.fn(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient)),
  };
}

// =====================================================================
// invite()
// =====================================================================

describe('VendorAuthService.invite', () => {
  it('rejects implausible emails', async () => {
    const db = makeFakeDb();
    const svc = new VendorAuthService(db as any, new AuditOutboxService(db as any));
    await expect(
      svc.invite({ tenantId: TENANT, vendorId: VENDOR, email: 'not-an-email', invitedByUserId: ADMIN }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unknown role', async () => {
    const db = makeFakeDb();
    const svc = new VendorAuthService(db as any, new AuditOutboxService(db as any));
    await expect(
      svc.invite({
        tenantId: TENANT, vendorId: VENDOR, email: 'kitchen@acme.example',
        role: 'super_admin' as never, invitedByUserId: ADMIN,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('writes a vendor_user + magic link + audit event in one tx', async () => {
    const db = makeFakeDb();
    const svc = new VendorAuthService(db as any, new AuditOutboxService(db as any));
    const result = await svc.invite({
      tenantId: TENANT, vendorId: VENDOR, email: 'KITCHEN@Acme.Example',
      invitedByUserId: ADMIN,
    });
    expect(result.vendorUser.id).toBe(VENDOR_USER);
    expect(result.magicLinkToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);   // url-safe base64

    const txSqls = db.captured.filter((c) => c.tx).map((c) => c.sql);
    expect(txSqls.some((s) => s.includes('insert into vendor_users'))).toBe(true);
    expect(txSqls.some((s) => s.includes('insert into vendor_user_magic_links'))).toBe(true);
    expect(txSqls.some((s) => s.includes('insert into audit_outbox'))).toBe(true);
  });

  it('lowercases the email before insert', async () => {
    const db = makeFakeDb();
    const svc = new VendorAuthService(db as any, new AuditOutboxService(db as any));
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
    const db = makeFakeDb({ magicLinkClaim: null });
    const svc = new VendorAuthService(db as any, new AuditOutboxService(db as any));
    await expect(svc.redeem({ token: 'not-real' })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws Unauthorized when the vendor_user is inactive', async () => {
    const db = makeFakeDb({
      magicLinkClaim: { id: 'ml-1', vendor_user_id: VENDOR_USER, expires_at: new Date().toISOString() },
      userActive: false,
    });
    const svc = new VendorAuthService(db as any, new AuditOutboxService(db as any));
    await expect(svc.redeem({ token: 'a-token' })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('mints a session, marks first_login on the first redeem, returns raw token only', async () => {
    const db = makeFakeDb({
      magicLinkClaim: { id: 'ml-1', vendor_user_id: VENDOR_USER, expires_at: new Date().toISOString() },
      userFirstLoginAt: null,
    });
    const svc = new VendorAuthService(db as any, new AuditOutboxService(db as any));
    const result = await svc.redeem({ token: 'a-magic-token' });

    expect(result.isFirstLogin).toBe(true);
    expect(result.sessionToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    // Stored hash matches sha256(token).
    expect(result.session.session_token_hash).toBe(sha256(result.sessionToken));

    const txSqls = db.captured.filter((c) => c.tx).map((c) => c.sql);
    expect(txSqls.some((s) => s.includes('insert into vendor_user_sessions'))).toBe(true);
    // first_login_at set via coalesce — the UPDATE writes both stamps.
    expect(txSqls.some((s) => s.includes('first_login_at = coalesce'))).toBe(true);
  });

  it('emits the recurring login event when first_login_at is already set', async () => {
    const db = makeFakeDb({
      magicLinkClaim: { id: 'ml-1', vendor_user_id: VENDOR_USER, expires_at: new Date().toISOString() },
      userFirstLoginAt: '2026-01-01T00:00:00Z',
    });
    const svc = new VendorAuthService(db as any, new AuditOutboxService(db as any));
    const result = await svc.redeem({ token: 'a-magic-token' });
    expect(result.isFirstLogin).toBe(false);

    const auditEmits = db.captured.filter(
      (c) => c.tx && c.sql.includes('insert into audit_outbox'),
    );
    expect(auditEmits[0]?.params?.[1]).toBe('vendor_user.login');
  });

  it('atomically claims the magic link via UPDATE-with-RETURNING (exactly-once redemption)', async () => {
    const db = makeFakeDb({
      magicLinkClaim: { id: 'ml-1', vendor_user_id: VENDOR_USER, expires_at: new Date().toISOString() },
    });
    const svc = new VendorAuthService(db as any, new AuditOutboxService(db as any));
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
// validate() / revoke()
// =====================================================================

describe('VendorAuthService.validate', () => {
  it('hashes the raw token before lookup', async () => {
    const db = makeFakeDb();
    db.queryOne = jest.fn(async (sql: string, params?: unknown[]) => {
      // Capture so we can assert.
      (db.queryOne as jest.Mock).mock.results[0] = sql;
      return null;
    });
    const svc = new VendorAuthService(db as any, new AuditOutboxService(db as any));
    await svc.validate('the-raw-token');
    const calls = (db.queryOne as jest.Mock).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][1]?.[0]).toBe(sha256('the-raw-token'));
  });
});

describe('VendorAuthService.revoke', () => {
  it('is idempotent — no audit when no row updated', async () => {
    const db = makeFakeDb();
    db.query = jest.fn(async () => ({ rows: [], rowCount: 0 }));
    const svc = new VendorAuthService(db as any, new AuditOutboxService(db as any));
    await svc.revoke({ sessionToken: 'unknown' });
    // No audit emit captured (only the UPDATE).
    const auditEmits = db.captured.filter((c) => c.sql.includes('insert into audit_outbox'));
    expect(auditEmits).toHaveLength(0);
  });
});
