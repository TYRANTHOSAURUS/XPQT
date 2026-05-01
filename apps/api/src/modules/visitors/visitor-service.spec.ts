/**
 * VisitorService.transitionStatus — state machine unit tests.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §5
 *
 * The DB trigger `assert_visitor_status_transition` (migration 00253) is
 * defense-in-depth. The app-layer matrix here is the canonical write path
 * and rejects bad transitions BEFORE the SQL ever runs. Both layers must
 * agree — the migrations.spec.ts integration tests prove the trigger
 * blocks the same illegal pairs.
 */

import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { VisitorService } from './visitor.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const VISITOR_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR = { user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', person_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };

interface CapturedSql {
  sql: string;
  params?: unknown[];
}

interface FakeRow {
  id: string;
  tenant_id: string;
  status: string;
  arrived_at: string | null;
  logged_at: string | null;
  checked_out_at: string | null;
  checkout_source: string | null;
  auto_checked_out: boolean;
  visitor_pass_id: string | null;
}

function baseVisitor(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: VISITOR_ID,
    tenant_id: TENANT_ID,
    status: 'expected',
    arrived_at: null,
    logged_at: null,
    checked_out_at: null,
    checkout_source: null,
    auto_checked_out: false,
    visitor_pass_id: null,
    ...overrides,
  };
}

/**
 * Fake pg PoolClient. The service's `tx` callback receives this client and
 * issues SELECT FOR UPDATE + UPDATE + INSERT (audit) queries. We answer
 * each with the canned row + capture the SQL for assertions.
 */
function makeFakeDb(initialRow: FakeRow) {
  let row: FakeRow = { ...initialRow };
  const captured: CapturedSql[] = [];
  const auditInserts: Array<{ event_type: string; details: Record<string, unknown> }> = [];
  const domainEvents: Array<{ event_type: string; payload: Record<string, unknown> }> = [];

  const client: Partial<PoolClient> & { query: jest.Mock } = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      const trimmed = sql.trim().toLowerCase();
      if (trimmed.startsWith('select') && trimmed.includes('from public.visitors')) {
        return { rows: [row], rowCount: 1 };
      }
      if (trimmed.startsWith('update public.visitors')) {
        // Apply the SET clause naively from the params: the service's UPDATE
        // takes named params in a fixed order — we rely on test introspection
        // of the `captured` log instead of simulating real UPDATE semantics.
        // For the new status, parse "set status = $1" and pull params[0].
        const setMatch = sql.match(/set\s+([\s\S]+?)\s+where/i);
        if (setMatch && params) {
          const cols = setMatch[1]
            .split(',')
            .map((s) => s.trim())
            .map((piece) => piece.split('=')[0].trim());
          for (let i = 0; i < cols.length; i++) {
            const col = cols[i] as keyof FakeRow;
            const val = params[i] as never;
            row = { ...row, [col]: val } as FakeRow;
          }
        }
        return { rows: [row], rowCount: 1 };
      }
      if (trimmed.startsWith('insert into public.audit_events')) {
        const eventType = (params?.[1] as string) ?? '';
        const rawDetails = params?.[4];
        const details =
          typeof rawDetails === 'string'
            ? (JSON.parse(rawDetails) as Record<string, unknown>)
            : ((rawDetails as Record<string, unknown> | undefined) ?? {});
        auditInserts.push({ event_type: eventType, details });
        return { rows: [], rowCount: 1 };
      }
      if (trimmed.startsWith('insert into public.domain_events')) {
        const eventType = (params?.[1] as string) ?? '';
        const rawPayload = params?.[4];
        const payload =
          typeof rawPayload === 'string'
            ? (JSON.parse(rawPayload) as Record<string, unknown>)
            : ((rawPayload as Record<string, unknown> | undefined) ?? {});
        domainEvents.push({ event_type: eventType, payload });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };

  const db = {
    tx: jest.fn(async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => fn(client as PoolClient)),
  };

  return {
    db,
    client,
    captured,
    auditInserts,
    domainEvents,
    getRow: () => row,
  };
}

function tenantCtx() {
  return jest
    .spyOn(TenantContext, 'current')
    .mockReturnValue({ id: TENANT_ID } as never);
}

describe('VisitorService.transitionStatus', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('valid transitions', () => {
    it('expected → arrived sets arrived_at + logged_at', async () => {
      tenantCtx();
      const ctx = makeFakeDb(baseVisitor({ status: 'expected' }));
      const svc = new VisitorService(ctx.db as never);

      const result = await svc.transitionStatus(VISITOR_ID, 'arrived', ACTOR);

      expect(result.status).toBe('arrived');
      expect(result.arrived_at).toBeTruthy();
      expect(result.logged_at).toBeTruthy();
      expect(ctx.auditInserts.find((a) => a.event_type === 'visitor.arrived')).toBeTruthy();
    });

    it('expected → arrived honours opts.arrived_at (backdated entry)', async () => {
      tenantCtx();
      const ctx = makeFakeDb(baseVisitor({ status: 'expected' }));
      const svc = new VisitorService(ctx.db as never);
      const backdated = '2026-05-01T08:55:00.000Z';

      const result = await svc.transitionStatus(VISITOR_ID, 'arrived', ACTOR, {
        arrived_at: backdated,
      });

      expect(result.arrived_at).toBe(backdated);
      // logged_at is server-side (now), >= arrived_at — and not equal to
      // backdated unless we got extremely unlucky with the clock.
      expect(result.logged_at).toBeTruthy();
      expect(new Date(result.logged_at!).getTime()).toBeGreaterThanOrEqual(
        new Date(backdated).getTime(),
      );
    });

    it('arrived → in_meeting succeeds', async () => {
      tenantCtx();
      const ctx = makeFakeDb(baseVisitor({ status: 'arrived', arrived_at: '2026-05-01T09:00:00Z' }));
      const svc = new VisitorService(ctx.db as never);
      const result = await svc.transitionStatus(VISITOR_ID, 'in_meeting', ACTOR);
      expect(result.status).toBe('in_meeting');
    });

    it('arrived → checked_out with checkout_source=reception sets checked_out_at, auto_checked_out=false', async () => {
      tenantCtx();
      const ctx = makeFakeDb(baseVisitor({ status: 'arrived', arrived_at: '2026-05-01T09:00:00Z' }));
      const svc = new VisitorService(ctx.db as never);
      const result = await svc.transitionStatus(VISITOR_ID, 'checked_out', ACTOR, {
        checkout_source: 'reception',
      });
      expect(result.status).toBe('checked_out');
      expect(result.checkout_source).toBe('reception');
      expect(result.auto_checked_out).toBe(false);
      expect(result.checked_out_at).toBeTruthy();
    });

    it('arrived → checked_out with checkout_source=eod_sweep sets auto_checked_out=true', async () => {
      tenantCtx();
      const ctx = makeFakeDb(baseVisitor({ status: 'arrived', arrived_at: '2026-05-01T09:00:00Z' }));
      const svc = new VisitorService(ctx.db as never);
      const result = await svc.transitionStatus(VISITOR_ID, 'checked_out', ACTOR, {
        checkout_source: 'eod_sweep',
      });
      expect(result.auto_checked_out).toBe(true);
      expect(result.checkout_source).toBe('eod_sweep');
    });

    it('in_meeting → checked_out succeeds', async () => {
      tenantCtx();
      const ctx = makeFakeDb(baseVisitor({ status: 'in_meeting', arrived_at: '2026-05-01T09:00:00Z' }));
      const svc = new VisitorService(ctx.db as never);
      const result = await svc.transitionStatus(VISITOR_ID, 'checked_out', ACTOR, {
        checkout_source: 'host',
      });
      expect(result.status).toBe('checked_out');
    });

    it('expected → no_show succeeds (EOD sweep path)', async () => {
      tenantCtx();
      const ctx = makeFakeDb(baseVisitor({ status: 'expected' }));
      const svc = new VisitorService(ctx.db as never);
      const result = await svc.transitionStatus(VISITOR_ID, 'no_show', ACTOR);
      expect(result.status).toBe('no_show');
    });

    it('expected → cancelled records actor in audit metadata', async () => {
      tenantCtx();
      const ctx = makeFakeDb(baseVisitor({ status: 'expected' }));
      const svc = new VisitorService(ctx.db as never);
      await svc.transitionStatus(VISITOR_ID, 'cancelled', ACTOR);
      const evt = ctx.auditInserts.find((a) => a.event_type === 'visitor.cancelled');
      expect(evt).toBeTruthy();
      expect(evt!.details).toMatchObject({ actor_user_id: ACTOR.user_id });
    });

    it('pending_approval → expected succeeds (approval grant path)', async () => {
      tenantCtx();
      const ctx = makeFakeDb(baseVisitor({ status: 'pending_approval' }));
      const svc = new VisitorService(ctx.db as never);
      const result = await svc.transitionStatus(VISITOR_ID, 'expected', ACTOR);
      expect(result.status).toBe('expected');
    });

    it('pending_approval → denied succeeds', async () => {
      tenantCtx();
      const ctx = makeFakeDb(baseVisitor({ status: 'pending_approval' }));
      const svc = new VisitorService(ctx.db as never);
      const result = await svc.transitionStatus(VISITOR_ID, 'denied', ACTOR);
      expect(result.status).toBe('denied');
    });
  });

  describe('idempotent same-status writes', () => {
    it('expected → expected is a no-op (no UPDATE issued, returns current row)', async () => {
      tenantCtx();
      const ctx = makeFakeDb(baseVisitor({ status: 'expected' }));
      const svc = new VisitorService(ctx.db as never);
      const result = await svc.transitionStatus(VISITOR_ID, 'expected', ACTOR);
      expect(result.status).toBe('expected');
      const updateCalls = ctx.captured.filter((c) =>
        c.sql.toLowerCase().trim().startsWith('update public.visitors'),
      );
      expect(updateCalls).toHaveLength(0);
    });
  });

  describe('invalid transitions', () => {
    it('expected → checked_out (skipping arrived) throws BadRequestException', async () => {
      tenantCtx();
      const ctx = makeFakeDb(baseVisitor({ status: 'expected' }));
      const svc = new VisitorService(ctx.db as never);
      await expect(
        svc.transitionStatus(VISITOR_ID, 'checked_out', ACTOR, { checkout_source: 'reception' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('checked_out → arrived (terminal state) throws BadRequestException', async () => {
      tenantCtx();
      const ctx = makeFakeDb(
        baseVisitor({ status: 'checked_out', arrived_at: '2026-05-01T09:00:00Z', checkout_source: 'reception' }),
      );
      const svc = new VisitorService(ctx.db as never);
      await expect(svc.transitionStatus(VISITOR_ID, 'arrived', ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('denied → expected throws BadRequestException', async () => {
      tenantCtx();
      const ctx = makeFakeDb(baseVisitor({ status: 'denied' }));
      const svc = new VisitorService(ctx.db as never);
      await expect(svc.transitionStatus(VISITOR_ID, 'expected', ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('pending_approval → arrived (must go through expected first) throws BadRequestException', async () => {
      tenantCtx();
      const ctx = makeFakeDb(baseVisitor({ status: 'pending_approval' }));
      const svc = new VisitorService(ctx.db as never);
      await expect(svc.transitionStatus(VISITOR_ID, 'arrived', ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('checkout invariants', () => {
    it('arrived → checked_out without checkout_source throws BadRequestException', async () => {
      tenantCtx();
      const ctx = makeFakeDb(baseVisitor({ status: 'arrived', arrived_at: '2026-05-01T09:00:00Z' }));
      const svc = new VisitorService(ctx.db as never);
      await expect(
        svc.transitionStatus(VISITOR_ID, 'checked_out', ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Defense-in-depth: the visitors_checkout_source_required CHECK
      // would also catch this in the DB. Both layers in agreement.
    });
  });

  describe('cross-tenant', () => {
    it('throws when the locked row is in a different tenant than TenantContext', async () => {
      tenantCtx();
      const ctx = makeFakeDb(baseVisitor({ status: 'expected', tenant_id: '99999999-9999-4999-8999-999999999999' }));
      const svc = new VisitorService(ctx.db as never);
      await expect(svc.transitionStatus(VISITOR_ID, 'arrived', ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('downstream side-effects', () => {
    it('emits visitor.arrived domain event on arrived transition (host notif hook for slice 2b)', async () => {
      tenantCtx();
      const ctx = makeFakeDb(baseVisitor({ status: 'expected' }));
      const svc = new VisitorService(ctx.db as never);
      await svc.transitionStatus(VISITOR_ID, 'arrived', ACTOR);
      expect(ctx.domainEvents.find((e) => e.event_type === 'visitor.arrived')).toBeTruthy();
    });

    it('emits visitor.pass_return_requested domain event when checked_out and visitor_pass_id is set', async () => {
      tenantCtx();
      const ctx = makeFakeDb(
        baseVisitor({
          status: 'arrived',
          arrived_at: '2026-05-01T09:00:00Z',
          visitor_pass_id: '33333333-3333-4333-8333-333333333333',
        }),
      );
      const svc = new VisitorService(ctx.db as never);
      await svc.transitionStatus(VISITOR_ID, 'checked_out', ACTOR, {
        checkout_source: 'reception',
      });
      expect(
        ctx.domainEvents.find((e) => e.event_type === 'visitor.pass_return_requested'),
      ).toBeTruthy();
    });

    it('does NOT emit visitor.pass_return_requested when no pass is held', async () => {
      tenantCtx();
      const ctx = makeFakeDb(
        baseVisitor({ status: 'arrived', arrived_at: '2026-05-01T09:00:00Z', visitor_pass_id: null }),
      );
      const svc = new VisitorService(ctx.db as never);
      await svc.transitionStatus(VISITOR_ID, 'checked_out', ACTOR, {
        checkout_source: 'reception',
      });
      expect(
        ctx.domainEvents.find((e) => e.event_type === 'visitor.pass_return_requested'),
      ).toBeUndefined();
    });
  });
});

/**
 * VisitorService.onApprovalDecided — slice 3 unit tests.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §11.3
 *
 * The dispatcher in ApprovalService.respond() calls onApprovalDecided when
 * an approvals row with target_entity_type='visitor_invite' is granted or
 * denied. The visitor side must:
 *   - on 'approved': transition pending_approval → expected and emit
 *     visitor.invitation.expected (parallels InvitationService.create's
 *     no-approval branch).
 *   - on 'rejected': transition pending_approval → denied and notify
 *     hosts via HostNotificationService.notifyInvitationDenied. The
 *     visitor receives nothing (spec §11.3).
 *   - on already-resolved: idempotent if outcome matches, otherwise
 *     BadRequest.
 *   - cross-tenant: throw rather than silently no-op.
 */
describe('VisitorService.onApprovalDecided', () => {
  const APPROVER_USER_ID = 'apr-user-uuid';

  afterEach(() => jest.restoreAllMocks());

  /**
   * Build a service plus a mutable visitor row + a SupabaseService stub
   * that serves the row on `.from('visitors').select().eq().maybeSingle()`
   * and captures `.from('domain_events').insert()` writes.
   * The DbService is the same makeFakeDb harness used above so
   * transitionStatus exercises its real path.
   */
  function makeApprovalCtx(initialStatus: VisitorStatus, opts: { tenantOverride?: string } = {}) {
    const visitorRow = {
      id: VISITOR_ID,
      tenant_id: opts.tenantOverride ?? TENANT_ID,
      status: initialStatus,
    };
    const dbCtx = makeFakeDb(baseVisitor({ status: initialStatus }));

    const insertedDomainEvents: Array<Record<string, unknown>> = [];
    const supabase = {
      admin: {
        from: jest.fn((table: string) => {
          if (table === 'visitors') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: visitorRow, error: null }),
                }),
              }),
            };
          }
          if (table === 'domain_events') {
            return {
              insert: async (row: Record<string, unknown>) => {
                insertedDomainEvents.push(row);
                return { data: row, error: null };
              },
            };
          }
          throw new Error(`unexpected supabase table in onApprovalDecided test: ${table}`);
        }),
      },
    };

    const notifyDeniedSpy = jest.fn(async () => undefined);
    const hostNotifications = {
      notifyInvitationDenied: notifyDeniedSpy,
    };

    tenantCtx();
    const svc = new VisitorService(
      dbCtx.db as never,
      supabase as never,
      hostNotifications as never,
    );

    return { svc, dbCtx, supabase, insertedDomainEvents, notifyDeniedSpy, visitorRow };
  }

  it('approved: transitions pending_approval → expected and emits visitor.invitation.expected', async () => {
    const ctx = makeApprovalCtx('pending_approval');

    await ctx.svc.onApprovalDecided(VISITOR_ID, 'approved', APPROVER_USER_ID, TENANT_ID);

    expect(ctx.dbCtx.getRow().status).toBe('expected');
    const expectedEvt = ctx.insertedDomainEvents.find(
      (e) => e.event_type === 'visitor.invitation.expected',
    );
    expect(expectedEvt).toBeTruthy();
    expect(expectedEvt!.tenant_id).toBe(TENANT_ID);
    expect(expectedEvt!.entity_id).toBe(VISITOR_ID);
    // The approver_user_id must round-trip into the payload so the email
    // worker has audit lineage on the invitation send.
    const payload = expectedEvt!.payload as Record<string, unknown>;
    expect(payload.triggered_by).toBe('approval_grant');
    expect(payload.approver_user_id).toBe(APPROVER_USER_ID);

    // Audit insert from transitionStatus should record visitor.expected.
    expect(
      ctx.dbCtx.auditInserts.find((a) => a.event_type === 'visitor.expected'),
    ).toBeTruthy();
  });

  it('rejected: transitions pending_approval → denied and notifies host', async () => {
    const ctx = makeApprovalCtx('pending_approval');

    await ctx.svc.onApprovalDecided(VISITOR_ID, 'rejected', APPROVER_USER_ID, TENANT_ID);

    expect(ctx.dbCtx.getRow().status).toBe('denied');
    expect(ctx.notifyDeniedSpy).toHaveBeenCalledWith(VISITOR_ID, TENANT_ID);
    // No invitation.expected event on denial — the email must NOT be sent.
    expect(
      ctx.insertedDomainEvents.find((e) => e.event_type === 'visitor.invitation.expected'),
    ).toBeUndefined();
  });

  it('idempotent: approved on already-expected visitor is a no-op', async () => {
    const ctx = makeApprovalCtx('expected');

    await ctx.svc.onApprovalDecided(VISITOR_ID, 'approved', APPROVER_USER_ID, TENANT_ID);

    // No status mutation, no domain event, no audit on transitionStatus
    // (it's never called when the row is already in the target state).
    expect(ctx.dbCtx.getRow().status).toBe('expected');
    expect(ctx.insertedDomainEvents).toHaveLength(0);
    expect(ctx.notifyDeniedSpy).not.toHaveBeenCalled();
    // No SELECT FOR UPDATE / no UPDATE statement on the visitors table.
    const updateCalls = ctx.dbCtx.captured.filter((c) =>
      c.sql.toLowerCase().trim().startsWith('update public.visitors'),
    );
    expect(updateCalls).toHaveLength(0);
  });

  it('idempotent: rejected on already-denied visitor is a no-op', async () => {
    const ctx = makeApprovalCtx('denied');

    await ctx.svc.onApprovalDecided(VISITOR_ID, 'rejected', APPROVER_USER_ID, TENANT_ID);

    expect(ctx.dbCtx.getRow().status).toBe('denied');
    expect(ctx.notifyDeniedSpy).not.toHaveBeenCalled();
    expect(ctx.insertedDomainEvents).toHaveLength(0);
  });

  it('rejected on already-approved visitor throws BadRequest (state-machine bug)', async () => {
    // The dispatcher should not be able to flip an approved visitor into
    // denied — that would mean two conflicting approval grants on the
    // same target. Surface clearly.
    const ctx = makeApprovalCtx('expected');

    await expect(
      ctx.svc.onApprovalDecided(VISITOR_ID, 'rejected', APPROVER_USER_ID, TENANT_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ctx.dbCtx.getRow().status).toBe('expected');
    expect(ctx.notifyDeniedSpy).not.toHaveBeenCalled();
  });

  it('throws BadRequest when visitor is in a non-pending_approval state (e.g. cancelled)', async () => {
    const ctx = makeApprovalCtx('cancelled');

    await expect(
      ctx.svc.onApprovalDecided(VISITOR_ID, 'approved', APPROVER_USER_ID, TENANT_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cross-tenant: tenantId param mismatching TenantContext is rejected', async () => {
    const ctx = makeApprovalCtx('pending_approval');

    await expect(
      ctx.svc.onApprovalDecided(
        VISITOR_ID,
        'approved',
        APPROVER_USER_ID,
        '99999999-9999-4999-8999-999999999999',
      ),
    ).rejects.toThrow();
    // No transition fired.
    expect(ctx.dbCtx.getRow().status).toBe('pending_approval');
  });

  it('cross-tenant: visitor row in different tenant surfaces as not-found', async () => {
    // Same TenantContext as the caller, but the visitors row in our stub
    // belongs to a different tenant — composite-FK / explicit guard catches
    // this before any transition fires.
    const ctx = makeApprovalCtx('pending_approval', {
      tenantOverride: '99999999-9999-4999-8999-999999999999',
    });

    await expect(
      ctx.svc.onApprovalDecided(VISITOR_ID, 'approved', APPROVER_USER_ID, TENANT_ID),
    ).rejects.toThrow();
    expect(ctx.dbCtx.getRow().status).toBe('pending_approval');
  });
});
