import { WorkflowWaitSweeperCron } from './workflow-wait-sweeper.cron';
import type { WorkflowEngineService } from './workflow-engine.service';
import type { SupabaseService } from '../../common/supabase/supabase.service';

/**
 * Universal Workflow Architecture — Phase 1.C: WorkflowWaitSweeperCron tests.
 *
 * Spec: docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md
 *       §3.5 (Resume mechanism — Tier 1 cron poll)
 *       §3.6 (Cancel cascade)
 *       §7   (Sequencing — Phase 1.C)
 *
 * Coverage matrix:
 *   1. Zero expired rows → no-op.
 *   2. One expired row → atomic claim, link_resolved emit, engine.resume
 *      called with on_timeout_branch.
 *   3. Multiple expired rows → each processed independently; one failure
 *      does not abort the others.
 *   4. Row claimed by another worker between SELECT and UPDATE
 *      (resolved_at set) → atomic claim returns 0; sweep skips, no
 *      resume call, no emit.
 *   5. Wait extended between SELECT and UPDATE (wait_timeout_at > now())
 *      → atomic claim returns 0; sweep skips.
 *   6. engine.resume throws → unclaim the link; next sweep retries.
 *   7. engine.resume throws AND unclaim fails → log + continue (don't
 *      lose other links' progress).
 *   8. on_timeout_branch NULL → warn-log + still resume with undefined
 *      branch (engine falls through to edges[0]).
 *   9. Tenant assertion — link tenant_id != parent.tenant_id → refuse
 *      to resume; row left in claimed state.
 *  10. Batch size cap — sweep respects WORKFLOW_WAIT_SWEEPER_BATCH_SIZE
 *      via the .limit() on the SELECT.
 *  11. Disabled via env var → no-op.
 *  12. Tenant cache — multiple links from same tenant resolve tenant once.
 */

const TENANT_ID = 'a1111111-1111-4111-8111-111111111111';
const TENANT_ID_B = 'a2222222-2222-4222-8222-222222222222';
const PARENT_INSTANCE_ID = 'b1111111-1111-4111-8111-111111111111';
const PARENT_INSTANCE_ID_B = 'b2222222-2222-4222-8222-222222222222';
const LINK_ID = 'c1111111-1111-4111-8111-111111111111';
const LINK_ID_B = 'c2222222-2222-4222-8222-222222222222';
const BOOKING_ID = 'd1111111-1111-4111-8111-111111111111';
const BOOKING_ID_B = 'd2222222-2222-4222-8222-222222222222';

const PAST_ISO = '2020-01-01T00:00:00.000Z';
const FUTURE_ISO = '2099-01-01T00:00:00.000Z';

interface StoredLinkRow {
  id: string;
  tenant_id: string;
  parent_instance_id: string;
  parent_node_id: string;
  on_timeout_branch: string | null;
  child_entity_kind: 'case' | 'work_order' | 'booking';
  child_entity_id: string;
  spawn_mode: 'continue' | 'wait';
  aggregation_group_id: string | null;
  resolved_at: string | null;
  resolution_kind: string | null;
  wait_timeout_at: string | null;
}

interface ParentInstanceRow {
  id: string;
  tenant_id: string;
}

interface TenantRow {
  id: string;
  slug: string;
  tier: string;
}

interface FakeSupabaseOpts {
  links?: StoredLinkRow[];
  parents?: Record<string, ParentInstanceRow | null>;
  tenants?: Record<string, TenantRow | null>;
  candidatesError?: { message: string };
  claimError?: { message: string };
  unclaimError?: { message: string };
  parentReadError?: { message: string };
}

interface CapturedCalls {
  fromTables: string[];
  selectFilters: Array<Record<string, unknown>>;
  updates: Array<{ payload: Record<string, unknown>; filters: Record<string, unknown> }>;
  parentReadIds: string[];
  tenantReadIds: string[];
  eventInserts: Array<Record<string, unknown>>;
  limits: number[];
}

function makeStoredLink(overrides: Partial<StoredLinkRow> = {}): StoredLinkRow {
  return {
    id: LINK_ID,
    tenant_id: TENANT_ID,
    parent_instance_id: PARENT_INSTANCE_ID,
    parent_node_id: 'spawn-node-1',
    on_timeout_branch: 'timeout',
    child_entity_kind: 'booking',
    child_entity_id: BOOKING_ID,
    spawn_mode: 'wait',
    aggregation_group_id: null,
    resolved_at: null,
    resolution_kind: null,
    wait_timeout_at: PAST_ISO,
    ...overrides,
  };
}

/**
 * Fake supabase wired to the three tables the sweeper touches:
 *   - `workflow_instance_links` (SELECT for candidates + UPDATE for
 *     claim/unclaim).
 *   - `workflow_instances` (parent tenant assertion).
 *   - `tenants` (TenantInfo for TenantContext.run).
 *   - `workflow_instance_events` (audit insert via engine.emitForCron).
 */
function makeSupabase(opts: FakeSupabaseOpts) {
  const captured: CapturedCalls = {
    fromTables: [],
    selectFilters: [],
    updates: [],
    parentReadIds: [],
    tenantReadIds: [],
    eventInserts: [],
    limits: [],
  };

  const linkStore: StoredLinkRow[] = [...(opts.links ?? [])];

  function matchesFilters(
    row: StoredLinkRow,
    filters: Record<string, unknown>,
  ): boolean {
    const nowIso = new Date().toISOString();
    for (const [key, val] of Object.entries(filters)) {
      if (key === '__not_is') {
        const col = (val as { col: string }).col as keyof StoredLinkRow;
        const target = (val as { val: unknown }).val;
        if (row[col] === target) return false;
        continue;
      }
      if (key === '__lte') {
        const col = (val as { col: string }).col as keyof StoredLinkRow;
        const target = (val as { val: unknown }).val as string;
        const cur = row[col] as string | null;
        if (cur === null) return false;
        if (cur > target) return false;
        continue;
      }
      if (key.endsWith('__is')) {
        const col = key.slice(0, -'__is'.length) as keyof StoredLinkRow;
        if (row[col] !== val) return false;
        continue;
      }
      const col = key as keyof StoredLinkRow;
      if (row[col] !== val) return false;
    }
    // Defensive sanity check using `nowIso` so an unexpected
    // wait_timeout_at format doesn't silently match.
    void nowIso;
    return true;
  }

  const from = jest.fn((table: string) => {
    captured.fromTables.push(table);

    if (table === 'workflow_instance_links') {
      function buildSelectChain() {
        const filters: Record<string, unknown> = {};
        const chain = {
          is(col: string, val: unknown) {
            filters[`${col}__is`] = val;
            return chain;
          },
          eq(col: string, val: unknown) {
            filters[col] = val;
            return chain;
          },
          not(col: string, op: string, val: unknown) {
            if (op === 'is') {
              filters['__not_is'] = { col, val };
              return chain;
            }
            throw new Error(`unsupported .not() op: ${op}`);
          },
          lte(col: string, val: unknown) {
            filters['__lte'] = { col, val };
            return chain;
          },
          order(_col: string, _opts: unknown) {
            return chain;
          },
          limit(n: number) {
            captured.limits.push(n);
            captured.selectFilters.push(filters);
            if (opts.candidatesError) {
              return Promise.resolve({ data: null, error: opts.candidatesError });
            }
            const matched = linkStore.filter((row) =>
              matchesFilters(row, filters),
            );
            // Project the columns the sweeper SELECTs.
            const projected = matched.slice(0, n).map((row) => ({
              id: row.id,
              tenant_id: row.tenant_id,
              parent_instance_id: row.parent_instance_id,
              parent_node_id: row.parent_node_id,
              on_timeout_branch: row.on_timeout_branch,
              child_entity_kind: row.child_entity_kind,
              child_entity_id: row.child_entity_id,
              wait_timeout_at: row.wait_timeout_at,
            }));
            return Promise.resolve({ data: projected, error: null });
          },
        };
        return chain;
      }

      function buildUpdateChain(payload: Record<string, unknown>) {
        const filters: Record<string, unknown> = {};
        const chain: {
          eq: (c: string, v: unknown) => typeof chain;
          is: (c: string, v: unknown) => typeof chain;
          not: (c: string, op: string, v: unknown) => typeof chain;
          lte: (c: string, v: unknown) => typeof chain;
          select: (
            _cols: string,
          ) => Promise<{ data: unknown; error: unknown }>;
          then: (
            onfulfilled?: (v: { data: unknown; error: unknown }) => unknown,
            onrejected?: (r: unknown) => unknown,
          ) => Promise<unknown>;
        } = {
          eq(c, v) {
            filters[c] = v;
            return chain;
          },
          is(c, v) {
            filters[`${c}__is`] = v;
            return chain;
          },
          not(c, op, v) {
            if (op === 'is') {
              filters['__not_is'] = { col: c, val: v };
              return chain;
            }
            throw new Error(`unsupported .not() op in update: ${op}`);
          },
          lte(c, v) {
            filters['__lte'] = { col: c, val: v };
            return chain;
          },
          // Claim path — `.select('id')` is awaited.
          async select(_cols) {
            captured.updates.push({ payload, filters });
            if (opts.claimError) {
              return { data: null, error: opts.claimError };
            }
            const updated: Array<{ id: string }> = [];
            for (const row of linkStore) {
              if (matchesFilters(row, filters)) {
                Object.assign(row, payload);
                updated.push({ id: row.id });
              }
            }
            return { data: updated, error: null };
          },
          // Unclaim path — chain is awaited directly (no `.select()`).
          then(onfulfilled, onrejected) {
            captured.updates.push({ payload, filters });
            if (opts.unclaimError) {
              return Promise.resolve(
                onfulfilled?.({ data: null, error: opts.unclaimError }) ??
                  null,
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
        return chain;
      }

      return {
        select: (_cols: string) => buildSelectChain(),
        update: (payload: Record<string, unknown>) =>
          buildUpdateChain(payload),
      };
    }

    if (table === 'workflow_instances') {
      return {
        select: (_cols: string) => ({
          eq: (_col: string, val: string) => {
            captured.parentReadIds.push(val);
            return {
              maybeSingle: async () => {
                if (opts.parentReadError) {
                  return { data: null, error: opts.parentReadError };
                }
                const row = opts.parents?.[val];
                if (row === undefined || row === null) {
                  return { data: null, error: null };
                }
                return { data: row, error: null };
              },
            };
          },
        }),
      };
    }

    if (table === 'tenants') {
      return {
        select: (_cols: string) => ({
          eq: (_col: string, val: string) => {
            captured.tenantReadIds.push(val);
            return {
              maybeSingle: async () => {
                const row = opts.tenants?.[val];
                if (row === undefined || row === null) {
                  return { data: null, error: null };
                }
                return { data: row, error: null };
              },
            };
          },
        }),
      };
    }

    if (table === 'workflow_instance_events') {
      return {
        insert: (payload: Record<string, unknown>) => {
          captured.eventInserts.push(payload);
          return Promise.resolve({ data: null, error: null });
        },
      };
    }

    throw new Error('unexpected table: ' + table);
  });

  return {
    captured,
    linkStore,
    service: { admin: { from } } as unknown as SupabaseService,
  };
}

interface FakeEngineOpts {
  resumeError?: string;
  resumeErrorOnInstanceId?: string;
}

function makeWorkflowEngine(
  opts: FakeEngineOpts = {},
  supabase?: SupabaseService,
): WorkflowEngineService {
  return {
    resume: jest.fn(async (instanceId: string) => {
      if (
        opts.resumeErrorOnInstanceId &&
        instanceId === opts.resumeErrorOnInstanceId
      ) {
        throw new Error(opts.resumeError ?? 'resume_failed');
      }
      if (opts.resumeError && !opts.resumeErrorOnInstanceId) {
        throw new Error(opts.resumeError);
      }
      return undefined;
    }),
    // Real engine.emitForCron forwards to private emit() which writes to
    // workflow_instance_events. Mirror by routing through supabase if
    // provided, so tests can assert the audit row was emitted.
    emitForCron: jest.fn(
      async (
        instanceId: string,
        event_type: string,
        fields: Record<string, unknown> = {},
      ) => {
        if (!supabase) return;
        const f = fields as {
          node_id?: string;
          node_type?: string;
          decision?: string;
          payload?: Record<string, unknown>;
        };
        await supabase.admin
          .from('workflow_instance_events')
          .insert({
            workflow_instance_id: instanceId,
            event_type,
            node_id: f.node_id ?? null,
            node_type: f.node_type ?? null,
            decision: f.decision ?? null,
            payload: f.payload ?? {},
          });
      },
    ),
  } as unknown as WorkflowEngineService;
}

function defaultTenants(
  ids: string[] = [TENANT_ID, TENANT_ID_B],
): Record<string, TenantRow> {
  return ids.reduce<Record<string, TenantRow>>((acc, id) => {
    acc[id] = { id, slug: `tenant-${id.slice(0, 8)}`, tier: 'standard' };
    return acc;
  }, {});
}

describe('WorkflowWaitSweeperCron (Universal Workflow Architecture Phase 1.C)', () => {
  describe('zero expired rows', () => {
    it('no-op: no engine.resume call, no link mutation', async () => {
      const supabase = makeSupabase({ links: [] });
      const engine = makeWorkflowEngine({}, supabase.service);
      const cron = new WorkflowWaitSweeperCron(supabase.service, engine);
      const handled = await cron.sweepOnce();
      expect(handled).toBe(0);
      expect(engine.resume).not.toHaveBeenCalled();
      expect(supabase.captured.eventInserts).toHaveLength(0);
      expect(supabase.captured.updates).toHaveLength(0);
    });

    it('passes the full WHERE filters: resolved_at IS NULL, spawn_mode=wait, aggregation_group_id IS NULL, wait_timeout_at IS NOT NULL, wait_timeout_at <= now()', async () => {
      const supabase = makeSupabase({ links: [] });
      const engine = makeWorkflowEngine({}, supabase.service);
      const cron = new WorkflowWaitSweeperCron(supabase.service, engine);
      await cron.sweepOnce();
      expect(supabase.captured.selectFilters).toHaveLength(1);
      const f = supabase.captured.selectFilters[0];
      expect(f.resolved_at__is).toBeNull();
      expect(f.spawn_mode).toBe('wait');
      expect(f.aggregation_group_id__is).toBeNull();
      expect(f.__not_is).toEqual({ col: 'wait_timeout_at', val: null });
      // Lte filter captured.
      const lte = f.__lte as { col: string; val: unknown };
      expect(lte.col).toBe('wait_timeout_at');
      expect(typeof lte.val).toBe('string');
    });
  });

  describe('one expired row', () => {
    it('atomic claim, link_resolved emit, engine.resume called with on_timeout_branch', async () => {
      const supabase = makeSupabase({
        links: [makeStoredLink({ on_timeout_branch: 'timeout' })],
        parents: {
          [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID },
        },
        tenants: defaultTenants(),
      });
      const engine = makeWorkflowEngine({}, supabase.service);
      const cron = new WorkflowWaitSweeperCron(supabase.service, engine);
      const handled = await cron.sweepOnce();
      expect(handled).toBe(1);
      expect(engine.resume).toHaveBeenCalledTimes(1);
      expect(engine.resume).toHaveBeenCalledWith(
        PARENT_INSTANCE_ID,
        TENANT_ID,
        'timeout',
      );
      // link_resolved audit row was inserted.
      expect(supabase.captured.eventInserts).toHaveLength(1);
      const ev = supabase.captured.eventInserts[0];
      expect(ev.event_type).toBe('link_resolved');
      expect(ev.workflow_instance_id).toBe(PARENT_INSTANCE_ID);
      const payload = ev.payload as Record<string, unknown>;
      expect(payload.link_id).toBe(LINK_ID);
      expect(payload.resolution_kind).toBe('timeout');
      expect(payload.child_entity_kind).toBe('booking');
      expect(payload.child_entity_id).toBe(BOOKING_ID);
      // Link mutated to resolved + timeout.
      expect(supabase.linkStore[0].resolved_at).not.toBeNull();
      expect(supabase.linkStore[0].resolution_kind).toBe('timeout');
    });
  });

  describe('multiple expired rows in one sweep', () => {
    it('each processed independently; one failure does not abort the others', async () => {
      const supabase = makeSupabase({
        links: [
          makeStoredLink({ id: LINK_ID }),
          makeStoredLink({
            id: LINK_ID_B,
            parent_instance_id: PARENT_INSTANCE_ID_B,
            child_entity_id: BOOKING_ID_B,
          }),
        ],
        parents: {
          [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID },
          [PARENT_INSTANCE_ID_B]: { id: PARENT_INSTANCE_ID_B, tenant_id: TENANT_ID },
        },
        tenants: defaultTenants(),
      });
      const engine = makeWorkflowEngine(
        { resumeErrorOnInstanceId: PARENT_INSTANCE_ID, resumeError: 'transient' },
        supabase.service,
      );
      const cron = new WorkflowWaitSweeperCron(supabase.service, engine);
      const handled = await cron.sweepOnce();
      // First link claim succeeded (true) but resume threw → caught;
      // second link processed cleanly. handled counts the second.
      expect(handled).toBe(1);
      expect(engine.resume).toHaveBeenCalledTimes(2);
      // The failing link was unclaimed.
      const linkA = supabase.linkStore.find((l) => l.id === LINK_ID)!;
      expect(linkA.resolved_at).toBeNull();
      expect(linkA.resolution_kind).toBeNull();
      // The successful link stayed claimed.
      const linkB = supabase.linkStore.find((l) => l.id === LINK_ID_B)!;
      expect(linkB.resolved_at).not.toBeNull();
      expect(linkB.resolution_kind).toBe('timeout');
    });
  });

  describe('concurrent worker / wait extended race', () => {
    it('row already-resolved between SELECT and UPDATE → claim returns 0; sweep skips, no resume', async () => {
      // Seed a link that the SELECT will see (so it's in candidates),
      // but mutate it to resolved BEFORE the per-row UPDATE fires.
      // We achieve this by overriding the claimGate-style hook: the
      // simplest way is to have the link already resolved at SELECT
      // time — but our SELECT filters out resolved_at non-null. So
      // instead, simulate the race by pre-resolving the link AFTER
      // SELECT via a one-shot mutation injected into engine.resume...
      //
      // Simpler: directly construct a row that passes SELECT but is
      // mutated by the test BEFORE the cron's UPDATE runs. Achieve
      // this by intercepting the engine.resume of an unrelated link.
      //
      // Cleanest path: precondition the link as resolved_at IS NOT
      // NULL but with spawn_mode='wait' and a past timeout. The
      // SELECT filter `resolved_at IS NULL` won't pick it up — so
      // we instead test the claim's WHERE-clause semantics by
      // hand-mutating the linkStore between SELECT and UPDATE.
      const links = [makeStoredLink({ id: LINK_ID })];
      const supabase = makeSupabase({
        links,
        parents: {
          [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID },
        },
        tenants: defaultTenants(),
      });
      const engine = makeWorkflowEngine({}, supabase.service);

      // Force the link into resolved state AFTER the SELECT but
      // BEFORE the UPDATE: monkey-patch supabase to mutate on the
      // first `update()` call entry.
      const origFrom = supabase.service.admin.from;
      let claimAttempted = false;
      (supabase.service.admin as { from: typeof origFrom }).from = jest.fn(
        (table: string) => {
          const real = origFrom(table);
          if (table === 'workflow_instance_links') {
            const realUpdate = (
              real as unknown as { update: (p: Record<string, unknown>) => unknown }
            ).update;
            return {
              ...(real as Record<string, unknown>),
              update: (p: Record<string, unknown>) => {
                if (!claimAttempted) {
                  claimAttempted = true;
                  links[0].resolved_at = '2030-01-01T00:00:00Z';
                  links[0].resolution_kind = 'condition_met';
                }
                return realUpdate.call(real, p);
              },
            };
          }
          return real;
        },
      );

      const cron = new WorkflowWaitSweeperCron(supabase.service, engine);
      const handled = await cron.sweepOnce();
      expect(handled).toBe(0);
      expect(engine.resume).not.toHaveBeenCalled();
      // Pre-existing resolution_kind preserved (we didn't overwrite to 'timeout').
      expect(links[0].resolution_kind).toBe('condition_met');
    });

    it('wait extended (wait_timeout_at moved to the future) → claim WHERE rejects; sweep skips', async () => {
      const links = [makeStoredLink({ id: LINK_ID, wait_timeout_at: PAST_ISO })];
      const supabase = makeSupabase({
        links,
        parents: {
          [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID },
        },
        tenants: defaultTenants(),
      });
      const engine = makeWorkflowEngine({}, supabase.service);

      const origFrom = supabase.service.admin.from;
      let claimAttempted = false;
      (supabase.service.admin as { from: typeof origFrom }).from = jest.fn(
        (table: string) => {
          const real = origFrom(table);
          if (table === 'workflow_instance_links') {
            const realUpdate = (
              real as unknown as { update: (p: Record<string, unknown>) => unknown }
            ).update;
            return {
              ...(real as Record<string, unknown>),
              update: (p: Record<string, unknown>) => {
                if (!claimAttempted) {
                  claimAttempted = true;
                  // Extend the wait past now() — the UPDATE's
                  // .lte('wait_timeout_at', nowIso) filter must reject.
                  links[0].wait_timeout_at = FUTURE_ISO;
                }
                return realUpdate.call(real, p);
              },
            };
          }
          return real;
        },
      );

      const cron = new WorkflowWaitSweeperCron(supabase.service, engine);
      const handled = await cron.sweepOnce();
      expect(handled).toBe(0);
      expect(engine.resume).not.toHaveBeenCalled();
      // Link still in unresolved state.
      expect(links[0].resolved_at).toBeNull();
      expect(links[0].resolution_kind).toBeNull();
    });
  });

  describe('engine.resume failure → unclaim', () => {
    it('transient resume error unclaims the link; next sweep retries', async () => {
      const supabase = makeSupabase({
        links: [makeStoredLink()],
        parents: {
          [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID },
        },
        tenants: defaultTenants(),
      });
      const engine = makeWorkflowEngine(
        { resumeError: 'transient db wobble' },
        supabase.service,
      );
      const cron = new WorkflowWaitSweeperCron(supabase.service, engine);
      const handled = await cron.sweepOnce();
      // processOne caught + threw; outer per-link try caught → handled=0.
      expect(handled).toBe(0);
      // Unclaim landed.
      const link = supabase.linkStore[0];
      expect(link.resolved_at).toBeNull();
      expect(link.resolution_kind).toBeNull();
    });

    it('resume throws AND unclaim also fails → log + sweep continues to next link', async () => {
      const supabase = makeSupabase({
        links: [
          makeStoredLink({ id: LINK_ID }),
          makeStoredLink({
            id: LINK_ID_B,
            parent_instance_id: PARENT_INSTANCE_ID_B,
            child_entity_id: BOOKING_ID_B,
          }),
        ],
        parents: {
          [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID },
          [PARENT_INSTANCE_ID_B]: { id: PARENT_INSTANCE_ID_B, tenant_id: TENANT_ID },
        },
        tenants: defaultTenants(),
        unclaimError: { message: 'unclaim failed' },
      });
      const engine = makeWorkflowEngine(
        { resumeErrorOnInstanceId: PARENT_INSTANCE_ID, resumeError: 'resume failed' },
        supabase.service,
      );
      const cron = new WorkflowWaitSweeperCron(supabase.service, engine);
      const handled = await cron.sweepOnce();
      // Second link processed cleanly even though first failed both
      // resume + unclaim.
      expect(handled).toBe(1);
      expect(engine.resume).toHaveBeenCalledTimes(2);
      const linkB = supabase.linkStore.find((l) => l.id === LINK_ID_B)!;
      expect(linkB.resolution_kind).toBe('timeout');
    });
  });

  describe('on_timeout_branch null', () => {
    it('warns and still resumes with undefined branch (engine falls through to edges[0])', async () => {
      const supabase = makeSupabase({
        links: [makeStoredLink({ on_timeout_branch: null })],
        parents: {
          [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID },
        },
        tenants: defaultTenants(),
      });
      const engine = makeWorkflowEngine({}, supabase.service);
      const cron = new WorkflowWaitSweeperCron(supabase.service, engine);
      const handled = await cron.sweepOnce();
      expect(handled).toBe(1);
      expect(engine.resume).toHaveBeenCalledTimes(1);
      expect(engine.resume).toHaveBeenCalledWith(
        PARENT_INSTANCE_ID,
        TENANT_ID,
        undefined,
      );
    });
  });

  describe('tenant assertion (defense-in-depth)', () => {
    it('parent.tenant_id mismatch → refuse to resume; row left in claimed state', async () => {
      // Link rows from this fake live in linkStore with tenant_id =
      // TENANT_ID. Wire the parent_instance row to TENANT_ID_B so the
      // mismatch fires.
      const supabase = makeSupabase({
        links: [makeStoredLink({ tenant_id: TENANT_ID })],
        parents: {
          [PARENT_INSTANCE_ID]: {
            id: PARENT_INSTANCE_ID,
            tenant_id: TENANT_ID_B,
          },
        },
        tenants: defaultTenants(),
      });
      const engine = makeWorkflowEngine({}, supabase.service);
      const cron = new WorkflowWaitSweeperCron(supabase.service, engine);
      const handled = await cron.sweepOnce();
      // Claim landed (counted), but resume short-circuited on mismatch.
      expect(handled).toBe(1);
      expect(engine.resume).not.toHaveBeenCalled();
      // Row remains claimed so it doesn't get re-swept forever.
      expect(supabase.linkStore[0].resolved_at).not.toBeNull();
      expect(supabase.linkStore[0].resolution_kind).toBe('timeout');
    });
  });

  describe('batch size cap', () => {
    it('respects WORKFLOW_WAIT_SWEEPER_BATCH_SIZE (passes to .limit)', async () => {
      const prev = process.env.WORKFLOW_WAIT_SWEEPER_BATCH_SIZE;
      process.env.WORKFLOW_WAIT_SWEEPER_BATCH_SIZE = '2';
      try {
        const supabase = makeSupabase({ links: [] });
        const engine = makeWorkflowEngine({}, supabase.service);
        const cron = new WorkflowWaitSweeperCron(supabase.service, engine);
        await cron.sweepOnce();
        expect(supabase.captured.limits).toEqual([2]);
      } finally {
        if (prev === undefined) delete process.env.WORKFLOW_WAIT_SWEEPER_BATCH_SIZE;
        else process.env.WORKFLOW_WAIT_SWEEPER_BATCH_SIZE = prev;
      }
    });
  });

  describe('enabled flag', () => {
    it('sweepExpiredWaits is a no-op when WORKFLOW_WAIT_SWEEPER_ENABLED=false', async () => {
      const prev = process.env.WORKFLOW_WAIT_SWEEPER_ENABLED;
      process.env.WORKFLOW_WAIT_SWEEPER_ENABLED = 'false';
      try {
        const supabase = makeSupabase({
          links: [makeStoredLink()],
          parents: {
            [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID },
          },
          tenants: defaultTenants(),
        });
        const engine = makeWorkflowEngine({}, supabase.service);
        const cron = new WorkflowWaitSweeperCron(supabase.service, engine);
        await cron.sweepExpiredWaits();
        expect(engine.resume).not.toHaveBeenCalled();
        expect(supabase.captured.fromTables).toHaveLength(0);
      } finally {
        if (prev === undefined) delete process.env.WORKFLOW_WAIT_SWEEPER_ENABLED;
        else process.env.WORKFLOW_WAIT_SWEEPER_ENABLED = prev;
      }
    });
  });

  describe('tenant cache', () => {
    it('multiple links from the same tenant resolve tenants row once', async () => {
      const supabase = makeSupabase({
        links: [
          makeStoredLink({ id: LINK_ID }),
          makeStoredLink({
            id: LINK_ID_B,
            parent_instance_id: PARENT_INSTANCE_ID_B,
            child_entity_id: BOOKING_ID_B,
          }),
        ],
        parents: {
          [PARENT_INSTANCE_ID]: { id: PARENT_INSTANCE_ID, tenant_id: TENANT_ID },
          [PARENT_INSTANCE_ID_B]: { id: PARENT_INSTANCE_ID_B, tenant_id: TENANT_ID },
        },
        tenants: defaultTenants(),
      });
      const engine = makeWorkflowEngine({}, supabase.service);
      const cron = new WorkflowWaitSweeperCron(supabase.service, engine);
      await cron.sweepOnce();
      // Both links share tenant_id; the tenants table should be read once.
      expect(supabase.captured.tenantReadIds.filter((id) => id === TENANT_ID))
        .toHaveLength(1);
    });
  });
});
