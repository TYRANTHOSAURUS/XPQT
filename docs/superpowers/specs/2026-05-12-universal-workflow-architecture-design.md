# Universal Workflow Architecture (Booking Workflows + Cross-Entity Spawn)

**Status:** v2 — REMEDIATED, READY FOR USER APPROVAL. Plan-review
Checkpoint 1 (parallel plan + approach reviewers) complete; CRITICAL
fact-foundation findings corrected directly; architectural pivots
flagged in §9 as open questions for user decision.

**Authors:** Claude main (architecture decision + implementation phasing) +
codex (spawn-and-wait nuance + workflow_instance_links table shape) +
Claude main (5 missing-pieces additions: wait conditions, timeouts,
resume mechanism, cancellation propagation, multi-spawn aggregation) +
v2 plan-review remediation (2 parallel reviewers — see revision history).

## Revision history

- 2026-05-12 — v1 draft. Establishes Option 3 architecture. Phases 0-5
  estimated at 6-10 weeks.
- 2026-05-12 — **v2 plan-review remediation.** Two parallel adversarial
  reviewers (plan-reviewer + approach-reviewer). Six CRITICAL findings
  corrected directly: (a) reuse existing `workflow_definitions.entity_type`
  column instead of adding a parallel `entity_kind` (the column has
  shipped since 00009:8 with default `'ticket'`); (b) avoid re-introducing
  the strict polymorphic CHECK constraint that 00239 retired because it
  conflicted with `ON DELETE SET NULL` FKs from 00238; (c) `booking.edited`
  is NOT an outbox event — it's a `domain_events`/`audit_events` row at
  00364:980,1006 — corrected §1.4, §2, §3.5; (d) `aggregation_strategy`
  CHECK enum corrected to include `'quorum'` literal + remove the
  meaningless `null` IN-clause; (e) editor location corrected to
  single-file `apps/web/src/pages/admin/workflow-editor.tsx`; (f) noted
  the engine hardcodes `target_entity_type: 'ticket'` at
  `workflow-engine.service.ts:421,601` — Phase 1 must polymorphize.
  Three IMPORTANT findings: cancellation hook at
  `workflow-engine.service.ts:142` is ticket-scoped and needs
  generalization scoped explicitly (§3.6); multi-spawn aggregation race
  needs a row-locking story (§3.7); Phase 4 scope widened to reflect
  greenfield-like effort. Five architectural pivots surfaced to §9 open
  questions for user decision (spawn-and-wait decomposition;
  cancellation default flip; pulling Phase 5 forward; multi-spawn YAGNI
  in v1; cron-vs-outbox MVP choice).

## 0. Scope contract

**Goal:** unify the workflow story across all primary entity kinds
(today: `case`, `work_order`; new: `booking`; future: `visitor`,
`asset`). One editor surface, primary-entity-typed workflows, explicit
cross-entity spawn nodes with continue/wait modes.

**Decision:** Option 3 (one editor, primary-entity-typed workflows,
explicit cross-entity spawn nodes). Rejected alternatives:

- **Option 1 (mixed entity-kinds in a single workflow_instance).**
  Breaks audit semantics (which entity does the row belong to?),
  permission scoping, lifecycle queries, and debugging. The single-
  entity polymorphism added in `00228_step1c7_workflow_instances_polymorphic.sql`
  is a load-bearing simplification.
- **Option 2 (separate editors per entity kind).** Real workflows ARE
  cross-entity ("service request needs a room"). Modeling that as N
  workflows with bridge events is a usability disaster — author has to
  understand bridge mechanism, debug across N instances, see fragmented
  state.

**In scope (Phases 0-5 below):**
- Schema extension: extend the `workflow_definitions.entity_type` value
  set (existing column at `00009_workflows.sql:8`, default `'ticket'`)
  to align with the polymorphic instance vocabulary (`'case' |
  'work_order' | 'booking'` — backfill the existing `'ticket'` rows
  per Phase 0). Add `'booking'` to `workflow_instances.entity_kind`
  CHECK + `booking_id` polymorphic column.
- New table `workflow_instance_links` for parent-child spawn tracking.
- Engine extension: waiting-state, wake mechanism, cancellation
  propagation, multi-spawn aggregation.
- Booking-side primary nodes (`update_booking`, `cancel_booking`,
  `transition_booking_status`, etc.).
- Cross-entity boundary nodes (`spawn_booking_from_ticket`,
  `spawn_work_order_from_booking`, etc.) with both spawn modes.
- Editor UI: kind picker on workflow create, palette filtering per
  primary kind + boundary nodes for other kinds.
- Audit-trail UI for the workflow chain view.

**Not in scope (deferred):**
- Visitor workflows (separate spec when visitor module catches up).
- Asset workflows.
- Fully rebuilt editor UI — incremental enhancement only.
- Complex BPMN constructs beyond the 5 patterns listed (parallel
  gateways with race conditions, signal events, escalation timers
  beyond simple wait-timeouts).
- Automated migration of existing ticket workflows. Existing
  definitions stay; new ones use the new shape; schema is additive.
- Approval-workflow migration (room rule's `approval_config` jsonb →
  visual workflow) — possible Phase 5 but probably its own spec.

## 0.1 Source-of-truth contract

| Field | Source | Constraint |
|---|---|---|
| `workflow_definitions.entity_type` | Set at creation, IMMUTABLE. Existing column from 00009:8 — Phase 0 widens its accepted values + backfills `'ticket'` → `'case'` or `'work_order'` from each row's existing instance set. | New definition for new kind. Note: column name stays `entity_type` (no parallel `entity_kind` column on definitions — single SoT). |
| `workflow_instances.entity_kind` + `<kind>_id` | Inherited from definition + provided at start | One entity per instance (the polymorphism rule from 00228) |
| `workflow_instance_links.*` | Frozen at spawn time | Re-deployed parent definitions don't change in-flight semantics |
| `spawn_node_config.wait_*` | Authored in editor → frozen into link row | Engine consults the link row, not the live definition |
| Cross-entity actions | Only via explicit `spawn_*` nodes | No implicit event-routing across entity kinds |

## 1. Survey — existing state

### 1.1 workflow_instances polymorphism

`supabase/migrations/00009_workflows.sql:28` defines the table. Was
ticket-only at create time. `00228_step1c7_workflow_instances_polymorphic.sql:8-11`
added:

```sql
add column if not exists entity_kind text
  check (entity_kind in ('case', 'work_order')),
add column if not exists case_id uuid references public.tickets(id) on delete cascade,
add column if not exists work_order_id uuid references public.work_orders(id) on delete cascade;
```

`00230_step1c_polymorphic_auto_derive.sql:67` added auto-derivation
logic. `00238_step1c_post_review_fk_disaster.sql:62-68` reset the FK
constraints. `00345_workflow_instances_active_unique_idx.sql` added the
active-uniqueness index used by Step 12 of B.2.A.

**Implication:** the polymorphism pattern is already established for 2
entity kinds. Phase 0 extends this to 3 (`'booking'` + `booking_id`).

### 1.2 Workflow engine node types

`apps/api/src/modules/workflow/workflow-engine.service.ts` (~997 lines)
implements 11 node types: `trigger`, `assign`, `update_ticket`,
`notification`, `condition`, `create_child_tasks`, `approval`,
`wait_for`, `timer`, `end`, `http_request`.

Notable:
- `assign` cut over to `set_entity_assignment` RPC in B.2.A Step 9
  (`workflow-engine.service.ts:254`).
- `update_ticket` cut over to `update_entity_combined` RPC in B.2.A
  Step 9 with a 14-field allowlist `UPDATE_TICKET_ALLOWED_FIELDS`
  (line :88). 19 orphan fields are documented in
  `docs/follow-ups/b2-followups.md` "Workflow update_ticket orphan
  fields".
- `create_child_tasks` cut over to `dispatch_child_work_orders_batch`
  RPC in B.2.A Step 8 with all-or-nothing HALT semantics
  (`workflow-engine.service.ts:467`).
- `wait_for` (line :623) and `timer` (line :641) exist but operate on
  WALL-CLOCK time / external signals — they are NOT the same as
  spawn-and-wait described below. Spawn-and-wait is structurally
  different (waits for a specific child workflow_instance OR entity
  state); reuse the wait_for primitive only if its shape genuinely
  generalizes (verify during Phase 1 design review).

### 1.3 Cross-entity orchestration today

`create_child_tasks` (workflow-engine.service.ts:467) is the existing
cross-entity precedent: a ticket workflow dispatches N child
work_orders via the `dispatch_child_work_orders_batch` RPC. This is
fire-and-forget — parent workflow does NOT wait for child work_orders
to complete.

There is NO bidirectional pattern today (work_order workflows can't
spawn tickets). This spec generalizes both directions.

### 1.4 Booking lifecycle today

Bookings are created via `create_booking_with_attach_plan` RPC
(`supabase/migrations/00309_create_booking_with_attach_plan_rpc.sql`).
Approval logic is hardcoded across:
- `room_booking_rules.approval_config` (jsonb edited as raw JSON
  today)
- `create_booking_with_attach_plan` (insert chain rows at create time
  if rule outcome = `require_approval`)
- `grant_booking_approval` RPC (`00310`)
- `edit_booking` v4 §3.6.5 (`00364`) 10-row reconciliation table

**Approval workflows are operational, not visual-editor-defined.**
This spec lays the groundwork for Phase 5 (or a future spec) to
migrate approval-config jsonb → visual workflow.

Booking lifecycle events (audited verbatim against current code 2026-05-12):
- Create: implicit. No outbox event today. `booking-flow.service.ts:389,582`
  insert a `booking.created` row into `audit_events` (TS-side audit only,
  not outbox) — there's no event to subscribe to from a workflow wake
  handler.
- Edit: **NOT an outbox event today.** `00364_edit_booking_rpc_v4.sql:980,1006`
  inserts `booking.edited` into `audit_events` and `domain_events` — the
  `outbox.emit(...)` calls in the same RPC emit only
  `booking.location_changed` (00364:1022), `booking.cost_changed`
  (00364:1042), `booking.approval_required` (00364:1065), and
  `sla.timer_repointed_required` (00364:1087). Phase 1's wake handler
  cannot subscribe to `booking.edited` without first promoting it from
  domain_event to outbox event.
- Approval state changes: `booking.approval_required` outbox event
  emitted by `edit_booking` (00364:1063) and `grant_booking_approval`.
  v1 stub consumer registered in `apps/api/src/modules/outbox/handlers/booking-approval-required.handler.ts`
  (logs, no notification dispatch — deferred to B.4.A.5).
- Cancel: `delete_booking_with_guard` RPC (00292). `reservation.service.ts:464,506`
  emits a `booking.cancelled` `audit_events` row (TS-side, not outbox).
  No outbox event.
- Status change (confirmed → checked_in → released): not currently
  emitted as audit OR outbox events. State transitions today happen
  through `edit_booking` (slot patches) and magic-link check-in
  handlers — no centralised state-machine RPC exists (see open question 4).

**Implication for Phase 1:** the resume mechanism (waking parent
workflows on child entity status changes) needs new outbox event
types or a cron-based polling fallback. See §5.6.

### 1.5 Outbox infrastructure

Established pattern at `apps/api/src/modules/outbox/`:
- Producers emit via `outbox.emit(...)` from inside PL/pgSQL RPCs
  (atomic with the domain mutation).
- Consumers register via `@OutboxHandler('event.type', { version: N })`
  + listed in `OutboxModule.providers`.
- Handler skeleton: `apps/api/src/modules/outbox/handlers/sla-timer-repoint.handler.ts`
  is the canonical reference.
- Dead-letter pattern: throw `DeadLetterError` for terminal failures,
  `Error` for transient.

Phase 1's wake mechanism plugs into this infrastructure — no new
infrastructure needed.

## 2. Bug / gap inventory

1. **Booking workflows do not exist.** `entity_kind` enum supports
   `'case' | 'work_order'`. Booking lifecycle hooks have no workflow
   integration.
2. **Approval config is hand-edited JSON.** `room_booking_rules.approval_config`
   jsonb requires admin-via-API-or-SQL editing. No UI affordance.
3. **Cross-entity orchestration is one-directional.** Tickets can spawn
   work_orders (`create_child_tasks`); other directions are absent.
4. **No spawn-and-wait primitive.** `create_child_tasks` is
   fire-and-forget. Workflows that need "ticket waits until booking
   confirmed" can't be expressed today.
5. **No parent-child link table.** `workflow_instances` doesn't track
   "this instance was spawned by that one." Audit + debugging across
   workflow chains is impossible.
6. **Workflow editor UI is ticket-shaped.** Inspector panel, node
   palette, trigger configuration all assume tickets. Per the user's
   triage prompt: "a lot of stuff is broken there." Triage is its own
   exercise (recommend `docs/follow-ups/workflow-editor-breakage-2026-05-12.md`)
   — this spec assumes the editor UI is tractable, not rebuilt.
7. **Booking lifecycle outbox events are partial.** The 4 outbox events
   from booking-related RPCs are `booking.location_changed`,
   `booking.cost_changed`, `booking.approval_required` (all from
   `edit_booking` 00364), and `sla.timer_repointed_required` (also from
   00364, but emits on a `work_orders` aggregate). `booking.edited`
   exists as a `domain_events`/`audit_events` row only — NOT outbox.
   Missing entirely (audit + outbox) for Phase 1: `booking.created`,
   `booking.cancelled`, `booking.status_changed` (confirmed → checked_in
   → released etc.). Each requires a producer migration before the
   wake handler can subscribe.
8. **Workflow engine is hardcoded to `entity_type='ticket'`.**
   `workflow-engine.service.ts:421,601` emit `related_entity_type:
   'ticket'` and `target_entity_type: 'ticket'` literally. Phase 1 must
   polymorphize these emit sites to read the instance's actual
   entity_kind. Otherwise booking-side workflow runs would emit
   misleading audit rows.

## 3. Architectural shape

### 3.1 Polymorphism extension (Phase 0)

**Re-use, do not duplicate, the existing `workflow_definitions.entity_type`
column.** Plan-review found this column already exists at
`00009_workflows.sql:8` (`entity_type text not null default 'ticket'`)
and is actively read/written by `workflow.service.ts:23,51,119` and the
public API at `workflow.controller.ts:26`. The v1 draft proposed adding
a parallel `entity_kind` column with different value vocabulary
(`'case'/'work_order'/'booking'` vs the existing `'ticket'` default) —
that would have split SoT. Phase 0 widens the existing column instead.

**The 00239 lesson on CHECK vs FK SET NULL.** Plan-review surfaced a
direct-regression risk: `workflow_instances_kind_matches_fk`
(00228:23-28) was DROPPED in `00239_step1c_round5_fixes.sql:25-26`
explicitly because it conflicted with `ON DELETE SET NULL` FKs added
in 00238 (00239:3 — "kind_matches_fk check constraints conflict with
ON DELETE SET NULL"). Re-introducing a stricter one-of CHECK in 00367
would reproduce the bug 00239 fixed: parent delete → FK SET NULL on
the polymorphic id → CHECK refuses → parent delete blocked. Phase 0
therefore uses **partial unique indices + a defensive trigger** rather
than a single one-of CHECK, mirroring the post-00239 polymorphic
shape.

Migration `00367` (next free slot — `00366_workflow_events_add_node_failed.sql`
just shipped; verified 2026-05-12):

```sql
-- workflow_definitions: WIDEN the existing entity_type column's
-- accepted vocabulary; backfill 'ticket' rows to their actual kind by
-- joining to existing workflow_instances and reading the polymorphic
-- side, defaulting to 'case' when no instance exists yet.
alter table public.workflow_definitions
  drop constraint if exists workflow_definitions_entity_type_check;
update public.workflow_definitions wd
  set entity_type = coalesce((
    select case when wi.entity_kind = 'work_order' then 'work_order' else 'case' end
      from public.workflow_instances wi
     where wi.workflow_definition_id = wd.id
       and wi.entity_kind is not null
     order by wi.started_at desc
     limit 1
  ), 'case')
  where wd.entity_type = 'ticket';
alter table public.workflow_definitions
  add constraint workflow_definitions_entity_type_check
    check (entity_type in ('case', 'work_order', 'booking'));

-- workflow_instances: widen the entity_kind CHECK to admit 'booking'.
alter table public.workflow_instances
  drop constraint if exists workflow_instances_entity_kind_check;
alter table public.workflow_instances
  add constraint workflow_instances_entity_kind_check
    check (entity_kind in ('case', 'work_order', 'booking'));
alter table public.workflow_instances
  add column if not exists booking_id uuid
    references public.bookings(id) on delete set null;
  -- ON DELETE SET NULL (not CASCADE) mirrors 00238:67-69 for case_id
  -- and work_order_id. The 00239 lesson: cascading deletes through
  -- workflow_instances would orphan workflow audit rows and
  -- workflow_instance_links. The post-00239 contract is "entity
  -- delete clears the polymorphic id; instance row + audit chain
  -- survive".

-- Polymorphism enforcement WITHOUT the 00239-incompatible one-of CHECK:
-- (a) Partial unique indices already exist for case_id and work_order_id
--     (00228:30-33). Add a matching one for booking_id.
-- (b) A BEFORE INSERT trigger asserts the one-of invariant ONLY at
--     insert time — does NOT block FK SET NULL post-delete.
create index if not exists idx_wi_booking
  on public.workflow_instances (booking_id) where booking_id is not null;

create or replace function public.assert_workflow_instance_polymorphism()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT') then
    if not (
      (new.entity_kind = 'case'       and new.case_id is not null and new.work_order_id is null and new.booking_id is null) or
      (new.entity_kind = 'work_order' and new.work_order_id is not null and new.case_id is null and new.booking_id is null) or
      (new.entity_kind = 'booking'    and new.booking_id is not null and new.case_id is null and new.work_order_id is null)
    ) then
      raise exception 'workflow_instance.polymorphism_violation: entity_kind=% case_id=% work_order_id=% booking_id=%',
        new.entity_kind, new.case_id, new.work_order_id, new.booking_id;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists workflow_instances_assert_polymorphism on public.workflow_instances;
create trigger workflow_instances_assert_polymorphism
  before insert on public.workflow_instances
  for each row execute function public.assert_workflow_instance_polymorphism();
```

Auto-derive logic at `00230_step1c_polymorphic_auto_derive.sql:67`
reads `tickets.ticket_kind` (no booking equivalent). Phase 0 extends
the trigger function `derive_polymorphic_entity_from_ticket_id` with
an early-return when `entity_kind` is already set (the booking-side
spawn path will set it explicitly), preserving the case/work_order
auto-derive behavior. Blast radius note: the same trigger also fires
on `sla_timers` and `routing_decisions` (00230:62-77) — the
early-return is safe for both because they target the same polymorphic
shape.

### 3.2 workflow_instance_links table (Phase 0)

```sql
create table public.workflow_instance_links (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null,  -- #0 invariant
  parent_instance_id       uuid not null
    references public.workflow_instances(id) on delete cascade,
  parent_node_id           text not null,  -- WHICH node spawned this (for resume-here)
  child_instance_id        uuid null
    references public.workflow_instances(id) on delete set null,  -- nullable: spawn-without-workflow
  parent_entity_kind       text not null,  -- denormalized; survives parent deletion
  parent_entity_id         uuid not null,
  child_entity_kind        text not null,
  child_entity_id          uuid not null,
  spawn_mode               text not null
    check (spawn_mode in ('continue', 'wait')),
  -- wait_* columns relevant only when spawn_mode='wait':
  wait_for                 text null
    check (wait_for in ('workflow_terminal', 'entity_status', 'either')),
  entity_terminal_statuses text[] null,
  wait_timeout_at          timestamptz null,
  on_timeout_branch        text null,  -- branch label in parent workflow if timeout fires
  -- Cancellation cascade:
  on_parent_cancel         text not null
    default 'orphan_child'
    check (on_parent_cancel in ('cancel_child', 'orphan_child')),
  -- Resolution audit:
  resolved_at              timestamptz null,
  resolution_kind          text null
    check (resolution_kind in ('condition_met', 'timeout', 'parent_cancelled', null)),
  -- Aggregation when one parent node spawns multiple children:
  aggregation_group_id     uuid null,  -- shared across siblings spawned by the same node invocation
  aggregation_strategy     text null
    check (aggregation_strategy in ('all', 'any', 'first', null)),
  aggregation_quorum_n     int null,  -- when strategy='quorum_N'
  created_at               timestamptz not null default now()
);

alter table public.workflow_instance_links enable row level security;
create index idx_wil_tenant on public.workflow_instance_links (tenant_id);
create index idx_wil_parent on public.workflow_instance_links (parent_instance_id);
create index idx_wil_child on public.workflow_instance_links (child_instance_id) where child_instance_id is not null;
create index idx_wil_waiting on public.workflow_instance_links (resolved_at, wait_timeout_at)
  where resolved_at is null and spawn_mode = 'wait';
```

**Why denormalize `parent_entity_kind` + `parent_entity_id` + `child_entity_kind` + `child_entity_id`:** survives parent workflow_instance deletion (audit row stays); makes audit-chain queries faster (no join through workflow_instances); freezes the contract at spawn time so editor changes to the workflow definition don't retroactively change semantics.

**RLS policy:** mirror `workflow_instances` RLS shape (tenant_id-scoped via `auth.uid()` → `tenant_id`).

### 3.3 Spawn node taxonomy

Two user-visible spawn nodes per cross-entity boundary:

| Node label | spawn_mode | When to use |
|---|---|---|
| "Spawn X (continue immediately)" | `continue` | Parent doesn't care about child's outcome. Fire-and-forget. |
| "Spawn X and wait" | `wait` | Parent depends on child's outcome (success/failure/cancel). Branches based on result. |

Per cross-entity direction (5 directions for Phase 3, more later):

- `spawn_booking_from_ticket` (continue + wait variants)
- `spawn_work_order_from_ticket` (already exists as `create_child_tasks`; refactor to share spawn-link infrastructure)
- `spawn_work_order_from_booking` (continue + wait variants)
- `spawn_ticket_from_booking` (continue + wait variants)
- `spawn_ticket_from_work_order` (continue + wait variants)

### 3.4 Wait condition expression (MVP — enum-based)

```typescript
interface SpawnWaitConfig {
  wait_for: 'workflow_terminal' | 'entity_status' | 'either';
  // When wait_for = 'entity_status' or 'either':
  entity_terminal_statuses?: string[];  // e.g., ['confirmed', 'cancelled']
  // When wait_for = 'workflow_terminal' or 'either':
  workflow_terminal_statuses?: string[];  // typically ['completed', 'failed', 'cancelled']
  // Always:
  wait_timeout_seconds?: number;  // null = no timeout (forbidden in v1; require explicit value)
  on_timeout_branch?: string;  // required when timeout is set
}
```

**Validation at editor time:**
- If `wait_for = 'entity_status'`, `entity_terminal_statuses` MUST be non-empty.
- If `wait_for = 'workflow_terminal'`, `workflow_terminal_statuses` defaults to `['completed', 'failed', 'cancelled']` if omitted.
- `wait_timeout_seconds` is REQUIRED in v1 (no infinite waits). MUST have a corresponding `on_timeout_branch` defined in the parent workflow graph.

Future extension: free-form expression language (probably reuse the existing `condition` node's predicate engine if any) — defer until concrete demand.

### 3.5 Resume mechanism

Two-tier:

**Tier 1 (MVP — cron poll):**
- Cron job (every 30s) selects from `workflow_instance_links WHERE resolved_at IS NULL AND spawn_mode = 'wait'`.
- For each row, check the wait condition:
  - `workflow_terminal`: read `child_instance_id` row's status; if in `workflow_terminal_statuses`, fire.
  - `entity_status`: read child entity's status (`bookings.status` etc.); if in `entity_terminal_statuses`, fire.
  - `either`: check both, OR.
- If `wait_timeout_at <= now()`, fire timeout branch.
- Firing: update link row (`resolved_at`, `resolution_kind`), call `WorkflowEngineService.resume(parent_instance_id, parent_node_id, branch_label)`.

**Tier 2 (production — outbox events):**
- **New outbox event types** (verified missing from current code as of
  2026-05-12): `booking.status_changed` (carries `from`+`to` status),
  `booking.cancelled` (today only `audit_events` row from
  `reservation.service.ts:464,506`), `booking.created` (today only
  `audit_events` row from `booking-flow.service.ts:389,582`). Each
  needs a producer migration that adds `outbox.emit(...)` to the
  appropriate RPC body. Note: there is no `booking.confirmed` event
  type in the proposal — `confirmed` is a value of
  `booking_slots.status`, surfaced through the unified
  `booking.status_changed` event.
- Same for ticket / work_order lifecycle events (some exist already
  via the §3.0/3.4 RPCs; audit and extend).
- **`booking.edited` is currently a `domain_events`/`audit_events` row,
  not an outbox event.** If Tier 2 wants to subscribe to edits, Phase 1
  must additionally promote it to outbox via a `00364→v5` supersession
  (or its own producer migration). Listed as Phase 1 deferred work.
- New outbox handler `WorkflowSpawnWakeHandler` consumes these events:
  - Look up `workflow_instance_links WHERE child_entity_id = event.entity_id AND resolved_at IS NULL AND spawn_mode = 'wait'`.
  - For each row, check the wait condition matches the event's new status.
  - If yes, fire (same code path as Tier 1).

**MVP boundary — surfaced to user as open question 1.** v1 draft chose
Tier 1 cron (30s latency). Plan-review pushed back: 30s is fine for
operator-time scenarios ("ticket waits for service-desk approval") but
unacceptable for the most plausible booking spawn-and-wait workflow
("requester confirms a booking → notify the host immediately"). Tier 2
producers are already on the Phase 1 critical path because
spawn-cancellation propagation needs the same producer events. See
§9.1 for the recommendation. The link-row schema accommodates both
without schema change either way.

### 3.6 Cancellation propagation

**Hook generalization (Phase 1 scope, made explicit by plan-review).**
The cancellation hook today is `WorkflowEngineService.cancelInstanceForTicket`
at `apps/api/src/modules/workflow/workflow-engine.service.ts:142` —
ticket-scoped (`.eq('ticket_id', ticketId)`) and does no link-row
cascade. Phase 1 must (a) rename the method to
`cancelInstance(entityKind, entityId, reason)` (or split into
`cancelInstanceForBooking`, `cancelInstanceForCase`,
`cancelInstanceForWorkOrder` — decide at code-review time), (b) flip
the lookup to read polymorphically, (c) iterate
`workflow_instance_links` after the status flip, and (d) keep the
existing call site in `TicketService` working through a thin shim.
Estimate: +0.5w on Phase 1.

When a parent workflow_instance is cancelled (status → `cancelled`), iterate `workflow_instance_links WHERE parent_instance_id = ? AND resolved_at IS NULL`:

- For rows with `on_parent_cancel = 'cancel_child'`:
  - If `child_instance_id` is not null: cancel the child workflow_instance (status → `cancelled`, reason `parent_workflow_cancelled`).
  - Cancel the spawned entity (call the appropriate cancellation RPC: `delete_booking_with_guard`, etc.) with reason `parent_workflow_cancelled`.
- For rows with `on_parent_cancel = 'orphan_child'`:
  - Set `resolved_at = now()`, `resolution_kind = 'parent_cancelled'`.
  - Child workflow + entity continue independently.

**Default on every spawn node — surfaced to user as open question 2.**
v1 draft chose `'orphan_child'` ("Cancellation must require explicit
author intent."). Plan-review pushed back hard: the plausible failure
mode is "facilities admin cancels service request, room stays booked,
requester arrives Monday to a booked room" — a P1 user-trust bug.
Cascade-by-default (`cancel_child`) is the natural reading of every
other parent-child relationship in the project (the FKs added in 00367
above are `ON DELETE SET NULL` precisely because cascade is dangerous
for the schema, but cascade IS the right semantic for *intent-driven*
cancellation). v2 RECOMMENDS flipping the default to `'cancel_child'`
pending user confirmation. See §9.2.

**Cycle detection — visited-set, not just depth limit.** Plan-review
flagged that depth-10 catches diverging chains but misses tight
cycles (A spawns B spawns A spawns B — depth grows linearly, cycle
never detected). Phase 1 ships BOTH:
- **Visited-set** of `(entity_kind, entity_id)` per chain root —
  rejects re-entry into any ancestor entity with
  `spawn_link.cycle_detected` (422). Computed from
  `workflow_instance_links` on the parent's chain ancestry at spawn
  time.
- **Depth limit** (default 10) — rejects runaway chains that diverge
  forever without cycling, with `spawn_link.depth_exceeded` (422).
Both are cheap; both are needed.

### 3.7 Multi-spawn aggregation

**Surfaced to user as open question 3 (YAGNI risk).** Plan-review
flagged this as the spec's biggest scope speculation: the only example
("ticket workflow spawns 3 bookings for a multi-room event") is
hypothetical, no concrete demand cited, and customer-size memory
suggests single-vendor / single-room is the typical case. v2
RECOMMENDS deferring the aggregation columns + logic to v1.x when
demand surfaces. Schema is additive — the link-row columns can be
added in a later migration without a backfill burden. v2 keeps the
*design* documented here so the future migration is a copy-paste,
but Phase 1 ships SINGLE-spawn only.

A ticket workflow node that spawns 3 bookings (multi-room event) writes 3 link rows with the same `aggregation_group_id` + `aggregation_strategy`.

Wake logic at fire time:
- `all`: parent waits until ALL siblings in the group meet the wait condition. Resume on the LAST one.
- `any` / `first`: first sibling to meet the condition resumes the parent. Other siblings continue but don't re-wake.
- `quorum`: N-of-M siblings must meet the condition (the threshold N
  lives in `aggregation_quorum_n`). Resume on the N-th.

**Race story (added by plan-review).** Two siblings firing
simultaneously could each pass the strategy threshold check and each
call `WorkflowEngineService.resume()` — double-resume hazard,
especially under Tier 2 (concurrent outbox handlers). Implementation:
when a single link row's condition fires, take a `pg_advisory_xact_lock`
keyed on `aggregation_group_id` for the duration of the check + update.
Then query siblings via `aggregation_group_id` and apply the strategy.
Update only the firing row's `resolved_at` initially; mark the group
resolved (set a `group_resolved_at` row flag — added when this section
ships) only when the strategy condition is met. Tier 1 cron uses a
single worker so the race is theoretically zero, but the lock is cheap
defense-in-depth and required for Tier 2.

**CHECK enum correction (v2 plan-review).** The v1 draft's column
spec for `aggregation_strategy` was `check (... in ('all', 'any',
'first', null))` — `IN (null)` never matches in SQL (nullability is
already permitted by the column lacking `NOT NULL`), and `'quorum_N'`
was referenced in the design text but missing from the enum. The
corrected shape (when this section ships):

```sql
aggregation_strategy text null
  check (aggregation_strategy in ('all', 'any', 'first', 'quorum')),
aggregation_quorum_n int null
  check ((aggregation_strategy = 'quorum' and aggregation_quorum_n is not null and aggregation_quorum_n >= 1)
      or (aggregation_strategy <> 'quorum' and aggregation_quorum_n is null)
      or aggregation_strategy is null),
```

### 3.8 Editor UI

**Single editor app.** Extends the existing workflow editor at
`apps/web/src/pages/admin/workflow-editor.tsx` (single file, not a
directory — verified 2026-05-12). Adjacent surfaces:
`workflow-instance.tsx`, `workflow-templates.tsx`. Plan-review
verified the editor is **not entity-kind-aware today** — there's no
`entity_kind` / `ticket_kind` switching in the page or in
`palette.tsx` / `inspector.tsx`. The editor is entity-agnostic in a
"ticket-shaped-by-default" way; the engine hardcodes
`target_entity_type: 'ticket'` at `workflow-engine.service.ts:421,601`.
Phase 4 is therefore closer to "greenfield kind-awareness on top of
existing graph-edit chrome" than "incremental enhancement". Estimate
widened to 3-4 weeks (was 2-3).

Changes:
1. **`entity_type` picker on workflow definition create.** Set once,
   immutable. Drives palette + inspector. Mirrors the existing column
   on `workflow_definitions` (no parallel `entity_kind`).
2. **Palette filtering:**
   - Always-shown generic nodes: `branch`, `wait_for`, `timer`, `notification`, `http_request`, `end`.
   - Primary-kind-shown nodes: when `entity_type = 'booking'`, show `update_booking`, `cancel_booking`, `transition_booking_status`. When `entity_type = 'case'`, show `update_ticket`, `assign`, etc. (existing surface).
   - Boundary-shown nodes: ALWAYS show `spawn_X_from_Y` for kinds OTHER than the primary. Visually distinct (e.g., a different border/icon) to flag the cross-entity boundary.
3. **Inspector panel** adapts to node type. `spawn_*` nodes' inspector shows the spawn-mode toggle + (when wait) the wait condition + timeout + on_timeout_branch picker.
4. **Branch label management.** Spawn-and-wait nodes need typed branches (`condition_met`, `timeout`, `parent_cancelled`). Editor surfaces these as the spawn node's outgoing edges.

**Workflow editor breakage triage** is recommended (NOT a hard
dependency) before Phase 4 — produce
`docs/follow-ups/workflow-editor-breakage-2026-05-12.md` to size what's
broken vs what needs new build. The user's spec-author note in §1.18
flagged "a lot of stuff is broken there."

### 3.9 Booking-side primary nodes (Phase 2)

Initial set (kept small; extend on demand):

| Node | Body | Idempotency key |
|---|---|---|
| `update_booking` | Calls `edit_booking` RPC with a single-field plan. Allowlist of fields (mirror the 14-field `update_ticket` discipline). | `workflow:update_booking:<instance>:<node>:<booking>` |
| `cancel_booking` | Calls `delete_booking_with_guard` RPC. | `workflow:cancel_booking:<instance>:<node>:<booking>` |
| `transition_booking_status` | Calls a NEW `transition_booking_status` RPC. Verified 2026-05-12: no such RPC exists today + no equivalent state-machine surface exists for `bookings.status` (only `delete_booking_with_guard` for cancel, `edit_booking` for edits, magic-link check-in handlers for state changes). Phase 2 ships this RPC as part of the booking-side primary nodes — must include outbox emit of the new `booking.status_changed` event (so the wake handler can subscribe). Estimate +0.5w. | `workflow:transition_booking_status:<instance>:<node>:<booking>` |
| `request_booking_setup` | Wraps the existing `create_setup_work_order_from_event` flow. | `workflow:request_setup:<instance>:<node>:<booking>` |

Each node MUST use AppError + register error codes per the
`feedback_review_loop_protocol` (5-site registration). Field
allowlists per node tracked in `apps/api/src/modules/workflow/`
constants.

### 3.10 Cross-entity boundary nodes (Phase 3)

Each boundary node has TWO modes (continue + wait) — same node type
with a `spawn_mode` config field. Implementation:

1. Validate the spawn-target entity payload (FK validation via
   `validate_entity_in_tenant` for any referenced ids).
2. Call the spawn RPC (e.g., `create_booking_with_attach_plan`) to
   create the entity.
3. Insert `workflow_instance_links` row with the frozen config.
4. If `spawn_mode = 'wait'`: set parent workflow_instance status to
   `'waiting'`, return without advancing. The wake mechanism (§3.5)
   handles resume.
5. If `spawn_mode = 'continue'`: advance the parent workflow normally.

Optional: start a child workflow on the spawned entity. Child workflow
definition id is configured per spawn node. If null, no child workflow
starts (entity exists but no workflow runs on it).

### 3.11 Audit trail across the chain

Audit UI extension (Phase 4 / 5): given a ticket id, show the full
workflow chain that touched it — including bookings spawned, work
orders dispatched, parent workflows that orchestrated.

Query shape:
```sql
-- Find all workflow_instances connected to a starting entity, transitively.
with recursive chain as (
  select id, parent_instance_id, child_instance_id, depth = 0
    from workflow_instance_links
   where parent_entity_id = :starting_entity_id or child_entity_id = :starting_entity_id
  union all
  select wil.id, wil.parent_instance_id, wil.child_instance_id, c.depth + 1
    from workflow_instance_links wil
    join chain c on wil.parent_instance_id = c.child_instance_id
                 or wil.child_instance_id = c.parent_instance_id
   where c.depth < 10  -- match the cycle-prevention depth limit
)
select * from chain;
```

Surface this in the audit-events feed UI as a "Show workflow chain"
expandable row.

### 3.12 AppError ratchet considerations

Every new node, every new RPC, every new outbox handler MUST use
`AppError` via the registered factories (per
`feedback_review_loop_protocol.md` shared rules + project CLAUDE.md).
New error codes per phase:

- Phase 0: `workflow_definition.entity_kind_immutable` (422),
  `workflow_instance.entity_mismatch` (422 — instance entity doesn't
  match definition entity_kind).
- Phase 1: `spawn_link.parent_terminated` (422),
  `spawn_link.depth_exceeded` (422), `spawn_link.timeout` (no AppError
  raise; engine fires the timeout branch internally).
- Phase 2: `update_booking.field_not_allowed` (422 — mirrors
  `workflow.update_ticket_field_not_allowed`),
  `cancel_booking.already_cancelled` (422),
  `transition_booking_status.invalid_transition` (422).
- Phase 3: `spawn_booking_from_ticket.invalid_payload` (400),
  `spawn_*.entity_creation_failed` (500 server-class — wraps the spawn
  RPC's failure).

All registered in 5 sites: `packages/shared/src/error-codes.ts` union
+ Set, `apps/api/src/common/errors/map-rpc-error.ts` STATUS_BY_CODE,
`apps/api/src/common/errors/messages.{en,nl}.ts`,
`apps/web/src/lib/errors/messages.{en,nl}.ts`.

## 4. Migration plan

| # | File | Purpose |
|---|---|---|
| 00367 | `workflow_polymorphism_booking.sql` | Phase 0: add 'booking' to entity_kind enum + booking_id column on workflow_instances + one-of constraint extension. |
| 00368 | `workflow_instance_links.sql` | Phase 0: new table + RLS policies + indexes. |
| 00369 (optional) | `bookings_outbox_lifecycle_events.sql` | Phase 1: add `booking.created`, `booking.cancelled`, `booking.status_changed` outbox emissions to the existing booking RPCs. Defer if MVP uses cron-poll resume. |
| 00370 (optional) | `transition_booking_status_rpc.sql` | Phase 2: new RPC if no equivalent exists. Verify before scoping. |

**Backfill considerations:**
- Existing workflow_definitions get `entity_kind='case'` default.
  Verify NO existing definition is actually targeting work_orders
  (the polymorphism arrived in 00228 but actual usage is sparse —
  audit before defaulting).
- workflow_instances backfill from existing `case_id` / `work_order_id`
  presence to set `entity_kind` if any rows have it null.

Per project CLAUDE.md: confirm with user before `pnpm db:push` against
the remote. Standing permission for the B.4 workstream does NOT extend
to this spec automatically — re-confirm.

## 5. Test plan

**Per-node unit tests** (mocked Supabase):
- Each new node (booking-side primary + cross-entity spawn) with happy
  path + each documented error case.
- Engine-side tests: waiting-state transitions, wake mechanism,
  cancellation propagation, multi-spawn aggregation.

**Integration tests** (real DB via concurrency harness):
- `spawn_booking_from_ticket(continue)`: parent advances, child
  booking created, link row inserted.
- `spawn_booking_from_ticket(wait)`: parent enters waiting state, link
  row created with frozen config, child booking confirmed → parent
  resumes on `condition_met` branch.
- Spawn-and-wait timeout: parent resumes on `timeout` branch.
- Cancellation propagation (`cancel_child`): cancelling parent cancels
  child workflow + entity.
- Cancellation propagation (`orphan_child`): cancelling parent leaves
  child intact.
- Multi-spawn aggregation: parent spawns 3 bookings with `all`
  strategy; resumes only after all 3 confirmed.
- Cycle prevention: depth-10 chain rejected with
  `spawn_link.depth_exceeded`.
- Cross-tenant smuggling: spawn payload references entity in
  different tenant → rejected via `validate_entity_in_tenant`.
- Idempotency replay: same `(parent_instance, node, child_entity)`
  tuple returns cached result.

**Live-API smoke probes:**
- `pnpm smoke:workflows` (new): exercise each cross-entity boundary
  end-to-end. Mint an Admin JWT, create a workflow definition, start
  an instance, drive it through the spawn path, assert link rows +
  child entities + parent advancement.

**Real-DB concurrency probes** (extend `apps/api/test/concurrency/`):
- Two parents racing to spawn the same child entity (different parent
  instances) → both succeed if entity-creation is idempotent; engine
  link rows are independent.
- Parent cancellation racing with child entity status change → engine
  picks one outcome deterministically (last-writer-wins on link row
  `resolved_at`).

## 6. Estimated scope

| Phase | Subject | Estimate | Migrations |
|---|---|---|---|
| 0 | Schema (entity_type widening + booking_id + workflow_instance_links + polymorphism trigger) | 1-1.5 weeks | 2 |
| 1 | Engine extension (waiting state, wake, cancel hook generalization, single-spawn only — aggregation deferred per §3.7 / §9.3, polymorphize hardcoded `target_entity_type`) + producer migrations for `booking.created`/`cancelled`/`status_changed` | 3-4 weeks | 1-2 (lifecycle outbox events; mandatory if Tier 2 wake ships per §9.1) |
| 2 | Booking-side primary nodes (incl. NEW `transition_booking_status` RPC) | 1.5-2 weeks | 1 (transition_booking_status RPC) |
| 3 | Cross-entity boundary nodes (5 directions × 2 modes; modes scope contingent on §9.4 outcome) | 2 weeks | 0 |
| 4 | Editor UI (entity_type picker, palette filtering, inspector polymorphism, audit-chain view) | 3-4 weeks | 0 |
| 5 | (Optional, surfaced as §9.5 for ordering decision) Approval-workflow migration | 1-2 weeks | 1+ depending on backfill |

**Total: 11-15 working weeks for one engineer** (was 9-13; v2 widened
based on plan-review). Compress to 7-10 weeks with two engineers
(Phase 4 UI work parallelizes with Phase 1-3 backend). Includes the
review-loop overhead per `feedback_review_loop_protocol.md`. If
§9.4 (drop multi-spawn from v1) lands, knock 0.5w off Phase 1; if
§9.5 (pull approval workflow forward) lands, Phase 1.5 inserts and
total stretches by 1-2w.

## 7. Sequencing

**Hard ordering constraints:**

1. Phase 0 (schema) MUST land before any Phase 1+ work touches
   `workflow_instances` or `workflow_instance_links`. No partial
   schema state.
2. Phase 1 (engine) MUST land before Phase 2 (nodes that depend on
   the engine's wait/wake mechanism don't make sense without it).
3. Phase 2 (booking nodes) and Phase 3 (boundary nodes) can ship in
   parallel — boundary nodes only call the spawn RPCs, not the
   primary nodes. Sequencing by dependency: ship `update_booking` +
   `cancel_booking` (Phase 2) before `spawn_booking_from_ticket`
   (Phase 3) so spawn-and-wait scenarios have something to wait FOR.
4. Phase 4 (UI) ships after Phase 3 backend is callable so the editor
   has real APIs to surface.
5. Phase 5 (approval migration) is OPTIONAL and probably its own
   spec. Don't bundle.

**Per-phase review-loop protocol:**

Apply `feedback_review_loop_protocol.md` to each phase:
- Plan-review (Checkpoint 1) for the phase's design before coding.
- Implementation-review (Checkpoint 2) per sub-step within the phase.
- Codex on each non-trivial sub-step (this work qualifies — multi-file
  + cross-cutting + new RPCs + new schema).

**Producer-before-consumer (Phase 1 specifically):**

If Phase 1 ships Tier 2 resume mechanism (outbox events) — recommended
per §9.1 — the `booking.status_changed` / `booking.cancelled` /
`booking.created` event types must be:
1. Registered in `apps/api/src/modules/reservations/event-types.ts`
   (mirror `BookingEditEventType` shape — likely a sibling
   `BookingLifecycleEventType` const so the BookingEdit shape stays
   tightly scoped to the edit pipeline).
2. Emitted from the booking lifecycle RPCs (NEW migrations for
   `delete_booking_with_guard`, the create flow, and
   `transition_booking_status`).
3. Consumer handler (`WorkflowSpawnWakeHandler`) registered + listed
   in `OutboxModule.providers` BEFORE any TS controller emits.

Same invariant lesson from B.4 / B.2.A. **Enforcement (added by
plan-review):** add a smoke probe `pnpm smoke:workflow-wake` that
fails CI if a registered consumer references an event type with no
producer in the codebase (`grep -r "outbox.emit('<event>'"
supabase/migrations/`). Catches the silent-consumer drift class that
the spec's prose-only invariant doesn't structurally prevent.

## 8. Dependencies

- **00228 polymorphism** (shipped). Foundation.
- **B.2.A engine cutovers** (shipped). `assign`, `update_ticket`,
  `create_child_tasks` already route through atomic RPCs. Phase 2/3
  nodes follow the same pattern.
- **B.4 booking edit RPC + handler stub** (shipped). Phase 1 wake
  mechanism reuses `booking.approval_required` outbox infrastructure
  as the pattern; new event types follow.
- **Outbox handler infrastructure** (shipped). Phase 1 Tier 2 wake
  handler is just another registered handler.
- **Visitor module** (shipped). Future visitor workflows will follow
  the same pattern; no Phase 0-5 dependency, but the design choices
  here constrain how visitor workflows look later.

**Workflow editor breakage triage** is recommended (NOT a hard
dependency) — produce `docs/follow-ups/workflow-editor-breakage-2026-05-12.md`
before Phase 4 UI work to size what's broken vs what needs new build.

## 9. Open questions

**§9.1-9.5 are ARCHITECTURAL PIVOTS surfaced by v2 plan-review — each
needs explicit user decision before Phase 0 starts. v2 RECOMMENDS the
default in each but does not silently flip the architecture.**

### 9.1 (PIVOT) Cron poll vs outbox events for Phase 1 resume

v1 chose Tier 1 cron (30s latency) as MVP. Plan-review pushed back:
30s is fine for operator-time scenarios ("ticket waits for service-desk
approval") but unacceptable for the most plausible booking
spawn-and-wait scenario ("requester confirms a booking → notify the
host"). 30s of dead air after clicking "confirm" reads as broken.

**v2 recommendation:** ship Tier 2 (outbox events) from day 1. Rationale:
the producer events (`booking.status_changed`, `booking.cancelled`,
`booking.created`) are already on the Phase 1 critical path because
spawn-cancellation cascade in §3.6 needs them — adding the wake handler
on top is incremental work, not new infra. Keep the Tier 1 cron poll
as the safety net for events that get dropped from outbox (durability,
not primary path).

### 9.2 (PIVOT) Cancellation default — orphan_child vs cancel_child

v1 said `'orphan_child'` ("Cancellation must require explicit author
intent"). Plan-review pushed back hard: the plausible failure mode is
"facilities admin cancels service request → room stays booked →
requester arrives Monday to a booked room they thought they'd
cancelled." That's a P1 user-trust bug, not a "surprising default."

**v2 recommendation:** flip default to `'cancel_child'`. Rationale:
cascade is the natural reading of every other parent-child
relationship in the project; admins explicitly modeling a
fire-and-forget child can opt-in to `'orphan_child'` per spawn node;
the safety net pattern (require explicit intent for the dangerous
choice) reverses what's safe vs surprising here.

### 9.3 (PIVOT) Multi-spawn aggregation in v1 — needed or YAGNI

v1 included the full aggregation surface (`all` / `any` / `first` /
`quorum`). Plan-review pointed out the only example is hypothetical
("multi-room event"); customer-size memory says single-vendor /
single-room is typical. 4 columns + ~15% engine complexity for an
unproven use case.

**v2 recommendation:** drop multi-spawn from v1. Ship single-spawn
only. The schema is additive, so adding the columns + logic later when
demand surfaces is a clean migration. v2 keeps the *design* documented
in §3.7 so that future migration is a copy-paste — but Phase 1 ships
single-spawn only.

### 9.4 (PIVOT) Spawn-and-wait — combined node vs decomposed primitives

v1 packs spawn + wait into one node config (`spawn_mode: 'continue' |
'wait'`). Plan-review proposed decomposition: `spawn` always continues,
and a separate `wait_for_event` node listens for the entity-status /
workflow-terminal condition. Reasons:
- Today's engine has `wait_for` (line :623); generalizing it is
  structurally cheaper than inventing a parallel waiting machinery
  inside spawn nodes.
- Real workflows already need "wait without spawning" (e.g., wait for
  an Outlook sync event on a booking we did NOT create).
- Editor UX: explicit wait node makes parent's branching obvious.
- Link rows stay pure parent-child genealogy; wait state moves into a
  separate `workflow_waits` table.

Counter-argument: combined spawn-and-wait is a more discoverable
primitive ("I want to spawn this and wait for it" reads naturally as
ONE node). Decomposition forces authors to wire two nodes for what's
conceptually one decision.

**v2 has no default recommendation here.** Both shapes work; the
trade-off is discoverability (combined wins) vs primitive purity
(decomposed wins). User decision before Phase 1 starts.

### 9.5 (PIVOT) Phase 5 ordering — defer or pull forward to Phase 1.5

v1 marked the approval-config-jsonb → visual-workflow migration as
optional / probably its own spec. Plan-review pushed back: bug #2 in
§2 ("approval config is hand-edited JSON") is the only one in the
inventory a real admin will notice this quarter. Phases 0-4 deliver
generalization no admin asked for; Phase 5 delivers the user-visible
win. Pulling forward to Phase 1.5 means real admin demand validates
the cross-entity infra.

**v2 has no default recommendation here.** The trade-off is "ship
infra clean and risk it baking in design choices nobody pressure-tests"
vs "ship visual-approvals first and risk infra churn from real-use
feedback." User decision before Phase 0 starts.

### 9.6-9.10 (mechanical / scoping)

6. **Booking lifecycle outbox events (now mandatory if §9.1 lands).**
   Phase 1 needs producer migrations for `booking.status_changed`,
   `booking.cancelled`, `booking.created`. Each is a
   producer-before-consumer item.
7. **Multi-tenant RLS on `workflow_instance_links`.** Standard
   tenant_id-scoped policy. Cross-tenant chains are forbidden by
   design; Phase 0 ships standard. Revisit if cross-team workflow
   chains within a tenant need narrower visibility.
8. **Editor i18n scope.** New error codes ship with EN+NL; confirm
   whether new node labels + inspector copy also need NL at Phase 4
   ship time vs deferred.
9. **Compatibility with B.4.A.5 gate.** B.4 step 2D-D shipped a
   controller-vs-notification gate at `reservation.service.ts:1213`
   (422 `booking.edit_requires_notification_dispatch`). If §9.5 lands
   (approval workflow pulled forward), the gate needs to retire or
   coexist with the visual approval flow. Decide before Phase 1.5.
10. **Audit chain UI surface.** Is the chain view a new page or an
    expandable section in the existing audit-events feed? Phase 4
    decision.
11. **Spawn-and-wait UX in editor (or the decomposed equivalent per
    §9.4).** Visual representation of the waiting state vs continue —
    distinct node icons / border styles? Phase 4 design decision.

## 10. Out of scope (deferred)

- Visitor workflows (separate spec).
- Asset workflows (separate spec).
- Editor UI rebuild (incremental enhancement only).
- BPMN parallel gateways with race conditions, signal events,
  escalation timer chains beyond simple spawn-and-wait timeouts.
- Migration tooling for existing `room_booking_rules.approval_config`
  jsonb → visual workflow definitions (Phase 5 or its own spec).
- Cross-tenant workflow chains (if a parent in tenant A spawns a
  child in tenant B — explicitly forbidden by RLS).
- Workflow versioning / migration of in-flight instances when a
  definition changes (existing definitions stay; in-flight instances
  stay on the version they started; new instances get the new
  version).
- Workflow-as-code authoring (TypeScript / DSL) — this spec is
  visual-editor-only.

---

**Status:** v2 — ready for user approval. Plan-review Checkpoint 1
complete (parallel plan + approach reviewers; six CRITICAL fact-
foundation findings corrected directly + five architectural pivots
surfaced as §9.1-9.5 for user decision). After user approval +
optional codex pass: phase-by-phase implementation gated on user
approval per phase, with the per-sub-step review loop (Checkpoint 2).

**Citations re-verified against current code 2026-05-12 in v2
remediation.** v1's claim that all citations were verified missed two
fact-foundation errors (existing `workflow_definitions.entity_type`
column; the 00239 CHECK-vs-FK lesson) and one factual misclassification
(`booking.edited` as outbox event when it's only a domain_event). v2
implementer should still re-verify file:line references before quoting
in commit messages (citation discipline rule applies).
