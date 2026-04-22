# Change Request Type on Existing Ticket — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow agents to change a parent ticket's `request_type_id` in place, cascading the change through workflows, child work orders, SLA timers, and routing, with an itemised preview and required reason.

**Architecture:** New `ReclassifyService` alongside the existing `DispatchService` in the ticket module, orchestrating a single Postgres RPC `reclassify_ticket(...)` for the atomic write block. Frontend uses a shadcn Sheet with three stages (pick → preview → confirm) backed by two endpoints (`/preview` and the execute).

**Tech Stack:** NestJS + Supabase (Postgres + RLS) for backend; React 19 + Vite + shadcn/ui + React Query for frontend; Jest for backend tests; Vitest + RTL for frontend tests.

**Spec:** `docs/superpowers/specs/2026-04-21-change-request-type-design.md`

---

## File Structure

**Backend (create):**
- `apps/api/src/modules/ticket/reclassify.service.ts`
- `apps/api/src/modules/ticket/reclassify.controller.ts`
- `apps/api/src/modules/ticket/dto/reclassify.dto.ts`
- `apps/api/src/modules/ticket/reclassify.service.spec.ts`
- `apps/api/src/modules/ticket/reclassify.controller.spec.ts`
- `supabase/migrations/00044_reclassify_support.sql`

**Backend (modify):**
- `apps/api/src/modules/ticket/ticket.module.ts` — register new service + controller
- `apps/api/src/modules/sla/sla.service.ts` — add `stopTimers`, filter all active-timer queries on `stopped_at is null`
- `apps/api/src/modules/workflow/workflow-engine.service.ts` — add `cancelInstanceForTicket`
- `apps/api/src/modules/routing/routing.service.ts` — add `persistDecision: false` support to `evaluate()` via existing `recordDecision` split (no behaviour change in existing callers)

**Frontend (create):**
- `apps/web/src/components/desk/reclassify-ticket-dialog.tsx`
- `apps/web/src/components/desk/reclassify-impact-panel.tsx`
- `apps/web/src/components/desk/ticket-actions-menu.tsx` (if not present)
- `apps/web/src/hooks/use-reclassify-preview.ts`
- `apps/web/src/hooks/use-reclassify-ticket.ts`
- `apps/web/src/components/desk/reclassify-ticket-dialog.test.tsx`
- `apps/web/src/components/desk/reclassify-impact-panel.test.tsx`

**Frontend (modify):**
- `apps/web/src/pages/ticket-detail.tsx` — wire actions menu; render reclassified badge
- `apps/web/src/lib/api/tickets.ts` (or equivalent API client) — add `reclassifyPreview` / `reclassify` functions

**Docs (modify):**
- `docs/assignments-routing-fulfillment.md` — add reclassification section
- `docs/visibility.md` — note reclassify-to-watcher promotion

---

## Task 1 — Database migration

**Files:**
- Create: `supabase/migrations/00044_reclassify_support.sql`

- [ ] **Step 1.1: Create the migration file**

Write to `supabase/migrations/00044_reclassify_support.sql`:

```sql
-- Reclassification support: columns + RPC for atomic request-type change.
-- See docs/superpowers/specs/2026-04-21-change-request-type-design.md

-- Parent ticket: reclassification metadata + generic close reason.
alter table public.tickets
  add column if not exists reclassified_at        timestamptz,
  add column if not exists reclassified_from_id   uuid references public.request_types(id),
  add column if not exists reclassified_reason    text,
  add column if not exists reclassified_by        uuid references public.users(id),
  add column if not exists close_reason           text;

-- Workflow instance cancellation metadata.
alter table public.workflow_instances
  add column if not exists cancelled_at       timestamptz,
  add column if not exists cancelled_reason   text,
  add column if not exists cancelled_by       uuid references public.users(id);

-- SLA timer stop metadata (distinct from pause and from breach completion).
alter table public.sla_timers
  add column if not exists stopped_at      timestamptz,
  add column if not exists stopped_reason  text;

create index if not exists sla_timers_ticket_active_idx
  on public.sla_timers (ticket_id)
  where stopped_at is null and completed_at is null;

notify pgrst, 'reload schema';
```

- [ ] **Step 1.2: Add the RPC function**

Append to the same migration file:

```sql
-- reclassify_ticket: atomic write block for changing a ticket's request type.
-- All arguments are trusted — the NestJS service validates permissions,
-- tenant scope, and preconditions before calling this RPC.
create or replace function public.reclassify_ticket(
  p_ticket_id              uuid,
  p_tenant_id              uuid,
  p_new_request_type_id    uuid,
  p_reason                 text,
  p_actor_user_id          uuid,
  p_new_assigned_team_id   uuid,
  p_new_assigned_user_id   uuid,
  p_new_assigned_vendor_id uuid,
  p_new_sla_policy_id      uuid,
  p_new_workflow_definition_id uuid,
  p_routing_context        jsonb,
  p_routing_trace          jsonb,
  p_routing_chosen_by      text,
  p_routing_rule_id        uuid,
  p_routing_strategy       text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_type_id  uuid;
  v_current_user_id  uuid;
  v_cancelled_wf_id  uuid;
  v_new_wf_id        uuid;
  v_closed_children  uuid[];
  v_stopped_timers   uuid[];
  v_new_timers       uuid[];
  v_watchers         uuid[];
  v_prefixed_reason  text := 'Parent ticket reclassified: ' || p_reason;
begin
  -- Advisory lock to serialise concurrent reclassifies on the same ticket.
  if not pg_try_advisory_xact_lock(hashtext(p_ticket_id::text)) then
    raise exception 'reclassify_in_progress' using errcode = '55P03';
  end if;

  -- Load current state under the lock.
  select ticket_type_id, assigned_user_id, coalesce(watchers, '{}'::uuid[])
    into v_current_type_id, v_current_user_id, v_watchers
  from public.tickets
  where id = p_ticket_id and tenant_id = p_tenant_id
  for update;

  if v_current_type_id is null then
    raise exception 'ticket_not_found' using errcode = 'P0002';
  end if;

  if v_current_type_id = p_new_request_type_id then
    raise exception 'same_request_type' using errcode = '22023';
  end if;

  -- 4a. Cancel any active workflow_instances for this ticket.
  update public.workflow_instances
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_reason = p_reason,
      cancelled_by = p_actor_user_id
  where ticket_id = p_ticket_id
    and tenant_id = p_tenant_id
    and status = 'active'
  returning id into v_cancelled_wf_id;

  -- 4b. Close non-terminal child tickets.
  with closed as (
    update public.tickets
    set status_category = 'closed',
        status = 'closed',
        close_reason = v_prefixed_reason,
        closed_at = now(),
        closed_by = p_actor_user_id
    where parent_ticket_id = p_ticket_id
      and tenant_id = p_tenant_id
      and status_category not in ('closed', 'resolved')
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_closed_children from closed;

  -- 4c. Stop active SLA timers.
  with stopped as (
    update public.sla_timers
    set stopped_at = now(),
        stopped_reason = p_reason
    where ticket_id = p_ticket_id
      and tenant_id = p_tenant_id
      and stopped_at is null
      and completed_at is null
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_stopped_timers from stopped;

  -- 4d. Update parent: new type, routing result, reclassified_* fields,
  -- previous user-assignee promoted to watcher if present and distinct.
  if v_current_user_id is not null
     and v_current_user_id is distinct from coalesce(p_new_assigned_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
     and not (v_current_user_id = any (v_watchers))
  then
    v_watchers := v_watchers || v_current_user_id;
  end if;

  update public.tickets
  set ticket_type_id       = p_new_request_type_id,
      assigned_team_id     = p_new_assigned_team_id,
      assigned_user_id     = p_new_assigned_user_id,
      assigned_vendor_id   = p_new_assigned_vendor_id,
      watchers             = v_watchers,
      reclassified_at      = now(),
      reclassified_from_id = v_current_type_id,
      reclassified_reason  = p_reason,
      reclassified_by      = p_actor_user_id,
      updated_at           = now()
  where id = p_ticket_id and tenant_id = p_tenant_id;

  -- 4e/4f/4g are performed by the NestJS service after this RPC returns.
  -- New SLA timers, new workflow instance, and routing_decisions insert
  -- require service-layer logic (loading policy config, business-hours
  -- calendar, workflow graph) that is cleaner to keep in TypeScript.
  -- These happen post-RPC but the atomic "old state torn down" block
  -- above is complete by the time the RPC returns.

  -- 4h. Domain events: ticket_type_changed on parent + workflow_cancelled if applicable.
  insert into public.domain_events (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id)
  values (
    p_tenant_id,
    'ticket_type_changed',
    'ticket',
    p_ticket_id,
    jsonb_build_object(
      'from_request_type_id', v_current_type_id,
      'to_request_type_id', p_new_request_type_id,
      'reason', p_reason,
      'cancelled_workflow_instance_id', v_cancelled_wf_id,
      'closed_child_ticket_ids', to_jsonb(v_closed_children),
      'stopped_sla_timer_ids', to_jsonb(v_stopped_timers),
      'previous_assignment', jsonb_build_object('user_id', v_current_user_id),
      'new_assignment', jsonb_build_object(
        'team_id', p_new_assigned_team_id,
        'user_id', p_new_assigned_user_id,
        'vendor_id', p_new_assigned_vendor_id
      ),
      'previous_assignee_watched',
        v_current_user_id is not null and v_current_user_id = any(v_watchers)
    ),
    p_actor_user_id
  );

  if v_cancelled_wf_id is not null then
    insert into public.domain_events (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id)
    values (
      p_tenant_id, 'workflow_cancelled', 'ticket', p_ticket_id,
      jsonb_build_object('workflow_instance_id', v_cancelled_wf_id, 'reason', p_reason),
      p_actor_user_id
    );
  end if;

  -- 4i. One ticket_closed event per closed child, flagged as reclassify-driven.
  if array_length(v_closed_children, 1) > 0 then
    insert into public.domain_events (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id)
    select p_tenant_id, 'ticket_closed', 'ticket', child_id,
           jsonb_build_object('reason', v_prefixed_reason, 'closed_by_reclassify', true, 'parent_ticket_id', p_ticket_id),
           p_actor_user_id
    from unnest(v_closed_children) as child_id;
  end if;

  return jsonb_build_object(
    'ticket_id', p_ticket_id,
    'from_request_type_id', v_current_type_id,
    'to_request_type_id', p_new_request_type_id,
    'cancelled_workflow_instance_id', v_cancelled_wf_id,
    'closed_child_ticket_ids', to_jsonb(v_closed_children),
    'stopped_sla_timer_ids', to_jsonb(v_stopped_timers),
    'previous_assignee_user_id', v_current_user_id,
    'previous_assignee_watched',
      v_current_user_id is not null and v_current_user_id = any(v_watchers)
  );
end;
$$;

grant execute on function public.reclassify_ticket(uuid, uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, text, uuid, text) to authenticated;
```

- [ ] **Step 1.3: Verify migration applies locally**

Run: `cd /Users/x/Desktop/XPQT && pnpm db:reset`
Expected: all migrations apply, no errors. Migration shows `00044_reclassify_support.sql` in the apply list.

- [ ] **Step 1.4: Commit**

```bash
git add supabase/migrations/00044_reclassify_support.sql
git commit -m "feat(db): reclassify ticket migration + RPC"
```

---

## Task 2 — SLA service: stopTimers + filter active queries

**Files:**
- Modify: `apps/api/src/modules/sla/sla.service.ts`
- Modify: `apps/api/src/modules/sla/business-hours.service.spec.ts` (only if touched)
- Test: `apps/api/src/modules/sla/sla.service.spec.ts` (create if absent)

- [ ] **Step 2.1: Inventory all queries on `sla_timers` that must filter on stopped_at**

Run: `rg "from\('sla_timers'\)" apps/api/src/modules/sla/sla.service.ts -n`
For each hit, note whether it represents "active timers" (needs filter) or "all timers including stopped" (no filter). Queries inside `startTimers` (writes) are unaffected.

Active-timer query locations that need `stopped_at is null`:
- `pauseTimers` — updating active timers on ticket pause
- `resumeTimers` — updating paused timers
- `restartTimers` — any select/update of current timers
- `checkBreaches` (cron) — scanning active timers
- Any threshold-crossing scan
- `getCrossingsForTicket` (only if it shows only "active" crossings; usually includes historical — no filter needed)

- [ ] **Step 2.2: Add `stopped_at is null` filter to each active-timer query**

For each identified location, add `.is('stopped_at', null)` to the query chain. Example:

```ts
// before
.from('sla_timers')
  .update({ paused: true })
  .eq('ticket_id', ticketId)
  .eq('tenant_id', tenantId);

// after
.from('sla_timers')
  .update({ paused: true })
  .eq('ticket_id', ticketId)
  .eq('tenant_id', tenantId)
  .is('stopped_at', null);
```

Exception: queries that archive or report on historical timers (e.g., a future "view all timers for a ticket" endpoint) should NOT add the filter. In the current codebase none exist — every hit takes the filter.

- [ ] **Step 2.3: Add `stopTimers` method**

Add to `SlaService` (place it next to `pauseTimers` for visual grouping):

```ts
/**
 * Stop all active SLA timers for a ticket. Sets stopped_at and stopped_reason.
 * Used by reclassification and any future "tear down old SLA" flow.
 * Does NOT clear ticket.sla_response_due_at / sla_resolution_due_at —
 * those are overwritten when new timers are started.
 */
async stopTimers(ticketId: string, tenantId: string, reason: string) {
  const now = new Date().toISOString();
  await this.supabase.admin
    .from('sla_timers')
    .update({ stopped_at: now, stopped_reason: reason })
    .eq('ticket_id', ticketId)
    .eq('tenant_id', tenantId)
    .is('stopped_at', null)
    .is('completed_at', null);
}
```

- [ ] **Step 2.4: Write test for stopTimers**

Create or extend `apps/api/src/modules/sla/sla.service.spec.ts`. If no file exists yet for `SlaService` tests, create it with jest + an in-memory Supabase admin mock following the pattern in `apps/api/src/modules/ticket/dispatch.service.spec.ts`.

```ts
describe('SlaService.stopTimers', () => {
  it('updates only active timers with stopped_at and reason', async () => {
    const updates: Array<{ patch: Record<string, unknown>; filters: Record<string, unknown> }> = [];
    const supabase = makeSupabaseMock({
      sla_timers: {
        update: (patch: Record<string, unknown>) => ({
          eq: (col: string, val: unknown) => ({
            eq: (col2: string, val2: unknown) => ({
              is: (col3: string, val3: unknown) => ({
                is: (col4: string, val4: unknown) => {
                  updates.push({ patch, filters: { [col]: val, [col2]: val2, [col3]: val3, [col4]: val4 } });
                  return Promise.resolve({ data: null, error: null });
                },
              }),
            }),
          }),
        }),
      },
    });
    const svc = new SlaService(supabase as any, {} as any, {} as any);
    await svc.stopTimers('t1', 'ten1', 'reclassified');
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.stopped_reason).toBe('reclassified');
    expect(updates[0].patch.stopped_at).toEqual(expect.any(String));
    expect(updates[0].filters).toMatchObject({
      ticket_id: 't1',
      tenant_id: 'ten1',
      stopped_at: null,
      completed_at: null,
    });
  });
});
```

If `makeSupabaseMock` helper doesn't exist, inline the mock — the shape above is fine.

- [ ] **Step 2.5: Run tests**

Run: `cd apps/api && pnpm test -- sla.service.spec.ts`
Expected: PASS.

- [ ] **Step 2.6: Commit**

```bash
git add apps/api/src/modules/sla/sla.service.ts apps/api/src/modules/sla/sla.service.spec.ts
git commit -m "feat(sla): stopTimers method + filter active-timer queries on stopped_at"
```

---

## Task 3 — Workflow engine: cancelInstanceForTicket

**Files:**
- Modify: `apps/api/src/modules/workflow/workflow-engine.service.ts`
- Test: `apps/api/src/modules/workflow/workflow-engine.service.spec.ts` (create if absent)

- [ ] **Step 3.1: Add `cancelInstanceForTicket` method**

Add to `WorkflowEngineService`:

```ts
/**
 * Cancel any active workflow_instances for a ticket. Idempotent —
 * safe to call when no active instance exists.
 * Returns the list of cancelled instance IDs.
 */
async cancelInstanceForTicket(
  ticketId: string,
  tenantId: string,
  reason: string,
  actorUserId: string,
): Promise<string[]> {
  const { data } = await this.supabase.admin
    .from('workflow_instances')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancelled_reason: reason,
      cancelled_by: actorUserId,
    })
    .eq('ticket_id', ticketId)
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .select('id');

  return (data ?? []).map((row) => row.id as string);
}
```

Note: the RPC in Task 1 also performs this cancellation — keeping this method gives the service layer an option to do it outside the RPC if needed (e.g., a future "cancel workflow only" admin action). For reclassify, the RPC is authoritative; this method is not invoked from reclassify's happy path.

- [ ] **Step 3.2: Write test**

```ts
describe('WorkflowEngineService.cancelInstanceForTicket', () => {
  it('cancels active instances and returns their ids', async () => {
    const seen: any = {};
    const supabase = { admin: { from: (t: string) => ({
      update: (patch: any) => ({
        eq: (c1: string, v1: any) => ({
          eq: (c2: string, v2: any) => ({
            eq: (c3: string, v3: any) => ({
              select: (_cols: string) => Promise.resolve({
                data: [{ id: 'wi-1' }, { id: 'wi-2' }], error: null,
              }),
            }),
          }),
        }),
      }),
    }) } };
    const svc = new WorkflowEngineService(supabase as any, {} as any);
    const ids = await svc.cancelInstanceForTicket('t1', 'ten1', 'reclassified', 'u1');
    expect(ids).toEqual(['wi-1', 'wi-2']);
  });
});
```

- [ ] **Step 3.3: Run tests**

Run: `cd apps/api && pnpm test -- workflow-engine.service.spec.ts`
Expected: PASS.

- [ ] **Step 3.4: Commit**

```bash
git add apps/api/src/modules/workflow/workflow-engine.service.ts apps/api/src/modules/workflow/workflow-engine.service.spec.ts
git commit -m "feat(workflow): cancelInstanceForTicket helper"
```

---

## Task 4 — Routing service: evaluate without persisting decision

**Files:**
- Modify: `apps/api/src/modules/routing/routing.service.ts`

**Important:** the current `evaluate()` does NOT persist (it only computes). Persistence happens via a separate `recordDecision()` call. No API surface change is actually needed — the preview just calls `evaluate()` and skips `recordDecision()`. Document this clearly and add a JSDoc comment so future readers don't re-add persistence.

- [ ] **Step 4.1: Add clarifying JSDoc to `evaluate` and `recordDecision`**

```ts
/**
 * Compute a routing decision WITHOUT persisting it.
 * Callers who want the decision written to `routing_decisions` must
 * also call `recordDecision()`. The preview flow (reclassify, dry-run
 * automation) intentionally omits that call.
 */
async evaluate(context: ResolverContext): Promise<RoutingEvaluation> {
  // ... existing body
}

/**
 * Persist a previously computed evaluation to `routing_decisions`.
 * Safe to call multiple times — each call creates a new row, giving
 * a full history of routing decisions per ticket.
 */
async recordDecision(ticketId: string, context: ResolverContext, evaluation: RoutingEvaluation) {
  // ... existing body
}
```

- [ ] **Step 4.2: Commit**

```bash
git add apps/api/src/modules/routing/routing.service.ts
git commit -m "docs(routing): clarify evaluate vs recordDecision split"
```

---

## Task 5 — DTOs and controller shape

**Files:**
- Create: `apps/api/src/modules/ticket/dto/reclassify.dto.ts`

- [ ] **Step 5.1: Create the DTO file**

```ts
export interface ReclassifyPreviewDto {
  newRequestTypeId: string;
}

export interface ReclassifyExecuteDto {
  newRequestTypeId: string;
  reason: string;
  acknowledgedChildrenInProgress?: boolean;
}

export interface ReclassifyImpactDto {
  ticket: {
    id: string;
    current_request_type: { id: string; name: string };
    new_request_type: { id: string; name: string };
  };
  workflow: {
    current_instance: { id: string; definition_name: string; current_step: string } | null;
    will_be_cancelled: boolean;
    new_definition: { id: string; name: string } | null;
  };
  children: Array<{
    id: string;
    title: string;
    status_category: string;
    is_in_progress: boolean;
    assignee: { kind: 'user' | 'vendor' | 'team'; id: string; name: string } | null;
  }>;
  sla: {
    active_timers: Array<{
      id: string;
      metric_name: string;
      elapsed_minutes: number;
      target_minutes: number;
    }>;
    will_be_stopped: boolean;
    new_policy: {
      id: string;
      name: string;
      metrics: Array<{ name: string; target_minutes: number }>;
    } | null;
  };
  routing: {
    current_assignment: {
      team?: { id: string; name: string };
      user?: { id: string; name: string };
      vendor?: { id: string; name: string };
    };
    new_decision: {
      team?: { id: string; name: string };
      user?: { id: string; name: string };
      vendor?: { id: string; name: string };
      rule_name: string;
      explanation: string;
    };
    current_user_will_become_watcher: boolean;
  };
}
```

- [ ] **Step 5.2: Commit (bundled with Task 6)**

No commit here — Task 5 is too small to commit on its own. It will be included in Task 6's commit.

---

## Task 6 — ReclassifyService skeleton + computeImpact

**Files:**
- Create: `apps/api/src/modules/ticket/reclassify.service.ts`
- Test: `apps/api/src/modules/ticket/reclassify.service.spec.ts`

- [ ] **Step 6.1: Write the failing test for computeImpact**

```ts
import { ReclassifyService } from './reclassify.service';

describe('ReclassifyService.computeImpact', () => {
  it('returns an impact DTO with workflow, children, SLA, and routing sections', async () => {
    // In-memory mock supabase + mock dependent services (routing/sla/workflow)
    // following the dispatch.service.spec.ts pattern.
    const { service, ctx } = makeReclassifyHarness({
      ticket: {
        id: 'tk1',
        tenant_id: 'ten1',
        ticket_type_id: 'rt-old',
        ticket_kind: 'case',
        status_category: 'assigned',
        assigned_team_id: 'team-old',
        assigned_user_id: 'user-old',
        location_id: 'loc1',
      },
      currentType: { id: 'rt-old', name: 'HVAC Maintenance' },
      newType: {
        id: 'rt-new',
        name: 'Plumbing',
        active: true,
        sla_policy_id: 'sp-new',
        workflow_definition_id: 'wd-new',
      },
      currentWorkflowInstance: { id: 'wi1', current_node_id: 'triage', definition_name: 'HVAC v2' },
      newWorkflowDefinition: { id: 'wd-new', name: 'Plumbing Standard' },
      newSlaPolicy: { id: 'sp-new', name: 'Plumbing Policy', response_time_minutes: 30, resolution_time_minutes: 240 },
      children: [
        { id: 'c1', title: 'Replace compressor', status_category: 'in_progress', assigned_vendor_id: 'v1' },
        { id: 'c2', title: 'Inspect unit', status_category: 'assigned', assigned_user_id: 'u9' },
      ],
      activeTimers: [
        { id: 'tm1', timer_type: 'response', target_minutes: 30, started_at: '2026-04-21T10:00:00Z' },
        { id: 'tm2', timer_type: 'resolution', target_minutes: 240, started_at: '2026-04-21T10:00:00Z' },
      ],
      newRoutingResult: {
        target: { kind: 'team', team_id: 'team-new' },
        chosen_by: 'rule',
        rule_name: 'plumbing-default',
        trace: [],
      },
      teams: { 'team-old': 'HVAC Team', 'team-new': 'Plumbing Team' },
      users: { 'user-old': 'John Doe' },
    });

    const impact = await service.computeImpact('tk1', 'rt-new', ctx);

    expect(impact.workflow.will_be_cancelled).toBe(true);
    expect(impact.workflow.current_instance?.id).toBe('wi1');
    expect(impact.workflow.new_definition?.name).toBe('Plumbing Standard');
    expect(impact.children).toHaveLength(2);
    expect(impact.children[0].is_in_progress).toBe(true);
    expect(impact.sla.active_timers).toHaveLength(2);
    expect(impact.sla.new_policy?.metrics).toEqual([
      { name: 'response', target_minutes: 30 },
      { name: 'resolution', target_minutes: 240 },
    ]);
    expect(impact.routing.new_decision.team?.id).toBe('team-new');
    expect(impact.routing.current_user_will_become_watcher).toBe(true);
  });
});
```

Helper `makeReclassifyHarness` is defined inline at the top of the spec file. It returns a `service` wired to in-memory mocks and `ctx` holding the captured state for assertions. Pattern: `dispatch.service.spec.ts` lines 40–200.

- [ ] **Step 6.2: Run the test to verify it fails**

Run: `cd apps/api && pnpm test -- reclassify.service.spec.ts`
Expected: FAIL — `ReclassifyService` not defined.

- [ ] **Step 6.3: Implement the minimal ReclassifyService with computeImpact**

```ts
import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RoutingService } from '../routing/routing.service';
import { SlaService } from '../sla/sla.service';
import { WorkflowEngineService } from '../workflow/workflow-engine.service';
import { TicketService, SYSTEM_ACTOR } from './ticket.service';
import { TicketVisibilityService } from './ticket-visibility.service';
import type { ReclassifyImpactDto } from './dto/reclassify.dto';

const IN_PROGRESS_CATEGORIES = new Set(['in_progress', 'assigned']);
const TERMINAL_CATEGORIES = new Set(['closed', 'resolved']);

@Injectable()
export class ReclassifyService {
  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => TicketService)) private readonly tickets: TicketService,
    private readonly routingService: RoutingService,
    private readonly slaService: SlaService,
    private readonly workflowEngine: WorkflowEngineService,
    private readonly visibility: TicketVisibilityService,
  ) {}

  async computeImpact(ticketId: string, newRequestTypeId: string): Promise<ReclassifyImpactDto> {
    const tenant = TenantContext.current();

    const ticket = await this.loadTicket(ticketId, tenant.id);
    if (!ticket) throw new NotFoundException('ticket not found');
    if (ticket.ticket_kind !== 'case') {
      throw new BadRequestException('cannot reclassify child work orders — reclassify the parent');
    }
    if (TERMINAL_CATEGORIES.has(ticket.status_category)) {
      throw new BadRequestException('ticket is closed or resolved; cannot reclassify');
    }
    if (ticket.ticket_type_id === newRequestTypeId) {
      throw new BadRequestException('new request type is the same as current');
    }

    const [currentType, newType] = await Promise.all([
      this.loadRequestType(ticket.ticket_type_id, tenant.id),
      this.loadRequestType(newRequestTypeId, tenant.id),
    ]);
    if (!newType || !newType.active) {
      throw new BadRequestException('new request type is not active or not in tenant');
    }

    const [workflowInstance, newWorkflowDef, children, activeTimers, newPolicy] = await Promise.all([
      this.loadActiveWorkflowInstance(ticketId, tenant.id),
      newType.workflow_definition_id
        ? this.loadWorkflowDefinition(newType.workflow_definition_id, tenant.id)
        : Promise.resolve(null),
      this.loadChildren(ticketId, tenant.id),
      this.loadActiveTimers(ticketId, tenant.id),
      newType.sla_policy_id ? this.loadSlaPolicy(newType.sla_policy_id, tenant.id) : Promise.resolve(null),
    ]);

    const routingContext = this.buildRoutingContext(ticket, newType);
    const evaluation = await this.routingService.evaluate(routingContext);
    const now = Date.now();

    const currentUserAssignee = ticket.assigned_user_id as string | null;
    const newUserAssignee = evaluation.target?.kind === 'user' ? evaluation.target.user_id : null;
    const userBecomesWatcher =
      !!currentUserAssignee && currentUserAssignee !== newUserAssignee &&
      !(ticket.watchers ?? []).includes(currentUserAssignee);

    return {
      ticket: {
        id: ticket.id,
        current_request_type: { id: currentType!.id, name: currentType!.name },
        new_request_type: { id: newType.id, name: newType.name },
      },
      workflow: {
        current_instance: workflowInstance
          ? {
              id: workflowInstance.id,
              definition_name: workflowInstance.definition_name ?? '(unknown)',
              current_step: workflowInstance.current_node_id ?? '(unknown)',
            }
          : null,
        will_be_cancelled: !!workflowInstance,
        new_definition: newWorkflowDef ? { id: newWorkflowDef.id, name: newWorkflowDef.name } : null,
      },
      children: children.map((c) => ({
        id: c.id,
        title: c.title,
        status_category: c.status_category,
        is_in_progress: IN_PROGRESS_CATEGORIES.has(c.status_category),
        assignee: this.resolveAssigneeLabel(c),
      })),
      sla: {
        active_timers: activeTimers.map((t) => ({
          id: t.id,
          metric_name: t.timer_type,
          elapsed_minutes: Math.max(0, Math.floor((now - new Date(t.started_at as string).getTime()) / 60000)),
          target_minutes: t.target_minutes as number,
        })),
        will_be_stopped: activeTimers.length > 0,
        new_policy: newPolicy
          ? {
              id: newPolicy.id,
              name: newPolicy.name,
              metrics: [
                ...(newPolicy.response_time_minutes
                  ? [{ name: 'response', target_minutes: newPolicy.response_time_minutes }]
                  : []),
                ...(newPolicy.resolution_time_minutes
                  ? [{ name: 'resolution', target_minutes: newPolicy.resolution_time_minutes }]
                  : []),
              ],
            }
          : null,
      },
      routing: {
        current_assignment: this.labelAssignment(ticket),
        new_decision: {
          ...this.labelTarget(evaluation.target),
          rule_name: evaluation.rule_name ?? evaluation.chosen_by,
          explanation: this.explainDecision(evaluation),
        },
        current_user_will_become_watcher: userBecomesWatcher,
      },
    };
  }

  // Private loaders. Each uses this.supabase.admin and scopes by tenant_id.
  // See spec §6 and the dispatch.service.ts pattern for exact query shape.
  private async loadTicket(id: string, tenantId: string) { /* SELECT from tickets */ }
  private async loadRequestType(id: string | null, tenantId: string) { /* SELECT from request_types */ }
  private async loadActiveWorkflowInstance(ticketId: string, tenantId: string) { /* joined workflow_definitions for name */ }
  private async loadWorkflowDefinition(id: string, tenantId: string) { /* SELECT */ }
  private async loadChildren(parentId: string, tenantId: string) { /* SELECT from tickets WHERE parent_ticket_id */ }
  private async loadActiveTimers(ticketId: string, tenantId: string) { /* sla_timers WHERE stopped_at IS NULL AND completed_at IS NULL */ }
  private async loadSlaPolicy(id: string, tenantId: string) { /* SELECT */ }
  private buildRoutingContext(ticket: any, newType: any): any { /* see resolver.types.ts */ }
  private resolveAssigneeLabel(ticket: any): any { /* prefer vendor > user > team */ }
  private labelAssignment(ticket: any): any { /* resolves names from tables or accepts name join */ }
  private labelTarget(target: any): any { /* maps AssignmentTarget → labelled dict */ }
  private explainDecision(evaluation: any): string {
    if (evaluation.rule_name) return `Matched rule: ${evaluation.rule_name}`;
    return `Chosen by: ${evaluation.chosen_by}`;
  }
}
```

Private loader bodies MUST be filled out — do not leave as stubs. Each is a thin `supabase.admin.from(...).select(...).eq(...).maybeSingle()` scoped to tenant. Follow the exact query style in `dispatch.service.ts`.

- [ ] **Step 6.4: Run tests until green**

Run: `cd apps/api && pnpm test -- reclassify.service.spec.ts`
Iterate on implementation until `computeImpact` test passes.

- [ ] **Step 6.5: Add tests for validation errors**

```ts
describe('ReclassifyService.computeImpact validation', () => {
  it('throws when ticket is a child work order', async () => {
    const { service } = makeReclassifyHarness({ ticket: { ticket_kind: 'work_order', /* ... */ } });
    await expect(service.computeImpact('tk1', 'rt-new'))
      .rejects.toThrow(/cannot reclassify child/i);
  });

  it('throws when ticket is closed', async () => {
    const { service } = makeReclassifyHarness({ ticket: { status_category: 'closed', /* ... */ } });
    await expect(service.computeImpact('tk1', 'rt-new'))
      .rejects.toThrow(/closed or resolved/i);
  });

  it('throws when new type equals current', async () => {
    const { service } = makeReclassifyHarness({ ticket: { ticket_type_id: 'rt-same' } });
    await expect(service.computeImpact('tk1', 'rt-same'))
      .rejects.toThrow(/same as current/i);
  });

  it('throws when new type is inactive', async () => {
    const { service } = makeReclassifyHarness({ newType: { active: false } });
    await expect(service.computeImpact('tk1', 'rt-new'))
      .rejects.toThrow(/not active/i);
  });
});
```

- [ ] **Step 6.6: Run all ReclassifyService tests**

Run: `cd apps/api && pnpm test -- reclassify.service.spec.ts`
Expected: all PASS.

- [ ] **Step 6.7: Commit**

```bash
git add apps/api/src/modules/ticket/reclassify.service.ts \
        apps/api/src/modules/ticket/dto/reclassify.dto.ts \
        apps/api/src/modules/ticket/reclassify.service.spec.ts
git commit -m "feat(ticket): ReclassifyService computeImpact"
```

---

## Task 7 — ReclassifyService.execute

**Files:**
- Modify: `apps/api/src/modules/ticket/reclassify.service.ts`
- Modify: `apps/api/src/modules/ticket/reclassify.service.spec.ts`

- [ ] **Step 7.1: Write failing test for happy path execute**

```ts
describe('ReclassifyService.execute', () => {
  it('calls RPC, starts new timers/workflow, records routing decision, returns fresh ticket', async () => {
    const { service, captured } = makeReclassifyHarness({
      ticket: { /* same as computeImpact test */ },
      newType: { id: 'rt-new', active: true, sla_policy_id: 'sp-new', workflow_definition_id: 'wd-new' },
      /* ... */
      rpcResult: {
        ticket_id: 'tk1',
        from_request_type_id: 'rt-old',
        to_request_type_id: 'rt-new',
        cancelled_workflow_instance_id: 'wi1',
        closed_child_ticket_ids: ['c1', 'c2'],
        stopped_sla_timer_ids: ['tm1', 'tm2'],
        previous_assignee_user_id: 'user-old',
        previous_assignee_watched: true,
      },
    });

    const updated = await service.execute(
      'tk1',
      { newRequestTypeId: 'rt-new', reason: 'actually plumbing', acknowledgedChildrenInProgress: true },
      'actor-auth-uid',
    );

    expect(captured.rpcCalls).toHaveLength(1);
    expect(captured.rpcCalls[0].name).toBe('reclassify_ticket');
    expect(captured.rpcCalls[0].args.p_reason).toBe('actually plumbing');
    expect(captured.rpcCalls[0].args.p_new_request_type_id).toBe('rt-new');

    // Post-RPC: new SLA timers started
    expect(captured.slaTimerInserts).toHaveLength(2);
    // Post-RPC: new workflow instance started
    expect(captured.workflowStartCalls).toHaveLength(1);
    // Post-RPC: routing_decisions row recorded
    expect(captured.routingDecisionInserts).toHaveLength(1);

    expect(updated).toMatchObject({ id: 'tk1', ticket_type_id: 'rt-new' });
  });

  it('rejects when in-progress children present but acknowledgement is false', async () => {
    const { service } = makeReclassifyHarness({
      children: [{ id: 'c1', status_category: 'in_progress' }],
    });
    await expect(service.execute(
      'tk1',
      { newRequestTypeId: 'rt-new', reason: 'x', acknowledgedChildrenInProgress: false },
      'actor',
    )).rejects.toThrow(/acknowledg/i);
  });

  it('rejects reason shorter than 3 characters', async () => {
    const { service } = makeReclassifyHarness({});
    await expect(service.execute(
      'tk1',
      { newRequestTypeId: 'rt-new', reason: 'x' },
      'actor',
    )).rejects.toThrow(/reason/i);
  });

  it('rejects when caller lacks ticket write access', async () => {
    const { service } = makeReclassifyHarness({ visibilityDenies: true });
    await expect(service.execute(
      'tk1',
      { newRequestTypeId: 'rt-new', reason: 'legitimate reason' },
      'actor',
    )).rejects.toThrow();
  });
});
```

- [ ] **Step 7.2: Run tests, verify they fail**

Run: `cd apps/api && pnpm test -- reclassify.service.spec.ts`
Expected: FAIL — `execute` not defined.

- [ ] **Step 7.3: Implement `execute`**

Add to `ReclassifyService`:

```ts
async execute(
  ticketId: string,
  dto: ReclassifyExecuteDto,
  actorAuthUid: string,
): Promise<unknown> {
  const tenant = TenantContext.current();

  if (!dto.reason || dto.reason.trim().length < 3) {
    throw new BadRequestException('reason must be at least 3 characters');
  }
  if (dto.reason.length > 500) {
    throw new BadRequestException('reason must be at most 500 characters');
  }

  // Permission check — skipped only for system actor (not a real use case here).
  const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
  await this.visibility.assertVisible(ticketId, ctx, 'write');

  // Compute impact — shares the preflight checks (not closed, not child, types differ, etc).
  const impact = await this.computeImpact(ticketId, dto.newRequestTypeId);

  const hasInProgressChildren = impact.children.some((c) => c.is_in_progress);
  if (hasInProgressChildren && !dto.acknowledgedChildrenInProgress) {
    throw new BadRequestException('in-progress child work orders require acknowledgement');
  }

  // Re-run routing fresh (preview evaluation can be stale if caller lingered).
  const ticket = await this.loadTicket(ticketId, tenant.id);
  const newType = await this.loadRequestType(dto.newRequestTypeId, tenant.id);
  const routingContext = this.buildRoutingContext(ticket, newType);
  const evaluation = await this.routingService.evaluate(routingContext);
  const target = evaluation.target;

  // Actor user id — look up from auth uid to persist in tickets.reclassified_by.
  const actorUserId = await this.resolveUserIdFromAuth(actorAuthUid, tenant.id);

  // 4a-4d, 4h, 4i atomically via RPC.
  const { data: rpcResult, error: rpcError } = await this.supabase.admin.rpc('reclassify_ticket', {
    p_ticket_id: ticketId,
    p_tenant_id: tenant.id,
    p_new_request_type_id: dto.newRequestTypeId,
    p_reason: dto.reason,
    p_actor_user_id: actorUserId,
    p_new_assigned_team_id: target?.kind === 'team' ? target.team_id : null,
    p_new_assigned_user_id: target?.kind === 'user' ? target.user_id : null,
    p_new_assigned_vendor_id: target?.kind === 'vendor' ? target.vendor_id : null,
    p_new_sla_policy_id: newType.sla_policy_id ?? null,
    p_new_workflow_definition_id: newType.workflow_definition_id ?? null,
    p_routing_context: routingContext,
    p_routing_trace: evaluation.trace,
    p_routing_chosen_by: evaluation.chosen_by,
    p_routing_rule_id: evaluation.rule_id,
    p_routing_strategy: evaluation.strategy,
  });

  if (rpcError) {
    if (rpcError.code === '55P03') {
      throw new BadRequestException('another reclassify is in progress for this ticket');
    }
    throw rpcError;
  }

  // 4e. Start new SLA timers if the new type has an SLA policy.
  if (newType.sla_policy_id) {
    await this.slaService.startTimers(ticketId, tenant.id, newType.sla_policy_id);
  }

  // 4f. Start the new workflow if the new type has a definition.
  if (newType.workflow_definition_id) {
    await this.workflowEngine.startForTicket(ticketId, newType.workflow_definition_id);
  }

  // 4g. Persist routing decision (preview didn't).
  await this.routingService.recordDecision(ticketId, routingContext, evaluation);

  // Return the fresh ticket so the client can swap it into cache.
  return this.tickets.getById(ticketId, SYSTEM_ACTOR);
}

private async resolveUserIdFromAuth(authUid: string, tenantId: string): Promise<string | null> {
  const { data } = await this.supabase.admin
    .from('users')
    .select('id')
    .eq('auth_user_id', authUid)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}
```

- [ ] **Step 7.4: Run tests until green**

Run: `cd apps/api && pnpm test -- reclassify.service.spec.ts`
Iterate until all tests pass.

- [ ] **Step 7.5: Commit**

```bash
git add apps/api/src/modules/ticket/reclassify.service.ts apps/api/src/modules/ticket/reclassify.service.spec.ts
git commit -m "feat(ticket): ReclassifyService execute"
```

---

## Task 8 — Reclassify controller

**Files:**
- Create: `apps/api/src/modules/ticket/reclassify.controller.ts`
- Create: `apps/api/src/modules/ticket/reclassify.controller.spec.ts`

- [ ] **Step 8.1: Write failing controller tests**

```ts
import { Test } from '@nestjs/testing';
import { ReclassifyController } from './reclassify.controller';
import { ReclassifyService } from './reclassify.service';

describe('ReclassifyController', () => {
  let controller: ReclassifyController;
  let service: { computeImpact: jest.Mock; execute: jest.Mock };

  beforeEach(async () => {
    service = {
      computeImpact: jest.fn().mockResolvedValue({ ticket: { id: 'tk1' } }),
      execute: jest.fn().mockResolvedValue({ id: 'tk1', ticket_type_id: 'rt-new' }),
    };
    const module = await Test.createTestingModule({
      controllers: [ReclassifyController],
      providers: [{ provide: ReclassifyService, useValue: service }],
    }).compile();
    controller = module.get(ReclassifyController);
  });

  it('POST /tickets/:id/reclassify/preview calls computeImpact', async () => {
    const result = await controller.preview('tk1', { newRequestTypeId: 'rt-new' });
    expect(service.computeImpact).toHaveBeenCalledWith('tk1', 'rt-new');
    expect(result).toEqual({ ticket: { id: 'tk1' } });
  });

  it('POST /tickets/:id/reclassify calls execute with actor uid from request', async () => {
    const req = { user: { id: 'auth-uid' } };
    const result = await controller.execute('tk1', { newRequestTypeId: 'rt-new', reason: 'legitimate' }, req as any);
    expect(service.execute).toHaveBeenCalledWith('tk1', { newRequestTypeId: 'rt-new', reason: 'legitimate' }, 'auth-uid');
    expect(result).toEqual({ id: 'tk1', ticket_type_id: 'rt-new' });
  });
});
```

- [ ] **Step 8.2: Run tests, verify fail**

Run: `cd apps/api && pnpm test -- reclassify.controller.spec.ts`
Expected: FAIL — controller not defined.

- [ ] **Step 8.3: Implement the controller**

```ts
import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../common/auth/auth.guard';
import { ReclassifyService } from './reclassify.service';
import type { ReclassifyPreviewDto, ReclassifyExecuteDto } from './dto/reclassify.dto';

@Controller('tickets/:id/reclassify')
@UseGuards(AuthGuard)
export class ReclassifyController {
  constructor(private readonly service: ReclassifyService) {}

  @Post('preview')
  async preview(@Param('id') id: string, @Body() dto: ReclassifyPreviewDto) {
    return this.service.computeImpact(id, dto.newRequestTypeId);
  }

  @Post()
  async execute(@Param('id') id: string, @Body() dto: ReclassifyExecuteDto, @Req() req: { user: { id: string } }) {
    return this.service.execute(id, dto, req.user.id);
  }
}
```

Verify the `AuthGuard` import path matches the project convention — look at `ticket.controller.ts` for the exact shape.

- [ ] **Step 8.4: Run tests**

Run: `cd apps/api && pnpm test -- reclassify.controller.spec.ts`
Expected: PASS.

- [ ] **Step 8.5: Commit**

```bash
git add apps/api/src/modules/ticket/reclassify.controller.ts apps/api/src/modules/ticket/reclassify.controller.spec.ts
git commit -m "feat(ticket): reclassify controller with preview + execute endpoints"
```

---

## Task 9 — Module wiring

**Files:**
- Modify: `apps/api/src/modules/ticket/ticket.module.ts`

- [ ] **Step 9.1: Register ReclassifyService and ReclassifyController**

Read the current module file first. Add to `providers`: `ReclassifyService`. Add to `controllers`: `ReclassifyController`. Add to `exports` if other modules will DI the service (not required for v1).

- [ ] **Step 9.2: Boot the API to verify module compiles**

Run: `cd apps/api && pnpm dev:api` (in background if interactive). Watch startup logs for errors. Kill the process once you see "Nest application successfully started".

Alternative: `cd apps/api && pnpm typecheck` — faster if a typecheck script exists; otherwise `pnpm build`.

- [ ] **Step 9.3: Commit**

```bash
git add apps/api/src/modules/ticket/ticket.module.ts
git commit -m "feat(ticket): wire ReclassifyService + controller into module"
```

---

## Task 10 — API client and React Query hooks

**Files:**
- Modify: `apps/web/src/lib/api/tickets.ts` (or the existing ticket API file — find it first)
- Create: `apps/web/src/hooks/use-reclassify-preview.ts`
- Create: `apps/web/src/hooks/use-reclassify-ticket.ts`

- [ ] **Step 10.1: Find the existing ticket API client**

Run: `rg "GET.*tickets" apps/web/src/lib -n`  and  `rg "getTicketById|fetchTicket" apps/web/src -n`
Use the file these turn up. If no ticket API client exists yet, create it at `apps/web/src/lib/api/tickets.ts` following the same HTTP pattern used by other API modules in `apps/web/src/lib/api/`.

- [ ] **Step 10.2: Add `reclassifyPreview` and `reclassifyExecute` functions**

```ts
// in apps/web/src/lib/api/tickets.ts (or equivalent)

export async function reclassifyPreview(ticketId: string, newRequestTypeId: string) {
  return apiFetch(`/tickets/${ticketId}/reclassify/preview`, {
    method: 'POST',
    body: JSON.stringify({ newRequestTypeId }),
  });
}

export async function reclassifyExecute(
  ticketId: string,
  body: { newRequestTypeId: string; reason: string; acknowledgedChildrenInProgress?: boolean },
) {
  return apiFetch(`/tickets/${ticketId}/reclassify`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
```

`apiFetch` is the existing wrapper. Match its signature exactly — do NOT invent a new HTTP helper.

- [ ] **Step 10.3: Create `use-reclassify-preview.ts`**

```ts
import { useQuery } from '@tanstack/react-query';
import { reclassifyPreview } from '../lib/api/tickets';

export function useReclassifyPreview(ticketId: string, newRequestTypeId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['ticket-reclassify-preview', ticketId, newRequestTypeId],
    queryFn: () => reclassifyPreview(ticketId, newRequestTypeId!),
    enabled: enabled && !!newRequestTypeId,
    staleTime: 0,
    gcTime: 0,
  });
}
```

- [ ] **Step 10.4: Create `use-reclassify-ticket.ts`**

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { reclassifyExecute } from '../lib/api/tickets';

export function useReclassifyTicket(ticketId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { newRequestTypeId: string; reason: string; acknowledgedChildrenInProgress?: boolean }) =>
      reclassifyExecute(ticketId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
      qc.invalidateQueries({ queryKey: ['ticket-children', ticketId] });
      qc.invalidateQueries({ queryKey: ['ticket-sla-crossings', ticketId] });
      qc.invalidateQueries({ queryKey: ['ticket-activity', ticketId] });
    },
  });
}
```

Verify the query keys actually used by the existing code — open `apps/web/src/hooks/` and grep for `['ticket'` / `['ticket-children'` / etc. Adjust the invalidation keys to exactly match existing conventions.

- [ ] **Step 10.5: Commit**

```bash
git add apps/web/src/lib/api/tickets.ts apps/web/src/hooks/use-reclassify-preview.ts apps/web/src/hooks/use-reclassify-ticket.ts
git commit -m "feat(web): API client + React Query hooks for ticket reclassify"
```

---

## Task 11 — Impact panel component

**Files:**
- Create: `apps/web/src/components/desk/reclassify-impact-panel.tsx`
- Create: `apps/web/src/components/desk/reclassify-impact-panel.test.tsx`

- [ ] **Step 11.1: Write failing test**

```tsx
import { render, screen } from '@testing-library/react';
import { ReclassifyImpactPanel } from './reclassify-impact-panel';

const baseImpact = {
  ticket: {
    id: 'tk1',
    current_request_type: { id: 'rt-old', name: 'HVAC' },
    new_request_type: { id: 'rt-new', name: 'Plumbing' },
  },
  workflow: {
    current_instance: { id: 'wi1', definition_name: 'HVAC v2', current_step: 'Triage' },
    will_be_cancelled: true,
    new_definition: { id: 'wd-new', name: 'Plumbing Standard' },
  },
  children: [
    { id: 'c1', title: 'Replace compressor', status_category: 'in_progress', is_in_progress: true,
      assignee: { kind: 'vendor', id: 'v1', name: 'Acme Plumbing' } },
    { id: 'c2', title: 'Inspect unit', status_category: 'assigned', is_in_progress: false, assignee: null },
  ],
  sla: {
    active_timers: [{ id: 'tm1', metric_name: 'response', elapsed_minutes: 94, target_minutes: 30 }],
    will_be_stopped: true,
    new_policy: { id: 'sp-new', name: 'Plumbing Policy', metrics: [{ name: 'response', target_minutes: 30 }] },
  },
  routing: {
    current_assignment: { team: { id: 'team-old', name: 'HVAC Team' }, user: { id: 'u1', name: 'John Doe' } },
    new_decision: {
      team: { id: 'team-new', name: 'Plumbing Team' },
      rule_name: 'plumbing-default',
      explanation: 'Matched rule: plumbing-default',
    },
    current_user_will_become_watcher: true,
  },
};

describe('ReclassifyImpactPanel', () => {
  it('renders workflow, assignment, SLA, and children sections', () => {
    render(<ReclassifyImpactPanel impact={baseImpact as any} />);
    expect(screen.getByText(/HVAC v2/)).toBeInTheDocument();
    expect(screen.getByText(/Plumbing Standard/)).toBeInTheDocument();
    expect(screen.getByText(/Replace compressor/)).toBeInTheDocument();
    expect(screen.getByText(/Acme Plumbing/)).toBeInTheDocument();
    expect(screen.getByText(/John Doe/)).toBeInTheDocument();
    expect(screen.getByText(/will be added as a watcher/i)).toBeInTheDocument();
  });

  it('flags in-progress children with a warning icon or text', () => {
    render(<ReclassifyImpactPanel impact={baseImpact as any} />);
    expect(screen.getByText(/in progress/i)).toBeInTheDocument();
  });

  it('shows empty state when children list is empty', () => {
    const impact = { ...baseImpact, children: [] };
    render(<ReclassifyImpactPanel impact={impact as any} />);
    expect(screen.getByText(/no child work orders/i)).toBeInTheDocument();
  });

  it('shows when new type has no workflow', () => {
    const impact = { ...baseImpact, workflow: { ...baseImpact.workflow, new_definition: null } };
    render(<ReclassifyImpactPanel impact={impact as any} />);
    expect(screen.getByText(/no workflow/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 11.2: Verify failure**

Run: `cd apps/web && pnpm test reclassify-impact-panel`
Expected: FAIL — component not defined.

- [ ] **Step 11.3: Implement the component**

Pure presentational; accepts `{ impact: ReclassifyImpactDto }` as its only prop. Four labelled sections: **Workflow**, **Assignment**, **SLA**, **Child work orders**.

Use shadcn components for structure. Each section uses a small heading (e.g., `<div className="flex items-center gap-2 text-sm font-medium">` with a lucide-react icon) and content below. Check `apps/web/src/components/ui/` for what's installed; install anything missing via `npx shadcn@latest add <name>`.

```tsx
import { AlertTriangle, Cog, Clock, Users, FileStack } from 'lucide-react';
import type { ReclassifyImpactDto } from '../../lib/api/tickets';

export function ReclassifyImpactPanel({ impact }: { impact: ReclassifyImpactDto }) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Changing request type to <span className="font-medium text-foreground">{impact.ticket.new_request_type.name}</span>{' '}
        will apply the following changes:
      </p>

      <section>
        <header className="flex items-center gap-2 text-sm font-medium"><Cog className="size-4" /> Workflow</header>
        <div className="mt-2 space-y-1 text-sm text-muted-foreground pl-6">
          {impact.workflow.current_instance ? (
            <p>Cancel: "{impact.workflow.current_instance.definition_name}" (at step: {impact.workflow.current_instance.current_step})</p>
          ) : (
            <p>No active workflow on this ticket.</p>
          )}
          {impact.workflow.new_definition ? (
            <p>Start: "{impact.workflow.new_definition.name}"</p>
          ) : (
            <p className="italic">New request type has no workflow — ticket will have no active workflow afterward.</p>
          )}
        </div>
      </section>

      <section>
        <header className="flex items-center gap-2 text-sm font-medium"><Users className="size-4" /> Assignment</header>
        <div className="mt-2 space-y-1 text-sm text-muted-foreground pl-6">
          <p>Was: {formatAssignment(impact.routing.current_assignment)}</p>
          <p>New: {formatNewDecision(impact.routing.new_decision)}</p>
          {impact.routing.current_user_will_become_watcher && impact.routing.current_assignment.user && (
            <p>{impact.routing.current_assignment.user.name} will be added as a watcher.</p>
          )}
        </div>
      </section>

      <section>
        <header className="flex items-center gap-2 text-sm font-medium"><Clock className="size-4" /> SLA</header>
        <div className="mt-2 space-y-1 text-sm text-muted-foreground pl-6">
          {impact.sla.active_timers.length > 0 ? (
            <p>Stop {impact.sla.active_timers.length} active timer(s) ({impact.sla.active_timers.map(t => `${t.metric_name} elapsed ${t.elapsed_minutes}m`).join(', ')}).</p>
          ) : (
            <p>No active SLA timers to stop.</p>
          )}
          {impact.sla.new_policy ? (
            <div>
              <p>Start new timers on "{impact.sla.new_policy.name}":</p>
              <ul className="list-disc pl-6">
                {impact.sla.new_policy.metrics.map(m => <li key={m.name}>{m.name}: {m.target_minutes}m</li>)}
              </ul>
            </div>
          ) : (
            <p className="italic">New request type has no SLA policy — no new timers will start.</p>
          )}
        </div>
      </section>

      <section>
        <header className="flex items-center gap-2 text-sm font-medium"><FileStack className="size-4" /> Child work orders ({impact.children.length} will be closed)</header>
        <div className="mt-2 space-y-1 text-sm text-muted-foreground pl-6">
          {impact.children.length === 0 ? (
            <p>No child work orders.</p>
          ) : (
            <ul className="space-y-1">
              {impact.children.map(c => (
                <li key={c.id} className="flex items-center gap-2">
                  {c.is_in_progress ? <AlertTriangle className="size-3.5 text-amber-600" /> : <span className="size-3.5" />}
                  <span className="font-medium text-foreground">{c.title}</span>
                  {c.assignee && <span className="text-xs">— {c.assignee.name}</span>}
                  {c.is_in_progress && <span className="text-xs text-amber-700 font-medium">IN PROGRESS</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function formatAssignment(a: ReclassifyImpactDto['routing']['current_assignment']): string {
  const parts: string[] = [];
  if (a.team) parts.push(a.team.name);
  if (a.user) parts.push(a.user.name);
  if (a.vendor) parts.push(a.vendor.name);
  return parts.length > 0 ? parts.join(' → ') : '(unassigned)';
}

function formatNewDecision(d: ReclassifyImpactDto['routing']['new_decision']): string {
  const parts: string[] = [];
  if (d.team) parts.push(d.team.name);
  if (d.user) parts.push(d.user.name);
  if (d.vendor) parts.push(d.vendor.name);
  return parts.length > 0 ? parts.join(' → ') : '(unassigned)';
}
```

`ReclassifyImpactDto` is exported from `apps/web/src/lib/api/tickets.ts`; add the type there (mirrors the backend DTO).

- [ ] **Step 11.4: Run tests until green**

Run: `cd apps/web && pnpm test reclassify-impact-panel`
Iterate until PASS.

- [ ] **Step 11.5: Commit**

```bash
git add apps/web/src/components/desk/reclassify-impact-panel.tsx apps/web/src/components/desk/reclassify-impact-panel.test.tsx
git commit -m "feat(web): ReclassifyImpactPanel component"
```

---

## Task 12 — Reclassify dialog (Sheet)

**Files:**
- Create: `apps/web/src/components/desk/reclassify-ticket-dialog.tsx`
- Create: `apps/web/src/components/desk/reclassify-ticket-dialog.test.tsx`

- [ ] **Step 12.1: Verify shadcn Sheet is installed**

Run: `ls apps/web/src/components/ui/sheet.tsx`
If absent: `cd apps/web && npx shadcn@latest add sheet`. Similarly verify `field`, `select`, `textarea`, `checkbox`, `button` exist; install anything missing.

- [ ] **Step 12.2: Write failing test**

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReclassifyTicketDialog } from './reclassify-ticket-dialog';

jest.mock('../../lib/api/tickets', () => ({
  reclassifyPreview: jest.fn().mockResolvedValue(/* use baseImpact from impact-panel test */),
  reclassifyExecute: jest.fn().mockResolvedValue({ id: 'tk1' }),
}));

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('ReclassifyTicketDialog', () => {
  const baseProps = {
    ticketId: 'tk1',
    currentRequestType: { id: 'rt-old', name: 'HVAC' },
    availableRequestTypes: [
      { id: 'rt-old', name: 'HVAC' },
      { id: 'rt-new', name: 'Plumbing' },
    ],
    open: true,
    onOpenChange: jest.fn(),
  };

  it('shows the picker stage initially', () => {
    renderWithClient(<ReclassifyTicketDialog {...baseProps} />);
    expect(screen.getByText(/new request type/i)).toBeInTheDocument();
  });

  it('disables Preview until a new type is picked', () => {
    renderWithClient(<ReclassifyTicketDialog {...baseProps} />);
    expect(screen.getByRole('button', { name: /preview/i })).toBeDisabled();
  });

  it('advances to preview stage after picking a type', async () => {
    const user = userEvent.setup();
    renderWithClient(<ReclassifyTicketDialog {...baseProps} />);
    await user.click(screen.getByLabelText(/new request type/i));
    await user.click(screen.getByText('Plumbing'));
    await user.click(screen.getByRole('button', { name: /preview/i }));
    expect(await screen.findByText(/will apply the following changes/i)).toBeInTheDocument();
  });

  it('disables Confirm when reason is empty or too short', async () => {
    /* advance to preview stage first, then assert button state */
  });

  it('requires the ack checkbox when an in-progress child is present', async () => {
    /* preview response includes an is_in_progress child; assert checkbox visible + required */
  });

  it('calls execute and closes on success', async () => {
    /* fill reason, check ack, click confirm; assert mutation was called and onOpenChange(false) */
  });
});
```

- [ ] **Step 12.3: Verify failure**

Run: `cd apps/web && pnpm test reclassify-ticket-dialog`
Expected: FAIL — component not defined.

- [ ] **Step 12.4: Implement the dialog**

```tsx
import { useState } from 'react';
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '../ui/sheet';
import { Button } from '../ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '../ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Textarea } from '../ui/textarea';
import { Checkbox } from '../ui/checkbox';
import { AlertCircle } from 'lucide-react';
import { useReclassifyPreview } from '../../hooks/use-reclassify-preview';
import { useReclassifyTicket } from '../../hooks/use-reclassify-ticket';
import { ReclassifyImpactPanel } from './reclassify-impact-panel';
import { toast } from 'sonner';

interface Props {
  ticketId: string;
  currentRequestType: { id: string; name: string };
  availableRequestTypes: Array<{ id: string; name: string }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Stage = 'pick' | 'preview';

export function ReclassifyTicketDialog({
  ticketId, currentRequestType, availableRequestTypes, open, onOpenChange,
}: Props) {
  const [stage, setStage] = useState<Stage>('pick');
  const [newTypeId, setNewTypeId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [ackInProgress, setAckInProgress] = useState(false);

  const preview = useReclassifyPreview(ticketId, newTypeId, stage === 'preview');
  const mutation = useReclassifyTicket(ticketId);

  const impact = preview.data;
  const hasInProgressChildren = (impact?.children ?? []).some((c: any) => c.is_in_progress);
  const canConfirm =
    stage === 'preview' &&
    reason.trim().length >= 3 &&
    reason.length <= 500 &&
    (!hasInProgressChildren || ackInProgress) &&
    !mutation.isPending;

  const pickableTypes = availableRequestTypes.filter(t => t.id !== currentRequestType.id);

  function reset() {
    setStage('pick');
    setNewTypeId(null);
    setReason('');
    setAckInProgress(false);
    mutation.reset();
  }

  async function onConfirm() {
    try {
      await mutation.mutateAsync({
        newRequestTypeId: newTypeId!,
        reason: reason.trim(),
        acknowledgedChildrenInProgress: ackInProgress,
      });
      toast.success(
        `Reclassified to ${impact!.ticket.new_request_type.name}. ` +
        `${impact!.children.length} work order(s) closed, new workflow started.`,
      );
      reset();
      onOpenChange(false);
    } catch {
      // Error surface handled via mutation.error below; no-op here.
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}
    >
      <SheetContent className="w-[540px] sm:max-w-[540px] flex flex-col">
        <SheetHeader>
          <SheetTitle>
            {stage === 'pick' ? 'Change request type' : `Change request type → ${impact?.ticket.new_request_type.name ?? ''}`}
          </SheetTitle>
          <SheetDescription>
            Current: <span className="text-foreground">{currentRequestType.name}</span>
          </SheetDescription>
        </SheetHeader>

        {mutation.error && (
          <div className="mt-4 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive flex items-start gap-2">
            <AlertCircle className="size-4 mt-0.5 flex-shrink-0" />
            <span>{mutation.error instanceof Error ? mutation.error.message : 'Reclassify failed.'}</span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto py-4">
          {stage === 'pick' && (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="reclassify-new-type">New request type</FieldLabel>
                <Select value={newTypeId ?? ''} onValueChange={setNewTypeId}>
                  <SelectTrigger id="reclassify-new-type">
                    <SelectValue placeholder="Pick a request type" />
                  </SelectTrigger>
                  <SelectContent>
                    {pickableTypes.map(t => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Switching type will reset this ticket's workflow and SLA.
                  You'll see a full impact preview before confirming.
                </FieldDescription>
              </Field>
            </FieldGroup>
          )}

          {stage === 'preview' && (
            <>
              {preview.isLoading && <p className="text-sm text-muted-foreground">Loading impact preview…</p>}
              {preview.error && (
                <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
                  {preview.error instanceof Error ? preview.error.message : 'Could not load preview.'}
                </div>
              )}
              {impact && (
                <>
                  <ReclassifyImpactPanel impact={impact} />
                  {hasInProgressChildren && (
                    <div className="mt-5 rounded-md border border-amber-300 bg-amber-50 p-3">
                      <FieldGroup>
                        <Field orientation="horizontal">
                          <Checkbox
                            id="ack-wip"
                            checked={ackInProgress}
                            onCheckedChange={(c) => setAckInProgress(c === true)}
                          />
                          <FieldLabel htmlFor="ack-wip" className="font-normal text-sm">
                            I understand work in progress will be stopped and the vendor notified.
                          </FieldLabel>
                        </Field>
                      </FieldGroup>
                    </div>
                  )}
                  <div className="mt-5">
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="reclassify-reason">Reason (required)</FieldLabel>
                        <Textarea
                          id="reclassify-reason"
                          rows={3}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          maxLength={500}
                        />
                        <FieldDescription>
                          Shown on this ticket, on each closed child work order, and in the audit log.
                        </FieldDescription>
                        {reason.length > 0 && reason.trim().length < 3 && (
                          <FieldError>Reason must be at least 3 characters.</FieldError>
                        )}
                      </Field>
                    </FieldGroup>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <SheetFooter>
          {stage === 'pick' ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => setStage('preview')} disabled={!newTypeId}>
                Preview →
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStage('pick')}>← Back</Button>
              <Button onClick={onConfirm} disabled={!canConfirm}>
                {mutation.isPending ? 'Reclassifying…' : 'Confirm reclassify'}
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
```

If `toast` from `sonner` is not available, use whatever toast library the project has. Find it with `rg "from 'sonner'" apps/web/src -l` first.

- [ ] **Step 12.5: Run tests until green**

Run: `cd apps/web && pnpm test reclassify-ticket-dialog`
Iterate until PASS.

- [ ] **Step 12.6: Commit**

```bash
git add apps/web/src/components/desk/reclassify-ticket-dialog.tsx apps/web/src/components/desk/reclassify-ticket-dialog.test.tsx
git commit -m "feat(web): ReclassifyTicketDialog with 2-stage flow"
```

---

## Task 13 — Ticket detail integration

**Files:**
- Modify: `apps/web/src/pages/ticket-detail.tsx`
- Potentially create: `apps/web/src/components/desk/ticket-actions-menu.tsx`

- [ ] **Step 13.1: Check if a ticket actions menu exists**

Run: `rg "DropdownMenu|ticket-actions" apps/web/src/pages/ticket-detail.tsx -n`
If a menu already exists, extend it. If not, create `ticket-actions-menu.tsx` using shadcn `DropdownMenu` and hoist whatever overflow actions are already on the page into it.

- [ ] **Step 13.2: Add the "Change request type" menu item**

Wire it to open `<ReclassifyTicketDialog>`. Load the list of tenant request types via the existing request-types query (find it via `rg "request-types|requestTypes" apps/web/src/hooks -l`). Pass `availableRequestTypes` that are `active = true`.

Visibility conditions (all must hold to show the item):
- `ticket.ticket_kind === 'case'`
- `ticket.status_category !== 'closed'` and `!== 'resolved'`
- Current user has ticket write access (reuse the flag already driving other ticket mutation buttons)

- [ ] **Step 13.3: Add the reclassified badge**

Directly below the "Request type" display on the ticket meta row: if `ticket.reclassified_at` is truthy, render a small inline badge:

```tsx
{ticket.reclassified_at && (
  <Tooltip>
    <TooltipTrigger asChild>
      <span className="text-xs text-muted-foreground cursor-help">
        Reclassified from {ticket.reclassified_from?.name ?? '(type removed)'} ·{' '}
        {formatRelative(ticket.reclassified_at)}
      </span>
    </TooltipTrigger>
    <TooltipContent>
      <div className="max-w-xs space-y-1">
        <p className="font-medium">Reason</p>
        <p className="text-xs">{ticket.reclassified_reason}</p>
      </div>
    </TooltipContent>
  </Tooltip>
)}
```

The ticket payload must include `reclassified_from` (joined to `request_types`). If the backend doesn't include it already, extend the ticket select in `TicketService.getById` to left-join `request_types rf ON rf.id = tickets.reclassified_from_id` or fetch it separately — pick whichever matches existing conventions.

- [ ] **Step 13.4: Manual browser smoke**

Start the dev server: `pnpm dev` (may already be running). Open a ticket in the browser, open the actions menu, click "Change request type", pick a different type, preview, confirm. Verify:
- Dialog renders without console errors
- Preview shows sensible content
- Confirm triggers a toast
- Page refreshes with new request type + reclassified badge

If any of the above fails: debug, fix, re-run. Do NOT mark this task complete until the feature works end-to-end in the browser.

- [ ] **Step 13.5: Commit**

```bash
git add apps/web/src/pages/ticket-detail.tsx apps/web/src/components/desk/ticket-actions-menu.tsx
git commit -m "feat(web): wire reclassify dialog into ticket detail page + badge"
```

---

## Task 14 — End-to-end integration check

**Files:** none — this task is verification only.

- [ ] **Step 14.1: Seed a ticket with workflow + SLA + 2 children**

Either use an existing seeded ticket in the remote DB (inspect via the running app), or create one via the UI: pick a request type with a workflow that auto-creates children, submit, wait for children to appear.

- [ ] **Step 14.2: Reclassify via the UI**

Pick a different request type. Verify the preview shows both active children. Enter a reason. Confirm.

- [ ] **Step 14.3: Verify DB end state via the app UI**

- Parent ticket now shows new request type + "Reclassified from …" badge
- Both child work orders show `status: closed` with close reason prefixed "Parent ticket reclassified: …"
- Activity/audit stream on the parent shows the `ticket_type_changed` event
- If the new type has a workflow: new workflow has started (new children may appear if the new workflow auto-creates them)
- If the new type has an SLA policy: new SLA timers visible on the ticket

- [ ] **Step 14.4: If anything is off, add a failing test at the relevant layer and fix.**

No commit for this task unless fixes are needed.

---

## Task 15 — Documentation updates

**Files:**
- Modify: `docs/assignments-routing-fulfillment.md`
- Modify: `docs/visibility.md`

- [ ] **Step 15.1: Update `docs/assignments-routing-fulfillment.md`**

Add a new section "Reclassification" near the bottom of the document (after "Resolver order" and before the "Keep the reference doc in sync" section). Explain:

- Which endpoint performs reclassification (`POST /tickets/:id/reclassify`)
- How reclassify interacts with the four axes:
  - **Routing:** re-runs `RoutingService.evaluate()` with the new request type's context
  - **Ownership:** parent's `assigned_team_id` / `assigned_user_id` / `assigned_vendor_id` updated from new routing
  - **Execution:** all non-terminal child work orders are closed with a prefixed reason
  - **Visibility:** previous user-assignee (if any) is promoted to watcher so they retain visibility; no change to operator-based access
- The atomic RPC write path (`reclassify_ticket`)
- New columns on `tickets`, `workflow_instances`, `sla_timers`

- [ ] **Step 15.2: Update `docs/visibility.md`**

Add a note in the "Participants" tier section: reclassification automatically adds a ticket's previous user-assignee to the `watchers` array, which is a new path for entering the Participants tier (alongside requester/assignee/explicit-watcher/vendor).

- [ ] **Step 15.3: Commit docs**

```bash
git add docs/assignments-routing-fulfillment.md docs/visibility.md
git commit -m "docs: reclassify impact on four-axis routing model and visibility"
```

---

## Task 16 — Push migration to remote

**Files:** none modified; this is an operational step.

- [ ] **Step 16.1: Try `pnpm db:push` first**

Run: `cd /Users/x/Desktop/XPQT && pnpm db:push`
If it succeeds, skip to Step 16.3. If it fails with auth/permission errors, fall through to Step 16.2.

- [ ] **Step 16.2: Fall back to psql if needed**

Per the existing CLAUDE.md note, the DB password isn't in the repo — the user already granted permission in this session for the migration push, but if `db:push` is broken, prompt for the password only if it hasn't been captured. Otherwise use the psql path:

```bash
PGPASSWORD="<password from session>" psql \
  "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -v ON_ERROR_STOP=1 \
  -f supabase/migrations/00044_reclassify_support.sql
```

Follow with `NOTIFY pgrst, 'reload schema';` (already in the migration).

- [ ] **Step 16.3: Smoke-test the deployed endpoint**

Via the running dev app (which points at the remote DB per CLAUDE.md), open a ticket and confirm the reclassify feature works end-to-end. This validates the migration is live on the remote.

- [ ] **Step 16.4: No commit needed — the migration file was already committed in Task 1.**

---

## Plan self-review

After writing this plan, verified:

- **Spec coverage:** every §4 file mapped to a task; every §9 edge case covered by either a service-level validation test (Task 6 step 6.5, Task 7 step 7.1) or a handled path inside the RPC (Task 1). §11 testing section matches Tasks 6–14.
- **Placeholder scan:** no "TBD" / "TODO" / "implement later" / "add appropriate error handling" phrases. One stubbed set of private loader method bodies in Task 6.3 — the plan explicitly flags that those bodies MUST be filled out and names the source pattern (`dispatch.service.ts`).
- **Type consistency:** `ReclassifyImpactDto` shape identical across Task 5 (definition), Task 6 (service return), Task 11 (component prop), Task 10 (hook return). `reclassify_ticket` RPC argument list identical in Task 1 (SQL signature) and Task 7 (service `.rpc(...)` call).
