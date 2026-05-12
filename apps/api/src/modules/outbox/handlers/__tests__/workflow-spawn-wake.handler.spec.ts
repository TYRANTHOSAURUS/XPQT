import {
  WorkflowSpawnWakeCore,
  WorkflowSpawnWakeOnBookingCancelledHandler,
  WorkflowSpawnWakeOnBookingCreatedHandler,
  WorkflowSpawnWakeOnBookingStatusChangedHandler,
  type BookingLifecyclePayload,
} from '../workflow-spawn-wake.handler';
import { DeadLetterError } from '../../dead-letter.error';
import { BookingLifecycleEventType } from '../../../reservations/event-types';
import type { WorkflowEngineService } from '../../../workflow/workflow-engine.service';
import type { OutboxEvent } from '../../outbox.types';

/**
 * Universal Workflow Architecture Phase 1.A — WorkflowSpawnWake* handler tests.
 *
 * Spec: docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md
 *       §3.5 (Resume mechanism — Tier 2 LOCKED v2.2).
 *
 * Producers under test:
 *   - 00372_create_booking_emit_lifecycle.sql       → booking.created
 *   - 00373_delete_booking_emit_cancelled.sql       → booking.cancelled
 *   - (Phase 2)                                       → booking.status_changed
 *
 * Coverage matrix:
 *   1. Tenant smuggling defense (event vs payload mismatch).
 *   2. UUID validation (malformed booking_id terminal dead-letter).
 *   3. Zero waiting rows (no-op path; log + return).
 *   4. One waiting row claimed (atomic claim succeeds, resume called once).
 *   5. Two concurrent invocations (only one wins atomic claim).
 *   6. Cross-tenant link defense-in-depth (parent.tenant_id mismatch).
 *   7. All three event types resolve through the shared core (per-event
 *      shells delegate; branch label differs per event).
 *   8. Wait-condition gating:
 *        a. workflow_terminal links are NOT claimed (filtered in SELECT).
 *        b. entity_terminal_statuses membership mismatch → not claimed.
 *        c. expired wait_timeout_at → not claimed (left for Tier 1 cron).
 *        d. aggregation_group_id IS NOT NULL → not claimed (deferred).
 *   9. Per-row claim rollback on resume failure (unclaim → null).
 */

const TENANT_ID = 'e1111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = 'e9999999-9999-4999-8999-999999999999';
const EVENT_ID = 'e2222222-2222-4222-8222-222222222222';
const BOOKING_ID = 'e3333333-3333-4333-8333-333333333333';
const PARENT_INSTANCE_ID = 'e4444444-4444-4444-8444-444444444444';
const PARENT_INSTANCE_ID_B = 'e5555555-5555-4555-8555-555555555555';
const LINK_ID = 'e6666666-6666-4666-8666-666666666666';
const LINK_ID_B = 'e7777777-7777-4777-8777-777777777777';

function makeEvent(
  eventType: string,
  overrides: Partial<OutboxEvent<BookingLifecyclePayload>> = {},
  payloadOverrides: Partial<BookingLifecyclePayload> = {},
): OutboxEvent<BookingLifecyclePayload> {
  return {
    id: EVENT_ID,
    tenant_id: TENANT_ID,
    event_type: eventType,
    event_version: 1,
    aggregate_type: 'booking',
    aggregate_id: BOOKING_ID,
    payload: {
      tenant_id: TENANT_ID,
      booking_id: BOOKING_ID,
      started_at: '2026-05-12T09:00:00Z',
      ...payloadOverrides,
    },
    payload_hash: 'hash',
    idempotency_key: `${eventType}:${BOOKING_ID}:test`,
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

interface CandidateRow {
  id: string;
  parent_instance_id: string;
  parent_node_id: string;
  on_timeout_branch: string | null;
  wait_for: 'workflow_terminal' | 'entity_status' | 'either' | null;
  entity_terminal_statuses: string[] | null;
  wait_timeout_at: string | null;
}

interface StoredLinkRow extends CandidateRow {
  tenant_id: string;
  child_entity_id: string;
  spawn_mode: 'continue' | 'wait';
  aggregation_group_id: string | null;
  resolved_at: string | null;
  resolution_kind: string | null;
}

interface ParentInstanceRow {
  id: string;
  tenant_id: string;
}

interface FakeSupabaseOpts {
  /**
   * Full rows present in `workflow_instance_links`. The fake applies the
   * filter chain (eq/is/in) against these rows; whatever passes the
   * filters is what the handler sees on SELECT and what's eligible for
   * per-row UPDATE claim.
   */
  links?: StoredLinkRow[];
  /**
   * Map of parent_instance_id → row returned from workflow_instances SELECT.
   * If a parent_instance_id is not present, the SELECT returns null (parent
   * deleted between claim + read).
   */
  parents?: Record<string, ParentInstanceRow | null>;
  /** If set, every SELECT against workflow_instance_links returns this error. */
  candidatesError?: { message: string };
  /** If set, the per-row UPDATE (claim) against workflow_instance_links returns this error. */
  claimError?: { message: string };
  /** If set, the per-row UPDATE (unclaim) against workflow_instance_links returns this error. */
  unclaimError?: { message: string };
}

interface CapturedCalls {
  fromTables: string[];
  /** SELECT filter snapshots (per call). */
  selectFilters: Array<Record<string, unknown>>;
  /** UPDATE payload + filter snapshots (per call). */
  updates: Array<{ payload: Record<string, unknown>; filters: Record<string, unknown> }>;
  parentReadIds: string[];
}

/**
 * Fake supabase that supports both the candidate SELECT and the per-row
 * claim/unclaim UPDATEs against `workflow_instance_links`, plus the
 * parent SELECT against `workflow_instances`.
 *
 * The link rows are stored as a mutable in-memory table; each UPDATE
 * mutates the matching rows so subsequent SELECTs/UPDATEs see the new
 * `resolved_at` value (this is what makes the "concurrent worker can't
 * double-claim" + "rollback on resume failure" semantics observable from
 * tests).
 */
function makeSupabase(opts: FakeSupabaseOpts) {
  const captured: CapturedCalls = {
    fromTables: [],
    selectFilters: [],
    updates: [],
    parentReadIds: [],
  };

  const linkStore: StoredLinkRow[] = [...(opts.links ?? [])];

  function matchesFilters(row: StoredLinkRow, filters: Record<string, unknown>): boolean {
    for (const [key, val] of Object.entries(filters)) {
      if (key.endsWith('__is')) {
        const col = key.slice(0, -'__is'.length) as keyof StoredLinkRow;
        if (row[col] !== val) return false;
        continue;
      }
      if (key.endsWith('__in')) {
        const col = key.slice(0, -'__in'.length) as keyof StoredLinkRow;
        const allowed = val as unknown[];
        if (!allowed.includes(row[col] as unknown)) return false;
        continue;
      }
      const col = key as keyof StoredLinkRow;
      if (row[col] !== val) return false;
    }
    return true;
  }

  const from = jest.fn((table: string) => {
    captured.fromTables.push(table);

    if (table === 'workflow_instance_links') {
      function buildSelectChain(initialFilters: Record<string, unknown> = {}) {
        const filters = { ...initialFilters };
        const chain: {
          eq: (col: string, val: unknown) => typeof chain;
          is: (col: string, val: unknown) => typeof chain;
          in: (col: string, val: unknown[]) => typeof chain;
          then: (
            onfulfilled?: (value: { data: unknown; error: unknown }) => unknown,
            onrejected?: (reason: unknown) => unknown,
          ) => Promise<unknown>;
        } = {
          eq(col: string, val: unknown) {
            filters[col] = val;
            return chain;
          },
          is(col: string, val: unknown) {
            filters[`${col}__is`] = val;
            return chain;
          },
          in(col: string, val: unknown[]) {
            filters[`${col}__in`] = val;
            return chain;
          },
          // The handler does `.select(...)` and then awaits the builder;
          // expose a `then` so `await` on the chain resolves directly.
          then(
            onfulfilled?: (value: { data: unknown; error: unknown }) => unknown,
            onrejected?: (reason: unknown) => unknown,
          ) {
            captured.selectFilters.push(filters);
            if (opts.candidatesError) {
              return Promise.resolve(
                onfulfilled?.({ data: null, error: opts.candidatesError }) ?? null,
              );
            }
            const matched = linkStore.filter((row) => matchesFilters(row, filters));
            const projected: CandidateRow[] = matched.map((row) => ({
              id: row.id,
              parent_instance_id: row.parent_instance_id,
              parent_node_id: row.parent_node_id,
              on_timeout_branch: row.on_timeout_branch,
              wait_for: row.wait_for,
              entity_terminal_statuses: row.entity_terminal_statuses,
              wait_timeout_at: row.wait_timeout_at,
            }));
            return Promise.resolve(
              onfulfilled?.({ data: projected, error: null }) ?? null,
            ).catch(onrejected as never);
          },
        };
        return chain;
      }

      return {
        // SELECT — used for the candidate fetch.
        select: (_cols: string) => buildSelectChain(),
        // UPDATE — used for both the per-row atomic claim AND the unclaim.
        update: (payload: Record<string, unknown>) => {
          const filters: Record<string, unknown> = {};

          const updateChain: {
            eq: (col: string, val: unknown) => typeof updateChain;
            is: (col: string, val: unknown) => typeof updateChain;
            select: (_cols: string) => Promise<{ data: unknown; error: unknown }>;
            then: (
              onfulfilled?: (value: { data: unknown; error: unknown }) => unknown,
              onrejected?: (reason: unknown) => unknown,
            ) => Promise<unknown>;
          } = {
            eq(col: string, val: unknown) {
              filters[col] = val;
              return updateChain;
            },
            is(col: string, val: unknown) {
              filters[`${col}__is`] = val;
              return updateChain;
            },
            // Claim path: `.update(...).eq(...).is(...).select('id')`.
            async select(_cols: string) {
              captured.updates.push({ payload, filters });
              if (opts.claimError) {
                return { data: null, error: opts.claimError };
              }
              const updated: Array<Pick<StoredLinkRow, 'id'>> = [];
              for (const row of linkStore) {
                if (matchesFilters(row, filters)) {
                  Object.assign(row, payload);
                  updated.push({ id: row.id });
                }
              }
              return { data: updated, error: null };
            },
            // Unclaim path: `.update({ resolved_at: null, resolution_kind: null }).eq('id', X)`
            // — no `.select`, just awaited as a no-data UPDATE.
            then(
              onfulfilled?: (value: { data: unknown; error: unknown }) => unknown,
              onrejected?: (reason: unknown) => unknown,
            ) {
              captured.updates.push({ payload, filters });
              if (opts.unclaimError) {
                return Promise.resolve(
                  onfulfilled?.({ data: null, error: opts.unclaimError }) ?? null,
                );
              }
              for (const row of linkStore) {
                if (matchesFilters(row, filters)) {
                  Object.assign(row, payload);
                }
              }
              return Promise.resolve(
                onfulfilled?.({ data: null, error: null }) ?? null,
              ).catch(onrejected as never);
            },
          };
          return updateChain;
        },
      };
    }

    if (table === 'workflow_instances') {
      return {
        select: () => ({
          eq: (_col: string, val: string) => {
            captured.parentReadIds.push(val);
            return {
              maybeSingle: async () => {
                const row = opts.parents?.[val];
                if (row === null) return { data: null, error: null };
                if (row === undefined) return { data: null, error: null };
                return { data: row, error: null };
              },
            };
          },
        }),
      };
    }

    throw new Error('unexpected table: ' + table);
  });

  return {
    captured,
    linkStore,
    service: { admin: { from } } as never,
  };
}

interface FakeEngineOpts {
  resumeError?: string;
  resumeErrorOnInstanceId?: string;
}

function makeWorkflowEngine(opts: FakeEngineOpts = {}): WorkflowEngineService {
  return {
    resume: jest.fn(async (instanceId: string) => {
      if (opts.resumeErrorOnInstanceId && instanceId === opts.resumeErrorOnInstanceId) {
        throw new Error(opts.resumeError ?? 'resume_failed');
      }
      if (opts.resumeError && !opts.resumeErrorOnInstanceId) {
        throw new Error(opts.resumeError);
      }
      return undefined;
    }),
  } as unknown as WorkflowEngineService;
}

function makeStoredLink(overrides: Partial<StoredLinkRow> = {}): StoredLinkRow {
  return {
    id: LINK_ID,
    tenant_id: TENANT_ID,
    child_entity_id: BOOKING_ID,
    parent_instance_id: PARENT_INSTANCE_ID,
    parent_node_id: 'spawn-node-1',
    spawn_mode: 'wait',
    wait_for: 'entity_status',
    entity_terminal_statuses: ['confirmed', 'cancelled'],
    wait_timeout_at: null,
    aggregation_group_id: null,
    on_timeout_branch: null,
    resolved_at: null,
    resolution_kind: null,
    ...overrides,
  };
}

describe('WorkflowSpawnWake* handlers (Universal Workflow Architecture Phase 1.A)', () => {
  describe('tenant smuggling defense (all 3 event types)', () => {
    it.each([
      [BookingLifecycleEventType.Created, WorkflowSpawnWakeOnBookingCreatedHandler],
      [BookingLifecycleEventType.Cancelled, WorkflowSpawnWakeOnBookingCancelledHandler],
      [
        BookingLifecycleEventType.StatusChanged,
        WorkflowSpawnWakeOnBookingStatusChangedHandler,
      ],
    ] as const)(
      '%s — dead-letters when payload.tenant_id != event.tenant_id',
      async (eventType, HandlerCtor) => {
        const supabase = makeSupabase({});
        const engine = makeWorkflowEngine();
        const core = new WorkflowSpawnWakeCore(supabase.service, engine);
        const handler = new HandlerCtor(core);
        const event = makeEvent(eventType, {}, { tenant_id: OTHER_TENANT_ID });
        await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
        // No DB touched before the tenant gate fires.
        expect(supabase.captured.fromTables).toHaveLength(0);
        expect(engine.resume).not.toHaveBeenCalled();
      },
    );
  });

  describe('UUID validation', () => {
    it('dead-letters when booking_id is not a uuid', async () => {
      const supabase = makeSupabase({});
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCreatedHandler(core);
      const event = makeEvent(
        BookingLifecycleEventType.Created,
        {},
        { booking_id: 'not-a-uuid' },
      );
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
      expect(supabase.captured.fromTables).toHaveLength(0);
      expect(engine.resume).not.toHaveBeenCalled();
    });

    it('dead-letters when booking_id is missing (undefined)', async () => {
      const supabase = makeSupabase({});
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCancelledHandler(core);
      const event = makeEvent(
        BookingLifecycleEventType.Cancelled,
        {},
        { booking_id: undefined as unknown as string },
      );
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });
  });

  describe('zero waiting rows (no-op path)', () => {
    it('returns void without calling resume', async () => {
      const supabase = makeSupabase({ links: [] });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCreatedHandler(core);
      await expect(handler.handle(makeEvent(BookingLifecycleEventType.Created)))
        .resolves.toBeUndefined();
      expect(supabase.captured.fromTables).toEqual(['workflow_instance_links']);
      expect(engine.resume).not.toHaveBeenCalled();
    });

    it('passes the full WHERE filters: tenant_id, child_entity_id, spawn_mode, resolved_at, aggregation_group_id, wait_for', async () => {
      const supabase = makeSupabase({ links: [] });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCancelledHandler(core);
      await handler.handle(makeEvent(BookingLifecycleEventType.Cancelled));
      expect(supabase.captured.selectFilters).toHaveLength(1);
      const f = supabase.captured.selectFilters[0];
      expect(f.tenant_id).toBe(TENANT_ID);
      expect(f.child_entity_id).toBe(BOOKING_ID);
      expect(f.spawn_mode).toBe('wait');
      expect(f.resolved_at__is).toBeNull();
      expect(f.aggregation_group_id__is).toBeNull();
      expect(f.wait_for__in).toEqual(['entity_status', 'either']);
    });
  });

  describe('one waiting row claimed', () => {
    it('Cancelled event resumes parent on `cancelled` branch', async () => {
      const supabase = makeSupabase({
        links: [makeStoredLink()],
        parents: { [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID } },
      });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCancelledHandler(core);
      await expect(handler.handle(makeEvent(BookingLifecycleEventType.Cancelled)))
        .resolves.toBeUndefined();
      expect(engine.resume).toHaveBeenCalledTimes(1);
      expect(engine.resume).toHaveBeenCalledWith(PARENT_INSTANCE_ID, TENANT_ID, 'cancelled');
      // Link is in claimed state.
      expect(supabase.linkStore[0].resolved_at).not.toBeNull();
      expect(supabase.linkStore[0].resolution_kind).toBe('condition_met');
    });

    it('Created event resumes parent on `created` branch (when entity_terminal_statuses includes "created")', async () => {
      const supabase = makeSupabase({
        links: [makeStoredLink({ entity_terminal_statuses: ['created'] })],
        parents: { [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID } },
      });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCreatedHandler(core);
      await handler.handle(makeEvent(BookingLifecycleEventType.Created));
      expect(engine.resume).toHaveBeenCalledWith(PARENT_INSTANCE_ID, TENANT_ID, 'created');
    });

    it('StatusChanged event resumes parent on the new status branch when status is in entity_terminal_statuses', async () => {
      const supabase = makeSupabase({
        links: [
          makeStoredLink({ entity_terminal_statuses: ['confirmed', 'cancelled'] }),
        ],
        parents: { [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID } },
      });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingStatusChangedHandler(core);
      await handler.handle(
        makeEvent(
          BookingLifecycleEventType.StatusChanged,
          {},
          { from_status: 'pending_approval', to_status: 'confirmed' },
        ),
      );
      expect(engine.resume).toHaveBeenCalledWith(PARENT_INSTANCE_ID, TENANT_ID, 'confirmed');
    });
  });

  describe('wait-condition gating', () => {
    it('workflow_terminal links are filtered out at the SELECT (not claimed)', async () => {
      const supabase = makeSupabase({
        links: [makeStoredLink({ wait_for: 'workflow_terminal' })],
        parents: { [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID } },
      });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCancelledHandler(core);
      await expect(handler.handle(makeEvent(BookingLifecycleEventType.Cancelled)))
        .resolves.toBeUndefined();
      expect(engine.resume).not.toHaveBeenCalled();
      // Link should still be unresolved — the SELECT filter excludes it
      // and no UPDATE fires.
      expect(supabase.linkStore[0].resolved_at).toBeNull();
    });

    it('status not in entity_terminal_statuses → not claimed', async () => {
      // StatusChanged event with to_status='released' but link only
      // allows ['confirmed'] — must not resume.
      const supabase = makeSupabase({
        links: [makeStoredLink({ entity_terminal_statuses: ['confirmed'] })],
        parents: { [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID } },
      });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingStatusChangedHandler(core);
      await handler.handle(
        makeEvent(
          BookingLifecycleEventType.StatusChanged,
          {},
          { from_status: 'confirmed', to_status: 'released' },
        ),
      );
      expect(engine.resume).not.toHaveBeenCalled();
      expect(supabase.linkStore[0].resolved_at).toBeNull();
    });

    it('Created event with entity_terminal_statuses NOT containing "created" → not claimed', async () => {
      // Parent waits for ['confirmed'] (status change), Created event
      // arrives — must not resume on `created` branch.
      const supabase = makeSupabase({
        links: [makeStoredLink({ entity_terminal_statuses: ['confirmed'] })],
        parents: { [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID } },
      });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCreatedHandler(core);
      await handler.handle(makeEvent(BookingLifecycleEventType.Created));
      expect(engine.resume).not.toHaveBeenCalled();
      expect(supabase.linkStore[0].resolved_at).toBeNull();
    });

    it('Cancelled event with entity_terminal_statuses NOT containing "cancelled" → not claimed', async () => {
      // Parent waits for ['confirmed'] only. Cancelled event arrives;
      // the parent's wait config explicitly excludes the 'cancelled'
      // outcome — leave the row for the engine's terminal hook or for
      // ops to triage. Tier 2 wake must not synthesize a resume here.
      const supabase = makeSupabase({
        links: [makeStoredLink({ entity_terminal_statuses: ['confirmed'] })],
        parents: { [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID } },
      });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCancelledHandler(core);
      await handler.handle(makeEvent(BookingLifecycleEventType.Cancelled));
      expect(engine.resume).not.toHaveBeenCalled();
      expect(supabase.linkStore[0].resolved_at).toBeNull();
    });

    it('expired wait_timeout_at → not claimed (left for Tier 1 cron)', async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const supabase = makeSupabase({
        links: [makeStoredLink({ wait_timeout_at: yesterday })],
        parents: { [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID } },
      });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCancelledHandler(core);
      await handler.handle(makeEvent(BookingLifecycleEventType.Cancelled));
      expect(engine.resume).not.toHaveBeenCalled();
      // Row stays unclaimed for the Tier 1 sweeper.
      expect(supabase.linkStore[0].resolved_at).toBeNull();
    });

    it('future wait_timeout_at → still claimed (within wait window)', async () => {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const supabase = makeSupabase({
        links: [makeStoredLink({ wait_timeout_at: tomorrow })],
        parents: { [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID } },
      });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCancelledHandler(core);
      await handler.handle(makeEvent(BookingLifecycleEventType.Cancelled));
      expect(engine.resume).toHaveBeenCalledWith(PARENT_INSTANCE_ID, TENANT_ID, 'cancelled');
      expect(supabase.linkStore[0].resolved_at).not.toBeNull();
    });

    it('aggregation_group_id IS NOT NULL → not claimed (multi-spawn deferred)', async () => {
      const supabase = makeSupabase({
        links: [
          makeStoredLink({
            aggregation_group_id: 'a8888888-8888-4888-8888-888888888888',
          }),
        ],
        parents: { [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID } },
      });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCancelledHandler(core);
      await handler.handle(makeEvent(BookingLifecycleEventType.Cancelled));
      expect(engine.resume).not.toHaveBeenCalled();
      expect(supabase.linkStore[0].resolved_at).toBeNull();
    });

    it('wait_for=either + matching entity_terminal_statuses → claimed', async () => {
      const supabase = makeSupabase({
        links: [
          makeStoredLink({
            wait_for: 'either',
            entity_terminal_statuses: ['cancelled', 'confirmed'],
          }),
        ],
        parents: { [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID } },
      });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCancelledHandler(core);
      await handler.handle(makeEvent(BookingLifecycleEventType.Cancelled));
      expect(engine.resume).toHaveBeenCalledTimes(1);
      expect(engine.resume).toHaveBeenCalledWith(PARENT_INSTANCE_ID, TENANT_ID, 'cancelled');
    });
  });

  describe('two concurrent handler invocations', () => {
    it('first invocation claims; second sees zero rows (no double-resume)', async () => {
      const supabase = makeSupabase({
        links: [makeStoredLink()],
        parents: { [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID } },
      });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handlerA = new WorkflowSpawnWakeOnBookingCancelledHandler(core);
      const handlerB = new WorkflowSpawnWakeOnBookingCancelledHandler(core);

      await handlerA.handle(makeEvent(BookingLifecycleEventType.Cancelled));
      expect(engine.resume).toHaveBeenCalledTimes(1);

      // Second invocation — link is already resolved, so the SELECT
      // returns 0 rows (resolved_at IS NOT NULL filter excludes it).
      await handlerB.handle(makeEvent(BookingLifecycleEventType.Cancelled));
      expect(engine.resume).toHaveBeenCalledTimes(1);
    });

    it('multiple waiting parents on the same booking — all claimed (per-row), all resumed', async () => {
      const supabase = makeSupabase({
        links: [
          makeStoredLink({ id: LINK_ID, parent_instance_id: PARENT_INSTANCE_ID }),
          makeStoredLink({ id: LINK_ID_B, parent_instance_id: PARENT_INSTANCE_ID_B }),
        ],
        parents: {
          [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID },
          [PARENT_INSTANCE_ID_B]: { id: PARENT_INSTANCE_ID_B, tenant_id: TENANT_ID },
        },
      });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCancelledHandler(core);
      await handler.handle(makeEvent(BookingLifecycleEventType.Cancelled));
      expect(engine.resume).toHaveBeenCalledTimes(2);
      expect(engine.resume).toHaveBeenCalledWith(PARENT_INSTANCE_ID, TENANT_ID, 'cancelled');
      expect(engine.resume).toHaveBeenCalledWith(PARENT_INSTANCE_ID_B, TENANT_ID, 'cancelled');
    });
  });

  describe('cross-tenant link defense-in-depth', () => {
    it('dead-letters when parent workflow_instance.tenant_id != event.tenant_id', async () => {
      // Should be impossible per the link table's INSERT trigger (00370:205-228),
      // but defended anyway because the handler runs RLS-bypassed.
      const supabase = makeSupabase({
        links: [makeStoredLink()],
        parents: {
          [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: OTHER_TENANT_ID },
        },
      });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCancelledHandler(core);
      await expect(handler.handle(makeEvent(BookingLifecycleEventType.Cancelled)))
        .rejects.toBeInstanceOf(DeadLetterError);
      expect(engine.resume).not.toHaveBeenCalled();
    });

    it('skips (warn) when parent_instance is missing (deleted between claim + read)', async () => {
      const supabase = makeSupabase({
        links: [makeStoredLink()],
        parents: { [PARENT_INSTANCE_ID]: null },
      });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCancelledHandler(core);
      await expect(handler.handle(makeEvent(BookingLifecycleEventType.Cancelled)))
        .resolves.toBeUndefined();
      expect(engine.resume).not.toHaveBeenCalled();
    });
  });

  describe('per-row claim rollback on resume failure', () => {
    it('rolls resolved_at back to NULL when resume() throws transient', async () => {
      const supabase = makeSupabase({
        links: [makeStoredLink()],
        parents: { [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID } },
      });
      const engine = makeWorkflowEngine({
        resumeError: 'engine_wobble',
        resumeErrorOnInstanceId: PARENT_INSTANCE_ID,
      });
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCancelledHandler(core);

      let captured: unknown = null;
      try {
        await handler.handle(makeEvent(BookingLifecycleEventType.Cancelled));
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(Error);
      expect(captured).not.toBeInstanceOf(DeadLetterError);
      expect((captured as Error).message).toMatch(/partial_failure/);

      // The unclaim ran: row's resolved_at is null again, so a retry can
      // re-claim it. This is the critical post-condition.
      expect(supabase.linkStore[0].resolved_at).toBeNull();
      expect(supabase.linkStore[0].resolution_kind).toBeNull();
    });

    it('continues to siblings on resume() failure; failed row is unclaimed, succeeded row stays claimed', async () => {
      const supabase = makeSupabase({
        links: [
          makeStoredLink({ id: LINK_ID, parent_instance_id: PARENT_INSTANCE_ID }),
          makeStoredLink({ id: LINK_ID_B, parent_instance_id: PARENT_INSTANCE_ID_B }),
        ],
        parents: {
          [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID },
          [PARENT_INSTANCE_ID_B]: { id: PARENT_INSTANCE_ID_B, tenant_id: TENANT_ID },
        },
      });
      const engine = makeWorkflowEngine({
        resumeError: 'engine_wobble',
        resumeErrorOnInstanceId: PARENT_INSTANCE_ID,
      });
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCancelledHandler(core);

      let captured: unknown = null;
      try {
        await handler.handle(makeEvent(BookingLifecycleEventType.Cancelled));
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(Error);
      expect((captured as Error).message).toMatch(/partial_failure/);
      expect(engine.resume).toHaveBeenCalledTimes(2);

      const linkA = supabase.linkStore.find((r) => r.id === LINK_ID)!;
      const linkB = supabase.linkStore.find((r) => r.id === LINK_ID_B)!;
      // Failed link rolled back; succeeded link stays claimed.
      expect(linkA.resolved_at).toBeNull();
      expect(linkA.resolution_kind).toBeNull();
      expect(linkB.resolved_at).not.toBeNull();
      expect(linkB.resolution_kind).toBe('condition_met');
    });

    it('unclaim failure escalates to DeadLetterError (stranded link)', async () => {
      const supabase = makeSupabase({
        links: [makeStoredLink()],
        parents: { [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID } },
        unclaimError: { message: 'unclaim driver wobble' },
      });
      const engine = makeWorkflowEngine({
        resumeError: 'engine_wobble',
        resumeErrorOnInstanceId: PARENT_INSTANCE_ID,
      });
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCancelledHandler(core);

      await expect(handler.handle(makeEvent(BookingLifecycleEventType.Cancelled)))
        .rejects.toBeInstanceOf(DeadLetterError);
    });
  });

  describe('claim driver wobble → transient', () => {
    it('throws non-DeadLetter when the supabase candidate SELECT returns an error', async () => {
      const supabase = makeSupabase({
        candidatesError: { message: 'connection wobble' },
      });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCreatedHandler(core);
      let captured: unknown = null;
      try {
        await handler.handle(makeEvent(BookingLifecycleEventType.Created));
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(Error);
      expect(captured).not.toBeInstanceOf(DeadLetterError);
      expect((captured as Error).message).toMatch(/connection wobble/);
      expect(engine.resume).not.toHaveBeenCalled();
    });

    it('throws non-DeadLetter when the per-row claim UPDATE returns an error', async () => {
      // entity_terminal_statuses must include 'cancelled' so the
      // candidate survives isWaitMatch and we actually exercise the
      // claim UPDATE path (where the configured claimError fires).
      const supabase = makeSupabase({
        links: [makeStoredLink({ entity_terminal_statuses: ['cancelled'] })],
        parents: { [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID } },
        claimError: { message: 'claim driver wobble' },
      });
      const engine = makeWorkflowEngine();
      const core = new WorkflowSpawnWakeCore(supabase.service, engine);
      const handler = new WorkflowSpawnWakeOnBookingCancelledHandler(core);
      let captured: unknown = null;
      try {
        await handler.handle(makeEvent(BookingLifecycleEventType.Cancelled));
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(Error);
      expect(captured).not.toBeInstanceOf(DeadLetterError);
      expect((captured as Error).message).toMatch(/partial_failure|claim driver wobble/);
      expect(engine.resume).not.toHaveBeenCalled();
    });
  });
});
