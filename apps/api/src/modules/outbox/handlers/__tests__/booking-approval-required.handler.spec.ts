import {
  BookingApprovalRequiredHandler,
  type BookingApprovalRequiredPayload,
} from '../booking-approval-required.handler';
import { DeadLetterError } from '../../dead-letter.error';
import type { OutboxEvent } from '../../outbox.types';
import type { NotificationsService } from '../../../notifications';
import type { SupabaseService } from '../../../../common/supabase/supabase.service';
import type { ConfigService } from '@nestjs/config';
import { TenantContext } from '../../../../common/tenant-context';

/**
 * B.4.A.4 + B.4.A.5 — `BookingApprovalRequiredHandler.handle` tests.
 *
 * Producer: supabase/migrations/00394_edit_booking_rpc_v5.sql:974-993
 *           (post-B.4.A.5-sub-step-B; supersedes 00364 v4).
 * Event literal: apps/api/src/modules/reservations/event-types.ts:51
 *                (`BookingEditEventType.ApprovalRequired`).
 *
 * Coverage:
 *   - Validation gates (tenant smuggling defense, payload shape, legacy
 *     v4 backward-compat shim) — exercised against the same handler with
 *     minimal mocks. Self-review C1 dropped @Optional() DI, so every
 *     handler instance now has injected services.
 *   - Sub-step D dispatch path (re-read + fan-out + per-user email).
 *
 * The minimal mock returns empty arrays from the approvals re-read (causes
 * the "chain_not_found" no-op short-circuit) when validation is what's
 * being tested. That keeps the validation tests focused on payload shape
 * without exercising the dispatch path.
 */

const TENANT_ID = 'a1111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = 'a9999999-9999-4999-8999-999999999999';
const EVENT_ID = 'a2222222-2222-4222-8222-222222222222';
const BOOKING_ID = 'a3333333-3333-4333-8333-333333333333';
const CHAIN_ID = 'a4444444-4444-4444-8444-444444444444';
const APPROVER_A = 'a5555555-5555-4555-8555-555555555555';
const APPROVER_B = 'a6666666-6666-4666-8666-666666666666';

function makeEvent(
  overrides: Partial<OutboxEvent<BookingApprovalRequiredPayload>> = {},
  payloadOverrides: Partial<BookingApprovalRequiredPayload> = {},
): OutboxEvent<BookingApprovalRequiredPayload> {
  return {
    id: EVENT_ID,
    tenant_id: TENANT_ID,
    event_type: 'booking.approval_required',
    event_version: 1,
    aggregate_type: 'booking',
    aggregate_id: BOOKING_ID,
    payload: {
      tenant_id: TENANT_ID,
      booking_id: BOOKING_ID,
      chain_id: CHAIN_ID,
      approver_person_ids: [APPROVER_A, APPROVER_B],
      approver_team_ids: [],
      started_at: '2026-05-12T09:00:00Z',
      ...payloadOverrides,
    },
    payload_hash: 'hash',
    idempotency_key: 'booking.approval_required:' + BOOKING_ID + ':edit-1',
    enqueued_at: '2026-05-12T08:59:00Z',
    available_at: '2026-05-12T08:59:00Z',
    processed_at: null,
    processed_reason: null,
    claim_token: null,
    claimed_at: null,
    attempts: 0,
    last_error: null,
    dead_lettered_at: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Minimal handler factory — for tests that only exercise the validation
// gates upstream of the supabase reads. Self-review C1: @Optional() is
// gone, so every handler instance must inject its three deps.
//
// The supabase mock returns empty `approvals` so validation-passing events
// short-circuit at the chain_not_found no-op (step 3) without exercising
// the dispatch path. notifications.dispatch is never called in these
// tests.
// ─────────────────────────────────────────────────────────────────────────
function makeMinimalSupabase(): SupabaseService {
  return {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'approvals') {
          return {
            select: () => ({
              eq: () => ({
                eq: async () => ({ data: [], error: null }),
              }),
            }),
          };
        }
        // Unreachable in these tests — every validation-passing event
        // short-circuits at the empty approvals read above.
        throw new Error('unexpected table in minimal mock: ' + table);
      }),
    },
  } as unknown as SupabaseService;
}

function makeMinimalNotifications(): NotificationsService {
  return {
    dispatch: jest.fn(async () => ({
      channelId: 'email' as const,
      externalId: 'rs_unused',
      delivered: true,
    })),
  } as unknown as NotificationsService;
}

function makeMinimalConfig(): ConfigService {
  return {
    get: jest.fn(() => undefined),
  } as unknown as ConfigService;
}

function makeMinimalHandler(): BookingApprovalRequiredHandler {
  return new BookingApprovalRequiredHandler(
    makeMinimalSupabase(),
    makeMinimalNotifications(),
    makeMinimalConfig(),
  );
}

describe('BookingApprovalRequiredHandler.handle (validation gates)', () => {
  describe('happy path (validation passes; chain re-read no-op)', () => {
    it('accepts a well-formed event without throwing', async () => {
      const handler = makeMinimalHandler();
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
    });

    it('accepts a single-approver event', async () => {
      const handler = makeMinimalHandler();
      await expect(
        handler.handle(makeEvent({}, { approver_person_ids: [APPROVER_A], approver_team_ids: [] })),
      ).resolves.toBeUndefined();
    });

    it('accepts a team-only event', async () => {
      const handler = makeMinimalHandler();
      await expect(
        handler.handle(makeEvent({}, { approver_person_ids: [], approver_team_ids: [APPROVER_A] })),
      ).resolves.toBeUndefined();
    });
  });

  describe('tenant smuggling defense', () => {
    it('dead-letters when payload.tenant_id != event.tenant_id', async () => {
      const handler = makeMinimalHandler();
      const event = makeEvent({}, { tenant_id: OTHER_TENANT_ID });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });
  });

  describe('payload shape — terminal dead-letters', () => {
    it('dead-letters on missing booking_id', async () => {
      const handler = makeMinimalHandler();
      const event = makeEvent({}, { booking_id: undefined as unknown as string });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters on non-uuid booking_id', async () => {
      const handler = makeMinimalHandler();
      const event = makeEvent({}, { booking_id: 'not-a-uuid' });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters on missing chain_id', async () => {
      const handler = makeMinimalHandler();
      const event = makeEvent({}, { chain_id: undefined as unknown as string });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters when both approver arrays are empty', async () => {
      const handler = makeMinimalHandler();
      const event = makeEvent({}, { approver_person_ids: [], approver_team_ids: [] });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters on missing approver_person_ids', async () => {
      const handler = makeMinimalHandler();
      const event = makeEvent(
        {},
        { approver_person_ids: undefined as unknown as string[] },
      );
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters on missing approver_team_ids', async () => {
      const handler = makeMinimalHandler();
      const event = makeEvent(
        {},
        { approver_team_ids: undefined as unknown as string[] },
      );
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters when an approver person id is not a uuid', async () => {
      const handler = makeMinimalHandler();
      const event = makeEvent({}, { approver_person_ids: [APPROVER_A, 'bogus'] });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters when an approver team id is not a uuid', async () => {
      const handler = makeMinimalHandler();
      const event = makeEvent({}, { approver_team_ids: ['bogus'] });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters on unparseable started_at', async () => {
      const handler = makeMinimalHandler();
      const event = makeEvent({}, { started_at: 'not-a-date' });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters on missing started_at', async () => {
      const handler = makeMinimalHandler();
      const event = makeEvent({}, { started_at: undefined as unknown as string });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });
  });

  // ── Codex remediation: legacy v4 backward-compat shim ────────────────
  // Outbox events emitted by 00364 v4 BEFORE the v5 cutover landed on
  // remote (commits 7852ebf0 + c7ddb037 push) carry the mixed
  // `approver_ids` field instead of the split arrays. The handler tolerates
  // that shape best-effort: legacy `approver_ids` -> `approver_person_ids`
  // + a `legacy_payload_shape_detected` warn line. Remove this case after
  // the drain window closes.
  describe('legacy v4 backward-compat shim', () => {
    it('legacy approver_ids payload accepted as person_ids with warn log', async () => {
      const handler = makeMinimalHandler();
      const warnSpy = jest
        .spyOn((handler as unknown as { log: { warn: (msg: string) => void } }).log, 'warn')
        .mockImplementation(() => undefined);
      try {
        // Simulate a v4-shape payload: no approver_person_ids /
        // approver_team_ids, but legacy approver_ids present. Cast through
        // unknown because the typed payload schema doesn't expose the split
        // arrays as optional (they're required) — the runtime check is what
        // exercises the shim.
        const event = makeEvent(
          {},
          {
            approver_person_ids: undefined as unknown as string[],
            approver_team_ids: undefined as unknown as string[],
            approver_ids: [APPROVER_A, APPROVER_B],
          } as Partial<BookingApprovalRequiredPayload>,
        );
        await expect(handler.handle(event)).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const warnMsg = warnSpy.mock.calls[0][0];
        expect(typeof warnMsg).toBe('string');
        expect(warnMsg as string).toContain('legacy_payload_shape_detected');
        expect(warnMsg as string).toContain(EVENT_ID);
        expect(warnMsg as string).toContain(CHAIN_ID);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('legacy shim does not fire when split arrays are present (no warn)', async () => {
      const handler = makeMinimalHandler();
      const warnSpy = jest
        .spyOn((handler as unknown as { log: { warn: (msg: string) => void } }).log, 'warn')
        .mockImplementation(() => undefined);
      try {
        // v5-shape event with legacy approver_ids ALSO set (defensive: a
        // producer that emits both keys must NOT trigger the shim — split
        // arrays win).
        const event = makeEvent(
          {},
          {
            approver_person_ids: [APPROVER_A],
            approver_team_ids: [],
            approver_ids: [APPROVER_B],
          } as Partial<BookingApprovalRequiredPayload>,
        );
        await expect(handler.handle(event)).resolves.toBeUndefined();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('legacy shim still validates uuid shape on the salvaged person ids', async () => {
      const handler = makeMinimalHandler();
      const event = makeEvent(
        {},
        {
          approver_person_ids: undefined as unknown as string[],
          approver_team_ids: undefined as unknown as string[],
          approver_ids: [APPROVER_A, 'not-a-uuid'],
        } as Partial<BookingApprovalRequiredPayload>,
      );
      // Salvaged → flows through downstream uuid validation → dead-letters.
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// B.4.A.5 sub-step D — dispatch path tests
// ─────────────────────────────────────────────────────────────────────────
//
// Spec: /tmp/b4a5-plan-v2.md sub-step D + self-review remediation v2.
//
// Coverage:
//   1. Happy path — 1 person → 1 dispatch (en locale).
//   2. Happy path — team approver fan-out → N dispatches.
//   3. Happy path — mixed person + team → union dispatched.
//   4. Chain already resolved (status='approved'/'rejected') → no-op.
//   5. Chain rows missing entirely → no-op.
//   6. Person approver has no users row in tenant → that approver skipped,
//      others dispatched.
//   7. Booking deleted between RPC + handler drain → enrichment returns
//      null → no-op.
//   8. Per-user dispatch failure → other users still get dispatched.
//   9. Idempotency key shape = `<event.id>:<userId>`.
//  10. Locale 'en' default + NL tenant gets NL.
//  11. Tenant slug forwarded from TenantContext (or empty when unset).
//  12. (self-review I7) Transient supabase read errors throw AppError
//      (outbox retry picks up): approvals re-read, person_users lookup,
//      team_members lookup, booking enrichment.

const USER_A = 'aa000000-0000-4000-8000-000000000001';
const USER_B = 'aa000000-0000-4000-8000-000000000002';
const USER_C = 'aa000000-0000-4000-8000-000000000003';
const TEAM_X = 'aa000000-0000-4000-8000-00000000000a';
const SPACE_ID = 'aa000000-0000-4000-8000-000000000010';

interface ApprovalRow {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  approver_person_id: string | null;
  approver_team_id: string | null;
}

interface UserRow {
  id: string;
  person_id?: string | null;
  email: string | null;
}

interface BookingRow {
  id: string;
  tenant_id: string;
  title: string | null;
  location_id: string;
  requester_person_id: string;
  start_at: string;
  end_at: string;
}

interface SpaceRow {
  id: string;
  name: string;
}

interface PersonRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

interface TenantRow {
  id: string;
  locale_default: string | null;
}

interface DispatchHarnessOpts {
  approvals?: ApprovalRow[] | null;
  approvalsError?: { message: string } | null;
  personUsers?: UserRow[];
  personUsersError?: { message: string } | null;
  teamMembers?: Array<{ user_id: string; team_id: string }>;
  teamMembersError?: { message: string } | null;
  teamUsers?: UserRow[];
  teamUsersError?: { message: string } | null;
  booking?: BookingRow | null;
  bookingError?: { message: string } | null;
  space?: SpaceRow | null;
  requester?: PersonRow | null;
  tenant?: TenantRow | null;
  /** When true, the dispatch fn throws on the n-th call (1-indexed). */
  failDispatchOn?: number[];
}

interface DispatchCallCapture {
  tenantId: string;
  userId: string;
  locale: 'en' | 'nl';
  eventKind: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  context: { entityType: string; entityId: string; tenantSlug: string };
}

function makeDispatchHarness(opts: DispatchHarnessOpts) {
  const dispatchCalls: DispatchCallCapture[] = [];
  const fromTables: string[] = [];

  const supabase: SupabaseService = {
    admin: {
      from: jest.fn((table: string) => {
        fromTables.push(table);
        if (table === 'approvals') {
          // .eq().eq() chain returning {data, error}.
          return {
            select: () => ({
              eq: () => ({
                eq: async () => ({
                  data: opts.approvals ?? [],
                  error: opts.approvalsError ?? null,
                }),
              }),
            }),
          };
        }
        if (table === 'users') {
          // Two usage shapes: by person_id IN (persons), or by id IN (users).
          return {
            select: () => ({
              eq: () => ({
                in: async (col: string, ids: string[]) => {
                  if (col === 'person_id') {
                    if (opts.personUsersError) {
                      return { data: null, error: opts.personUsersError };
                    }
                    const rows = (opts.personUsers ?? []).filter((u) =>
                      ids.includes(u.person_id as string),
                    );
                    return { data: rows, error: null };
                  }
                  if (col === 'id') {
                    if (opts.teamUsersError) {
                      return { data: null, error: opts.teamUsersError };
                    }
                    const rows = (opts.teamUsers ?? []).filter((u) =>
                      ids.includes(u.id),
                    );
                    return { data: rows, error: null };
                  }
                  return { data: [], error: null };
                },
              }),
            }),
          };
        }
        if (table === 'team_members') {
          return {
            select: () => ({
              eq: () => ({
                in: async () => ({
                  data: opts.teamMembersError ? null : opts.teamMembers ?? [],
                  error: opts.teamMembersError ?? null,
                }),
              }),
            }),
          };
        }
        if (table === 'bookings') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: opts.booking ?? null,
                    error: opts.bookingError ?? null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'spaces') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: opts.space ?? null,
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'persons') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: opts.requester ?? null,
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'tenants') {
          // Locale resolution: single SELECT id, locale_default WHERE id =
          // tenantId. .eq().maybeSingle() chain.
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: opts.tenant ?? { id: TENANT_ID, locale_default: 'en' },
                  error: null,
                }),
              }),
            }),
          };
        }
        throw new Error('unexpected table: ' + table);
      }),
    },
  } as unknown as SupabaseService;

  const failOn = new Set(opts.failDispatchOn ?? []);
  const notifications = {
    dispatch: jest.fn(async (args: DispatchCallCapture) => {
      const idx = dispatchCalls.length + 1;
      dispatchCalls.push(args);
      if (failOn.has(idx)) {
        throw new Error('simulated_dispatch_failure_at_' + idx);
      }
      return {
        channelId: 'email' as const,
        externalId: 'rs_' + idx,
        delivered: true,
      };
    }),
  } as unknown as NotificationsService;

  const config = {
    get: jest.fn((key: string) => {
      if (key === 'FRONTEND_BASE_URL') return 'https://app.example.com';
      return undefined;
    }),
  } as unknown as ConfigService;

  return {
    supabase,
    notifications,
    config,
    dispatchCalls,
    fromTables,
  };
}

const FULL_BOOKING: BookingRow = {
  id: BOOKING_ID,
  tenant_id: TENANT_ID,
  title: 'Quarterly review',
  location_id: SPACE_ID,
  requester_person_id: APPROVER_A, // any person id; unused for matching
  start_at: '2026-05-13T09:00:00Z',
  end_at: '2026-05-13T10:30:00Z',
};
const FULL_SPACE: SpaceRow = { id: SPACE_ID, name: 'Boardroom 4' };
const FULL_REQUESTER: PersonRow = {
  id: APPROVER_A,
  first_name: 'Marleen',
  last_name: 'Visser',
};

const TENANT_INFO = {
  id: TENANT_ID,
  slug: 'acme',
  tier: 'standard' as const,
};

function withTenant<T>(fn: () => Promise<T>): Promise<T> {
  return TenantContext.run(TENANT_INFO, fn);
}

describe('BookingApprovalRequiredHandler.handle — B.4.A.5 sub-step D dispatch', () => {
  describe('happy paths', () => {
    it('1 person approver → 1 dispatch with enriched payload + en locale', async () => {
      const h = makeDispatchHarness({
        approvals: [
          {
            id: 'app1',
            status: 'pending',
            approver_person_id: APPROVER_A,
            approver_team_id: null,
          },
        ],
        personUsers: [{ id: USER_A, person_id: APPROVER_A, email: 'a@example.com' }],
        booking: FULL_BOOKING,
        space: FULL_SPACE,
        requester: FULL_REQUESTER,
      });
      const handler = new BookingApprovalRequiredHandler(
        h.supabase,
        h.notifications,
        h.config,
      );
      await withTenant(() =>
        handler.handle(
          makeEvent(
            {},
            { approver_person_ids: [APPROVER_A], approver_team_ids: [] },
          ),
        ),
      );

      expect(h.dispatchCalls).toHaveLength(1);
      const call = h.dispatchCalls[0];
      expect(call.userId).toBe(USER_A);
      expect(call.tenantId).toBe(TENANT_ID);
      expect(call.locale).toBe('en');
      expect(call.eventKind).toBe('booking.approval_required');
      expect(call.idempotencyKey).toBe(`${EVENT_ID}:${USER_A}`);
      expect(call.payload).toMatchObject({
        bookingId: BOOKING_ID,
        chainId: CHAIN_ID,
        bookingTitle: 'Quarterly review',
        requesterName: 'Marleen Visser',
        spaceName: 'Boardroom 4',
        startAt: '2026-05-13T09:00:00Z',
        endAt: '2026-05-13T10:30:00Z',
      });
      // Self-review I4: CTA falls back to /desk/bookings/<bookingId>?tab=
      // approval until /desk/approvals/<chainId> ships in approvals
      // Sprint 2.
      expect((call.payload as { approvalCtaUrl: string }).approvalCtaUrl).toBe(
        `https://app.example.com/desk/bookings/${encodeURIComponent(BOOKING_ID)}?tab=approval`,
      );
      expect(call.context).toEqual({
        entityType: 'booking',
        entityId: BOOKING_ID,
        tenantSlug: 'acme',
      });
    });

    it('team approver with N members → N dispatches', async () => {
      const h = makeDispatchHarness({
        approvals: [
          {
            id: 'app1',
            status: 'pending',
            approver_person_id: null,
            approver_team_id: TEAM_X,
          },
        ],
        teamMembers: [
          { user_id: USER_A, team_id: TEAM_X },
          { user_id: USER_B, team_id: TEAM_X },
          { user_id: USER_C, team_id: TEAM_X },
        ],
        teamUsers: [
          { id: USER_A, email: 'a@example.com' },
          { id: USER_B, email: 'b@example.com' },
          { id: USER_C, email: 'c@example.com' },
        ],
        booking: FULL_BOOKING,
        space: FULL_SPACE,
        requester: FULL_REQUESTER,
      });
      const handler = new BookingApprovalRequiredHandler(
        h.supabase,
        h.notifications,
        h.config,
      );
      await withTenant(() =>
        handler.handle(
          makeEvent(
            {},
            { approver_person_ids: [], approver_team_ids: [TEAM_X] },
          ),
        ),
      );

      expect(h.dispatchCalls).toHaveLength(3);
      const userIds = h.dispatchCalls.map((c) => c.userId).sort();
      expect(userIds).toEqual([USER_A, USER_B, USER_C].sort());
    });

    it('mixed person + team → union of users dispatched (deduped)', async () => {
      // USER_A appears on BOTH the person side and the team side; it must
      // be dispatched only ONCE.
      const h = makeDispatchHarness({
        approvals: [
          {
            id: 'app1',
            status: 'pending',
            approver_person_id: APPROVER_A,
            approver_team_id: null,
          },
          {
            id: 'app2',
            status: 'pending',
            approver_person_id: null,
            approver_team_id: TEAM_X,
          },
        ],
        personUsers: [{ id: USER_A, person_id: APPROVER_A, email: 'a@example.com' }],
        teamMembers: [
          { user_id: USER_A, team_id: TEAM_X },
          { user_id: USER_B, team_id: TEAM_X },
        ],
        teamUsers: [
          { id: USER_A, email: 'a@example.com' },
          { id: USER_B, email: 'b@example.com' },
        ],
        booking: FULL_BOOKING,
        space: FULL_SPACE,
        requester: FULL_REQUESTER,
      });
      const handler = new BookingApprovalRequiredHandler(
        h.supabase,
        h.notifications,
        h.config,
      );
      await withTenant(() =>
        handler.handle(
          makeEvent(
            {},
            {
              approver_person_ids: [APPROVER_A],
              approver_team_ids: [TEAM_X],
            },
          ),
        ),
      );

      expect(h.dispatchCalls).toHaveLength(2);
      const userIds = h.dispatchCalls.map((c) => c.userId).sort();
      expect(userIds).toEqual([USER_A, USER_B].sort());
    });
  });

  describe('no-op short-circuits (no dispatch)', () => {
    it('no-ops when chain is fully resolved (no pending rows)', async () => {
      const h = makeDispatchHarness({
        approvals: [
          {
            id: 'app1',
            status: 'approved',
            approver_person_id: APPROVER_A,
            approver_team_id: null,
          },
        ],
        personUsers: [{ id: USER_A, person_id: APPROVER_A, email: 'a@example.com' }],
        booking: FULL_BOOKING,
        space: FULL_SPACE,
        requester: FULL_REQUESTER,
      });
      const handler = new BookingApprovalRequiredHandler(
        h.supabase,
        h.notifications,
        h.config,
      );
      await withTenant(() => handler.handle(makeEvent()));
      expect(h.dispatchCalls).toHaveLength(0);
    });

    it('no-ops when chain rows are missing entirely', async () => {
      const h = makeDispatchHarness({
        approvals: [],
        booking: FULL_BOOKING,
        space: FULL_SPACE,
        requester: FULL_REQUESTER,
      });
      const handler = new BookingApprovalRequiredHandler(
        h.supabase,
        h.notifications,
        h.config,
      );
      await withTenant(() => handler.handle(makeEvent()));
      expect(h.dispatchCalls).toHaveLength(0);
    });

    it('no-ops when booking is hard-deleted between RPC + handler drain', async () => {
      const h = makeDispatchHarness({
        approvals: [
          {
            id: 'app1',
            status: 'pending',
            approver_person_id: APPROVER_A,
            approver_team_id: null,
          },
        ],
        personUsers: [{ id: USER_A, person_id: APPROVER_A, email: 'a@example.com' }],
        booking: null, // ← simulates hard-delete race
        space: FULL_SPACE,
        requester: FULL_REQUESTER,
      });
      const handler = new BookingApprovalRequiredHandler(
        h.supabase,
        h.notifications,
        h.config,
      );
      await withTenant(() =>
        handler.handle(
          makeEvent(
            {},
            { approver_person_ids: [APPROVER_A], approver_team_ids: [] },
          ),
        ),
      );
      expect(h.dispatchCalls).toHaveLength(0);
    });

    it('no-ops when no approver resolves to a user (e.g. external persons)', async () => {
      const h = makeDispatchHarness({
        approvals: [
          {
            id: 'app1',
            status: 'pending',
            approver_person_id: APPROVER_A,
            approver_team_id: null,
          },
        ],
        personUsers: [], // ← person has no users row
        booking: FULL_BOOKING,
        space: FULL_SPACE,
        requester: FULL_REQUESTER,
      });
      const handler = new BookingApprovalRequiredHandler(
        h.supabase,
        h.notifications,
        h.config,
      );
      await withTenant(() =>
        handler.handle(
          makeEvent(
            {},
            { approver_person_ids: [APPROVER_A], approver_team_ids: [] },
          ),
        ),
      );
      expect(h.dispatchCalls).toHaveLength(0);
    });
  });

  describe('partial resolution + per-user isolation', () => {
    it('person without users row is silently skipped; others still dispatched', async () => {
      // APPROVER_A resolves to USER_A; APPROVER_B does NOT resolve (no
      // users row). Expected: 1 dispatch for USER_A.
      const h = makeDispatchHarness({
        approvals: [
          {
            id: 'app1',
            status: 'pending',
            approver_person_id: APPROVER_A,
            approver_team_id: null,
          },
          {
            id: 'app2',
            status: 'pending',
            approver_person_id: APPROVER_B,
            approver_team_id: null,
          },
        ],
        personUsers: [{ id: USER_A, person_id: APPROVER_A, email: 'a@example.com' }],
        booking: FULL_BOOKING,
        space: FULL_SPACE,
        requester: FULL_REQUESTER,
      });
      const handler = new BookingApprovalRequiredHandler(
        h.supabase,
        h.notifications,
        h.config,
      );
      await withTenant(() =>
        handler.handle(
          makeEvent(
            {},
            {
              approver_person_ids: [APPROVER_A, APPROVER_B],
              approver_team_ids: [],
            },
          ),
        ),
      );
      expect(h.dispatchCalls).toHaveLength(1);
      expect(h.dispatchCalls[0].userId).toBe(USER_A);
    });

    it('per-user dispatch failure does not block other users', async () => {
      const h = makeDispatchHarness({
        approvals: [
          {
            id: 'app1',
            status: 'pending',
            approver_person_id: null,
            approver_team_id: TEAM_X,
          },
        ],
        teamMembers: [
          { user_id: USER_A, team_id: TEAM_X },
          { user_id: USER_B, team_id: TEAM_X },
          { user_id: USER_C, team_id: TEAM_X },
        ],
        teamUsers: [
          { id: USER_A, email: 'a@example.com' },
          { id: USER_B, email: 'b@example.com' },
          { id: USER_C, email: 'c@example.com' },
        ],
        booking: FULL_BOOKING,
        space: FULL_SPACE,
        requester: FULL_REQUESTER,
        failDispatchOn: [2], // ← second user's dispatch throws
      });
      const handler = new BookingApprovalRequiredHandler(
        h.supabase,
        h.notifications,
        h.config,
      );
      const warnSpy = jest
        .spyOn(
          (handler as unknown as { log: { warn: (msg: string) => void } }).log,
          'warn',
        )
        .mockImplementation(() => undefined);
      try {
        await expect(
          withTenant(() =>
            handler.handle(
              makeEvent(
                {},
                { approver_person_ids: [], approver_team_ids: [TEAM_X] },
              ),
            ),
          ),
        ).resolves.toBeUndefined();

        // All 3 dispatch calls were attempted (2nd threw, 1st + 3rd succeeded).
        expect(h.dispatchCalls).toHaveLength(3);
        // Warn fired for the failed user.
        const warnMessages = warnSpy.mock.calls
          .map((c) => c[0] as string)
          .filter((m) => m.includes('per_user_dispatch_failed'));
        expect(warnMessages).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('idempotency + locale + context', () => {
    it('idempotency key is `<event.id>:<userId>` for each dispatch', async () => {
      const h = makeDispatchHarness({
        approvals: [
          {
            id: 'app1',
            status: 'pending',
            approver_person_id: null,
            approver_team_id: TEAM_X,
          },
        ],
        teamMembers: [
          { user_id: USER_A, team_id: TEAM_X },
          { user_id: USER_B, team_id: TEAM_X },
        ],
        teamUsers: [
          { id: USER_A, email: 'a@example.com' },
          { id: USER_B, email: 'b@example.com' },
        ],
        booking: FULL_BOOKING,
        space: FULL_SPACE,
        requester: FULL_REQUESTER,
      });
      const handler = new BookingApprovalRequiredHandler(
        h.supabase,
        h.notifications,
        h.config,
      );
      await withTenant(() =>
        handler.handle(
          makeEvent(
            {},
            { approver_person_ids: [], approver_team_ids: [TEAM_X] },
          ),
        ),
      );
      const keys = h.dispatchCalls.map((c) => c.idempotencyKey).sort();
      expect(keys).toEqual(
        [`${EVENT_ID}:${USER_A}`, `${EVENT_ID}:${USER_B}`].sort(),
      );
    });

    it('locale defaults to "en" from tenants.locale_default', async () => {
      // Self-review C2/C3 + I2: per-user resolveUserLocale removed; locale
      // now comes from tenants.locale_default (single read per event).
      const h = makeDispatchHarness({
        approvals: [
          {
            id: 'app1',
            status: 'pending',
            approver_person_id: APPROVER_A,
            approver_team_id: null,
          },
        ],
        personUsers: [{ id: USER_A, person_id: APPROVER_A, email: 'a@example.com' }],
        booking: FULL_BOOKING,
        space: FULL_SPACE,
        requester: FULL_REQUESTER,
        tenant: { id: TENANT_ID, locale_default: 'en' },
      });
      const handler = new BookingApprovalRequiredHandler(
        h.supabase,
        h.notifications,
        h.config,
      );
      await withTenant(() =>
        handler.handle(
          makeEvent(
            {},
            { approver_person_ids: [APPROVER_A], approver_team_ids: [] },
          ),
        ),
      );
      expect(h.dispatchCalls).toHaveLength(1);
      expect(h.dispatchCalls[0].locale).toBe('en');
    });

    it('locale is "nl" when tenants.locale_default is "nl" (Benelux)', async () => {
      // Self-review I2: NL-primary tenants get NL emails. Memory:
      // project_market_benelux.md.
      const h = makeDispatchHarness({
        approvals: [
          {
            id: 'app1',
            status: 'pending',
            approver_person_id: null,
            approver_team_id: TEAM_X,
          },
        ],
        teamMembers: [
          { user_id: USER_A, team_id: TEAM_X },
          { user_id: USER_B, team_id: TEAM_X },
        ],
        teamUsers: [
          { id: USER_A, email: 'a@example.com' },
          { id: USER_B, email: 'b@example.com' },
        ],
        booking: FULL_BOOKING,
        space: FULL_SPACE,
        requester: FULL_REQUESTER,
        tenant: { id: TENANT_ID, locale_default: 'nl' },
      });
      const handler = new BookingApprovalRequiredHandler(
        h.supabase,
        h.notifications,
        h.config,
      );
      await withTenant(() =>
        handler.handle(
          makeEvent(
            {},
            { approver_person_ids: [], approver_team_ids: [TEAM_X] },
          ),
        ),
      );
      // Both dispatch calls share the tenant locale (single read, applied
      // to every approver — no per-user N+1).
      expect(h.dispatchCalls).toHaveLength(2);
      for (const call of h.dispatchCalls) {
        expect(call.locale).toBe('nl');
      }
    });

    it('tenantSlug is forwarded from TenantContext, empty string when unset', async () => {
      const h = makeDispatchHarness({
        approvals: [
          {
            id: 'app1',
            status: 'pending',
            approver_person_id: APPROVER_A,
            approver_team_id: null,
          },
        ],
        personUsers: [{ id: USER_A, person_id: APPROVER_A, email: 'a@example.com' }],
        booking: FULL_BOOKING,
        space: FULL_SPACE,
        requester: FULL_REQUESTER,
      });
      const handler = new BookingApprovalRequiredHandler(
        h.supabase,
        h.notifications,
        h.config,
      );
      // No TenantContext.run wrapper — handler must NOT throw, and must
      // pass an empty tenantSlug downstream (email channel ignores it).
      await handler.handle(
        makeEvent(
          {},
          { approver_person_ids: [APPROVER_A], approver_team_ids: [] },
        ),
      );
      expect(h.dispatchCalls).toHaveLength(1);
      expect(h.dispatchCalls[0].context.tenantSlug).toBe('');
    });
  });

  // ── Self-review CODE-I7: transient supabase read errors throw AppError so
  //    the outbox retry picks them up. Pre-fix, the harness exposed the
  //    knobs (approvalsError + bookingError) but NO test exercised them — a
  //    refactor that converted a throw to log+return would have passed
  //    silently.
  //    These tests also pin the new error code split (CODE-I5):
  //      - approvals re-read failure → approval.read_failed (NOT
  //        email.dispatch_failed)
  //      - users + team_members lookup failures → users.lookup_failed
  //      - booking enrichment failure → booking.read_failed
  describe('transient supabase read errors throw AppError (self-review I7)', () => {
    it('approvals re-read returns error → handler throws (outbox retries)', async () => {
      const h = makeDispatchHarness({
        approvals: null,
        approvalsError: { message: 'pgcode 57014: query timed out' },
        booking: FULL_BOOKING,
        space: FULL_SPACE,
        requester: FULL_REQUESTER,
      });
      const handler = new BookingApprovalRequiredHandler(
        h.supabase,
        h.notifications,
        h.config,
      );
      let captured: unknown;
      try {
        await withTenant(() => handler.handle(makeEvent()));
      } catch (e) {
        captured = e;
      }
      expect(captured).toBeDefined();
      // CODE-I5: dedicated approval.read_failed — NOT the generic
      // email.dispatch_failed blanket.
      expect((captured as { code?: string }).code).toBe('approval.read_failed');
      expect(h.dispatchCalls).toHaveLength(0);
    });

    it('person users lookup returns error → handler throws (outbox retries)', async () => {
      const h = makeDispatchHarness({
        approvals: [
          {
            id: 'app1',
            status: 'pending',
            approver_person_id: APPROVER_A,
            approver_team_id: null,
          },
        ],
        personUsersError: { message: 'pgcode 53300: too many connections' },
        booking: FULL_BOOKING,
        space: FULL_SPACE,
        requester: FULL_REQUESTER,
      });
      const handler = new BookingApprovalRequiredHandler(
        h.supabase,
        h.notifications,
        h.config,
      );
      let captured: unknown;
      try {
        await withTenant(() =>
          handler.handle(
            makeEvent(
              {},
              { approver_person_ids: [APPROVER_A], approver_team_ids: [] },
            ),
          ),
        );
      } catch (e) {
        captured = e;
      }
      expect(captured).toBeDefined();
      expect((captured as { code?: string }).code).toBe('users.lookup_failed');
      expect(h.dispatchCalls).toHaveLength(0);
    });

    it('team_members lookup returns error → handler throws (outbox retries)', async () => {
      const h = makeDispatchHarness({
        approvals: [
          {
            id: 'app1',
            status: 'pending',
            approver_person_id: null,
            approver_team_id: TEAM_X,
          },
        ],
        teamMembersError: { message: 'pgcode 57014: query timed out' },
        booking: FULL_BOOKING,
        space: FULL_SPACE,
        requester: FULL_REQUESTER,
      });
      const handler = new BookingApprovalRequiredHandler(
        h.supabase,
        h.notifications,
        h.config,
      );
      let captured: unknown;
      try {
        await withTenant(() =>
          handler.handle(
            makeEvent(
              {},
              { approver_person_ids: [], approver_team_ids: [TEAM_X] },
            ),
          ),
        );
      } catch (e) {
        captured = e;
      }
      expect(captured).toBeDefined();
      expect((captured as { code?: string }).code).toBe('users.lookup_failed');
      expect(h.dispatchCalls).toHaveLength(0);
    });

    it('booking enrichment returns error → handler throws (outbox retries)', async () => {
      const h = makeDispatchHarness({
        approvals: [
          {
            id: 'app1',
            status: 'pending',
            approver_person_id: APPROVER_A,
            approver_team_id: null,
          },
        ],
        personUsers: [{ id: USER_A, person_id: APPROVER_A, email: 'a@example.com' }],
        booking: null,
        bookingError: { message: 'pgcode 53300: too many connections' },
        space: FULL_SPACE,
        requester: FULL_REQUESTER,
      });
      const handler = new BookingApprovalRequiredHandler(
        h.supabase,
        h.notifications,
        h.config,
      );
      let captured: unknown;
      try {
        await withTenant(() =>
          handler.handle(
            makeEvent(
              {},
              { approver_person_ids: [APPROVER_A], approver_team_ids: [] },
            ),
          ),
        );
      } catch (e) {
        captured = e;
      }
      expect(captured).toBeDefined();
      // CODE-I5: dedicated booking.read_failed (was email.dispatch_failed).
      expect((captured as { code?: string }).code).toBe('booking.read_failed');
      expect(h.dispatchCalls).toHaveLength(0);
    });
  });
});
