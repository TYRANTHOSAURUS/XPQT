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

**Risk:** medium. Trigger overhead on every tickets write. Measure at scale before declaring stable.

### Phase 1c.4 — flip writers (dispatch, workflow, booking-origin, reclassify)

Now writers go to `work_orders_new` directly, and the dual-write trigger flips direction (work_orders_new → tickets shadow back, for any code still reading from tickets).

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

### Phase 1c.10 — drop work_order rows from tickets

Now that no readers/writers touch `tickets where ticket_kind='work_order'`:

```sql
delete from public.tickets where ticket_kind = 'work_order';

-- Drop the ticket_kind column entirely.
alter table public.tickets drop column ticket_kind;

-- Drop the dual-write triggers and shadow function.
drop trigger trg_ticket_wo_shadow on public.tickets;
drop function shadow_ticket_work_order_to_work_orders_new();

-- Drop the work_orders view (it's replaced by the work_orders_new table, now renamed).
drop view public.work_orders;
alter table public.work_orders_new rename to work_orders;

-- Drop legacy_ticket_id since the bridge is gone.
alter table public.work_orders drop column legacy_ticket_id;
```

**Risk:** HIGH. Point of no return. Run after 2+ stable release cycles in dual-write.

### Phase 1c.11 — ticket_activities migration

The `activities` polymorphic table from step 0 already shadows ticket_activities. After 1c.10, activities is the single source of truth. Drop the shadow trigger, deprecate `ticket_activities` (keep as a backward-compat view), eventually drop.

---

## Open questions

1. **Should `work_orders.id` reuse the source `tickets.id`?** Phase 1c.1 + 1c.2 use the same UUID for the work_order as the original ticket. This makes the dual-write phase trivially consistent but means `work_orders.id` is "really" a ticket id from before the split. Reasonable trade. Confirm with codex.

2. **Are there any frontends doing `supabase.from('tickets')` directly that we'd break?** Earlier codex review found none, but verify again at phase 1c.4.

3. **Do we need to update `tickets_visible_for_actor()` and `tickets_visible_for_vendor()` to handle the new world?** Both currently filter by `ticket_kind`. After 1c.10 the filter is meaningless (`tickets` only contains cases). Either drop the function or repurpose for cases. Confirm with codex.

4. **What's the rollback for phase 1c.10?** The drop is destructive. If we discover a critical bug after 1c.10, the recovery path is restoring from backup. That means 1c.10 should NOT happen near a deploy freeze or holiday weekend.

5. **Workflow instances and reclassify cross-table.** Reclassify (case ↔ work_order conversion) becomes a cross-table operation. Is there any case where a workflow instance attached to a ticket needs to "follow" the reclassification? Audit case study before 1c.4.

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
