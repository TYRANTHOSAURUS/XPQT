/**
 * Approval ↔ Visitor cross-module integration spec — slice 3.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §11
 * Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md §Slice 3
 *
 * The slice-3 contract is small but cuts across two modules: the existing
 * ApprovalService.respond() now dispatches `target_entity_type='visitor_invite'`
 * to VisitorService.onApprovalDecided, which transitions the visitor and
 * either emits the invitation-expected event (approval) or fans out a
 * denial notification (rejection). The unit specs cover each side
 * independently — this spec wires the REAL services together (with mocked
 * IO collaborators) so the dispatch path itself is tested end-to-end.
 *
 * What's mocked:
 *   - SupabaseService (one fake serves both ApprovalService and
 *     VisitorService — the underlying tables are emulated in memory).
 *   - DbService for VisitorService.transitionStatus (the same harness
 *     pattern used in visitor-service.spec.ts).
 *   - NotificationService (HostNotificationService's downstream).
 *   - VisitorEventBus (fresh per test).
 *   - The other ApprovalService dispatch targets (ticket / reservation /
 *     booking_bundle) — `target_entity_type='visitor_invite'` is the
 *     branch we exercise; the others are jest.fn() stubs.
 *
 * What's REAL:
 *   - ApprovalService.respond() — including the dispatcher switch.
 *   - VisitorService.onApprovalDecided — including idempotency,
 *     state-machine guards, transition+event emission.
 *   - HostNotificationService.notifyInvitationDenied — full path through
 *     loadVisitor + loadHosts + notification fan-out.
 */

import type { PoolClient } from 'pg';
import { TenantContext } from '../../common/tenant-context';
import { ApprovalService } from '../approval/approval.service';
import { HostNotificationService } from './host-notification.service';
import { VisitorEventBus } from './visitor-event-bus';
import { VisitorService } from './visitor.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '99999999-9999-4999-8999-999999999999';
const VISITOR_ID = '22222222-2222-4222-8222-222222222222';
const APPROVAL_ID = '33333333-3333-4333-8333-333333333333';
const APPROVER_PERSON_ID = '44444444-4444-4444-8444-444444444444';
const APPROVER_USER_ID = '55555555-5555-4555-8555-555555555555';
const HOST_PERSON_ID = '66666666-6666-4666-8666-666666666666';

interface VisitorState {
  id: string;
  tenant_id: string;
  status: string;
  arrived_at: string | null;
  logged_at: string | null;
  checked_out_at: string | null;
  checkout_source: string | null;
  auto_checked_out: boolean;
  visitor_pass_id: string | null;
  primary_host_person_id: string;
  first_name: string;
  last_name: string;
  company: string;
  building_id: string;
  expected_at: string;
}

interface ApprovalRow {
  id: string;
  tenant_id: string;
  target_entity_type: string;
  target_entity_id: string;
  status: 'pending' | 'approved' | 'rejected';
  approver_person_id: string;
  approver_team_id: string | null;
  approval_chain_id: string | null;
  parallel_group: string | null;
  step_number: number | null;
  comments: string | null;
  responded_at: string | null;
}

interface World {
  visitor: VisitorState | null;
  approval: ApprovalRow | null;
  hostsForVisitor: Array<{ id: string; person_id: string; tenant_id: string; visitor_id: string; notified_at: string | null; acknowledged_at: string | null }>;
  domainEvents: Array<{ event_type: string; entity_id: string; payload: Record<string, unknown> }>;
  auditEvents: Array<{ event_type: string; entity_id: string; details: Record<string, unknown> }>;
  notifications: Array<Record<string, unknown>>;
}

function makeWorld(initialVisitorTenant = TENANT_ID): World {
  return {
    visitor: {
      id: VISITOR_ID,
      tenant_id: initialVisitorTenant,
      status: 'pending_approval',
      arrived_at: null,
      logged_at: null,
      checked_out_at: null,
      checkout_source: null,
      auto_checked_out: false,
      visitor_pass_id: null,
      primary_host_person_id: HOST_PERSON_ID,
      first_name: 'Marleen',
      last_name: 'Visser',
      company: 'ABC Bank',
      building_id: 'building-1',
      expected_at: '2026-05-01T09:00:00Z',
    },
    approval: {
      id: APPROVAL_ID,
      tenant_id: TENANT_ID,
      target_entity_type: 'visitor_invite',
      target_entity_id: VISITOR_ID,
      status: 'pending',
      approver_person_id: APPROVER_PERSON_ID,
      approver_team_id: null,
      approval_chain_id: null,
      parallel_group: null,
      step_number: null,
      comments: null,
      responded_at: null,
    },
    hostsForVisitor: [
      {
        id: 'h1',
        visitor_id: VISITOR_ID,
        person_id: HOST_PERSON_ID,
        tenant_id: TENANT_ID,
        notified_at: null,
        acknowledged_at: null,
      },
    ],
    domainEvents: [],
    auditEvents: [],
    notifications: [],
  };
}

/**
 * Supabase fake. Routes by table to in-memory state in `world`.
 * Only the operations the production code actually issues are emulated;
 * if a test trips into a path we haven't faked, the fake throws so we
 * notice rather than silently returning empty data.
 */
function makeSupabase(world: World) {
  return {
    admin: {
      from(table: string) {
        if (table === 'approvals') {
          return makeApprovalsChain(world);
        }
        if (table === 'visitors') {
          return makeVisitorsChain(world);
        }
        if (table === 'visitor_hosts') {
          return makeVisitorHostsChain(world);
        }
        if (table === 'domain_events') {
          return {
            insert: async (row: Record<string, unknown>) => {
              world.domainEvents.push({
                event_type: row.event_type as string,
                entity_id: row.entity_id as string,
                payload: (row.payload as Record<string, unknown>) ?? {},
              });
              return { data: row, error: null };
            },
          };
        }
        if (table === 'audit_events') {
          return {
            insert: async (row: Record<string, unknown>) => {
              world.auditEvents.push({
                event_type: row.event_type as string,
                entity_id: row.entity_id as string,
                details: (row.details as Record<string, unknown>) ?? {},
              });
              return { data: row, error: null };
            },
          };
        }
        if (table === 'team_members' || table === 'delegations' || table === 'users') {
          // ApprovalService.callerCanRespond reads team_members + users +
          // delegations to decide if the caller may respond. The integration
          // tests below use the named approver_person_id so the very first
          // gate (approver_person_id === callerPersonId) returns true and
          // these fallbacks are never hit. Return empty defensively.
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          };
        }
        if (table === 'persons' || table === 'notifications' || table === 'notification_preferences') {
          // NotificationService.send reads/writes these. Stub so the call
          // succeeds; the test asserts on the recorded `world.notifications`.
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                  in: () => Promise.resolve({ data: [], error: null }),
                }),
                in: () => Promise.resolve({ data: [], error: null }),
              }),
              in: () => Promise.resolve({ data: [], error: null }),
            }),
            insert: async (rows: unknown) => {
              const list = Array.isArray(rows) ? rows : [rows];
              for (const row of list) {
                world.notifications.push(row as Record<string, unknown>);
              }
              return { data: rows, error: null, select: () => Promise.resolve({ data: rows, error: null }) };
            },
          };
        }
        throw new Error(`unhandled table in approval-integration fake: ${table}`);
      },
    },
  };
}

function makeApprovalsChain(world: World) {
  const buildSelectChain = () => {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    chain.eq = (col: unknown, val: unknown) => {
      filters[col as string] = val;
      return chain;
    };
    chain.single = async () => {
      if (!world.approval) {
        return { data: null, error: { message: 'not found' } };
      }
      const ok = (filters.id == null || world.approval.id === filters.id) &&
        (filters.tenant_id == null || world.approval.tenant_id === filters.tenant_id);
      if (!ok) {
        return { data: null, error: { message: 'not found' } };
      }
      return { data: world.approval, error: null };
    };
    chain.maybeSingle = async () => {
      const ok = world.approval &&
        (filters.id == null || world.approval.id === filters.id) &&
        (filters.tenant_id == null || world.approval.tenant_id === filters.tenant_id) &&
        (filters.status == null || world.approval.status === filters.status);
      if (!ok) return { data: null, error: null };
      return { data: world.approval, error: null };
    };
    return chain;
  };

  return {
    select: () => buildSelectChain(),
    update: (patch: Record<string, unknown>) => {
      const filters: Record<string, unknown> = {};
      const updateChain: Record<string, (...args: unknown[]) => unknown> = {};
      updateChain.eq = (col: unknown, val: unknown) => {
        filters[col as string] = val;
        return updateChain;
      };
      updateChain.select = () => updateChain;
      updateChain.maybeSingle = async () => {
        // Atomic CAS — only patch if filters all match.
        if (!world.approval) return { data: null, error: null };
        const ok = (filters.id == null || world.approval.id === filters.id) &&
          (filters.status == null || world.approval.status === filters.status);
        if (!ok) return { data: null, error: null };
        world.approval = { ...world.approval, ...(patch as Partial<ApprovalRow>) };
        return { data: world.approval, error: null };
      };
      return updateChain;
    },
  };
}

function makeVisitorsChain(world: World) {
  return {
    select: () => {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, (...args: unknown[]) => unknown> = {};
      chain.eq = (col: unknown, val: unknown) => {
        filters[col as string] = val;
        return chain;
      };
      chain.maybeSingle = async () => {
        if (!world.visitor) return { data: null, error: null };
        const ok = filters.id == null || world.visitor.id === filters.id;
        if (!ok) return { data: null, error: null };
        return { data: world.visitor, error: null };
      };
      return chain;
    },
  };
}

function makeVisitorHostsChain(world: World) {
  return {
    select: () => {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, (...args: unknown[]) => unknown> = {};
      chain.eq = (col: unknown, val: unknown) => {
        filters[col as string] = val;
        return chain;
      };
      chain.then = (resolve: (r: { data: unknown[]; error: null }) => unknown) => {
        const filtered = world.hostsForVisitor.filter((row) => {
          if (filters.visitor_id != null && row.visitor_id !== filters.visitor_id) return false;
          if (filters.tenant_id != null && row.tenant_id !== filters.tenant_id) return false;
          return true;
        });
        return resolve({ data: filtered, error: null });
      };
      return chain;
    },
    update: (patch: Record<string, unknown>) => {
      void patch;
      return {
        eq: () => ({
          eq: async () => ({ data: null, error: null }),
        }),
      };
    },
    insert: async () => ({ data: null, error: null }),
  };
}

/**
 * DbService fake — backs VisitorService.transitionStatus with a tx that
 * mutates `world.visitor`. The structure mirrors the makeFakeDb harness
 * in visitor-service.spec.ts but routes the inserts through `world` so
 * the integration test sees them.
 */
function makeDb(world: World) {
  const client: { query: jest.Mock } = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      const trimmed = sql.trim().toLowerCase();
      if (trimmed.startsWith('select') && trimmed.includes('from public.visitors')) {
        return { rows: world.visitor ? [world.visitor] : [], rowCount: world.visitor ? 1 : 0 };
      }
      if (trimmed.startsWith('update public.visitors')) {
        if (!world.visitor || !params) return { rows: [], rowCount: 0 };
        const setMatch = sql.match(/set\s+([\s\S]+?)\s+where/i);
        if (setMatch) {
          const cols = setMatch[1]
            .split(',')
            .map((s) => s.trim())
            .map((piece) => piece.split('=')[0].trim());
          const updated = { ...world.visitor };
          for (let i = 0; i < cols.length; i++) {
            const col = cols[i] as keyof VisitorState;
            (updated as unknown as Record<string, unknown>)[col] = params[i];
          }
          world.visitor = updated;
        }
        return { rows: [world.visitor], rowCount: 1 };
      }
      if (trimmed.startsWith('insert into public.audit_events')) {
        const details = params?.[4];
        const parsed = typeof details === 'string'
          ? (JSON.parse(details) as Record<string, unknown>)
          : ((details as Record<string, unknown> | undefined) ?? {});
        world.auditEvents.push({
          event_type: (params?.[1] as string) ?? '',
          entity_id: (params?.[3] as string) ?? '',
          details: parsed,
        });
        return { rows: [], rowCount: 1 };
      }
      if (trimmed.startsWith('insert into public.domain_events')) {
        const payload = params?.[4];
        const parsed = typeof payload === 'string'
          ? (JSON.parse(payload) as Record<string, unknown>)
          : ((payload as Record<string, unknown> | undefined) ?? {});
        world.domainEvents.push({
          event_type: (params?.[1] as string) ?? '',
          entity_id: (params?.[3] as string) ?? '',
          payload: parsed,
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };

  return {
    tx: jest.fn(async <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> =>
      fn(client as unknown as PoolClient),
    ),
  };
}

function buildWiring(world: World) {
  const supabase = makeSupabase(world);
  const db = makeDb(world);

  // NotificationService.send — minimal stub. Records the dto in the world
  // bucket so denial-flow tests can assert hosts got pinged.
  const notifications = {
    send: jest.fn(async (dto: Record<string, unknown>) => {
      world.notifications.push(dto);
      return [];
    }),
  };

  const eventBus = new VisitorEventBus();

  // Real HostNotificationService (slice 3 added notifyInvitationDenied).
  const hostNotifications = new HostNotificationService(
    supabase as never,
    notifications as never,
    eventBus,
  );

  // Real VisitorService with the new optional deps wired up.
  const visitorService = new VisitorService(
    db as never,
    supabase as never,
    hostNotifications,
  );

  // Real ApprovalService — but the other dispatcher targets are stubs
  // because we're only exercising the `visitor_invite` branch.
  const ticketStub = { onApprovalDecision: jest.fn() } as never;
  const bookingNotifsStub = { onApprovalDecided: jest.fn() } as never;
  const bundleStub = { onApprovalDecided: jest.fn() } as never;

  const approvalService = new ApprovalService(
    supabase as never,
    ticketStub,
    bookingNotifsStub,
    bundleStub,
    visitorService,
  );

  return { approvalService, visitorService, hostNotifications, world };
}

describe('Approval ↔ Visitor cross-module integration (slice 3)', () => {
  beforeEach(() => {
    jest.spyOn(TenantContext, 'current').mockReturnValue({
      id: TENANT_ID,
      slug: 'acme',
      tier: 'standard',
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('happy path approve: pending_approval → expected + invitation.expected event emitted', async () => {
    const world = makeWorld();
    const { approvalService } = buildWiring(world);

    expect(world.visitor!.status).toBe('pending_approval');
    expect(world.approval!.status).toBe('pending');

    const result = await approvalService.respond(
      APPROVAL_ID,
      { status: 'approved' },
      APPROVER_PERSON_ID,
      APPROVER_USER_ID,
    );

    // Approval row CAS-updated to approved.
    expect(result.status).toBe('approved');
    expect(world.approval!.status).toBe('approved');

    // Visitor transitioned.
    expect(world.visitor!.status).toBe('expected');

    // Invitation-expected event emitted (slice 5 email worker hook).
    const evt = world.domainEvents.find((e) => e.event_type === 'visitor.invitation.expected');
    expect(evt).toBeTruthy();
    expect(evt!.entity_id).toBe(VISITOR_ID);
    expect((evt!.payload as Record<string, unknown>).triggered_by).toBe('approval_grant');

    // No denial-side notification was sent.
    expect(
      world.notifications.find(
        (n) => (n as Record<string, unknown>).notification_type === 'visitor.invitation_denied',
      ),
    ).toBeUndefined();
  });

  it('happy path deny: pending_approval → denied + host fan-out', async () => {
    const world = makeWorld();
    const { approvalService } = buildWiring(world);

    const result = await approvalService.respond(
      APPROVAL_ID,
      { status: 'rejected' },
      APPROVER_PERSON_ID,
      APPROVER_USER_ID,
    );

    expect(result.status).toBe('rejected');
    expect(world.approval!.status).toBe('rejected');
    expect(world.visitor!.status).toBe('denied');

    // Host got a denial notification (only one host in the fixture).
    const denials = world.notifications.filter(
      (n) => (n as Record<string, unknown>).notification_type === 'visitor.invitation_denied',
    );
    expect(denials).toHaveLength(1);
    expect((denials[0] as Record<string, unknown>).recipient_person_id).toBe(HOST_PERSON_ID);
    expect((denials[0] as Record<string, unknown>).related_entity_id).toBe(VISITOR_ID);

    // No invitation-expected event on denial — the visitor must NOT be emailed.
    expect(
      world.domainEvents.find((e) => e.event_type === 'visitor.invitation.expected'),
    ).toBeUndefined();
  });

  it('cross-tenant: approval in tenant A on a visitor in tenant B does not transition the visitor', async () => {
    // Approval is in TENANT_ID (caller's context). The visitor row was
    // created in OTHER_TENANT_ID — cross-tenant. The dispatcher will
    // call onApprovalDecided with approval.tenant_id (TENANT_ID); the
    // visitor lookup inside onApprovalDecided notices the visitor row
    // belongs to a different tenant and surfaces as not-found. The
    // approval grant itself still commits (the row is in TENANT_ID)
    // but no visitor transition fires.
    const world = makeWorld(OTHER_TENANT_ID);
    const { approvalService } = buildWiring(world);

    // The approval-row tenant_id is TENANT_ID; the visitor tenant is OTHER.
    expect(world.approval!.tenant_id).toBe(TENANT_ID);
    expect(world.visitor!.tenant_id).toBe(OTHER_TENANT_ID);

    // Mute the dispatcher's console.error so the test output is clean.
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await approvalService.respond(
      APPROVAL_ID,
      { status: 'approved' },
      APPROVER_PERSON_ID,
      APPROVER_USER_ID,
    );

    // Approval committed, but visitor untouched.
    expect(world.approval!.status).toBe('approved');
    expect(world.visitor!.status).toBe('pending_approval');
    expect(
      world.domainEvents.find((e) => e.event_type === 'visitor.invitation.expected'),
    ).toBeUndefined();
    // The dispatcher swallows downstream errors and logs them — confirm.
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
