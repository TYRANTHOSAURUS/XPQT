# Fulfillment Architecture Fixes — Wave 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Slice 1 and Slice 3 are executable now; Slice 2 has product decisions that need user input first.

**Goal:** Land the three deferred items from Wave 1's codex review:
1. Vendor visibility on work-order tickets (unblocks the unified vendor inbox)
2. Derived lateness/breach metrics on order_line_items (unblocks scorecards)
3. Link-table replacement for `linked_ticket_id` + auto-creation rules + two-way status sync (cleans up the inert FK)

**Architecture decision (mid-plan):** the dormant `00035_vendor_participant_dormant.sql` was conceived for a "vendor-as-employee" model where a tenant `users` row would have a person whose `external_source = 'vendor'`. The actual vendor portal uses a parallel `vendor_users` table with its own session auth (`vendor-portal.guard.ts`), so retrofitting 00035 doesn't fit. Slice 1 introduces a **vendor-scoped predicate** that lives alongside the existing operator-scoped one.

**Tech Stack:** NestJS 11, Supabase Postgres + RLS, Vitest, pg.

---

## Slice 1: Vendor visibility on tickets

### Why

Today vendors can only see `order_line_items` rows assigned to them. Work-order tickets (`tickets.assigned_vendor_id = <them>`) are invisible — the vendor portal queues two parallel inboxes (orders queue + nothing for repairs/setups).

`fulfillment_units_v` (Wave 1) is the right shape, but the ticket half stays empty for vendors today because the existing `ticket_visibility_ids(p_user_id, p_tenant_id)` keys off `users.id` and vendors don't have one.

### Design

A new SQL predicate `tickets_visible_for_vendor(p_vendor_id, p_tenant_id)` returning `SETOF tickets`, modeled after the existing `tickets_visible_for_actor` (00187). Lookup is direct: `where assigned_vendor_id = p_vendor_id and tenant_id = p_tenant_id and ticket_kind = 'work_order'`. No team/role/permission ladders — vendors are first-class participants only on tickets explicitly assigned to them.

A new `/vendor/work-orders` endpoint on the vendor-portal side that:
- Authenticates via `vendor-portal.guard.ts` (existing pattern)
- Calls `tickets_visible_for_vendor(session.vendor_id, session.tenant_id)`
- PII-minimization mirrors `/vendor/orders`: vendor sees title, location, due date, status; never sees requester full name or watcher list

Update `00186_fulfillment_units_view.sql` documentation comment so the Wave 2 consumer guidance points at this predicate.

The dormant 00035 stays dormant — its TODO comment is updated to reflect that vendor visibility now lives in a parallel function rather than re-entry of the dormant clause.

### Tasks

- [ ] **Step 1: Migration `00188_tickets_visible_for_vendor.sql`**

```sql
-- 00188_tickets_visible_for_vendor.sql
-- Vendor-scoped ticket visibility predicate. Mirrors tickets_visible_for_actor
-- (00187) but keys off vendor_id instead of user_id, so the vendor portal
-- (which authenticates via vendor_users, not users) has a first-class
-- visibility surface.
--
-- Vendors are participant-only on tickets where they're explicitly the
-- assigned vendor. No team / role / read-all paths apply — those concepts
-- are tenant-employee-only.

begin;

create or replace function public.tickets_visible_for_vendor(
  p_vendor_id uuid,
  p_tenant_id uuid
) returns setof public.tickets
language sql
stable
as $$
  select t.*
  from public.tickets t
  where t.tenant_id = p_tenant_id
    and t.assigned_vendor_id = p_vendor_id
    and t.ticket_kind = 'work_order';
$$;

comment on function public.tickets_visible_for_vendor(uuid, uuid) is
  'Vendor-scoped ticket visibility. Returns work-order tickets where the vendor is the explicit assignee. Companion to tickets_visible_for_actor(p_user_id,...). Used by /vendor/work-orders + Wave-2 fulfillment_units_v vendor consumers.';

commit;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: New service `apps/api/src/modules/vendor-portal/vendor-work-order.service.ts`**

Mirrors `vendor-order.service.ts` shape. Lists tickets via the new RPC. Returns the same window default (today + 14 days) keyed off `sla_resolution_due_at`.

- [ ] **Step 3: New controller endpoint `GET /vendor/work-orders` in `vendor-order.controller.ts`** (or a new sibling controller).

Same auth gate (`@UseGuards(VendorPortalGuard)`), same session shape. Response shape mirrors `VendorOrderListItem` minimally:

```ts
{
  id: uuid,
  external_ref: string,
  due_at: timestamptz,
  location: string | null,  // formatted summary
  title: string,
  status: 'new' | 'assigned' | 'in_progress' | 'waiting' | 'resolved' | 'closed',
  priority: string | null,
}
```

PII minimization: never include `requester_person_id`, `watchers`, or any human name. Title is operator-authored and considered safe.

- [ ] **Step 4: Update `00186_fulfillment_units_view.sql` documentation comment**

Replace the line that says "vendors get an empty bag for the tickets union" with: "vendors should call `tickets_visible_for_vendor(vendor_id, tenant_id)` directly OR query a dedicated vendor-scoped view that filters the `work_order` rows on `vendor_id`. The fulfillment_units_v view does not enforce vendor scoping itself."

(We're not changing the view itself — the new predicate is a separate SQL surface.)

- [ ] **Step 5: Vitest spec** for `vendor-work-order.service.ts` covering:
  - Returns only tickets where `assigned_vendor_id = session.vendor_id`
  - Does NOT return tickets from other tenants
  - Honors the date-window filter
  - Returns no rows when there are no assignments (empty array, not error)

- [ ] **Step 6: Push migration to remote, smoke test**

- [ ] **Step 7: Codex review on the diff** — focus on RLS escape gaps + PII surface

- [ ] **Step 8: Commit**

---

## Slice 3: Derived lateness/breach metrics

### Why

Vendor scorecards need an "on-time delivery rate" KPI. Codex recommended derived metrics first (a view) over a full SLA engine — pause/business-hours semantics aren't required for vendor work today. The view can become a column or materialized view later if perf demands.

### Design

Two derived columns in a new view `order_line_lateness_v`, computed from `order_line_items.service_window_end_at` and `now()`:

- `is_late`: boolean — true if `service_window_end_at < now()` AND `fulfillment_status NOT IN ('delivered', 'cancelled')`
- `lateness_minutes`: int — `extract(epoch from greatest(now() - service_window_end_at, interval '0')) / 60`, or null if not late
- `was_late_at_completion`: boolean — for delivered lines, true if `updated_at > service_window_end_at` (best-effort proxy for "actual completion time"; flagged as approximate)

Extend `fulfillment_units_v` to inherit `is_late` from this view (or just join it inline). Since `fulfillment_units_v` is read-only and rebuilt each call, adding two columns is cheap.

For work-order tickets, lateness is `sla_resolution_due_at < now()` AND `status_category NOT IN ('resolved', 'closed')` — already computed today by the SLA service but exposed as `sla_resolution_breached_at`. Surface the same shape.

### Tasks

- [ ] **Step 1: Migration `00189_order_line_lateness_view.sql`**

```sql
-- 00189_order_line_lateness_view.sql
-- Derived lateness metrics on order_line_items, computed at read time.
-- No persisted state, no SLA-style pause/business-hours engine. Vendor
-- scorecards consume this for "on-time delivery rate" and similar KPIs.
--
-- Three columns:
--   * is_late: line is past its service_window_end_at AND not terminal
--   * lateness_minutes: how late, capped at 0 lower bound, NULL if not late
--   * was_late_at_completion: best-effort historical lateness for delivered
--     lines (uses updated_at as a proxy for completion time — approximate;
--     vendor_order_status_events would be more accurate but is sprint-2
--     work and out of scope here)

create or replace view public.order_line_lateness_v as
select
  oli.id,
  oli.tenant_id,
  oli.vendor_id,
  oli.fulfillment_status,
  oli.service_window_end_at,
  oli.updated_at,
  case
    when oli.service_window_end_at is null then false
    when oli.fulfillment_status in ('delivered', 'cancelled') then false
    else oli.service_window_end_at < now()
  end as is_late,
  case
    when oli.service_window_end_at is null then null
    when oli.fulfillment_status in ('delivered', 'cancelled') then null
    when oli.service_window_end_at >= now() then null
    else (extract(epoch from (now() - oli.service_window_end_at)) / 60)::int
  end as lateness_minutes,
  case
    when oli.fulfillment_status = 'delivered'
         and oli.service_window_end_at is not null
         and oli.updated_at > oli.service_window_end_at
      then true
    when oli.fulfillment_status = 'delivered' then false
    else null
  end as was_late_at_completion
from public.order_line_items oli;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Extend `00186_fulfillment_units_view.sql` to expose `is_late`**

A follow-up migration `00190_fulfillment_units_view_lateness.sql` rewrites the view to include `is_late` for both source kinds:

```sql
-- 00190_fulfillment_units_view_lateness.sql
-- Adds is_late to fulfillment_units_v so cross-source scorecards can compute
-- on-time rate without a per-source-kind branch.

create or replace view public.fulfillment_units_v as
select
  -- ... existing service_line columns ...
  case
    when oli.service_window_end_at is null then false
    when oli.fulfillment_status in ('delivered', 'cancelled') then false
    else oli.service_window_end_at < now()
  end as is_late,
  -- ... rest ...
from public.order_line_items oli
join public.orders ord ...

union all

select
  -- ... existing work_order columns ...
  case
    when t.sla_resolution_due_at is null then false
    when t.status_category in ('resolved', 'closed') then false
    else t.sla_resolution_due_at < now()
  end as is_late,
  -- ... rest ...
from public.tickets t
where t.ticket_kind = 'work_order';
```

Full body in the actual migration. This replaces the existing view.

- [ ] **Step 3: No backend code change required** — consumers query the views directly.

- [ ] **Step 4: Vitest spec** — pure-SQL test via direct psql or a small integration test that inserts an oli with a past `service_window_end_at` and verifies `is_late = true`.

- [ ] **Step 5: Push migrations to remote, smoke**

- [ ] **Step 6: Codex review**

- [ ] **Step 7: Commit**

---

## Slice 2: Link table for ticket↔line + auto-creation + two-way sync

### Why

`linked_ticket_id` on `order_line_items` is an inert FK today. Wave 1 removed the broken cascade code that would have crashed if anything wired it up. To re-introduce ticket linkage cleanly, codex recommended a **dedicated link table**, not nullable FKs on both sides.

### Design (proposal — needs product input)

New table:

```sql
create table public.order_line_ticket_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  order_line_item_id uuid not null references public.order_line_items(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  link_type text not null check (link_type in (
    'internal_handoff',  -- service rule said this line needs internal tech work
    'vendor_decline',    -- vendor declined, desk picked it up
    'manual'             -- operator linked them after the fact
  )),
  created_at timestamptz not null default now(),
  unique (order_line_item_id, ticket_id)
);
create index idx_olt_oli on public.order_line_ticket_links (order_line_item_id);
create index idx_olt_ticket on public.order_line_ticket_links (ticket_id);
```

Then: deprecate `order_line_items.linked_ticket_id` (mark column comment as DEPRECATED, keep for one release for safety, drop in Wave 3). All new linkage goes through the table.

**Auto-creation rules (PRODUCT DECISIONS NEEDED):**

1. **Service rule "internal_handoff" trigger** — when a service rule on a line says `requires_internal_handoff: true`, auto-create a child work-order ticket with:
   - Title: `Internal setup: <catalog item name>`
   - assigned_team_id: ?? (which team owns "internal services"?)
   - parent_ticket_id: NULL (standalone work-order, since there's no parent case)
   - ticket_type: ??
   - location, due-date, requester inherited from the line/order

2. **Vendor decline → fallback ticket** — when a vendor marks an order line as `cancelled` with reason `vendor_declined`, auto-create a fallback ticket for the desk team. Same fields TBD.

**Two-way status sync (DB trigger):**

- Line cancel: cancel any `internal_handoff` linked tickets that haven't reached terminal yet. Don't touch `vendor_decline` tickets (those are the desk's own work, decoupled).
- Ticket close: if it's the only `internal_handoff` link on a line, advance the line to `delivered` (work was done). If multiple linked tickets, only advance when all reach terminal.

### Open product questions

These need user input BEFORE I touch code:

- [ ] Q1: Which **team** owns auto-created `internal_handoff` tickets? (Existing teams: `internal_facilities`, etc. — depends on tenant config.) Propose: route via existing `RoutingService` using a synthetic request type, or pick a tenant-config "default internal team" pointer.
- [ ] Q2: Which **request type** do auto-created tickets use? (Maintenance? A new "service-line setup" type?) Propose: new request type `service_line_internal_handoff` seeded per tenant.
- [ ] Q3: Vendor decline → fallback: who's the **assignee**? Desk team? An ops manager? Same routing-service flow as Q1?
- [ ] Q4: When a line cancels, should it cascade-cancel `vendor_decline` tickets too, or treat them as fully decoupled? My read: decoupled (the desk took ownership; the line going away doesn't change that).
- [ ] Q5: Two-way sync direction priority — if a tech resolves a linked ticket but the vendor hasn't shipped the line yet, does the line go to `delivered` automatically, or stay open until the vendor confirms? My read: stay open (vendor is the source of truth on delivery; the ticket is just the internal half).

**Until the product Qs are answered, Slice 2 stays planned but unexecuted.** Q1–Q5 will surface to the user as a single AskUserQuestion at the slice gate.

### Tasks (gated)

- [ ] **Step 1: Get product answers to Q1–Q5**
- [ ] **Step 2: Migration `00191_order_line_ticket_links.sql`** — create table + indexes + deprecation comment on `order_line_items.linked_ticket_id`
- [ ] **Step 3: Service-rule resolver: detect `requires_internal_handoff`** in `service-rule-resolver.service.ts`, emit a side-effect to create the child ticket
- [ ] **Step 4: Vendor decline path** in `vendor-order-status.service.ts` — when status flips to cancelled with reason `vendor_declined`, create the fallback ticket
- [ ] **Step 5: DB trigger for two-way sync** — on `order_line_items` UPDATE of `fulfillment_status`, on `tickets` UPDATE of `status_category`, propagate per the rules above
- [ ] **Step 6: Backfill** — none today (no rows have `linked_ticket_id` set)
- [ ] **Step 7: Tests** covering each rule and trigger
- [ ] **Step 8: Codex review**
- [ ] **Step 9: Push + smoke**

---

## Self-review

- ✅ Slice 1 has a real architectural decision (don't activate 00035; new vendor-scoped predicate instead). Justified inline.
- ✅ Slice 3 is small, additive, and unblocks scorecards.
- ✅ Slice 2 has product decisions explicitly gated — won't ship without user input.
- ✅ Migration prefixes 00188–00191 in sequence (last is 00187).
- ✅ Each slice has its own codex review checkpoint.
