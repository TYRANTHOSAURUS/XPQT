# Step 1c plan — materialize `work_orders` and cut writers over

**Status:** PLAN ONLY. Not started. Needs codex review before execution.
**Predecessor:** `docs/data-model-redesign-2026-04-30.md` step 1a/1b (shipped).
**Estimated effort:** 3–6 months in a real engineering team. Do NOT attempt in a single autonomous session.

---

## What changes vs step 1b

Step 1b kept `work_orders` as a **view** over `tickets`. All writes still went to `tickets`; the view was read-only.

Step 1c makes `work_orders` a **real table**. Writers move from `tickets` to `work_orders`. Dependent tables (`sla_timers`, `routing_decisions`, `ticket_activities`) get FKs to `work_orders` parallel to their existing `tickets` FKs. Eventually the work_order rows in `tickets` are dropped.

This unlocks:
- A proper `work_order_visibility_ids(user_id, tenant_id)` SQL function (separate from ticket visibility).
- FK-anchored fulfillment_units_v projection without view-on-view chains.
- The `tickets` → `cases` rename (step 6) — possible only once `tickets` contains only cases.

---

## Coupling points (from codex review of original recommendation)

These are the eight places writers + FKs touch tickets-as-work-orders today:

| # | Location | What it does | Migration plan |
|---|---|---|---|
| 1 | `dispatch.service.ts:79–83` | Creates child work order rows in `tickets` with `ticket_kind='work_order'` | Switch insert to `work_orders` table directly. Phase: 1c.4 |
| 2 | `ticket.service.ts:1499–1574` | Booking-origin work order creation (`runPostCreateAutomation` for `requires_internal_setup`) | Switch insert to `work_orders` table. Phase: 1c.4 |
| 3 | `00030_case_workorder_and_scope_hierarchy.sql:89–156` | Parent/child rollup trigger fires `after insert/update of status_category on tickets` filtered by `ticket_kind='work_order'` | Move trigger to `work_orders` table; `parent_ticket_id` becomes `parent_case_id` referencing `tickets where ticket_kind='case'`. Phase: 1c.5 |
| 4 | `00011_tickets.sql:89–113` | `sla_timers.ticket_id` FK to tickets; `sla.service.ts:25` updates ticket SLA fields | Add `sla_timers.work_order_id` column nullable, backfill, make polymorphic via `(parent_kind, parent_id)`. Phase: 1c.6 |
| 5 | `workflow-engine.service.ts:74,147,213` | Workflow nodes mutate tickets; `create_child_tasks` calls `DispatchService.dispatch(ticketId,…)` | Workflow instances + create_child_tasks need to handle both case parents and work-order targets. Phase: 1c.7 |
| 6 | `00027_routing_foundation.sql:56` + `routing.service.ts:60` | `routing_decisions.ticket_id` FK to tickets | Add `routing_decisions.work_order_id` polymorphic; backfill. Phase: 1c.8 |
| 7 | `ticket.service.ts:230,308–310` | Ticket listing has `ticket_kind`, `parent_ticket_id`, booking-origin filters | Split into `getCases()` and `getWorkOrders()` API methods; deprecate the kind filter. Phase: 1c.9 |
| 8 | `reclassify.service.ts:398` | Case ↔ work_order conversion (`ticket_kind` flip) | Cross-table reclassify: insert into target table, delete from source. Phase: 1c.10 |

Plus the activities concern: `ticket_activities.ticket_id` FK; the polymorphic `activities` table from step 0 is the long-term answer but `ticket_activities` itself still exists. Phase: 1c.11.

---

## Phased migration sequence

Each phase is its own migration + commit. Each leaves the system consistent. Each can be rolled back if issues surface in production.

### Phase 1c.0 — pre-flight audit

Before any DDL:
1. Run `select count(*) from tickets where ticket_kind='work_order'` and snapshot the value.
2. Run `select count(*) from sla_timers join tickets on tickets.id = sla_timers.ticket_id where tickets.ticket_kind='work_order'`. Same for routing_decisions, ticket_activities.
3. Verify the `work_order_single_parent` constraint from 00208 has no violations (already verified at step 1a).
4. Run pg_stat_user_tables to confirm no concurrent VACUUM / autovacuum is blocking the migration window.

**Deliverable:** a numbers report committed to `docs/follow-ups/step1c-baseline.md`.

### Phase 1c.1 — create `work_orders` real table (mirror schema)

```sql
create table public.work_orders_new (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  parent_kind text check (parent_kind in ('case','booking_bundle')),
  parent_case_id uuid references public.tickets(id),    -- legacy bridge until step 6
  booking_bundle_id uuid references public.booking_bundles(id) on delete set null,
  -- … all 50+ columns mirrored from tickets work_order subset …
  legacy_ticket_id uuid unique references public.tickets(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Key: `legacy_ticket_id` is the reverse pointer back to the original tickets row, used for the dual-write phase. After phase 1c.10 (drop) it's removed.

Constraints: same `work_order_single_parent` check (parent_case_id and booking_bundle_id mutually exclusive), same `parent_case_id must reference a case` trigger.

Indexes: mirror the same hot-path indexes as on tickets (queue_primary, queue_sla, queue_location, etc.) but filtered to work_orders semantics.

Visibility: `work_order_visibility_ids(user_id, tenant_id)` SQL function — descendant of `ticket_visibility_ids` but tuned for the work_orders read patterns (no requester_person_id filter for booking-origin, vendor join already inlined).

RLS: tenant_isolation. REVOKE from anon/authenticated/public/service_role for write; SELECT only to service_role (matches current cases/work_orders view posture).

**Risk:** medium. Pure additive table; no FK changes yet.

### Phase 1c.2 — backfill from tickets

```sql
insert into public.work_orders_new (id, tenant_id, parent_case_id, booking_bundle_id, …, legacy_ticket_id)
select t.id, t.tenant_id, t.parent_ticket_id, t.booking_bundle_id, …, t.id
from public.tickets t
where t.ticket_kind = 'work_order'
on conflict (legacy_ticket_id) do nothing;
```

Verify: count(work_orders_new) == count(tickets where ticket_kind='work_order') from phase 1c.0 baseline.

**Risk:** medium. Long-running on tenants with millions of work orders. Consider a chunked backfill if any tenant has >100K work_orders (current largest is ~300, so single transaction is fine for now).

### Phase 1c.3 — dual-write trigger from tickets to work_orders_new

```sql
create or replace function public.shadow_ticket_work_order_to_work_orders_new()
returns trigger language plpgsql as $$
begin
  if new.ticket_kind = 'work_order' then
    if tg_op = 'INSERT' then
      insert into public.work_orders_new (id, tenant_id, …, legacy_ticket_id)
      values (new.id, new.tenant_id, …, new.id);
    elsif tg_op = 'UPDATE' then
      update public.work_orders_new set … where legacy_ticket_id = new.id;
    end if;
  end if;
  return new;
end $$;

create trigger trg_ticket_wo_shadow
after insert or update on public.tickets
for each row execute function public.shadow_ticket_work_order_to_work_orders_new();

-- Plus a delete trigger for cascades.
```

Now every write to `tickets` for a work_order row also writes to `work_orders_new`. Reads still hit tickets directly. This is the dual-write window.

**Run for at least 2 release cycles** before flipping any reader. Use the time to monitor for divergence (a daily cron: `select count(*) from tickets where ticket_kind='work_order'` vs `count(*) from work_orders_new` — alert if they differ).

**Index bloat caveat:** during the dual-write window, every `work_order` write goes through both tables, doubling index churn (queue_primary, queue_sla, queue_location all replicated). On busy tenants this can measurably slow desk-queue latency for the duration of the window. Mitigations: (a) keep the window short — 2 cycles, not "until comfortable"; (b) monitor desk-queue p95 latency during the soak; (c) if degradation is observable, defer the secondary indexes on `work_orders_new` until after writers cut over (1c.4).

**Risk:** medium. Trigger overhead on every tickets write. Measure at scale before declaring stable.

### Phase 1c.3.5 — install reverse trigger + parallel-soak

**Inserted after the original plan because the dual-write reversal in 1c.4 was hand-waved.** Reversing trigger direction during the writer cutover is the single highest-risk operation in the migration. Splitting it out gives a soak window where both directions run in parallel and divergence can be caught before it bites.

```sql
-- Reverse direction shim: every write to work_orders_new shadows back into tickets.
-- This protects callers still reading from `tickets` during the write cutover.
create or replace function public.shadow_work_orders_new_to_tickets()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into public.tickets (id, tenant_id, ticket_kind, …) values (new.id, new.tenant_id, 'work_order', …)
    on conflict (id) do nothing;  -- the forward shim may already have inserted
  elsif tg_op = 'UPDATE' then
    update public.tickets set … where id = new.id;
  end if;
  return new;
end $$;

create trigger trg_wo_new_to_tickets_shadow
after insert or update on public.work_orders_new
for each row execute function public.shadow_work_orders_new_to_tickets();
```

Run BOTH directions in parallel for one full release cycle. Daily divergence check: count + content hash on both sides. Zero divergence is the gate to 1c.4.

**Risk:** medium. The forward + reverse triggers must use `on conflict do nothing` and idempotent UPDATEs to avoid trigger ping-pong (forward fires reverse fires forward …). Test the loop-prevention before any traffic hits the soak.

### Phase 1c.3.6 — re-run all 1b readers against the materialized table

Step 1b cut three readers (vendor portal, fulfillment_units_v, booking_bundle_status_v) to read from the `work_orders` view. Step 1c.10 swaps the underlying object from view → table by renaming `work_orders_new` over `work_orders`. **PostgREST schema cache, prepared-statement plans, and RLS policy attachment behave differently for tables vs views** — a reader that worked against the view may need re-binding to work against the table.

Before 1c.4 (writer cutover):

1. Materialize the table by renaming view → `work_orders_view_legacy`, table → `work_orders` (in a transaction, atomically). Note this is a temporary swap — it can be reverted if any reader breaks.
2. Re-run every step-1b reader's full path under the new binding:
   - Vendor portal: query a known vendor, expect identical row count + content as before.
   - `fulfillment_units_v`: query against a known tenant, snapshot diff against pre-swap.
   - `booking_bundle_status_v`: query against all bundles, status_rollup unchanged.
3. If any reader breaks, swap back, debug, retry. Don't proceed to 1c.4 until all 1b readers pass.

**Risk:** medium. The atomic rename requires `ALTER VIEW … RENAME` and `ALTER TABLE … RENAME` in one transaction; PostgREST schema notify must fire after.

### Phase 1c.4 — flip writers (dispatch, workflow, booking-origin, reclassify)

Now writers go to `work_orders` (the table, post-rename in 1c.3.6) directly. Both the forward shadow (tickets → work_orders) and the reverse shadow (work_orders → tickets) keep both tables in sync during this phase.

Files to update:
- `apps/api/src/modules/ticket/dispatch.service.ts:79–83` — `from('tickets')` → `from('work_orders')` for work_order kind.
- `apps/api/src/modules/ticket/ticket.service.ts:1499–1574` — booking-origin insert.
- `apps/api/src/modules/workflow/workflow-engine.service.ts:213` — `dispatch(ticketId)` becomes `dispatch(workOrderId)`.
- `apps/api/src/modules/ticket/reclassify.service.ts:398` — case ↔ work_order conversion is now a cross-table operation.

**Risk:** HIGH. This is the actual cutover. Every test in `apps/api/src/modules/ticket/` and `apps/api/src/modules/dispatch/` must pass against the new path.

### Phase 1c.5 — move parent/child rollup trigger to work_orders

The 00030 trigger `rollup_parent_status_trg` currently fires on `tickets.status_category` updates filtered by `ticket_kind='work_order' and parent_ticket_id is not null`. Move it to fire on `work_orders.status_category` updates with `parent_case_id is not null`.

The parent update target stays on `tickets` (the case) — that's fine, the trigger function just selects from work_orders for sibling status aggregation.

**Risk:** medium. Easy to introduce timing-related bugs in trigger ordering.

### Phase 1c.6 — sla_timers FK migration

```sql
alter table public.sla_timers
  add column entity_kind text default 'case' check (entity_kind in ('case','work_order')),
  add column work_order_id uuid references public.work_orders(id) on delete cascade;

-- Backfill: timers attached to work_order tickets get entity_kind='work_order' and work_order_id set.
update public.sla_timers st
set entity_kind = 'work_order', work_order_id = st.ticket_id
from public.tickets t
where t.id = st.ticket_id and t.ticket_kind = 'work_order';

-- ticket_id is now case-only.
alter table public.sla_timers rename column ticket_id to case_id;
-- (or keep ticket_id and just split on entity_kind in queries — cleaner short-term)
```

Update `sla.service.ts:25` to write to the right column.

**Risk:** medium. Rename breaks every query that hard-codes `ticket_id`.

### Phase 1c.7 — workflow_instances FK migration

`workflow_instances.ticket_id` is FK to tickets. Workflows can be attached to either a case OR a work_order. Polymorphic via `(entity_kind, entity_id)`.

Same pattern as 1c.6.

### Phase 1c.8 — routing_decisions FK migration

`routing_decisions.ticket_id` is FK to tickets. Both case routing decisions and work-order dispatch decisions are recorded. Polymorphic via `(entity_kind, entity_id)`.

### Phase 1c.9 — split ticket listing API

`ticket.service.ts:230` has filters for `ticket_kind`, `parent_ticket_id`, booking-origin. Split into:
- `case.service.ts` — read-only methods on cases
- `work_order.service.ts` — read-only methods on work_orders

`ticket.service.ts` remains for transitional backward compatibility but new code uses the split services.

**Risk:** medium. Frontend code may import from ticket.service.ts; breaking changes are possible.

### Phase 1c.10 — drop work_order rows from tickets ⚠️ POINT OF NO RETURN

**This phase is destructive. There is no rollback path other than restore-from-backup.** Split into three sub-phases to maximise safe time at each step:

**1c.10a — stop dual-write.** Disable the forward + reverse shadow triggers. Continue running for 7 days with both tables present. Any production issue surfaces; we revert by re-enabling triggers, no data loss.

**1c.10b — wait 30 days.** Monitor production. The `tickets where ticket_kind='work_order'` rows still exist as a hot backup. If any bug surfaces in this window, point-in-time-recovery to a backup taken before 1c.10a is not needed — we just re-enable the shadow triggers and restore from `tickets`.

**1c.10c — destructive drop.**

```sql
delete from public.tickets where ticket_kind = 'work_order';

-- Drop the ticket_kind column entirely.
alter table public.tickets drop column ticket_kind;

-- Drop the (now-disabled) dual-write triggers and shadow functions.
drop trigger if exists trg_ticket_wo_shadow on public.tickets;
drop trigger if exists trg_wo_new_to_tickets_shadow on public.work_orders;
drop function if exists shadow_ticket_work_order_to_work_orders_new();
drop function if exists shadow_work_orders_new_to_tickets();

-- Drop legacy_ticket_id since the bridge is gone.
alter table public.work_orders drop column legacy_ticket_id;
```

**Required gating:**
- NOT during a deploy freeze, holiday, or oncall handover.
- NOT within 7 days of any other significant migration.
- Pre-1c.10c snapshot of `tickets where ticket_kind='work_order'` archived to S3 with 90-day retention SLA.
- Explicit DBA + product sign-off recorded.

**Risk:** HIGH and irreversible. Forward-fix only after 1c.10c completes — no rollback that doesn't involve restore-from-backup.

### Phase 1c.11 — ticket_activities migration

The `activities` polymorphic table from step 0 already shadows ticket_activities. After 1c.10, activities is the single source of truth. Drop the shadow trigger, deprecate `ticket_activities` (keep as a backward-compat view), eventually drop.

---

## Naming conventions — the `parent_kind` enum

The master doc and this plan disagreed on the enum values. Resolved here as the source of truth for step 1c:

```
parent_kind ∈ { 'case', 'booking_bundle' }
```

`booking_bundle` is the current table name (will be renamed to `bookings` at step 4). The line-level parents (`booking_service`, `booking_room_reservation`) referenced in the master doc are a STEP 1c+ design — not used during the bridge. When step 4 renames `booking_bundles` → `bookings`, this enum gains `booking` as a value and `booking_bundle` is deprecated. The line-level parent shape is a step 6+ concern.

**Action required:** the master doc (`data-model-redesign-2026-04-30.md:74`) currently states the line-level parents as the target. Update to match this resolution — the line-level parents are the END state, not the step 1c state.

The `parent_case_id` column name in 1c.1 schema (`work_orders_new`) was misleading because tickets won't be renamed to cases until step 6. Rename to `parent_ticket_id` to keep the bridge accurate, OR commit now to the column name and rename in step 6 with the table.

## Visibility surface transition (open Q3 elevated)

Per `docs/visibility.md` MANDATORY rule, doc updates ship in the same PR as the visibility change.

**Required at phase 1c.9:**

1. New SQL functions `cases_visible_for_actor(p_user_id, p_tenant_id, p_has_read_all)` and `work_orders_visible_for_actor(p_user_id, p_tenant_id, p_has_read_all)`. Each returns the appropriate setof rows. Drop `tickets_visible_for_actor` after the cutover (it's case-only after 1c.10c so it would just be `cases_visible_for_actor`).

2. Permission split: today's `tickets:read_all` permission must be migrated to the union of `cases:read_all` + `work_orders:read_all`. Choose:
   - **Implicit grant:** any role with `tickets:read_all` automatically gets both new permissions. Simpler migration, prevents lock-out. Risk: roles intended to read only cases (e.g. requesters' helpdesk) get unintended visibility on work_orders.
   - **Explicit re-grant:** every role gets re-evaluated. More work, more correct. Required for least-privilege orgs.
   - **Recommended:** start with implicit grant (no breakage), then audit + downgrade per-role over the next quarter.

3. Update `docs/visibility.md` in the same PR as 1c.9. The doc is the operational contract.

## Open questions

1. **`work_orders.id` reuses source `tickets.id`** — RESOLVED. Reuse the UUID. FK preservation across the transition is worth more than ID-cleanliness.

2. **Are any frontends doing `supabase.from('tickets')` directly that we'd break?** Earlier codex review found none. Verify again at phase 1c.4 with a fresh grep across `apps/web/`.

3. **`tickets_visible_for_vendor` already orphaned** (dropped in 00212). `tickets_visible_for_actor` transition is now specified in the "Visibility surface transition" section above.

4. **Reclassify cross-table.** Reclassify (case ↔ work_order conversion) becomes a cross-table operation. Phase 1c.4 lists `reclassify.service.ts:398` as a writer to update — but the case study is needed: when a case with workflow instances is reclassified to a work_order, do the workflow instances follow? Today they're keyed by `ticket_id` so they'd point at the new work_order's row. After 1c.7's `workflow_instances` polymorphic split, a reclassify must also update `workflow_instances.entity_kind`. Add to the 1c.4 implementation as a sub-task.

5. **Index bloat during 1c.3 dual-write** — flagged above (Phase 1c.3 caveat). Mitigation: short window, latency monitoring, defer secondary indexes if needed.

6. **Tenant_id integrity across the bridge.** `work_orders_new` rows are sourced from `tickets`. If a hypothetical bug allowed a tenant_id mismatch between `work_orders_new` and the source `tickets` row, RLS would silently break for a specific row. Add a check constraint at 1c.1 that asserts tenant_id integrity, and a daily audit query during 1c.3.

---

## Verification gates

Each phase has a hard gate before the next can ship:

- 1c.0 — baseline numbers committed.
- 1c.1 — `\d work_orders_new` matches expected schema; constraints in place.
- 1c.2 — backfill count == baseline count from 1c.0.
- 1c.3 — 24-hour trigger soak: divergence count = 0.
- 1c.4 — full API test suite green; manual smoke test of each cutover writer.
- 1c.5 — rollup trigger smoke test: change a work_order's status, confirm parent case status flips per spec.
- 1c.6/7/8 — equivalence test: query SLA / routing for each affected ticket via old + new path, results match.
- 1c.9 — frontend smoke: open service desk queue, vendor portal, daglijst — all render correctly.
- 1c.10 — pre-drop snapshot of `tickets` rows where ticket_kind='work_order' saved to S3 for 30 days.
- 1c.11 — `ticket_activities` view returns identical rows to the table for 1 week before drop.

---

## What this plan does NOT cover

- **Step 2** (`orders` → `service_orders`). Independent of step 1c. Can be done before, during, or after.
- **Step 3** (resources catalog). Independent. Can happen anytime.
- **Step 4** (`booking_bundles` → `bookings`). Best done after step 1c when the line tables (room_reservations, asset_reservations, services, visitors) are stable.
- **Step 5** (visitors). Blocked on the parallel visitors-track workstream.
- **Step 6** (`tickets` → `cases` rename). After 1c.10.
