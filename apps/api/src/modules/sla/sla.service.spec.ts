import { SlaService } from './sla.service';
import { buildSlaEscalationIdempotencyKey } from '@prequest/shared';

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

describe('SlaService.applyReassignment — audit02 Slice B (P0-2)', () => {
  // SLA escalation reassignment MUST route the assignment + watchers write
  // through the canonical `set_entity_assignment` v3 RPC (00416), not a raw
  // `tickets`/`work_orders` UPDATE. The RPC owns idempotency
  // (command_operations), routing_decisions, ticket_activities, and the
  // ticket_assigned domain event in one transaction.
  //
  // D-A02-1: tickets.watchers / work_orders.watchers are uuid[] of
  // persons.id (00011_tickets.sql:26). The outgoing assignee that "now
  // watches" is ticket.assigned_user_id — a users.id. v3's watcher
  // validator is persons-scoped and rejects a users.id. So the outgoing
  // assignee MUST be resolved users.id → person_id before being added to
  // the watcher set.

  type RpcCall = { fn: string; args: Record<string, unknown> };

  function makeReassignDeps(opts: {
    userRowByPersonId?: Record<string, { id: string; person_id: string } | null>;
    personIdByUserId?: Record<string, { person_id: string } | null>;
  }) {
    const rpcCalls: RpcCall[] = [];
    const rawUpdates: Array<{ table: string; patch: Record<string, unknown> }> = [];

    const supabase = {
      admin: {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          rpcCalls.push({ fn, args });
          return { data: { noop: false }, error: null };
        },
        from: (table: string) => {
          if (table === 'users') {
            const filters: Record<string, unknown> = {};
            const chain: Record<string, unknown> = {
              select: () => chain,
              eq: (col: string, val: unknown) => {
                filters[col] = val;
                return chain;
              },
              maybeSingle: async () => {
                // person_id → user row (forward lookup, existing code)
                if (filters.person_id !== undefined) {
                  return {
                    data:
                      opts.userRowByPersonId?.[filters.person_id as string] ?? null,
                    error: null,
                  };
                }
                // id (users.id) → person_id (D-A02-1 reverse lookup)
                if (filters.id !== undefined) {
                  return {
                    data: opts.personIdByUserId?.[filters.id as string] ?? null,
                    error: null,
                  };
                }
                return { data: null, error: null };
              },
            };
            return chain;
          }
          // Any raw tickets/work_orders update is a regression for the
          // assignment+watchers write.
          if (table === 'tickets' || table === 'work_orders') {
            const chain: Record<string, unknown> = {
              update: (patch: Record<string, unknown>) => {
                rawUpdates.push({ table, patch });
                const c2: Record<string, unknown> = {
                  eq: () => c2,
                  select: () => c2,
                  maybeSingle: async () => ({ data: { id: 'x' }, error: null }),
                };
                return c2;
              },
            };
            return chain;
          }
          throw new Error(`unexpected table in mock: ${table}`);
        },
      },
    };

    return { supabase, rpcCalls, rawUpdates };
  }

  it('routes the escalation assignment+watchers write through set_entity_assignment v3 with the deterministic SLA key, resolved entity kind, a non-null reason, and a person-id (not users.id) outgoing watcher', async () => {
    const { supabase, rpcCalls, rawUpdates } = makeReassignDeps({
      // resolved.personId → the new assignee's user row
      userRowByPersonId: { 'person-new': { id: 'user-new', person_id: 'person-new' } },
      // D-A02-1: outgoing assigned_user_id 'user-old' → its person_id
      personIdByUserId: { 'user-old': { person_id: 'person-old' } },
    });
    const svc = new SlaService(supabase as any, {} as any, {} as any);

    const ticket = {
      id: 'tic-1',
      tenant_id: 'ten-1',
      assigned_user_id: 'user-old',
      assigned_team_id: null as string | null,
      watchers: ['person-existing'] as string[] | null,
    };
    const timer = {
      id: 'timer-1',
      timer_type: 'response' as const,
    };
    const threshold = {
      at_percent: 100,
      timer_type: 'response' as const,
      action: 'escalate' as const,
      target_type: 'user' as const,
      target_id: 'person-new',
    };

    const changed = await (svc as any).applyReassignment(
      ticket,
      { personId: 'person-new' },
      'case',
      timer,
      threshold,
      'Priority P1 SLA',
    );

    expect(changed).toBe(true);

    // Exactly one set_entity_assignment RPC for the assignment write.
    const assignCalls = rpcCalls.filter((c) => c.fn === 'set_entity_assignment');
    expect(assignCalls).toHaveLength(1);
    const args = assignCalls[0].args;

    expect(args.p_entity_id).toBe('tic-1');
    expect(args.p_entity_kind).toBe('case');
    expect(args.p_tenant_id).toBe('ten-1');
    expect(args.p_actor_user_id).toBeNull();
    expect(args.p_idempotency_key).toBe(
      buildSlaEscalationIdempotencyKey('timer-1', 100, 'response'),
    );

    const payload = args.p_payload as Record<string, unknown>;
    expect(payload.assigned_user_id).toBe('user-new');
    expect(typeof payload.reason).toBe('string');
    expect((payload.reason as string).length).toBeGreaterThan(0);

    // D-A02-1: outgoing assignee added as its person_id, never the raw
    // users.id; existing person-id watcher preserved.
    const watchers = payload.watchers as string[];
    expect(watchers).toEqual(expect.arrayContaining(['person-existing', 'person-old']));
    expect(watchers).not.toContain('user-old');

    // No raw tickets/work_orders UPDATE for the assignment/watchers write.
    expect(rawUpdates).toHaveLength(0);
  });

  it('uses work_order entity kind when the SLA target is a work_order', async () => {
    const { supabase, rpcCalls } = makeReassignDeps({
      userRowByPersonId: { 'person-new': { id: 'user-new', person_id: 'person-new' } },
      personIdByUserId: {},
    });
    const svc = new SlaService(supabase as any, {} as any, {} as any);

    const ticket = {
      id: 'wo-1',
      tenant_id: 'ten-1',
      assigned_user_id: null as string | null,
      assigned_team_id: null as string | null,
      watchers: null as string[] | null,
    };
    const timer = { id: 'timer-9', timer_type: 'resolution' as const };
    const threshold = {
      at_percent: 80,
      timer_type: 'resolution' as const,
      action: 'escalate' as const,
      target_type: 'team' as const,
      target_id: 'team-x',
    };

    const changed = await (svc as any).applyReassignment(
      ticket,
      { teamId: 'team-x' },
      'work_order',
      timer,
      threshold,
      'Default SLA',
    );

    expect(changed).toBe(true);
    const assignCalls = rpcCalls.filter((c) => c.fn === 'set_entity_assignment');
    expect(assignCalls).toHaveLength(1);
    expect(assignCalls[0].args.p_entity_kind).toBe('work_order');
    expect(assignCalls[0].args.p_idempotency_key).toBe(
      buildSlaEscalationIdempotencyKey('timer-9', 80, 'resolution'),
    );
    const payload = assignCalls[0].args.p_payload as Record<string, unknown>;
    expect(payload.assigned_team_id).toBe('team-x');
    expect(payload.assigned_user_id).toBeNull();
  });
});

describe('SlaService.fireThreshold — R-A02-2 crossing-insert gates side-effects', () => {
  // R-A02-2 (audit02 CR1): the sla_threshold_crossings UNIQUE
  // (sla_timer_id, at_percent, timer_type) constraint is now the
  // idempotency gate for the NON-idempotent human-facing side-effects
  // (writeActivity + notification + emitEvent). applyReassignment stays
  // idempotent via command_operations and may be called by every tick;
  // only the tick that WINS the crossing insert fires the side-effects.
  //
  // No-permanent-suppression invariant: writeCrossing runs strictly AFTER
  // applyReassignment succeeds. If the RPC throws, fireThreshold throws
  // BEFORE any crossing is written ⇒ a later tick retries cleanly.
  //
  // Best-effort side-effects: after winning the crossing, a notification /
  // activity / event failure is caught+logged and does NOT throw out of
  // fireThreshold (durable state — assignment + crossing — already
  // committed; a retry would now be (correctly) suppressed by the crossing).

  type TimerRow = {
    id: string;
    tenant_id: string;
    ticket_id: string;
    sla_policy_id: string;
    timer_type: 'response' | 'resolution';
    due_at: string;
  };

  function makeFireDeps(opts: {
    // controls writeCrossing INSERT outcome per call index
    crossingInsertResults: Array<{ code?: string } | null>;
  }) {
    const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
    const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
    const rpcCalls: Array<{ fn: string }> = [];
    let crossingInsertIdx = 0;

    const supabase = {
      admin: {
        rpc: async (fn: string) => {
          rpcCalls.push({ fn });
          return { data: { noop: false }, error: null };
        },
        from: (table: string) => {
          if (table === 'sla_threshold_crossings') {
            return {
              insert: (row: Record<string, unknown>) => {
                inserts.push({ table, row });
                const err = opts.crossingInsertResults[crossingInsertIdx] ?? null;
                crossingInsertIdx += 1;
                return Promise.resolve({ error: err });
              },
              update: (patch: Record<string, unknown>) => {
                const chain: Record<string, unknown> = {
                  eq: () => chain,
                  then: (resolve: (v: unknown) => void) => {
                    updates.push({ table, patch });
                    return resolve({ error: null });
                  },
                };
                return chain;
              },
            };
          }
          if (table === 'ticket_activities' || table === 'domain_events') {
            return {
              insert: (row: Record<string, unknown>) => {
                inserts.push({ table, row });
                return Promise.resolve({ error: null });
              },
            };
          }
          throw new Error(`unexpected table in fire mock: ${table}`);
        },
      },
    };
    return { supabase, inserts, updates, rpcCalls };
  }

  function makeSvc(
    supabase: unknown,
    notifications: { send: jest.Mock; sendToTeam: jest.Mock },
  ) {
    const svc = new SlaService(supabase as any, {} as any, notifications as any);
    // Stub the read helpers — the reorder/gating logic is the unit under
    // test, not the cross-table reads.
    jest.spyOn(svc as any, 'loadTicketForFire').mockResolvedValue({
      id: 'tic-1',
      tenant_id: 'ten-1',
      title: 'Broken AC',
      assigned_user_id: 'user-old',
      assigned_team_id: null,
      requester_person_id: 'req-1',
      watchers: [],
      kind: 'case',
    });
    jest.spyOn(svc as any, 'loadPolicyName').mockResolvedValue('P1 SLA');
    jest
      .spyOn(svc as any, 'resolveTarget')
      .mockResolvedValue({ personId: 'person-new' });
    jest
      .spyOn(svc as any, 'resolveTargetName')
      .mockResolvedValue('Alice Manager');
    jest.spyOn(svc as any, 'applyReassignment').mockResolvedValue(true);
    return svc;
  }

  const timer: TimerRow = {
    id: 'timer-1',
    tenant_id: 'ten-1',
    ticket_id: 'tic-1',
    sla_policy_id: 'pol-1',
    timer_type: 'response',
    due_at: new Date().toISOString(),
  };
  const threshold = {
    at_percent: 100,
    timer_type: 'response' as const,
    action: 'escalate' as const,
    target_type: 'manager_of_requester' as const,
    target_id: null,
  };

  it('two sequential ticks: only the crossing-winner fires writeActivity + notification + event; loser does nothing further', async () => {
    // 1st insert succeeds (won), 2nd hits 23505 (lost).
    const { supabase, inserts, updates, rpcCalls } = makeFireDeps({
      crossingInsertResults: [null, { code: '23505' }],
    });
    const notifications = {
      send: jest.fn().mockResolvedValue([{ id: 'notif-1' }]),
      sendToTeam: jest.fn().mockResolvedValue([]),
    };
    const svc = makeSvc(supabase, notifications);
    const writeActivitySpy = jest.spyOn(svc as any, 'writeActivity');

    await (svc as any).fireThreshold(timer, threshold);
    await (svc as any).fireThreshold(timer, threshold);

    // applyReassignment called on BOTH ticks (idempotent via command_operations).
    const applySpy = svc.applyReassignment as unknown as jest.Mock;
    expect(applySpy).toHaveBeenCalledTimes(2);

    // Side-effects fired EXACTLY ONCE (only the winner).
    expect(writeActivitySpy).toHaveBeenCalledTimes(1);
    expect(notifications.send).toHaveBeenCalledTimes(1);

    // Two crossing INSERT attempts (one per tick), but only ONE
    // ticket_activities + ONE domain_events row.
    const crossingInserts = inserts.filter(
      (i) => i.table === 'sla_threshold_crossings',
    );
    expect(crossingInserts).toHaveLength(2);
    expect(inserts.filter((i) => i.table === 'ticket_activities')).toHaveLength(
      1,
    );
    expect(inserts.filter((i) => i.table === 'domain_events')).toHaveLength(1);

    // Winner backfills notification_id onto the crossing row.
    const crossingUpdates = updates.filter(
      (u) => u.table === 'sla_threshold_crossings',
    );
    expect(crossingUpdates).toHaveLength(1);
    expect(crossingUpdates[0].patch.notification_id).toBe('notif-1');

    // applyReassignment (stubbed) is the idempotent v3 boundary; it is
    // invoked on BOTH ticks (asserted above). rpcCalls stays empty because
    // the stub short-circuits the real RPC — the idempotency contract is
    // owned by command_operations inside set_entity_assignment, proven by
    // the concurrency suite, not re-proven here.
    expect(rpcCalls.filter((c) => c.fn === 'set_entity_assignment')).toHaveLength(
      0,
    );
  });

  it('no-permanent-suppression: applyReassignment throws ⇒ NO crossing row written ⇒ a later retry tick can still fire', async () => {
    const { supabase, inserts } = makeFireDeps({
      // first tick never reaches insert; retry tick wins.
      crossingInsertResults: [null],
    });
    const notifications = {
      send: jest.fn().mockResolvedValue([{ id: 'notif-2' }]),
      sendToTeam: jest.fn().mockResolvedValue([]),
    };
    const svc = makeSvc(supabase, notifications);
    const applySpy = svc.applyReassignment as unknown as jest.Mock;
    applySpy.mockRejectedValueOnce(new Error('rpc transient failure'));

    // Tick 1: RPC throws → fireThreshold rejects, NO crossing written.
    await expect((svc as any).fireThreshold(timer, threshold)).rejects.toThrow();
    expect(
      inserts.filter((i) => i.table === 'sla_threshold_crossings'),
    ).toHaveLength(0);
    expect(notifications.send).not.toHaveBeenCalled();

    // Tick 2 (retry): RPC now succeeds, crossing not yet recorded → it CAN
    // fire (not permanently suppressed).
    await (svc as any).fireThreshold(timer, threshold);
    expect(
      inserts.filter((i) => i.table === 'sla_threshold_crossings'),
    ).toHaveLength(1);
    expect(notifications.send).toHaveBeenCalledTimes(1);
  });

  it('best-effort: crossing won but notification throws ⇒ fireThreshold does NOT throw; durable state stands', async () => {
    const { supabase, inserts } = makeFireDeps({
      crossingInsertResults: [null],
    });
    const notifications = {
      send: jest.fn().mockRejectedValue(new Error('notification service down')),
      sendToTeam: jest.fn().mockResolvedValue([]),
    };
    const svc = makeSvc(supabase, notifications);

    await expect(
      (svc as any).fireThreshold(timer, threshold),
    ).resolves.toBeUndefined();

    // Crossing (durable) was claimed; the RPC (durable) ran.
    expect(
      inserts.filter((i) => i.table === 'sla_threshold_crossings'),
    ).toHaveLength(1);
    const applySpy = svc.applyReassignment as unknown as jest.Mock;
    expect(applySpy).toHaveBeenCalledTimes(1);
  });
});
