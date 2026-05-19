import { SlaService } from './sla.service';

// audit-02 D-A02-4 — caller-side command_operations success-probe in
// applyReassignment. The SLA escalation reuses the STABLE per-crossing
// idempotency key but rebuilds the mutable assignment payload every tick.
// If a prior tick's RPC committed but a post-RPC step crashed before
// fireThreshold wrote the crossing anchor, a later tick recomputes a
// drifted payload → command_operations.payload_mismatch → the escalation
// is permanently poisoned. The probe short-circuits a proven-committed
// crossing (return true → fireThreshold completes the stuck crossing
// once) instead of recomputing.
describe('SlaService.applyReassignment — audit-02 D-A02-4 success-probe', () => {
  type RpcCall = { fn: string; args: Record<string, unknown> };

  function makeReassignDeps(
    commandOpRow: { outcome: string; cached_result: unknown } | null,
  ) {
    const rpcCalls: RpcCall[] = [];
    const commandOpProbes: Array<Record<string, unknown>> = [];

    const supabase = {
      admin: {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          rpcCalls.push({ fn, args });
          return { data: { noop: false }, error: null };
        },
        from: (table: string) => {
          if (table === 'command_operations') {
            const filters: Record<string, unknown> = {};
            const chain: Record<string, unknown> = {
              select: () => chain,
              eq: (col: string, val: unknown) => {
                filters[col] = val;
                return chain;
              },
              maybeSingle: async () => {
                commandOpProbes.push({ ...filters });
                return { data: commandOpRow, error: null };
              },
            };
            return chain;
          }
          if (table === 'users') {
            const chain: Record<string, unknown> = {
              select: () => chain,
              eq: () => chain,
              maybeSingle: async () => ({ data: null, error: null }),
            };
            return chain;
          }
          throw new Error(`unexpected table in mock: ${table}`);
        },
      },
    };

    return { supabase, rpcCalls, commandOpProbes };
  }

  const STABLE_KEY = 'sla:escalation:timer-1:100:response';

  it('success-probe short-circuits BEFORE recompute: returns true, NO set_entity_assignment RPC, tenant-scoped probe', async () => {
    const { supabase, rpcCalls, commandOpProbes } = makeReassignDeps({
      outcome: 'success',
      cached_result: { entity_id: 'tic-1', noop: false },
    });
    const svc = new SlaService(supabase as any, {} as any, {} as any);

    const ticket = {
      id: 'tic-1',
      tenant_id: 'ten-1',
      assigned_user_id: 'user-old',
      assigned_team_id: null as string | null,
      watchers: ['person-existing'] as string[] | null,
      entity_kind: 'case' as const,
    };

    const changed = await (svc as any).applyReassignment(
      ticket,
      { personId: 'person-new' },
      STABLE_KEY,
      'SLA escalation — 100% threshold breached',
    );

    // "assignment already done" → fireThreshold's crossing-anchor gate
    // treats this exactly like a fresh successful reassign and completes
    // the stuck escalation once.
    expect(changed).toBe(true);
    // No RPC re-call → no recomputed payload → no payload_mismatch poison.
    expect(
      rpcCalls.filter((c) => c.fn === 'set_entity_assignment'),
    ).toHaveLength(0);
    // Probe tenant-scoped on the command_operations PK.
    expect(commandOpProbes).toHaveLength(1);
    expect(commandOpProbes[0]).toEqual({
      tenant_id: 'ten-1',
      idempotency_key: STABLE_KEY,
    });
  });

  it('no prior commit (no row): probe falls through → recompute + RPC exactly as before', async () => {
    const { supabase, rpcCalls } = makeReassignDeps(null);
    const svc = new SlaService(supabase as any, {} as any, {} as any);

    const ticket = {
      id: 'tic-1',
      tenant_id: 'ten-1',
      assigned_user_id: null as string | null,
      assigned_team_id: 'team-old',
      watchers: null as string[] | null,
      entity_kind: 'case' as const,
    };

    const changed = await (svc as any).applyReassignment(
      ticket,
      { teamId: 'team-new' },
      STABLE_KEY,
      'SLA escalation — 100% threshold breached',
    );

    expect(changed).toBe(true);
    expect(
      rpcCalls.filter((c) => c.fn === 'set_entity_assignment'),
    ).toHaveLength(1);
  });

  it("in_progress does NOT short-circuit: a concurrent tick holds the key → recompute + RPC proceeds", async () => {
    const { supabase, rpcCalls } = makeReassignDeps({
      outcome: 'in_progress',
      cached_result: null,
    });
    const svc = new SlaService(supabase as any, {} as any, {} as any);

    const ticket = {
      id: 'tic-1',
      tenant_id: 'ten-1',
      assigned_user_id: null as string | null,
      assigned_team_id: 'team-old',
      watchers: null as string[] | null,
      entity_kind: 'case' as const,
    };

    const changed = await (svc as any).applyReassignment(
      ticket,
      { teamId: 'team-new' },
      STABLE_KEY,
      'SLA escalation — 100% threshold breached',
    );

    expect(changed).toBe(true);
    expect(
      rpcCalls.filter((c) => c.fn === 'set_entity_assignment'),
    ).toHaveLength(1);
  });
});

// Hand-rolled supabase chain mock for the sla_policies lookup used by
// applyWaitingStateTransition. Captures the .eq() filters so tests can assert
// the tenant scope (codex C1 lock-in: same UUID across tenants must not
// resolve to the wrong-tenant pause_on_waiting_reasons array).
function makePolicyDeps(
  policiesByKey: Record<string, { pause_on_waiting_reasons: string[] | null } | null>,
) {
  const policyLookups: Array<{ id?: string; tenant_id?: string }> = [];

  const supabase = {
    admin: {
      from: (table: string) => {
        if (table !== 'sla_policies') {
          throw new Error(`unexpected table in mock: ${table}`);
        }
        return {
          select: () => {
            const filters: { id?: string; tenant_id?: string } = {};
            const chain = {
              eq: (col: string, val: string) => {
                if (col === 'id') filters.id = val;
                if (col === 'tenant_id') filters.tenant_id = val;
                return chain;
              },
              maybeSingle: async () => {
                policyLookups.push({ ...filters });
                const key = `${filters.id}|${filters.tenant_id}`;
                return { data: policiesByKey[key] ?? null, error: null };
              },
            };
            return chain;
          },
        };
      },
    },
  };

  return { supabase, policyLookups };
}

describe('SlaService.applyWaitingStateTransition', () => {
  function makeSvc(supabase: unknown) {
    const svc = new SlaService(supabase as any, {} as any, {} as any);
    // Stub the side-effecting helpers — applyWaitingStateTransition's
    // contract is "decide pause/resume based on policy + transition, then
    // call pauseTimers/resumeTimers". The pause/resume internals are out of
    // scope for this spec.
    jest.spyOn(svc, 'pauseTimers').mockResolvedValue(undefined);
    jest.spyOn(svc, 'resumeTimers').mockResolvedValue(undefined);
    return svc;
  }

  it('pauses timers when entering waiting state with a reason in pause_on_waiting_reasons', async () => {
    const { supabase } = makePolicyDeps({
      'sla-x|t1': { pause_on_waiting_reasons: ['vendor', 'requester'] },
    });
    const svc = makeSvc(supabase);

    await svc.applyWaitingStateTransition(
      'wo1',
      't1',
      { status_category: 'in_progress', waiting_reason: null, sla_id: 'sla-x' },
      { status_category: 'waiting', waiting_reason: 'vendor', sla_id: 'sla-x' },
    );

    expect(svc.pauseTimers).toHaveBeenCalledTimes(1);
    expect(svc.pauseTimers).toHaveBeenCalledWith('wo1', 't1');
    expect(svc.resumeTimers).not.toHaveBeenCalled();
  });

  it('resumes timers when exiting a paused waiting state', async () => {
    const { supabase } = makePolicyDeps({
      'sla-x|t1': { pause_on_waiting_reasons: ['vendor'] },
    });
    const svc = makeSvc(supabase);

    await svc.applyWaitingStateTransition(
      'wo1',
      't1',
      { status_category: 'waiting', waiting_reason: 'vendor', sla_id: 'sla-x' },
      { status_category: 'in_progress', waiting_reason: null, sla_id: 'sla-x' },
    );

    expect(svc.resumeTimers).toHaveBeenCalledTimes(1);
    expect(svc.resumeTimers).toHaveBeenCalledWith('wo1', 't1');
    expect(svc.pauseTimers).not.toHaveBeenCalled();
  });

  it('does NOT pause when waiting_reason is not in pause_on_waiting_reasons', async () => {
    const { supabase } = makePolicyDeps({
      'sla-x|t1': { pause_on_waiting_reasons: ['vendor'] },
    });
    const svc = makeSvc(supabase);

    await svc.applyWaitingStateTransition(
      'wo1',
      't1',
      { status_category: 'in_progress', waiting_reason: null, sla_id: 'sla-x' },
      { status_category: 'waiting', waiting_reason: 'other', sla_id: 'sla-x' },
    );

    expect(svc.pauseTimers).not.toHaveBeenCalled();
    expect(svc.resumeTimers).not.toHaveBeenCalled();
  });

  it('no-ops when both before and after sla_id are null', async () => {
    // No supabase calls are expected — surface them as test failures.
    const supabase = {
      admin: {
        from: () => {
          throw new Error('sla_policies should not be queried when sla_id is null');
        },
      },
    };
    const svc = makeSvc(supabase);

    await svc.applyWaitingStateTransition(
      'wo1',
      't1',
      { status_category: 'in_progress', waiting_reason: null, sla_id: null },
      { status_category: 'waiting', waiting_reason: 'vendor', sla_id: null },
    );

    expect(svc.pauseTimers).not.toHaveBeenCalled();
    expect(svc.resumeTimers).not.toHaveBeenCalled();
  });

  it('filters sla_policies lookup by tenant — same UUID across tenants does NOT cross-leak (codex C1 lock-in)', async () => {
    // Tenant t1 owns sla-x with pause_on_waiting_reasons=['vendor'].
    // Tenant t2 owns sla-x with pause_on_waiting_reasons=[] (a coincidental
    // collision — UUIDs SHOULD be globally unique, but supabase.admin
    // bypasses RLS and a foreign sla_id planted on a t2 row would otherwise
    // resolve to t1's policy and pause incorrectly).
    const { supabase, policyLookups } = makePolicyDeps({
      'sla-x|t1': { pause_on_waiting_reasons: ['vendor'] },
      'sla-x|t2': { pause_on_waiting_reasons: [] },
    });
    const svc = makeSvc(supabase);

    // Caller is tenant t2; even though sla-x exists in t1 with a matching
    // pause reason, t2's policy has no pause reasons → pauseTimers should
    // not be called.
    await svc.applyWaitingStateTransition(
      'wo1',
      't2',
      { status_category: 'in_progress', waiting_reason: null, sla_id: 'sla-x' },
      { status_category: 'waiting', waiting_reason: 'vendor', sla_id: 'sla-x' },
    );

    expect(policyLookups).toHaveLength(1);
    expect(policyLookups[0]).toEqual({ id: 'sla-x', tenant_id: 't2' });
    expect(svc.pauseTimers).not.toHaveBeenCalled();
    expect(svc.resumeTimers).not.toHaveBeenCalled();
  });
});

describe('SlaService.startTimers — Plan A.2 tenant filter', () => {
  // Plan A.2 / gap map §sla.service.ts:65-71. The pre-fix policy load
  // hit `from('sla_policies').select('*').eq('id', slaPolicyId).single()`
  // — no tenant filter. A foreign-tenant slaPolicyId planted on a
  // work_order or case (e.g. via the dispatch path before the same
  // commit added validation) would resolve to the wrong tenant's
  // pause_on_waiting_reasons + business_hours_calendar + escalation
  // thresholds, then start timers off the wrong policy. Closes the
  // create-side gap that mirrors applyWaitingStateTransition's already-
  // closed gap.
  function makeStartTimersDeps(rowsByTenant: Record<string, { id: string; tenant_id: string; response_time_minutes: number | null; resolution_time_minutes: number | null }>) {
    const lookups: Array<Record<string, unknown>> = [];
    const supabase = {
      admin: {
        from: (table: string) => {
          if (table === 'sla_policies') {
            const filters: Record<string, unknown> = {};
            const chain: Record<string, unknown> = {
              eq: (col: string, val: unknown) => {
                filters[col] = val;
                return chain;
              },
              maybeSingle: async () => {
                lookups.push({ ...filters });
                const key = `${filters.id}|${filters.tenant_id}`;
                const row = rowsByTenant[key];
                return { data: row ?? null, error: null };
              },
              single: async () => {
                lookups.push({ ...filters });
                const key = `${filters.id}|${filters.tenant_id}`;
                const row = rowsByTenant[key];
                return { data: row ?? null, error: null };
              },
            };
            return { select: () => chain };
          }
          if (table === 'sla_timers') {
            return { insert: () => Promise.resolve({ error: null }) };
          }
          if (table === 'tickets' || table === 'work_orders' || table === 'business_hours_calendars') {
            const filters: Record<string, unknown> = {};
            const chain: Record<string, unknown> = {
              eq: (col: string, val: unknown) => {
                filters[col] = val;
                return chain;
              },
              maybeSingle: async () => ({ data: null, error: null }),
              single: async () => ({ data: null, error: null }),
              select: () => chain,
            };
            return {
              update: () => chain,
              select: () => chain,
            };
          }
          return {} as unknown;
        },
      },
    };
    return { supabase, lookups };
  }

  it('does NOT load a cross-tenant policy when starting timers', async () => {
    // Same uuid present in BOTH tenants with different settings. The legacy
    // call resolved by id alone and would have returned the FIRST hit; with
    // the tenant filter, only the t2 policy is reachable.
    const { supabase, lookups } = makeStartTimersDeps({
      'sla-x|t1': { id: 'sla-x', tenant_id: 't1', response_time_minutes: 60, resolution_time_minutes: 240 },
      // Intentional: 't2|sla-x' is missing — caller is t2 but only t1 has the
      // policy. With the new filter, startTimers must NOT find it.
    });
    const businessHours = { addBusinessMinutes: jest.fn() };
    const notifications = {};
    const svc = new SlaService(supabase as any, businessHours as any, notifications as any);
    await svc.startTimers('wo1', 't2', 'sla-x');

    // Single lookup, scoped to t2 → policy not found → early return, no
    // calendar lookup, no business-hours calc.
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toEqual({ id: 'sla-x', tenant_id: 't2' });
    expect(businessHours.addBusinessMinutes).not.toHaveBeenCalled();
  });

  it('loads the in-tenant policy when present', async () => {
    const { supabase, lookups } = makeStartTimersDeps({
      'sla-x|t1': { id: 'sla-x', tenant_id: 't1', response_time_minutes: null, resolution_time_minutes: null },
    });
    const businessHours = { addBusinessMinutes: jest.fn() };
    const notifications = {};
    const svc = new SlaService(supabase as any, businessHours as any, notifications as any);
    await svc.startTimers('wo1', 't1', 'sla-x');
    expect(lookups[0]).toEqual({ id: 'sla-x', tenant_id: 't1' });
  });
});

describe('SlaService.stopTimers', () => {
  it('updates active timers with stopped_at and stopped_reason, scoped to ticket + tenant', async () => {
    const captured: Array<{ patch: Record<string, unknown>; filters: Record<string, unknown> }> = [];

    const chain = (filters: Record<string, unknown>) => ({
      eq: (col: string, val: unknown) => chain({ ...filters, [col]: val }),
      is: (col: string, val: unknown) => chain({ ...filters, [col]: val }),
      then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
    });

    const supabase = {
      admin: {
        from: (table: string) => {
          expect(table).toBe('sla_timers');
          return {
            update: (patch: Record<string, unknown>) => {
              const root = (filters: Record<string, unknown>) => ({
                eq: (col: string, val: unknown) => root({ ...filters, [col]: val }),
                is: (col: string, val: unknown) => {
                  const merged = { ...filters, [col]: val };
                  return {
                    eq: (c: string, v: unknown) => {
                      // Not used in stopTimers chain.
                      captured.push({ patch, filters: { ...merged, [c]: v } });
                      return Promise.resolve({ data: null, error: null });
                    },
                    is: (c: string, v: unknown) => {
                      captured.push({ patch, filters: { ...merged, [c]: v } });
                      return Promise.resolve({ data: null, error: null });
                    },
                  };
                },
              });
              return root({});
            },
          };
        },
      },
    };

    const svc = new SlaService(supabase as any, {} as any, {} as any);
    await svc.stopTimers('t1', 'ten1', 'reclassified');

    expect(captured).toHaveLength(1);
    expect(captured[0].patch.stopped_reason).toBe('reclassified');
    expect(captured[0].patch.stopped_at).toEqual(expect.any(String));
    expect(captured[0].filters).toMatchObject({
      ticket_id: 't1',
      tenant_id: 'ten1',
      stopped_at: null,
      completed_at: null,
    });
  });
});
