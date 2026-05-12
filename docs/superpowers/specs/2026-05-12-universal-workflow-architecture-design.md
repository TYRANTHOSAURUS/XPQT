# Universal Workflow Architecture (Booking Workflows + Cross-Entity Spawn)

**Status:** v2.1 — REMEDIATED (parallel + codex), READY FOR USER
APPROVAL. Plan-review Checkpoint 1 complete; all CRITICAL fact-
foundation findings + the codex BLOCKER (atomic spawn RPC) corrected
directly; architectural pivots flagged in §9 as open questions for
user decision.

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
- 2026-05-12 — **v2 codex second-opinion remediation.** Codex
  pressure-tested the v2 remediated state and surfaced one BLOCKER + 3
  CRITICAL + 5 IMPORTANT + 3 nits — all real, all corrected. BLOCKER:
  §3.10 spawn path was a multi-step TS pipeline (create entity → insert
  link → set parent waiting), which violates the project's "multi-step
  writes are PL/pgSQL RPCs" rule and creates orphaned-booking /
  parent-state failure modes on crash. v2.1 redesigns §3.10 around an
  atomic `spawn_workflow_entity_with_link` RPC per spawn boundary.
  CRITICALs: (a) §3.1 didn't actually unblock booking workflows because
  `workflow_instances.ticket_id NOT NULL` (00009:33) and
  00345's `(tenant_id, ticket_id)` active-uniqueness index weren't
  generalized — Phase 0 now drops `ticket_id NOT NULL` + replaces 00345
  with three polymorphic partial indices; (b) §3.5 Tier 2 wake had no
  atomic claim, so at-least-once delivery could double-resume — wake
  now uses `UPDATE … WHERE resolved_at IS NULL RETURNING …` to claim
  the link row before calling `resume`; (c) wake handler now explicitly
  asserts tenant equality across event/parent/child/link. IMPORTANTs:
  §3.1 backfill tightened to ABORT on zero-instance / mixed-history
  definitions (operator must explicitly map them); §3.1 polymorphism
  trigger extended to fire on UPDATE too (forbids entity_kind flips);
  §3.7 advisory lock pattern moved into a PL/pgSQL claim RPC with
  `FOR UPDATE` (TS-side `pg_advisory_xact_lock` doesn't survive across
  separate Supabase-js statements); §3.8 explicitly notes the editor's
  `NODE_TYPES[type]` registry at `workflow-node.tsx:49` and
  `inspector.tsx:46` must be extended (or fall back) for unknown nodes;
  §9.4 third option ("compound config + paired visual rendering")
  added. Nits: §3.2 / §3.4 broken `CHECK (... in (..., null))` forms
  removed; §3.12 wildcard `spawn_*.entity_creation_failed` replaced
  with concrete code per direction; renamed
  `entity_kind_immutable` → `entity_type_immutable`; estimate widened
  again to 14-20w one engineer.

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
-- ── 1. Preflight: refuse to migrate if any workflow_definitions row
--    is ambiguous (was used historically for both case AND work_order).
--    Operator must manually map ambiguous rows BEFORE re-running.
do $$
declare v_ambiguous int;
begin
  select count(*) into v_ambiguous from (
    select wd.id
      from public.workflow_definitions wd
      join public.workflow_instances wi on wi.workflow_definition_id = wd.id
     where wi.entity_kind is not null
     group by wd.id
    having count(distinct wi.entity_kind) > 1
  ) ambig;
  if v_ambiguous > 0 then
    raise exception
      'workflow_definitions backfill: % definition(s) have instances of multiple entity_kinds. Manually set workflow_definitions.entity_type for each before re-running 00367.',
      v_ambiguous;
  end if;
end $$;

-- ── 2. Widen workflow_definitions.entity_type vocabulary +
--    backfill 'ticket' rows from observed instance kind.
--    Zero-instance rows: no auto-default — operator must set those
--    explicitly via a one-line UPDATE before re-running.
do $$
declare v_unmapped int;
begin
  select count(*) into v_unmapped from public.workflow_definitions wd
    where wd.entity_type = 'ticket'
      and not exists (
        select 1 from public.workflow_instances wi
         where wi.workflow_definition_id = wd.id
           and wi.entity_kind is not null
      );
  if v_unmapped > 0 then
    raise exception
      'workflow_definitions backfill: % definition(s) with entity_type=''ticket'' have zero instances. Set entity_type explicitly before re-running 00367.',
      v_unmapped;
  end if;
end $$;

alter table public.workflow_definitions
  drop constraint if exists workflow_definitions_entity_type_check;
update public.workflow_definitions wd
  set entity_type = (
    select wi.entity_kind
      from public.workflow_instances wi
     where wi.workflow_definition_id = wd.id
       and wi.entity_kind is not null
     order by wi.started_at desc
     limit 1
  )
  where wd.entity_type = 'ticket';
alter table public.workflow_definitions
  add constraint workflow_definitions_entity_type_check
    check (entity_type in ('case', 'work_order', 'booking'));

-- ── 3. workflow_instances: drop ticket_id NOT NULL + booking_id column.
--    The historical NOT NULL on ticket_id (00009:33) blocks booking
--    workflows from inserting at all. v1 missed this. We KEEP the
--    column as a nullable bridge for the existing case/work_order
--    rows (the auto-derive trigger at 00230 still uses it as the
--    insert-time hint), but allow NULL for booking-typed rows.
alter table public.workflow_instances
  alter column ticket_id drop not null;

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

-- ── 4. Generalize the active-uniqueness index from 00345.
--    00345 indexed (tenant_id, ticket_id) WHERE status in ('active','waiting').
--    That's case-only. Replace with three polymorphic partial indices —
--    one per entity_kind. The "one active workflow per (tenant, entity)"
--    invariant is preserved; the index just splits across kinds.
drop index if exists public.workflow_instances_active_unique_idx;

create unique index if not exists workflow_instances_active_case_unique_idx
  on public.workflow_instances (tenant_id, case_id)
  where status in ('active', 'waiting') and entity_kind = 'case' and case_id is not null;

create unique index if not exists workflow_instances_active_work_order_unique_idx
  on public.workflow_instances (tenant_id, work_order_id)
  where status in ('active', 'waiting') and entity_kind = 'work_order' and work_order_id is not null;

create unique index if not exists workflow_instances_active_booking_unique_idx
  on public.workflow_instances (tenant_id, booking_id)
  where status in ('active', 'waiting') and entity_kind = 'booking' and booking_id is not null;

create index if not exists idx_wi_booking
  on public.workflow_instances (booking_id) where booking_id is not null;

-- ── 5. Polymorphism enforcement: BEFORE INSERT OR UPDATE trigger.
--    INSERT: assert one-of invariant.
--    UPDATE: forbid entity_kind flip + forbid swapping the polymorphic
--      id to a different kind's column. Allow FK SET NULL (entity
--      deletion path) by permitting NEW.<kind>_id IS NULL when OLD was
--      not null. That preserves the 00239 contract.
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
  if (tg_op = 'UPDATE') then
    if new.entity_kind is distinct from old.entity_kind then
      raise exception 'workflow_instance.entity_kind_immutable_post_insert';
    end if;
    -- One of the polymorphic ids may transition non-null → null
    -- (FK SET NULL on entity delete) but never non-null → other-non-null.
    if (old.case_id is not null and new.case_id is not null and new.case_id <> old.case_id) or
       (old.work_order_id is not null and new.work_order_id is not null and new.work_order_id <> old.work_order_id) or
       (old.booking_id is not null and new.booking_id is not null and new.booking_id <> old.booking_id) or
       -- Cross-kind smuggling: writing the wrong polymorphic id.
       (new.entity_kind = 'case'       and (new.work_order_id is distinct from old.work_order_id or new.booking_id    is distinct from old.booking_id)) or
       (new.entity_kind = 'work_order' and (new.case_id       is distinct from old.case_id       or new.booking_id    is distinct from old.booking_id)) or
       (new.entity_kind = 'booking'    and (new.case_id       is distinct from old.case_id       or new.work_order_id is distinct from old.work_order_id))
    then
      raise exception 'workflow_instance.polymorphic_id_smuggling';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists workflow_instances_assert_polymorphism on public.workflow_instances;
create trigger workflow_instances_assert_polymorphism
  before insert or update on public.workflow_instances
  for each row execute function public.assert_workflow_instance_polymorphism();
```

**00345 cutover preflight.** Before dropping
`workflow_instances_active_unique_idx`, run a duplicate-detection
preflight identical to 00345's own header runbook (00345:79-94) — but
across the polymorphic surface, not just `(tenant_id, ticket_id)`. The
old index was keyed on `ticket_id`; the new indices are keyed on the
polymorphic id columns. Any existing duplicates would block the new
indices from being created.

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
  resolution_kind          text null,
  group_resolved_at        timestamptz null,  -- aggregation: set on the firing row when the group meets the strategy
  -- Aggregation (deferred per §9.3 — kept here for forward compatibility;
  -- columns added in v1.x when concrete demand arrives):
  aggregation_group_id     uuid null,
  aggregation_strategy     text null,
  aggregation_quorum_n     int null,
  created_at               timestamptz not null default now(),
  -- Composite tenant assertion: parent and child entity must belong to
  -- the same tenant as the link row. Enforced by trigger (FK doesn't
  -- carry tenant). See `assert_workflow_instance_link_tenant` below.
  --
  -- CHECK shape note: SQL `CHECK (col IN (...))` *accepts* NULL because
  -- IN-comparisons against NULL are unknown — the v1 enum constraints
  -- that included `null` literally were no-ops. The columns above use
  -- bare nullable types + a value-set CHECK with NULL handled
  -- explicitly:
  constraint workflow_instance_links_resolution_kind_check
    check (resolution_kind is null
        or resolution_kind in ('condition_met', 'timeout', 'parent_cancelled')),
  constraint workflow_instance_links_aggregation_strategy_check
    check (aggregation_strategy is null
        or aggregation_strategy in ('all', 'any', 'first', 'quorum')),
  constraint workflow_instance_links_aggregation_quorum_check
    check ((aggregation_strategy = 'quorum' and aggregation_quorum_n is not null and aggregation_quorum_n >= 1)
        or (aggregation_strategy is distinct from 'quorum' and aggregation_quorum_n is null))
);

alter table public.workflow_instance_links enable row level security;
create index idx_wil_tenant on public.workflow_instance_links (tenant_id);
create index idx_wil_parent on public.workflow_instance_links (parent_instance_id);
create index idx_wil_child on public.workflow_instance_links (child_instance_id) where child_instance_id is not null;
create index idx_wil_waiting on public.workflow_instance_links (resolved_at, wait_timeout_at)
  where resolved_at is null and spawn_mode = 'wait';
create index idx_wil_aggregation on public.workflow_instance_links (aggregation_group_id)
  where aggregation_group_id is not null;

-- Tenant assertion at insert time: parent and child workflow_instances
-- must belong to the same tenant as the link row. The FK doesn't carry
-- tenant; this is the #0 invariant defense.
create or replace function public.assert_workflow_instance_link_tenant()
returns trigger language plpgsql as $$
declare
  v_parent_tenant uuid;
  v_child_tenant  uuid;
begin
  select tenant_id into v_parent_tenant
    from public.workflow_instances where id = new.parent_instance_id;
  if v_parent_tenant is null or v_parent_tenant <> new.tenant_id then
    raise exception 'workflow_instance_link.tenant_mismatch_parent';
  end if;
  if new.child_instance_id is not null then
    select tenant_id into v_child_tenant
      from public.workflow_instances where id = new.child_instance_id;
    if v_child_tenant is null or v_child_tenant <> new.tenant_id then
      raise exception 'workflow_instance_link.tenant_mismatch_child';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists workflow_instance_links_assert_tenant on public.workflow_instance_links;
create trigger workflow_instance_links_assert_tenant
  before insert on public.workflow_instance_links
  for each row execute function public.assert_workflow_instance_link_tenant();
```

**Why denormalize `parent_entity_kind` + `parent_entity_id` + `child_entity_kind` + `child_entity_id`:** survives parent workflow_instance deletion (audit row stays); makes audit-chain queries faster (no join through workflow_instances); freezes the contract at spawn time so editor changes to the workflow definition don't retroactively change semantics.

**RLS policy:** mirror `workflow_instances` RLS shape (tenant_id-scoped via `auth.uid()` → `tenant_id`). The wake handler (§3.5) runs under `supabase.admin` to clear RLS, so tenant enforcement at the wake boundary is a TS-side assertion (not RLS).

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
- **Atomic claim before fire:** the firing step writes
  `UPDATE workflow_instance_links SET resolved_at = now(),
   resolution_kind = $1 WHERE id = $2 AND resolved_at IS NULL
   RETURNING id`. If 0 rows return, another worker / handler already
   claimed it — skip the resume call. Only after the claim returns 1
   row does the cron call `WorkflowEngineService.resume(parent_instance_id,
   parent_node_id, branch_label)`. The claim is the deduplication
   boundary across Tier 1 cron + Tier 2 outbox handlers.
- The downstream `WorkflowEngineService.resume()` itself has its own
  race window today (`workflow-engine.service.ts:928,957` reads
  `status='waiting'` then separately writes `status='active'`). Phase 1
  hardens `resume()` to use a single `UPDATE … WHERE status='waiting'
  RETURNING …` claim before advancing; if the row is no longer
  `waiting`, the resume is a no-op (already advanced by another
  handler).

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
  - **Tenant-scoped lookup** (NOT `WHERE child_entity_id = event.entity_id`
    alone — that's cross-tenant smuggling territory): the handler
    reads the event's `tenant_id` from the outbox payload (the outbox
    pattern persists this on every emit) and queries
    `workflow_instance_links WHERE tenant_id = $event_tenant_id
     AND child_entity_id = $event_entity_id AND resolved_at IS NULL
     AND spawn_mode = 'wait'`.
  - Asserts before firing: `link.tenant_id = event.tenant_id` AND the
    parent workflow_instance's tenant_id matches. Both should already
    be enforced by the link table's tenant trigger (§3.2), but the
    handler defends-in-depth because it runs under `supabase.admin`
    (RLS-bypassing).
  - For each row, check the wait condition matches the event's new status.
  - If yes, fire via the SAME atomic claim path as Tier 1 (above).
    The claim is the deduplication boundary; concurrent Tier 2 handler
    invocations (at-least-once delivery) cannot double-resume because
    only one wins the `UPDATE … WHERE resolved_at IS NULL`.

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

**Race story (codex remediation).** Two siblings firing simultaneously
could each pass the strategy threshold check and each call
`WorkflowEngineService.resume()` — double-resume hazard, especially
under Tier 2 (concurrent outbox handlers). The aggregation
check-then-update logic must run inside a single PL/pgSQL transaction
that takes `FOR UPDATE` on the sibling link rows; a TS-side
`pg_advisory_xact_lock` does NOT survive across separate Supabase-js
HTTP statements (each is its own transaction).

Implementation: a new RPC `claim_aggregation_group_resume(link_id,
resolution_kind)` runs the entire atomic sequence:

```sql
-- Pseudocode for claim_aggregation_group_resume:
-- 1. SELECT * FROM workflow_instance_links WHERE id = $1 FOR UPDATE.
-- 2. Find sibling rows: SELECT * FROM workflow_instance_links
--    WHERE aggregation_group_id = (current row's group) FOR UPDATE.
-- 3. UPDATE the firing row: resolved_at = now(), resolution_kind = $2.
-- 4. Re-evaluate the group's strategy across siblings (now that the
--    firing row's resolved_at is committed in this tx).
-- 5. If strategy is met: UPDATE the firing row again (or any sibling)
--    with group_resolved_at = now() and RETURN parent_instance_id +
--    parent_node_id + branch_label. Otherwise RETURN NULL.
```

The TS caller sees: claim returns either `(parent_instance_id,
parent_node_id, branch_label)` or `null`. If non-null, call
`WorkflowEngineService.resume(...)`. The lock is held only for the
duration of the claim RPC (~ms); the `resume` call itself is a
separate transaction (and uses its own atomic claim per the §3.5 wake
hardening).

Tier 1 cron uses a single worker so the race is theoretically zero,
but the RPC pattern is the single-source-of-truth for both Tier 1 and
Tier 2 (concurrent outbox handlers).

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

**Unknown-node round-tripping (codex remediation).** The editor must
render workflow definitions that contain node types outside the
filtered palette — e.g., a `case`-typed editor opened against an
older definition that contains nodes added later, or a
cross-tenant-shared definition whose node set the local install hasn't
caught up to. Today the editor crashes on lookup at
`apps/web/src/components/workflow-editor/workflow-node.tsx:49`
(`NODE_TYPES[type]`) and at
`apps/web/src/components/workflow-editor/inspector.tsx:46`
(metadata lookup). Phase 4 must add a fallback render (a generic
"unknown node" card with the raw config jsonb shown read-only) before
the new node types ship, otherwise any user opening a published
definition with a missing node type bricks the page.

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

**Atomic spawn contract (codex BLOCKER remediation, 2026-05-12).** v1
described the spawn path as a TS pipeline (validate → create entity
RPC → insert link → set parent waiting). That violates the project
rule "multi-step writes are PL/pgSQL RPCs, not TS pipelines" and
creates an orphaned-booking / wrong-parent-state failure mode if the
TS process crashes between steps. v2.1 wraps the entire spawn
boundary in ONE atomic RPC per spawn direction:

```
spawn_booking_from_ticket_with_link(
  p_tenant_id, p_parent_instance_id, p_parent_node_id,
  p_spawn_mode, p_wait_config jsonb,
  p_booking_payload jsonb,
  p_child_workflow_definition_id uuid null,
  p_idempotency_key text
) returns jsonb
```

Inside the RPC body (single transaction):
1. Validate the spawn-target payload (FK validation via
   `validate_entity_in_tenant` for any referenced ids — already an
   established defense-in-depth pattern, see `00321/00340`).
2. Call into `create_booking_with_attach_plan` (00309) to create the
   entity.
3. If `p_child_workflow_definition_id` is provided, INSERT a child
   `workflow_instances` row (entity_kind matches the spawned entity).
4. INSERT the `workflow_instance_links` row (frozen wait config,
   parent_node_id, etc.).
5. If `p_spawn_mode = 'wait'`: UPDATE the parent
   `workflow_instances.status = 'waiting'` (with appropriate
   `waiting_for` reason) — atomic with steps 1-4. Return without
   advancing.
6. If `p_spawn_mode = 'continue'`: do NOT touch the parent's status;
   the TS caller advances normally after the RPC returns.

The TS workflow engine code reduces to: one RPC call per spawn node,
plus a conditional `advance()` for `'continue'` mode. Idempotency: the
RPC writes a `command_operations` row keyed on
`(p_parent_instance_id, p_parent_node_id, p_idempotency_key)`,
mirroring §3.0 / §3.4 conventions. Replays return the cached result.

**One RPC per spawn direction.** The five Phase 3 directions each get
their own RPC (`spawn_booking_from_ticket_with_link`,
`spawn_work_order_from_booking_with_link`, etc.). Reasons against a
single generic `spawn_with_link(target_kind, ...)` super-RPC: the
spawn-target RPC signature differs per kind
(`create_booking_with_attach_plan` payload ≠
`dispatch_child_work_orders_batch` payload), and the target-RPC
validation contracts are kind-specific. A super-RPC would fan out into
a `case … when … then` over each kind and lose the type-checked
payload schema at the SQL boundary. Per-direction is more code but
simpler per-call.

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

- Phase 0: `workflow_definition.entity_type_immutable` (422 — note:
  column is `entity_type`, not `entity_kind`),
  `workflow_instance.entity_mismatch` (422 — instance entity doesn't
  match definition entity_type),
  `workflow_instance.entity_kind_immutable_post_insert` (422 — emitted
  by the polymorphism trigger; UPDATE that flips entity_kind),
  `workflow_instance.polymorphic_id_smuggling` (422 — emitted by the
  polymorphism trigger; UPDATE that swaps polymorphic ids across
  kinds), `workflow_instance_link.tenant_mismatch_parent` (422 —
  emitted by the link tenant trigger),
  `workflow_instance_link.tenant_mismatch_child` (422 — same).
- Phase 1: `spawn_link.parent_terminated` (422),
  `spawn_link.depth_exceeded` (422),
  `spawn_link.cycle_detected` (422),
  `spawn_link.timeout` (no AppError raise; engine fires the timeout
  branch internally).
- Phase 2: `update_booking.field_not_allowed` (422 — mirrors
  `workflow.update_ticket_field_not_allowed`),
  `cancel_booking.already_cancelled` (422),
  `transition_booking_status.invalid_transition` (422).
- Phase 3: per-direction codes (no wildcards — codex flagged that
  wildcards aren't registerable in the 5-site enum). Each spawn
  direction registers its own pair:
  `spawn_booking_from_ticket.invalid_payload` (400),
  `spawn_booking_from_ticket.entity_creation_failed` (500),
  `spawn_work_order_from_booking.invalid_payload` (400),
  `spawn_work_order_from_booking.entity_creation_failed` (500),
  `spawn_ticket_from_booking.invalid_payload` (400),
  `spawn_ticket_from_booking.entity_creation_failed` (500),
  `spawn_work_order_from_ticket.invalid_payload` (400),
  `spawn_work_order_from_ticket.entity_creation_failed` (500),
  `spawn_ticket_from_work_order.invalid_payload` (400),
  `spawn_ticket_from_work_order.entity_creation_failed` (500).
  10 codes for 5 directions × 2 failure modes.

All registered in 5 sites: `packages/shared/src/error-codes.ts` union
+ Set, `apps/api/src/common/errors/map-rpc-error.ts` STATUS_BY_CODE,
`apps/api/src/common/errors/messages.{en,nl}.ts`,
`apps/web/src/lib/errors/messages.{en,nl}.ts`.

## 4. Migration plan

| # | File | Purpose |
|---|---|---|
| 00367 | `workflow_polymorphism_booking.sql` | Phase 0: add 'booking' to entity_kind enum + booking_id column on workflow_instances + one-of constraint extension. |
| 00368 | `workflow_instance_links.sql` | Phase 0: new table + RLS policies + indexes + tenant assertion trigger. |
| 00369 | `bookings_outbox_lifecycle_events.sql` | Phase 1: add `booking.created`, `booking.cancelled`, `booking.status_changed` outbox emissions to the existing booking RPCs (plus `delete_booking_with_guard` 00292 + the create flow). Mandatory if §9.1 picks Tier 2 (recommended); only "optional" under cron-poll-only MVP. |
| 00370 | `transition_booking_status_rpc.sql` | Phase 2: NEW RPC (verified missing 2026-05-12 — no equivalent state-machine surface for `bookings.status` exists today). Emits `booking.status_changed` outbox event. |
| 00371-00375 | `spawn_<direction>_with_link_rpc.sql` × 5 | Phase 3: one atomic RPC per spawn direction (codex BLOCKER remediation — spawn must not be a TS pipeline). Each RPC wraps validate + create entity + insert link + flip parent state in one tx. |
| 00376 | `claim_aggregation_group_resume_rpc.sql` | Phase 1.x (deferred per §9.3): claim RPC for multi-spawn aggregation. Schema-additive — ships when concrete demand arrives. |

**Backfill safety (codex remediation).** §3.1 backfill runs two
preflight `RAISE EXCEPTION` blocks BEFORE any UPDATE: (a) refuse to
proceed if any `workflow_definitions` row has instances of mixed
entity_kinds (operator must manually map); (b) refuse to proceed if
any `entity_type='ticket'` row has zero instances (operator must set
explicitly). The v1 "default to case for ambiguous rows" silent
heuristic was wrong — silent mis-mapping would put workflow
definitions on the wrong palette and break their existing instances.

**Active-uniqueness cutover (00367 step 4).** Before dropping
`workflow_instances_active_unique_idx` (00345) and replacing with the
three polymorphic partial indices, run a duplicate-detection preflight
across the polymorphic surface (mirrors 00345:79-94 but keyed on the
new index columns). Any duplicates found block the migration; operator
runs the cleanup runbook from 00345's header before re-running 00367.

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
| 0 | Schema (entity_type widening + ticket_id NOT NULL drop + 00345 index split + booking_id + workflow_instance_links + polymorphism trigger w/ INSERT+UPDATE coverage + link tenant trigger + backfill preflights) | 1.5-2 weeks | 2 |
| 1 | Engine extension (waiting state, atomic wake claim, resume() race fix, cancel hook generalization, polymorphize hardcoded `target_entity_type`, cycle visited-set, depth limit, single-spawn only) + producer migrations for `booking.created`/`cancelled`/`status_changed` | 4-5 weeks | 1-2 (lifecycle outbox events; mandatory if Tier 2 wake ships per §9.1) |
| 2 | Booking-side primary nodes (incl. NEW `transition_booking_status` RPC + outbox emit of `booking.status_changed`) | 1.5-2 weeks | 1 (transition_booking_status RPC) |
| 3 | Cross-entity boundary nodes — atomic per-direction `spawn_*_with_link` RPCs (5 directions × 2 modes) | 3-4 weeks | 5 (one per direction) |
| 4 | Editor UI (entity_type picker, palette filtering, inspector polymorphism, audit-chain view, unknown-node fallback render) | 4-5 weeks | 0 |
| 5 | (Optional, surfaced as §9.5 for ordering decision) Approval-workflow migration | 1-2 weeks | 1+ depending on backfill |

**Total: 14-20 working weeks for one engineer** (was 11-15; v2.1
widened per codex review which surfaced 5 atomic-RPCs in Phase 3,
schema generalization gaps in Phase 0, and editor unknown-node
fallback in Phase 4). Compress to 9-13 weeks with two engineers
(Phase 4 UI work parallelizes with Phase 1-3 backend). Includes the
review-loop overhead per `feedback_review_loop_protocol.md`. If §9.3
(drop multi-spawn from v1) lands, no time impact (already deferred
per §3.7); if §9.5 (pull approval workflow forward) lands, Phase 1.5
inserts and total stretches by 1-2w; if §9.4 lands as decomposed
(spawn-and-wait pivot), Phase 1's wake handler simplifies (~-0.5w)
but Phase 4 adds a second node-type to the editor (~+0.5w) — wash.

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

**Third option (codex addition):** persist ONE compound spawn-wait
config (the v1 shape), but render it in the editor as TWO linked
visual elements — a spawn box and an attached wait box, joined by a
fixed edge. Authors see "spawn THEN wait" as two visual steps
(decomposition-friendly UX); the engine reads one config record (no
additional wait_for table); the link row carries the wait config as
the single source of truth. Trades editor complexity for
runtime simplicity. Probably the right answer if the user's UX
priority is "the editor must look like the workflow runs," but adds
~0.5w to Phase 4.

**v2 has no default recommendation here.** Three shapes work; the
trade-off is discoverability (combined wins), primitive purity
(decomposed wins), or compound-render (best of both, more editor
work). User decision before Phase 1 starts.

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

**Status:** v2.1 — ready for user approval. Plan-review Checkpoint 1
complete (parallel plan + approach reviewers; codex second-opinion
remediation). 6 v1 CRITICAL findings + 1 v2 BLOCKER (atomic spawn
RPC) + 3 v2 CRITICAL (schema generalization gaps; wake idempotency;
tenant boundary at wake) + 8 v2 IMPORTANTs all corrected directly.
Five architectural pivots surfaced as §9.1-9.5 for user decision (NOT
silently flipped). After user approval: phase-by-phase implementation
gated on user approval per phase, with the per-sub-step review loop
(Checkpoint 2).

**Citations re-verified against current code 2026-05-12 in v2.1
remediation.** v1's claim that all citations were verified missed
two fact-foundation errors (existing `workflow_definitions.entity_type`
column; the 00239 CHECK-vs-FK lesson) and one factual misclassification
(`booking.edited` as outbox event when it's only a domain_event); v2
remediation also missed the `workflow_instances.ticket_id NOT NULL`
schema gap and the 00345 active-uniqueness index generalization need.
v2.1 closes both. Implementer should still re-verify file:line
references before quoting in commit messages (citation discipline rule
applies).
