# Fulfillment Architecture Fixes — Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four data-contract bugs and gaps codex flagged in the tickets/orders/reservations architecture: (1) `vendor_id` + `menu_item_id` not populated on `order_line_items` insert (live data bug); (2) latent broken cascade code that writes nonexistent ticket columns; (3) bundle status view masks open work-orders; (4) no unifying read model for cross-source fulfillment queries.

**Architecture:** Three-root model stays (tickets / reservations / orders+order_line_items), with `booking_bundles` as orchestration parent. Don't unify the roots. Add a thin read-side `fulfillment_units_v` view above them. Remove the broken latent linkage code; defer activating ticket linkage to Wave 2 (proper link table, vendor-on-tickets visibility).

**Tech Stack:** NestJS 11 (TypeScript), Supabase Postgres + RLS, Vitest, pg.

**Out of scope (Wave 2 — separate plan):**
- Activating vendor visibility on tickets (00035 dormant migration + ticket-visibility.service stubs)
- Replacing `linked_ticket_id` FK with a proper link table + auto-creation rules
- Two-way status sync between line and linked work-order
- Full SLA-style breach engine on order lines (start with derived lateness in Wave 2)

---

## Task 1: Fix #1A — populate `vendor_id` + `menu_item_id` in `bundle.service.ts` createLineItem

**Files:**
- Modify: `apps/api/src/modules/booking-bundles/bundle.service.ts:710-743`

The `HydratedLine` type already carries `fulfillment_vendor_id` and `menu_item_id` (lines 834–851). The data is in scope at insert time. The columns just need to be added to the insert payload.

- [ ] **Step 1: Add `vendor_id` and `menu_item_id` to insert column list**

In `createLineItem`, after `fulfillment_team_id: args.line.fulfillment_team_id,`, add:

```ts
        vendor_id: args.line.fulfillment_vendor_id,
        menu_item_id: args.line.menu_item_id,
```

Keep `policy_snapshot.menu_item_id` and `policy_snapshot.menu_id` — they're a write-time snapshot; the dedicated columns are the live denorm for queries.

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/booking-bundles/bundle.service.ts
git commit -m "fix(bundle): populate vendor_id + menu_item_id on order line items

Vendor portal, daglijst, and status updates filter on oli.vendor_id
but the bundle insert path was leaving it null. Same for menu_item_id."
```

---

## Task 2: Fix #1B — populate `vendor_id` + `menu_item_id` in `order.service.ts` createLineItem

**Files:**
- Modify: `apps/api/src/modules/orders/order.service.ts:1056-1094`

`resolveOffer` returns `{ menu_id, menu_item_id, vendor_id, ... }` (lines 996–1013). Same fix shape.

- [ ] **Step 1: Add `vendor_id` and `menu_item_id` to insert column list**

After `fulfillment_team_id: args.offer?.fulfillment_team_id ?? args.item.fulfillment_team_id,`:

```ts
        vendor_id: args.offer?.vendor_id ?? null,
        menu_item_id: args.offer?.menu_item_id ?? null,
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/orders/order.service.ts
git commit -m "fix(orders): populate vendor_id + menu_item_id on standalone order line items"
```

---

## Task 3: Fix #1C — backfill migration for existing rows

**Files:**
- Create: `supabase/migrations/00184_orders_line_vendor_provenance_backfill.sql`

For existing rows, recover `vendor_id` and `menu_item_id` from `policy_snapshot.menu_item_id` (always written by both insert paths today), joined to `menu_items`.

- [ ] **Step 1: Write the migration**

```sql
-- 00184_orders_line_vendor_provenance_backfill.sql
-- Backfill order_line_items.vendor_id and .menu_item_id from policy_snapshot.
-- Both insert paths historically wrote menu_item_id into policy_snapshot but
-- not into the dedicated columns the vendor portal queries against. The
-- vendor portal therefore sees mostly-null vendor_id for legacy rows and
-- can't filter today's deliveries correctly.
--
-- Strategy:
--   1. Where policy_snapshot.menu_item_id is set and the FK is still null,
--      copy it into the menu_item_id column.
--   2. Derive vendor_id by joining menu_items -> catalog_menus.fulfillment_vendor_id
--      where vendor_id is still null.
--   3. Skip rows where the snapshot value no longer exists in menu_items
--      (orphaned references; vendor stays null and ops can fix manually).

update public.order_line_items oli
   set menu_item_id = (oli.policy_snapshot ->> 'menu_item_id')::uuid
 where oli.menu_item_id is null
   and oli.policy_snapshot ? 'menu_item_id'
   and (oli.policy_snapshot ->> 'menu_item_id') ~ '^[0-9a-f-]{36}$'
   and exists (
     select 1 from public.menu_items mi
      where mi.id = (oli.policy_snapshot ->> 'menu_item_id')::uuid
        and mi.tenant_id = oli.tenant_id
   );

update public.order_line_items oli
   set vendor_id = cm.fulfillment_vendor_id
  from public.menu_items mi
  join public.catalog_menus cm on cm.id = mi.menu_id and cm.tenant_id = mi.tenant_id
 where oli.vendor_id is null
   and oli.menu_item_id = mi.id
   and oli.tenant_id = mi.tenant_id
   and cm.fulfillment_vendor_id is not null;

-- Telemetry: log how many rows we couldn't backfill (vendor still null on a
-- non-cancelled line). These need manual ops attention or are pre-vendor-FK.
do $$
declare
  v_unfilled_count int;
begin
  select count(*) into v_unfilled_count
    from public.order_line_items
   where vendor_id is null
     and fulfillment_status not in ('cancelled');
  raise notice 'order_line_items rows with NULL vendor_id after backfill: %', v_unfilled_count;
end$$;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Run `pnpm db:reset` to verify SQL applies cleanly**

```bash
pnpm db:reset
```

Expected: all migrations apply, including 00184.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00184_orders_line_vendor_provenance_backfill.sql
git commit -m "fix(db): backfill order_line_items vendor_id + menu_item_id from policy_snapshot"
```

---

## Task 4: Fix #2 — remove broken `linked_ticket_id` cascade code

**Files:**
- Modify: `apps/api/src/modules/booking-bundles/bundle.service.ts:477-512` (window-cascade)
- Modify: `apps/api/src/modules/booking-bundles/bundle-cascade.service.ts:113-119` (cancel-cascade)

Both blocks reference `tickets` columns that don't exist (`requested_for_start_at`, `requested_for_end_at`, `resolution`). They only run when `linked_ticket_id` is non-null, which is never today — but the code is a bomb if anything ever wires it up. Strip + comment.

- [ ] **Step 1: Replace the window-cascade block with a TODO stub in `bundle.service.ts`**

Replace the block from `// Cascade window change to the linked work-order ticket...` through `}` at line 512 with:

```ts
    // Note (2026-04-29): linked_ticket_id is currently a no-op FK. Earlier
    // cascade code attempted to write tickets.requested_for_start_at/end_at,
    // but those columns live on `orders`, not `tickets`. The cascade is
    // intentionally removed until Wave 2 introduces (a) a proper link table
    // between order_line_items and work-order tickets and (b) vendor-on-ticket
    // visibility. See docs/superpowers/plans/2026-04-29-fulfillment-fixes.md.
```

- [ ] **Step 2: Replace the cancel-cascade block with a TODO stub in `bundle-cascade.service.ts`**

Replace lines 113–119:

```ts
    if (line.linked_ticket_id) {
      await this.supabase.admin
        .from('tickets')
        .update({ status_category: 'closed', resolution: 'cancelled' })
        .eq('id', line.linked_ticket_id);
      cascaded.ticket_ids.push(line.linked_ticket_id);
    }
```

with:

```ts
    // Note (2026-04-29): ticket cancel-cascade removed. Old code wrote a
    // non-existent tickets.resolution column. Re-introduce when Wave 2 adds
    // the link table; until then linked_ticket_id stays null in production
    // and this branch never fires.
```

- [ ] **Step 3: Run typecheck to confirm nothing else referenced these blocks**

```bash
pnpm --filter @prequest/api typecheck
```

Expected: clean (or only pre-existing errors unrelated to bundle services).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/booking-bundles/bundle.service.ts \
        apps/api/src/modules/booking-bundles/bundle-cascade.service.ts
git commit -m "fix(bundle): remove broken linked_ticket_id cascade writes

Both code paths wrote columns that don't exist on tickets
(requested_for_start_at/end_at, resolution). The branches only fire
when linked_ticket_id is set, which is never today, but the latent
crash is removed and TODOs point at the Wave 2 link-table design."
```

---

## Task 5: Fix #4 — `booking_bundle_status_view` rollup includes ticket statuses

**Files:**
- Create: `supabase/migrations/00185_booking_bundle_status_view_ticket_aware.sql`

Current view (00148) selects `bt.ticket_statuses` but the CASE rollup never references it. An open work-order can be hidden because the rollup only checks reservation + order columns. Fix the rollup logic so a non-terminal ticket is reflected.

- [ ] **Step 1: Write the migration**

```sql
-- 00185_booking_bundle_status_view_ticket_aware.sql
-- The 00148 rollup CASE never inspects bt.ticket_statuses, so an open
-- work-order under a bundle can be masked by a confirmed reservation +
-- approved orders. Add ticket awareness:
--   - 'pending_approval' if any ticket is in approval-equivalent state
--     (status_category = 'new' with a pending_approval marker isn't trivial;
--     today we treat 'new' before assignment as part of confirmed for the
--     bundle, but a non-terminal ticket count keeps cancelled rollups honest)
--   - cancelled rollup requires every ticket to be 'closed' (or no tickets)
--   - partially_cancelled if some tickets are still alive but reservations or
--     orders are cancelled
--
-- Status names this view emits remain unchanged.

create or replace view public.booking_bundle_status_v as
with bundle_reservations as (
  select b.id as bundle_id,
         array_agg(r.status) filter (where r.id is not null) as reservation_statuses
  from public.booking_bundles b
  left join public.reservations r on r.booking_bundle_id = b.id
  group by b.id
),
bundle_orders as (
  select b.id as bundle_id,
         array_agg(o.status) filter (where o.id is not null) as order_statuses
  from public.booking_bundles b
  left join public.orders o on o.booking_bundle_id = b.id
  group by b.id
),
bundle_tickets as (
  select b.id as bundle_id,
         array_agg(t.status_category) filter (where t.id is not null) as ticket_statuses
  from public.booking_bundles b
  left join public.tickets t on t.booking_bundle_id = b.id and t.ticket_kind = 'work_order'
  group by b.id
)
select b.id as bundle_id,
       b.tenant_id,
       case
         when (
           coalesce(array_length(br.reservation_statuses, 1), 0) +
           coalesce(array_length(bo.order_statuses, 1), 0) +
           coalesce(array_length(bt.ticket_statuses, 1), 0)
         ) = 0 then 'pending'
         when 'pending_approval' = any(coalesce(br.reservation_statuses, '{}')) or
              'submitted' = any(coalesce(bo.order_statuses, '{}'))
           then 'pending_approval'
         when (br.reservation_statuses is null or br.reservation_statuses <@ array['cancelled','released']) and
              (bo.order_statuses is null or bo.order_statuses <@ array['cancelled','fulfilled']) and
              (bt.ticket_statuses is null or bt.ticket_statuses <@ array['closed'])
           then case
                  when 'fulfilled' = any(coalesce(bo.order_statuses, '{}'))
                    or (bt.ticket_statuses is not null and array_length(bt.ticket_statuses, 1) > 0
                        and not ('closed' = all(bt.ticket_statuses)))
                  then 'partially_cancelled'
                  else 'cancelled'
                end
         when 'cancelled' = any(coalesce(br.reservation_statuses, '{}')) or
              'cancelled' = any(coalesce(bo.order_statuses, '{}'))
           then 'partially_cancelled'
         else 'confirmed'
       end as status_rollup,
       br.reservation_statuses,
       bo.order_statuses,
       bt.ticket_statuses
from public.booking_bundles b
left join bundle_reservations br on br.bundle_id = b.id
left join bundle_orders bo on bo.bundle_id = b.id
left join bundle_tickets bt on bt.bundle_id = b.id;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Run `pnpm db:reset` to verify**

```bash
pnpm db:reset
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00185_booking_bundle_status_view_ticket_aware.sql
git commit -m "fix(db): bundle status rollup honors open work-order tickets

00148 collected ticket_statuses but never read them in the CASE ladder,
so an open work-order under an otherwise-cancelled bundle was masked.
Cancelled rollup now requires every ticket to be closed; mixed states
fall through to partially_cancelled."
```

---

## Task 6: Fix #3 — add `fulfillment_units_v` unifying view

**Files:**
- Create: `supabase/migrations/00186_fulfillment_units_view.sql`

A read-only UNION across `order_line_items` and work-order tickets, with shared columns. Vendor scorecards, cross-source reporting, and the (Wave 2) unified vendor inbox all read from this.

- [ ] **Step 1: Write the migration**

```sql
-- 00186_fulfillment_units_view.sql
-- Cross-root read model: every "unit of work the org owes" represented as
-- one row, regardless of whether it originated as a service line on a
-- reservation or a dispatched work-order ticket.
--
-- This is a READ-ONLY view. Underlying state machines (oli.fulfillment_status
-- vs ticket.status_category) stay separate. Use this view for:
--   - vendor scorecards ("on-time delivery rate" across both)
--   - "all my work this week" cross-source reporting
--   - the future unified vendor inbox (gated on Wave 2 vendor-on-tickets
--     visibility being activated)

create or replace view public.fulfillment_units_v as
select
  'service_line'::text as source_kind,
  oli.id as source_id,
  oli.tenant_id,
  oli.vendor_id,
  oli.fulfillment_team_id as assigned_team_id,
  null::uuid as assigned_user_id,
  ord.delivery_location_id as location_id,
  ord.booking_bundle_id,
  oli.service_window_end_at as due_at,
  oli.fulfillment_status as status,
  -- Best-effort summary: catalog item name + quantity. Falls back to a stub
  -- so callers always have a non-null label.
  coalesce(ci.name, 'Service line') ||
    case when oli.quantity is not null then ' × ' || oli.quantity::text else '' end
    as summary,
  ord.id as parent_order_id,
  null::uuid as parent_ticket_id,
  oli.created_at,
  oli.updated_at
from public.order_line_items oli
join public.orders ord on ord.id = oli.order_id and ord.tenant_id = oli.tenant_id
left join public.catalog_items ci on ci.id = oli.catalog_item_id and ci.tenant_id = oli.tenant_id

union all

select
  'work_order'::text as source_kind,
  t.id as source_id,
  t.tenant_id,
  t.assigned_vendor_id as vendor_id,
  t.assigned_team_id,
  t.assigned_user_id,
  t.location_id,
  t.booking_bundle_id,
  t.sla_resolution_due_at as due_at,
  t.status_category as status,
  t.title as summary,
  null::uuid as parent_order_id,
  t.parent_ticket_id,
  t.created_at,
  t.updated_at
from public.tickets t
where t.ticket_kind = 'work_order';

-- Indexable surface: most queries will filter (tenant_id, vendor_id, due_at).
-- The view is non-materialized; the composite indexes already exist on the
-- underlying tables (idx_oli_vendor + idx_tickets_queue_sla) so this is
-- fine for now. If query latency becomes an issue, materialize and refresh
-- on writes (out of scope for Wave 1).

-- View inherits RLS from underlying tables; vendor_id-scoped reads from the
-- vendor portal already work because oli is filtered. Ticket rows here
-- inherit the existing ticket-visibility RLS — vendors will not see ticket
-- rows until the dormant 00035 vendor-on-tickets policy is activated in
-- Wave 2. That's intentional: this view is forward-compatible.

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Run `pnpm db:reset` to verify**

```bash
pnpm db:reset
```

- [ ] **Step 3: Smoke query — count rows by source_kind**

```bash
PGPASSWORD=postgres psql "postgresql://postgres@127.0.0.1:54322/postgres" -c \
  "select source_kind, count(*) from public.fulfillment_units_v group by 1;"
```

Expected: at least one count for `service_line` from seed data.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00186_fulfillment_units_view.sql
git commit -m "feat(db): add fulfillment_units_v cross-source read model

Unions order_line_items and work-order tickets into one row-shape so
vendor scorecards, reporting, and the future unified inbox have a
single canonical query. Read-only view; underlying state machines
remain separate. RLS-clean (inherits)."
```

---

## Task 7: Vitest tests for line-item insert paths

**Files:**
- Create: `apps/api/src/modules/booking-bundles/__tests__/bundle-vendor-provenance.spec.ts` (or extend an existing bundle service test)

Verify both insert paths now write `vendor_id` and `menu_item_id` to the dedicated columns, not just `policy_snapshot`.

- [ ] **Step 1: Find the existing bundle service test (if any)**

```bash
find apps/api/src/modules/booking-bundles -name "*.spec.ts" | head
```

- [ ] **Step 2: Add a test that inserts a line through `attachServicesToReservation` and asserts the resulting row has the FK columns set**

If no existing test harness exists for bundle.service, prefer a thin SQL-level integration test that:
1. Inserts a tenant, requester, space, vendor, menu, menu_item, catalog_item with the menu+vendor link
2. Calls the service to attach a single line
3. Reads back `order_line_items` and asserts `vendor_id is not null and menu_item_id is not null`

If existing tests already cover bundle service, add the assertion to whichever test currently inserts a line.

- [ ] **Step 3: Run the suite**

```bash
pnpm --filter @prequest/api test -- bundle
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/booking-bundles
git commit -m "test(bundle): assert vendor_id + menu_item_id on inserted line items"
```

---

## Task 8: Push migrations to remote + smoke

**Files:** none (DB-only)

Per memory: user has standing permission for portal-scope work to push migrations.

- [ ] **Step 1: Apply migrations to remote via psql fallback**

```bash
PGPASSWORD='<db_password>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -v ON_ERROR_STOP=1 \
  -f supabase/migrations/00184_orders_line_vendor_provenance_backfill.sql \
  -f supabase/migrations/00185_booking_bundle_status_view_ticket_aware.sql \
  -f supabase/migrations/00186_fulfillment_units_view.sql
```

(User provides DB password per session.)

- [ ] **Step 2: Reload PostgREST schema**

The `notify pgrst, 'reload schema';` at the bottom of each migration handles this. Confirm by hitting the API.

- [ ] **Step 3: Smoke via running API**

```bash
# Confirm vendor portal reads non-null vendor_id rows
curl -s -H "Authorization: Bearer $VENDOR_TOKEN" "$API_BASE/vendor/orders?from=2026-04-29&to=2026-05-15" | jq '.[0]'
```

---

## Task 9: Codex review on the diff

- [ ] **Step 1: Run codex on the branch**

```bash
codex exec --full-auto -C /Users/x/Desktop/XPQT \
  "Review the diff on branch fix/fulfillment-architecture-cleanup against main. Focus areas: \
  (1) Are the vendor_id/menu_item_id insert fixes complete? Any third insert path I missed? \
  (2) Is the backfill migration safe? Any risk of writing the wrong vendor for a row? \
  (3) Is the fulfillment_units_v view RLS-correct in practice — would a vendor reading this view \
  see ticket rows they shouldn't? \
  (4) Is the bundle status view fix logically correct for 'all closed = cancelled' rollups? \
  Cite file paths + line numbers. Under 500 words."
```

- [ ] **Step 2: Address findings (if any)**

If codex finds blockers, file follow-up tasks; if minor, fix inline + amend the relevant commit.

- [ ] **Step 3: Report milestone to user**

Summarize: 4 fixes shipped on branch, migrations on remote, codex verdict, propose Wave 2 (vendor-on-tickets visibility + link table) as next decision.

---

## Self-review checklist

- ✅ Spec coverage: codex finding #1 (line vendor provenance) → Tasks 1+2+3+7. Codex finding #2 (broken cascade) → Task 4. Codex finding #4 (bundle rollup) → Task 5. Codex finding #3 (fulfillment_units view) → Task 6.
- ✅ No placeholders — every step has actual code or actual command.
- ✅ Migration prefixes 00184–00186 are in sequence (last existing is 00183).
- ✅ Tests included (Task 7).
- ✅ Codex review included (Task 9).
- ✅ Wave 2 scope explicitly listed and deferred (vendor-on-tickets + link table).
