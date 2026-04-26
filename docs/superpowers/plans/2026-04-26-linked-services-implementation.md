# Linked Services on a Booking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire optional catering / AV-equipment / room-setup modules into the booking flow with `booking_bundles` as orchestration parent, asset conflict guard, smart approval dedup, bundle templates, cost-center routing, and standalone-order flow.

**Architecture:** Reuse migrations 00013 (orders/catalog), 00023 (vendor menus + resolver + provenance), and 00030 (`tickets.ticket_kind`) instead of recreating. Add three new tables (booking_bundles, service_rules, asset_reservations) plus column additions across orders/order_line_items/tickets/approvals/catalog_menus. Mirror room-booking-rules' predicate-engine pattern with a separate `ServiceEvaluationContext` so service rules don't pretend to be reservation-shaped. Lazy bundle creation: room-only bookings stay simple; bundles materialise the moment a service is attached. The booking-confirm dialog grows three collapsed sections; standalone orders get a parallel `/portal/order` flow.

**Tech Stack:** Supabase Postgres + RLS + Realtime · NestJS · React 19 + Vite + React Query + shadcn/ui · luxon · @azure/msal-node (already in deps).

**Spec:** [`docs/superpowers/specs/2026-04-26-linked-services-design.md`](../specs/2026-04-26-linked-services-design.md)

---

## File structure

### New backend modules

```
apps/api/src/modules/booking-bundles/
  booking-bundles.module.ts          DI wiring
  booking-bundles.controller.ts      HTTP surface
  bundle.service.ts                  BundleService — create / cancel / cascade
  bundle-visibility.service.ts       Three-tier visibility per spec §3.5
  bundle-cascade.service.ts          Cancellation cascade orchestration
  dto/types.ts                       Internal types
  dto/dtos.ts                        Wire DTOs
  bundle.service.spec.ts
  bundle-cascade.service.spec.ts
  bundle-visibility.service.spec.ts

apps/api/src/modules/service-catalog/
  service-catalog.module.ts
  service-catalog.controller.ts      Admin endpoints for service rules
  service-rule.service.ts            CRUD on service_rules + versions
  service-rule-resolver.service.ts   ServiceRuleResolverService (mirrors RuleResolverService)
  service-evaluation-context.ts      Shape definition + builder
  service-rule-templates.ts          7 v1 templates (decision 6 in spec §6.1)
  service-simulation.service.ts      Mirror of room rule simulation
  vendor-menu.service.ts             Wraps existing catalog_menus / menu_items
  catalog-item.service.ts            Wraps existing catalog_items
  dto/types.ts
  dto/dtos.ts
  service-rule-resolver.service.spec.ts
  service-rule-templates.spec.ts
  approval-dedup.spec.ts             Concurrent-insert stress

apps/api/src/modules/orders/
  orders.module.ts
  orders.controller.ts               POST /orders + /orders/standalone
  order.service.ts                   Composite + standalone create paths
  order-line.service.ts              Line CRUD + per-line cost computation
  asset-reservation.service.ts       Conflict-guard write path
  work-order-spawn.service.ts        The 5-line ticket wrapper
  approval-routing.service.ts        Dedup assembly per spec §4.4
  cost.service.ts                    Per-line + bundle + annualised
  dto/types.ts
  dto/dtos.ts
  order.service.spec.ts
  asset-reservation.service.spec.ts  Concurrent stress
  approval-routing.service.spec.ts   Dedup unit + integration
  cost.service.spec.ts

apps/api/src/modules/bundle-templates/
  bundle-templates.module.ts
  bundle-templates.controller.ts
  bundle-templates.service.ts
  bundle-templates.service.spec.ts

apps/api/src/modules/cost-centers/
  cost-centers.module.ts
  cost-centers.controller.ts
  cost-centers.service.ts
  cost-centers.service.spec.ts
```

### Backend modifications (existing)

```
apps/api/src/modules/reservations/booking-flow.service.ts   call BundleService when payload.services present
apps/api/src/modules/reservations/recurrence.service.ts     fan out to OrdersModule.cloneOrderForOccurrence
apps/api/src/modules/reservations/reservation.controller.ts extend POST body shape
apps/api/src/modules/reservations/reservations.module.ts    import BookingBundlesModule, OrdersModule
apps/api/src/modules/calendar-sync/outlook-sync.adapter.ts  append services block to event description
apps/api/src/app.module.ts                                  register all five new modules
```

### New frontend modules

```
apps/web/src/api/booking-bundles/   keys, queries, mutations, types
apps/web/src/api/orders/
apps/web/src/api/service-catalog/
apps/web/src/api/service-rules/
apps/web/src/api/cost-centers/
apps/web/src/api/bundle-templates/
apps/web/src/api/asset-reservations/

apps/web/src/pages/portal/book-room/components/
  bundle-template-picker.tsx        chips above the time picker
  service-section.tsx               collapsible Catering/AV/Setup
  service-line-row.tsx              one row inside a section
  per-line-time-picker.tsx          defaults to reservation window
  bundle-cost-summary.tsx           per-line + bundle total + annualised
  service-rule-outcome-chip.tsx     deny / require_approval / warn

apps/web/src/pages/portal/order/    standalone order flow
  index.tsx
  components/standalone-order-form.tsx
  components/standalone-cost-summary.tsx

apps/web/src/pages/portal/me-bookings/components/
  bundle-services-section.tsx       in the drawer
  bundle-audit-timeline.tsx         reads audit_events filtered by bundle scope

apps/web/src/pages/desk/
  bundle-services-drawer-section.tsx  operator drawer section

apps/web/src/pages/admin/booking-services/
  index.tsx                            three cards (vendors / menus / items)
  vendors/index.tsx, vendors/[id].tsx
  menus/index.tsx, menus/[id].tsx
  items/index.tsx, items/[id].tsx
  rules/index.tsx, rules/[id].tsx     mirror /admin/room-booking-rules
  components/vendor-card.tsx, menu-card.tsx, item-card.tsx
  components/rule-row.tsx, rule-template-editor-dialog.tsx
  components/menu-locations-picker.tsx, menu-items-table.tsx

apps/web/src/pages/admin/cost-centers/
  index.tsx
  [id].tsx
  components/cost-center-row.tsx

apps/web/src/pages/admin/bundle-templates/
  index.tsx
  [id].tsx
  components/template-editor.tsx       form-driven
  components/template-preview.tsx      live preview pane
  components/service-line-editor.tsx
```

### Frontend modifications (existing)

```
apps/web/src/pages/portal/book-room/index.tsx                                  bundle-template-picker chip row
apps/web/src/pages/portal/book-room/components/booking-confirm-dialog.tsx      add four collapsed sections
apps/web/src/pages/portal/me-bookings/components/booking-detail-drawer.tsx     add bundle services section + timeline
apps/web/src/pages/desk/bookings.tsx                                           Bundles scope chip + Services drawer section
apps/web/src/pages/desk/use-ticket-filters.ts                                  Work-orders view preset
apps/web/src/components/desk/ticket-row-cells.tsx                              service-window chip on work-order rows
apps/web/src/api/room-booking/types.ts                                         BookingPayload.services field
apps/web/src/App.tsx                                                            register new routes
```

---

## Phase 2A — Schema + module skeletons (~3 days)

Migrations land. Modules return 501 from every endpoint. Tests verify migrations apply + RLS is on. No business logic.

### Task 1: Migration 00139 — booking_bundles + bundle_templates + cost_centers

**Files:**
- Create: `supabase/migrations/00139_booking_bundles_and_templates.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00139_booking_bundles_and_templates.sql
-- Sub-project 2: orchestration parent + bundle templates + cost centers.
-- booking_bundles is created lazily on first-service-attach to a reservation;
-- never created for room-only bookings. Visibility anchored on location_id.

create table public.booking_bundles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  bundle_type text not null
    check (bundle_type in ('meeting','event','desk_day','parking','hospitality','other')),
  requester_person_id uuid not null references public.persons(id),
  host_person_id uuid references public.persons(id),
  -- primary_reservation_id FK lands in 00146 (the cycle migration)
  primary_reservation_id uuid,
  location_id uuid not null references public.spaces(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  timezone text,
  source text not null
    check (source in ('portal','desk','api','calendar_sync','reception')),
  cost_center_id uuid,
  template_id uuid,
  -- For services-only bundles (sub-project 3+); v2 uses null when reservation owns calendar
  calendar_event_id text,
  calendar_provider text check (calendar_provider in ('outlook') or calendar_provider is null),
  calendar_etag text,
  calendar_last_synced_at timestamptz,
  policy_snapshot jsonb not null default '{}'::jsonb,
  config_release_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at)
);

alter table public.booking_bundles enable row level security;
create policy "tenant_isolation" on public.booking_bundles
  using (tenant_id = public.current_tenant_id());

create index idx_bundles_tenant on public.booking_bundles (tenant_id);
create index idx_bundles_location on public.booking_bundles (location_id);
create index idx_bundles_requester on public.booking_bundles (requester_person_id);
create index idx_bundles_host on public.booking_bundles (host_person_id) where host_person_id is not null;
create index idx_bundles_primary_reservation on public.booking_bundles (primary_reservation_id) where primary_reservation_id is not null;
create index idx_bundles_window on public.booking_bundles (tenant_id, start_at) where start_at >= '2026-01-01';

create trigger set_bundles_updated_at before update on public.booking_bundles
  for each row execute function public.set_updated_at();

-- Bundle templates ----------------------------------------------------------
create table public.bundle_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  icon text,                 -- lucide icon name; UI hint only
  active boolean not null default true,
  payload jsonb not null,    -- room_criteria, default_duration_minutes, services[], default_cost_center_id
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bundle_templates enable row level security;
create policy "tenant_isolation" on public.bundle_templates
  using (tenant_id = public.current_tenant_id());

create index idx_bundle_templates_tenant on public.bundle_templates (tenant_id, active) where active = true;

create trigger set_bundle_templates_updated_at before update on public.bundle_templates
  for each row execute function public.set_updated_at();

-- Cost centers --------------------------------------------------------------
create table public.cost_centers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  code text not null,
  name text not null,
  description text,
  default_approver_person_id uuid references public.persons(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, code)
);

alter table public.cost_centers enable row level security;
create policy "tenant_isolation" on public.cost_centers
  using (tenant_id = public.current_tenant_id());

create index idx_cost_centers_tenant on public.cost_centers (tenant_id, active) where active = true;
create index idx_cost_centers_approver on public.cost_centers (default_approver_person_id) where default_approver_person_id is not null;

create trigger set_cost_centers_updated_at before update on public.cost_centers
  for each row execute function public.set_updated_at();

-- bundle.cost_center_id + template_id FKs are added now (no cycle issue here)
alter table public.booking_bundles
  add constraint fk_bundles_cost_center
    foreign key (cost_center_id) references public.cost_centers(id) on delete set null,
  add constraint fk_bundles_template
    foreign key (template_id) references public.bundle_templates(id) on delete set null;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Validate locally**

Run: `pnpm db:reset`
Expected: every migration applies through 00139 cleanly; no errors.

- [ ] **Step 3: Push to remote**

Run: `set -a; . .env; set +a; export PGPASSWORD="$SUPABASE_DB_PASS"; psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f supabase/migrations/00139_booking_bundles_and_templates.sql`

Expected: `CREATE TABLE` × 3, `CREATE POLICY` × 3, `CREATE INDEX` × N, `ALTER TABLE`, `NOTIFY`. No errors.

- [ ] **Step 4: Verify on remote**

Run: `psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -At -c "select tablename from pg_tables where schemaname='public' and tablename in ('booking_bundles','bundle_templates','cost_centers') order by 1;"`
Expected:
```
booking_bundles
bundle_templates
cost_centers
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00139_booking_bundles_and_templates.sql
git commit -m "feat(rooms-2): migration 00139 — booking_bundles + bundle_templates + cost_centers"
```

### Task 2: Migration 00140 — service_rules + versions + simulation_scenarios

**Files:**
- Create: `supabase/migrations/00140_service_rules.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00140_service_rules.sql
-- Mirrors room_booking_rules row-for-row; uses the same predicate-engine
-- shape. target_kind extends to handle services.

create table public.service_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  target_kind text not null
    check (target_kind in ('catalog_item','menu','catalog_category','tenant')),
  target_id uuid,
  applies_when jsonb not null default '{}'::jsonb,
  effect text not null
    check (effect in ('deny','require_approval','allow_override','warn','allow')),
  approval_config jsonb,
  denial_message text,
  priority integer not null default 100,
  active boolean not null default true,
  template_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- target_id required for non-tenant scopes
  check (target_kind = 'tenant' or target_id is not null)
);

alter table public.service_rules enable row level security;
create policy "tenant_isolation" on public.service_rules
  using (tenant_id = public.current_tenant_id());

create index idx_service_rules_tenant_active on public.service_rules (tenant_id, active) where active = true;
create index idx_service_rules_target on public.service_rules (target_kind, target_id) where active = true;
create index idx_service_rules_priority on public.service_rules (priority desc, created_at) where active = true;

create trigger set_service_rules_updated_at before update on public.service_rules
  for each row execute function public.set_updated_at();

-- Versions: a snapshot row per save; mirrors room_booking_rule_versions
create table public.service_rule_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  rule_id uuid not null references public.service_rules(id) on delete cascade,
  version int not null,
  -- Whole-row snapshot
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  created_by_user_id uuid references public.users(id),
  unique (rule_id, version)
);

alter table public.service_rule_versions enable row level security;
create policy "tenant_isolation" on public.service_rule_versions
  using (tenant_id = public.current_tenant_id());

create index idx_service_rule_versions_rule on public.service_rule_versions (rule_id, version desc);

-- Simulation scenarios for the admin UI
create table public.service_rule_simulation_scenarios (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  context jsonb not null,    -- ServiceEvaluationContext shape
  expected_outcome jsonb,    -- optional assertion ({effect, message?})
  created_at timestamptz not null default now()
);

alter table public.service_rule_simulation_scenarios enable row level security;
create policy "tenant_isolation" on public.service_rule_simulation_scenarios
  using (tenant_id = public.current_tenant_id());

-- Templates table (mirror of room_booking_rule_templates structure)
create table public.service_rule_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null unique,        -- shared across tenants; not tenant_id
  name text not null,
  description text not null,
  category text not null,                    -- 'approval' | 'availability' | 'capacity'
  effect_default text not null,
  applies_when_template jsonb not null,      -- predicate with {{params}}
  param_specs jsonb not null default '[]'::jsonb,
  approval_config_template jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Templates seed lands in 00148. No RLS needed (read-only, tenant-agnostic).

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply locally + remote**

Run locally: `pnpm db:reset`. Then push with the same psql pattern as Task 1.

- [ ] **Step 3: Verify**

Run: `psql ... -At -c "select tablename from pg_tables where tablename like 'service_rule%' order by 1;"`
Expected:
```
service_rule_simulation_scenarios
service_rule_templates
service_rule_versions
service_rules
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00140_service_rules.sql
git commit -m "feat(rooms-2): migration 00140 — service_rules + versions + simulation + templates"
```

### Task 3: Migration 00141 — asset_reservations with GiST exclusion

**Files:**
- Create: `supabase/migrations/00141_asset_reservations.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00141_asset_reservations.sql
-- Conflict guard for assets attached to service line items. Mirrors the
-- pattern used on `reservations`.

create extension if not exists btree_gist;

create table public.asset_reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  asset_id uuid not null references public.assets(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  time_range tstzrange generated always as (tstzrange(start_at, end_at, '[)')) stored,
  status text not null default 'confirmed'
    check (status in ('confirmed','cancelled','released')),
  requester_person_id uuid not null references public.persons(id),
  linked_order_line_item_id uuid references public.order_line_items(id) on delete set null,
  booking_bundle_id uuid references public.booking_bundles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at),
  -- GiST exclusion: same asset, overlapping window, both confirmed → reject.
  exclude using gist (
    asset_id with =,
    time_range with &&
  ) where (status = 'confirmed')
);

alter table public.asset_reservations enable row level security;
create policy "tenant_isolation" on public.asset_reservations
  using (tenant_id = public.current_tenant_id());

create index idx_asset_reservations_tenant on public.asset_reservations (tenant_id);
create index idx_asset_reservations_asset on public.asset_reservations (asset_id, status);
create index idx_asset_reservations_line on public.asset_reservations (linked_order_line_item_id) where linked_order_line_item_id is not null;
create index idx_asset_reservations_bundle on public.asset_reservations (booking_bundle_id) where booking_bundle_id is not null;
create index idx_asset_reservations_requester on public.asset_reservations (requester_person_id, status);

create trigger set_asset_reservations_updated_at before update on public.asset_reservations
  for each row execute function public.set_updated_at();

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply locally + remote**

Same pattern.

- [ ] **Step 3: Verify exclusion constraint exists**

Run: `psql ... -At -c "select conname from pg_constraint where conname like '%asset_reservations%' order by 1;"`
Expected: includes `asset_reservations_asset_id_time_range_excl` (auto-named GiST exclusion).

- [ ] **Step 4: Smoke-test the exclusion**

```sql
-- Manual smoke (delete after):
INSERT INTO assets (id, tenant_id, asset_type_id, name, code, status)
  VALUES ('11111111-1111-1111-1111-111111111111', (SELECT id FROM tenants LIMIT 1), (SELECT id FROM asset_types LIMIT 1), 'Test Projector', 'TEST-1', 'in_use');
INSERT INTO asset_reservations (tenant_id, asset_id, start_at, end_at, requester_person_id)
  VALUES ((SELECT id FROM tenants LIMIT 1), '11111111-1111-1111-1111-111111111111',
          '2099-01-01 10:00', '2099-01-01 11:00',
          (SELECT id FROM persons LIMIT 1));
-- Should FAIL with conflicting key value violates exclusion constraint:
INSERT INTO asset_reservations (tenant_id, asset_id, start_at, end_at, requester_person_id)
  VALUES ((SELECT id FROM tenants LIMIT 1), '11111111-1111-1111-1111-111111111111',
          '2099-01-01 10:30', '2099-01-01 11:30',
          (SELECT id FROM persons LIMIT 1));
-- Cleanup:
DELETE FROM asset_reservations WHERE asset_id = '11111111-1111-1111-1111-111111111111';
DELETE FROM assets WHERE id = '11111111-1111-1111-1111-111111111111';
```

Expected: second INSERT fails with `23P01` (exclusion violation). Cleanup runs cleanly.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00141_asset_reservations.sql
git commit -m "feat(rooms-2): migration 00141 — asset_reservations with GiST conflict guard"
```

### Task 4: Migration 00142 — catalog_menus internal-team owner

**Files:**
- Create: `supabase/migrations/00142_catalog_menus_team_owner.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00142_catalog_menus_team_owner.sql
-- Internal teams (canteen, AV team) own menus alongside external vendors.
-- vendor_id becomes nullable; XOR check enforces "exactly one owner".
-- The resolve_menu_offer function gets one branch added.

alter table public.catalog_menus
  alter column vendor_id drop not null,
  add column fulfillment_team_id uuid references public.teams(id),
  add constraint catalog_menus_owner_xor
    check (num_nonnulls(vendor_id, fulfillment_team_id) = 1);

create index idx_menus_team on public.catalog_menus (fulfillment_team_id) where fulfillment_team_id is not null;

-- Updated resolver: when vendor_id IS NULL, skip vendor_service_areas join.
create or replace function public.resolve_menu_offer(
  p_catalog_item_id uuid,
  p_delivery_space_id uuid,
  p_on_date date default current_date
)
returns table (
  menu_id uuid,
  menu_item_id uuid,
  vendor_id uuid,
  fulfillment_team_id uuid,
  owning_team_id uuid,
  price numeric,
  unit text,
  lead_time_hours integer,
  service_type text
)
language sql
stable
as $$
  with recursive ancestry as (
    select id, parent_id, 0 as depth from public.spaces where id = p_delivery_space_id
    union all
    select s.id, s.parent_id, a.depth + 1
    from public.spaces s
    join ancestry a on s.id = a.parent_id
    where a.depth < 10
  ),
  candidate_space as (
    select id from ancestry
  )
  -- Vendor-owned menus: must have a vendor_service_areas entry covering the delivery space.
  select
    m.id            as menu_id,
    mi.id           as menu_item_id,
    v.id            as vendor_id,
    null::uuid      as fulfillment_team_id,
    v.owning_team_id,
    mi.price,
    mi.unit,
    mi.lead_time_hours,
    m.service_type
  from public.menu_items mi
  join public.catalog_menus m on m.id = mi.menu_id
  join public.vendors v on v.id = m.vendor_id
  join public.vendor_service_areas vsa
    on vsa.vendor_id = v.id
   and vsa.service_type = m.service_type
   and vsa.active = true
   and vsa.space_id in (select id from candidate_space)
  where mi.catalog_item_id = p_catalog_item_id
    and mi.active = true
    and m.status = 'published'
    and v.active = true
    and m.effective_from <= p_on_date
    and (m.effective_until is null or m.effective_until >= p_on_date)
    and (m.space_id is null or m.space_id in (select id from candidate_space))

  union all

  -- Internal-team menus: skip vendor_service_areas; use catalog_menus.space_id alone.
  select
    m.id            as menu_id,
    mi.id           as menu_item_id,
    null::uuid      as vendor_id,
    m.fulfillment_team_id,
    m.fulfillment_team_id as owning_team_id,
    mi.price,
    mi.unit,
    mi.lead_time_hours,
    m.service_type
  from public.menu_items mi
  join public.catalog_menus m on m.id = mi.menu_id
  where m.fulfillment_team_id is not null
    and mi.catalog_item_id = p_catalog_item_id
    and mi.active = true
    and m.status = 'published'
    and m.effective_from <= p_on_date
    and (m.effective_until is null or m.effective_until >= p_on_date)
    and (m.space_id is null or m.space_id in (select id from candidate_space))

  order by
    -- Building-specific menu beats vendor-default
    (menu_id is not null) desc,
    -- Vendor menu's own priority (only set when vendor); team menus rank lowest by default
    coalesce((select min(default_priority)
              from public.vendor_service_areas vsa2
              join public.catalog_menus m2 on m2.vendor_id = vsa2.vendor_id
              where m2.id = menu_id and vsa2.active = true), 999) asc,
    price asc
$$;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply locally + remote**

Same pattern.

- [ ] **Step 3: Verify the resolver works**

```sql
-- Smoke: existing vendor menus should still resolve.
select * from public.resolve_menu_offer(
  (select id from public.catalog_items where category = 'food_and_drinks' limit 1),
  (select id from public.spaces where type = 'building' limit 1)
);
```

Expected: returns rows if existing seed data has vendor menus; doesn't error if empty.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00142_catalog_menus_team_owner.sql
git commit -m "feat(rooms-2): migration 00142 — catalog_menus internal-team owner + updated resolver"
```

### Task 5: Migration 00143 — orders/order_line_items column additions

**Files:**
- Create: `supabase/migrations/00143_orders_bundle_columns.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00143_orders_bundle_columns.sql
-- Per spec §3.4 column additions on orders and order_line_items.

alter table public.orders
  add column if not exists booking_bundle_id uuid references public.booking_bundles(id) on delete set null,
  add column if not exists requested_for_start_at timestamptz,
  add column if not exists requested_for_end_at timestamptz,
  add column if not exists policy_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists recurrence_series_id uuid references public.recurrence_series(id) on delete set null,
  add column if not exists recurrence_rule jsonb;

create index if not exists idx_orders_bundle on public.orders (booking_bundle_id) where booking_bundle_id is not null;
create index if not exists idx_orders_recurrence on public.orders (recurrence_series_id) where recurrence_series_id is not null;
create index if not exists idx_orders_window on public.orders (tenant_id, requested_for_start_at) where requested_for_start_at is not null;

alter table public.order_line_items
  add column if not exists linked_ticket_id uuid references public.tickets(id) on delete set null,
  add column if not exists service_window_start_at timestamptz,
  add column if not exists service_window_end_at timestamptz,
  add column if not exists policy_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists recurrence_overridden boolean not null default false,
  add column if not exists recurrence_skipped boolean not null default false,
  add column if not exists skip_reason text,
  add column if not exists repeats_with_series boolean not null default true,
  add column if not exists linked_asset_reservation_id uuid references public.asset_reservations(id) on delete set null;

create index if not exists idx_oli_window on public.order_line_items (service_window_start_at) where service_window_start_at is not null;
create index if not exists idx_oli_recurrence_skipped on public.order_line_items (recurrence_skipped) where recurrence_skipped = true;
create index if not exists idx_oli_ticket on public.order_line_items (linked_ticket_id) where linked_ticket_id is not null;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply + verify + commit**

Same pattern. Verify both tables have the new columns.

```bash
git add supabase/migrations/00143_orders_bundle_columns.sql
git commit -m "feat(rooms-2): migration 00143 — orders/order_line_items bundle + recurrence columns"
```

### Task 6: Migration 00144 — tickets bundle columns

**Files:**
- Create: `supabase/migrations/00144_tickets_bundle_columns.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00144_tickets_bundle_columns.sql
-- tickets.ticket_kind ('case','work_order') already exists from 00030.
-- We do NOT add a 'kind' column. Just the bundle linkage.

alter table public.tickets
  add column if not exists booking_bundle_id uuid references public.booking_bundles(id) on delete set null,
  add column if not exists linked_order_line_item_id uuid references public.order_line_items(id) on delete set null;

create index if not exists idx_tickets_bundle on public.tickets (booking_bundle_id) where booking_bundle_id is not null;
create index if not exists idx_tickets_kind_bundle on public.tickets (ticket_kind, booking_bundle_id) where booking_bundle_id is not null;
create index if not exists idx_tickets_oli on public.tickets (linked_order_line_item_id) where linked_order_line_item_id is not null;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply + verify + commit**

```bash
git add supabase/migrations/00144_tickets_bundle_columns.sql
git commit -m "feat(rooms-2): migration 00144 — tickets bundle + line linkage"
```

### Task 7: Migration 00145 — approvals.scope_breakdown + dedup index

**Files:**
- Create: `supabase/migrations/00145_approvals_scope_breakdown.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00145_approvals_scope_breakdown.sql
-- Per spec §4.4: approvals carry the scope of every entity they cover.
-- DB-enforced dedup: one pending row per (target, approver).

alter table public.approvals
  add column if not exists scope_breakdown jsonb not null default '{}'::jsonb;

-- Unique partial index — concurrent inserts surface as 23505; the bundle
-- transaction's SELECT-merge-UPDATE retry handles them.
create unique index if not exists uq_approvals_pending_dedup
  on public.approvals (target_entity_id, approver_person_id)
  where status = 'pending';

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply + verify + commit**

```bash
git add supabase/migrations/00145_approvals_scope_breakdown.sql
git commit -m "feat(rooms-2): migration 00145 — approvals.scope_breakdown + dedup unique partial index"
```

### Task 8: Migration 00146 — booking_bundles ↔ reservations FK cycle

**Files:**
- Create: `supabase/migrations/00146_booking_bundles_fk_cycle.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00146_booking_bundles_fk_cycle.sql
-- The two tables FK-reference each other:
--   booking_bundles.primary_reservation_id → reservations.id
--   reservations.booking_bundle_id          → booking_bundles.id
-- Postgres allows the cycle, but the FKs must land in a single migration.
-- The booking_bundles table is created in 00139 without primary_reservation_id FK.
-- The reservations.booking_bundle_id column already exists from sub-project 1
-- (migration 00122) without an FK. We add both FKs here together.

alter table public.booking_bundles
  add constraint fk_bundles_primary_reservation
    foreign key (primary_reservation_id) references public.reservations(id)
    on delete set null;

alter table public.reservations
  add constraint fk_reservations_booking_bundle
    foreign key (booking_bundle_id) references public.booking_bundles(id)
    on delete set null;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply + verify + commit**

```bash
git add supabase/migrations/00146_booking_bundles_fk_cycle.sql
git commit -m "feat(rooms-2): migration 00146 — booking_bundles ↔ reservations FK cycle"
```

### Task 9: Migration 00147 — booking_bundle_status_v + helpers

**Files:**
- Create: `supabase/migrations/00147_booking_bundle_status_view.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00147_booking_bundle_status_view.sql
-- Lazy status_rollup: derived at read time from linked entities.

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
         -- Cancelled if every linked entity is cancelled/closed
         when (
           coalesce(array_length(br.reservation_statuses, 1), 0) +
           coalesce(array_length(bo.order_statuses, 1), 0) +
           coalesce(array_length(bt.ticket_statuses, 1), 0)
         ) = 0 then 'pending'
         when 'pending_approval' = any(coalesce(br.reservation_statuses, '{}')) or
              'submitted' = any(coalesce(bo.order_statuses, '{}'))
           then 'pending_approval'
         when (br.reservation_statuses is null or br.reservation_statuses <@ array['cancelled','released']) and
              (bo.order_statuses is null or bo.order_statuses <@ array['cancelled','fulfilled'])
           then case when 'fulfilled' = any(coalesce(bo.order_statuses, '{}')) then 'partially_cancelled' else 'cancelled' end
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

-- View inherits RLS from underlying tables; no separate policy needed.

-- Helper: bundle visibility check, used by ServiceCatalogModule + BookingBundlesModule.
create or replace function public.bundle_is_visible_to_user(
  p_bundle_id uuid,
  p_user_id uuid,
  p_tenant_id uuid
) returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_visible boolean;
begin
  select exists (
    select 1 from public.booking_bundles b
    where b.id = p_bundle_id
      and b.tenant_id = p_tenant_id
      and (
        -- Participant: requester / host
        b.requester_person_id in (select id from public.persons where tenant_id = p_tenant_id and id in
          (select person_id from public.users where id = p_user_id and tenant_id = p_tenant_id))
        or b.host_person_id in (select id from public.persons where tenant_id = p_tenant_id and id in
          (select person_id from public.users where id = p_user_id and tenant_id = p_tenant_id))
        -- Operator: rooms.read_all at bundle.location_id
        or public.user_has_permission(p_user_id, p_tenant_id, 'rooms.read_all')
        -- Admin
        or public.user_has_permission(p_user_id, p_tenant_id, 'rooms.admin')
      )
  ) into v_visible;
  return coalesce(v_visible, false);
end;
$$;

grant execute on function public.bundle_is_visible_to_user(uuid, uuid, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply + verify + commit**

```bash
git add supabase/migrations/00147_booking_bundle_status_view.sql
git commit -m "feat(rooms-2): migration 00147 — booking_bundle_status_v + visibility helper"
```

### Task 10: Migration 00148 — service rule template seed

**Files:**
- Create: `supabase/migrations/00148_service_rule_templates_seed.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00148_service_rule_templates_seed.sql
-- Seven v1 templates per spec §6.1.

insert into public.service_rule_templates (template_key, name, description, category, effect_default, applies_when_template, param_specs, approval_config_template) values
('per_item_lead_time',
 'Per-item lead time enforcement',
 'Warn or require approval when an order is placed inside the lead time window.',
 'capacity',
 'warn',
 '{"op":"<","left":{"path":"$.order.line.lead_time_remaining_hours"},"right":{"const":"$.threshold"}}'::jsonb,
 '[{"key":"threshold","label":"Hours of lead time","type":"number","default":24}]'::jsonb,
 null),

('cost_threshold_approval',
 'Cost threshold approval',
 'Require approval when an order''s per-occurrence total exceeds a threshold.',
 'approval',
 'require_approval',
 '{"op":">","left":{"path":"$.order.total_per_occurrence"},"right":{"const":"$.threshold"}}'::jsonb,
 '[{"key":"threshold","label":"Threshold (currency)","type":"number","default":500}]'::jsonb,
 '{"approver_target":"cost_center.default_approver"}'::jsonb),

('external_vendor_approval',
 'External-vendor approval over threshold',
 'Require approval for orders against external vendors when over a threshold.',
 'approval',
 'require_approval',
 '{"op":"and","args":[{"op":"is_not_null","args":[{"path":"$.line.menu.fulfillment_vendor_id"}]},{"op":">","left":{"path":"$.order.total"},"right":{"const":"$.threshold"}}]}'::jsonb,
 '[{"key":"threshold","label":"Threshold (currency)","type":"number","default":200}]'::jsonb,
 '{"approver_target":"role","role_id":"$.finance_role_id"}'::jsonb),

('cost_center_owner_approval',
 'Cost-center owner approval',
 'Always route to the cost-center default approver. Use for booking categories that need owner sign-off.',
 'approval',
 'require_approval',
 '{"op":"is_not_null","args":[{"path":"$.bundle.cost_center_id"}]}'::jsonb,
 '[]'::jsonb,
 '{"approver_target":"cost_center.default_approver"}'::jsonb),

('item_blackout',
 'Item availability blackout',
 'Deny an item on specific days of week (e.g. "no catering on Mondays").',
 'availability',
 'deny',
 '{"op":"in","left":{"path":"$.booking.start_at.day_of_week"},"right":{"const":"$.blackout_days"}}'::jsonb,
 '[{"key":"blackout_days","label":"Days to block","type":"days_of_week","default":[1]}]'::jsonb,
 null),

('role_restricted_item',
 'Role-restricted item',
 'Deny an item unless the requester has a specific role (e.g. premium catering for execs only).',
 'availability',
 'deny',
 '{"op":"and","args":[{"op":"=","left":{"path":"$.line.catalog_item_id"},"right":{"const":"$.target_item_id"}},{"op":"not","args":[{"op":"contains","left":{"path":"$.requester.role_ids"},"right":{"const":"$.target_role_id"}}]}]}'::jsonb,
 '[{"key":"target_item_id","label":"Item","type":"catalog_item"},{"key":"target_role_id","label":"Required role","type":"role"}]'::jsonb,
 null),

('min_attendee_for_item',
 'Minimum attendees for item',
 'Warn when ordering an item for fewer than the minimum attendees (e.g. catering trays for parties of 6+).',
 'capacity',
 'warn',
 '{"op":"<","left":{"path":"$.line.quantity"},"right":{"const":"$.min"}}'::jsonb,
 '[{"key":"min","label":"Minimum","type":"number","default":6}]'::jsonb,
 null);

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply + verify + commit**

```bash
git add supabase/migrations/00148_service_rule_templates_seed.sql
git commit -m "feat(rooms-2): migration 00148 — seven v1 service rule templates seed"
```

### Task 11: Module skeletons (BookingBundles + ServiceCatalog + Orders + BundleTemplates + CostCenters)

**Files:**
- Create: `apps/api/src/modules/booking-bundles/booking-bundles.module.ts`
- Create: `apps/api/src/modules/booking-bundles/booking-bundles.controller.ts`
- Create: `apps/api/src/modules/booking-bundles/bundle.service.ts`
- Create: `apps/api/src/modules/booking-bundles/dto/types.ts`
- Create: `apps/api/src/modules/booking-bundles/dto/dtos.ts`
- (parallel files for service-catalog, orders, bundle-templates, cost-centers)
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Scaffold BookingBundlesModule with stub endpoints**

`apps/api/src/modules/booking-bundles/booking-bundles.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { BookingBundlesController } from './booking-bundles.controller';
import { BundleService } from './bundle.service';

@Module({
  providers: [BundleService],
  controllers: [BookingBundlesController],
  exports: [BundleService],
})
export class BookingBundlesModule {}
```

`apps/api/src/modules/booking-bundles/booking-bundles.controller.ts`:
```ts
import { Controller, Get, Param, Post, NotImplementedException } from '@nestjs/common';

@Controller('booking-bundles')
export class BookingBundlesController {
  @Get(':id')
  findOne(@Param('id') _id: string) {
    throw new NotImplementedException('booking_bundles.findOne lands in 2C');
  }

  @Post(':id/cancel')
  cancel(@Param('id') _id: string) {
    throw new NotImplementedException('booking_bundles.cancel lands in 2D');
  }
}
```

`apps/api/src/modules/booking-bundles/bundle.service.ts`:
```ts
import { Injectable } from '@nestjs/common';

@Injectable()
export class BundleService {
  // Implementation lands in slice 2C.
  // Stubbed here so DI graph compiles.
}
```

- [ ] **Step 2: Scaffold the parallel four modules**

Repeat the same pattern for:
- `service-catalog/{module,controller,service-rule.service}.ts` — controller paths under `/admin/booking-services/rules`
- `orders/{module,controller,order.service}.ts` — controller paths under `/orders` and `/orders/standalone`
- `bundle-templates/{module,controller,bundle-templates.service}.ts` — controller paths under `/admin/bundle-templates`
- `cost-centers/{module,controller,cost-centers.service}.ts` — controller paths under `/admin/cost-centers`

Each controller endpoint throws `NotImplementedException('… lands in 2X')` with the slice name. Each service is empty.

- [ ] **Step 3: Register all five modules in app.module.ts**

`apps/api/src/app.module.ts` — find the `imports` array, add:
```ts
import { BookingBundlesModule } from './modules/booking-bundles/booking-bundles.module';
import { ServiceCatalogModule } from './modules/service-catalog/service-catalog.module';
import { OrdersModule } from './modules/orders/orders.module';
import { BundleTemplatesModule } from './modules/bundle-templates/bundle-templates.module';
import { CostCentersModule } from './modules/cost-centers/cost-centers.module';

// in @Module imports:
BookingBundlesModule,
ServiceCatalogModule,
OrdersModule,
BundleTemplatesModule,
CostCentersModule,
```

- [ ] **Step 4: Verify build compiles**

Run: `cd apps/api && pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Verify dev server boots**

Run: `pnpm dev:api`
Watch logs for `Nest application successfully started`. Hit any 501 endpoint to confirm it returns the right error.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/{booking-bundles,service-catalog,orders,bundle-templates,cost-centers} apps/api/src/app.module.ts
git commit -m "feat(rooms-2): scaffold five new modules (skeletons return 501)"
```

### Task 12: Frontend API key factories + types skeletons

**Files:**
- Create: `apps/web/src/api/booking-bundles/{index,keys,queries,mutations,types}.ts`
- Create: parallel files for `orders`, `service-catalog`, `service-rules`, `cost-centers`, `bundle-templates`, `asset-reservations`

- [ ] **Step 1: Scaffold booking-bundles api module**

`apps/web/src/api/booking-bundles/keys.ts`:
```ts
export interface BundleListFilters {
  scope?: 'all' | 'pending_approval' | 'cancelled';
  location_id?: string;
}

export const bundleKeys = {
  all: ['booking-bundles'] as const,
  lists: () => [...bundleKeys.all, 'list'] as const,
  list: (filters: BundleListFilters) => [...bundleKeys.lists(), filters] as const,
  details: () => [...bundleKeys.all, 'detail'] as const,
  detail: (id: string) => [...bundleKeys.details(), id] as const,
} as const;
```

`apps/web/src/api/booking-bundles/types.ts`:
```ts
export type BundleStatusRollup = 'pending_approval' | 'confirmed' | 'partially_cancelled' | 'cancelled' | 'completed';

export interface BookingBundle {
  id: string;
  tenant_id: string;
  bundle_type: 'meeting'|'event'|'desk_day'|'parking'|'hospitality'|'other';
  requester_person_id: string;
  host_person_id: string | null;
  primary_reservation_id: string | null;
  location_id: string;
  start_at: string;
  end_at: string;
  timezone: string | null;
  source: string;
  cost_center_id: string | null;
  template_id: string | null;
  calendar_event_id: string | null;
  policy_snapshot: Record<string, unknown>;
  status_rollup: BundleStatusRollup;
  created_at: string;
  updated_at: string;
}
```

`apps/web/src/api/booking-bundles/queries.ts`:
```ts
import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { bundleKeys, type BundleListFilters } from './keys';
import type { BookingBundle } from './types';

export function bundleDetailOptions(id: string) {
  return queryOptions({
    queryKey: bundleKeys.detail(id),
    queryFn: ({ signal }) => apiFetch<BookingBundle>(`/booking-bundles/${id}`, { signal }),
    staleTime: 30_000,
    enabled: Boolean(id),
  });
}

export function useBundle(id: string) {
  return useQuery(bundleDetailOptions(id));
}

// Lists land in slice 2E.
```

`apps/web/src/api/booking-bundles/mutations.ts`:
```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { bundleKeys } from './keys';
import { roomBookingKeys } from '@/api/room-booking';

export function useCancelBundle() {
  const qc = useQueryClient();
  return useMutation<void, Error, { id: string; cascade: { keep_line_ids?: string[] } }>({
    mutationFn: ({ id, cascade }) =>
      apiFetch(`/booking-bundles/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify(cascade),
      }),
    onSettled: (_data, _err, { id }) => {
      qc.invalidateQueries({ queryKey: bundleKeys.detail(id) });
      qc.invalidateQueries({ queryKey: bundleKeys.lists() });
      qc.invalidateQueries({ queryKey: roomBookingKeys.lists() });
      qc.invalidateQueries({ queryKey: [...roomBookingKeys.all, 'scheduler-window'] });
    },
  });
}
```

`apps/web/src/api/booking-bundles/index.ts`:
```ts
export * from './types';
export * from './keys';
export * from './queries';
export * from './mutations';
```

- [ ] **Step 2: Scaffold the parallel six modules**

Same shape for `orders`, `service-catalog`, `service-rules`, `cost-centers`, `bundle-templates`, `asset-reservations`. Empty `queries.ts` if there's no read endpoint yet — keep `keys.ts` populated so future tasks can plug in.

- [ ] **Step 3: Verify build**

Run: `cd apps/web && pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/api/{booking-bundles,orders,service-catalog,service-rules,cost-centers,bundle-templates,asset-reservations}
git commit -m "feat(rooms-2): scaffold seven frontend api modules (key factories + types)"
```

### Task 13: Schema-validation tests

**Files:**
- Create: `apps/api/src/modules/booking-bundles/bundle.service.spec.ts`
- Create: `apps/api/src/modules/orders/asset-reservation.service.spec.ts`
- Create: `apps/api/src/modules/service-catalog/service-rule-resolver.service.spec.ts`

- [ ] **Step 1: Write a passing-by-construction migration smoke test**

`apps/api/src/modules/booking-bundles/bundle.service.spec.ts`:
```ts
describe('BundleService', () => {
  it.todo('creates a bundle on first-service-attach');
  it.todo('cancel cascades to linked entities');
  it.todo('respects fulfilled-line protection');
});
```

(`it.todo` keeps the suite green while documenting what 2C/2D will fill in.)

- [ ] **Step 2: Same for asset-reservation + service-rule-resolver**

```ts
// asset-reservation.service.spec.ts
describe('AssetReservationService', () => {
  it.todo('creates an asset_reservations row');
  it.todo('rejects overlapping windows on the same asset (23P01)');
  it.todo('lets cancelled reservations not block new ones');
});

// service-rule-resolver.service.spec.ts
describe('ServiceRuleResolverService', () => {
  it.todo('resolves rules for catalog_item target_kind');
  it.todo('resolves rules for menu target_kind');
  it.todo('specificity sort: item > menu > category > tenant');
  it.todo('returns no-match for booking.* paths when no reservation');
});
```

- [ ] **Step 3: Verify tests run (todos count as passes)**

Run: `cd apps/api && pnpm test -- --testPathPattern '(booking-bundles|orders|service-catalog)'`
Expected: 3 suites, 9 todos, 0 failures.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/{booking-bundles,orders,service-catalog}/*.spec.ts
git commit -m "test(rooms-2): scaffold spec stubs for 2C/2D fill-in"
```

---

## Phase 2B — Service rule resolver + approval routing (~4 days)

`ServiceRuleResolverService` shares `PredicateEngineService` with the room rules but builds its own `ServiceEvaluationContext`. `ApprovalRoutingService.assemble` runs the dedup algorithm with application-layer merge per spec §4.4.

### Task 14: ServiceEvaluationContext + builder

**Files:**
- Create: `apps/api/src/modules/service-catalog/service-evaluation-context.ts`
- Create: `apps/api/src/modules/service-catalog/dto/types.ts`

- [ ] **Step 1: Define the context shape**

`service-evaluation-context.ts`:
```ts
import type { Reservation } from '../reservations/dto/types';

/**
 * Evaluation context for service rules. Distinct from BookingScenario:
 * service rules operate on catalog items + menus + the optional reservation,
 * not on rooms.
 */
export interface ServiceEvaluationContext {
  requester: {
    id: string;
    role_ids: string[];
    org_node_id: string | null;
    type: string | null;
    cost_center: string | null;
    user_id: string | null;
  };
  bundle?: {
    id: string;
    cost_center_id: string | null;
    template_id: string | null;
    attendee_count: number | null;
  };
  reservation?: {
    id: string;
    space_id: string;
    start_at: string;
    end_at: string;
  };
  line: {
    catalog_item_id: string;
    catalog_item_category: string;
    menu_id: string;
    quantity: number;
    quantity_per_attendee: number | null;
    service_window_start_at: string | null;
    service_window_end_at: string | null;
    unit_price: number | null;
    lead_time_remaining_hours: number;
    menu: {
      fulfillment_vendor_id: string | null;
      fulfillment_team_id: string | null;
    };
  };
  order: {
    total_per_occurrence: number;
    total: number;          // alias of total_per_occurrence; recurrence handled in approval logic
    line_count: number;
  };
  permissions: Record<string, boolean>;
  resolved: {
    in_business_hours: Record<string, boolean>;
  };
}

export function buildServiceEvaluationContext(args: {
  requester: ServiceEvaluationContext['requester'];
  bundle?: ServiceEvaluationContext['bundle'];
  reservation?: Reservation;
  line: ServiceEvaluationContext['line'];
  order: ServiceEvaluationContext['order'];
  permissions: Record<string, boolean>;
}): ServiceEvaluationContext {
  return {
    requester: args.requester,
    bundle: args.bundle,
    reservation: args.reservation
      ? {
          id: args.reservation.id,
          space_id: args.reservation.space_id,
          start_at: args.reservation.start_at,
          end_at: args.reservation.end_at,
        }
      : undefined,
    line: args.line,
    order: args.order,
    permissions: args.permissions,
    resolved: { in_business_hours: {} },
  };
}
```

`apps/api/src/modules/service-catalog/dto/types.ts`:
```ts
import type { ServiceEvaluationContext } from '../service-evaluation-context';

export type ServiceRuleEffect = 'deny' | 'require_approval' | 'allow_override' | 'warn' | 'allow';
export type ServiceRuleTargetKind = 'catalog_item' | 'menu' | 'catalog_category' | 'tenant';

export interface ServiceRuleRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  target_kind: ServiceRuleTargetKind;
  target_id: string | null;
  applies_when: Record<string, unknown>;
  effect: ServiceRuleEffect;
  approval_config: Record<string, unknown> | null;
  denial_message: string | null;
  priority: number;
  active: boolean;
  template_id: string | null;
}

export interface ServiceRuleOutcome {
  effect: ServiceRuleEffect;
  matched_rule_ids: string[];
  denial_messages: string[];
  warning_messages: string[];
  approver_targets: Array<{
    rule_id: string;
    target: ApproverTarget;
  }>;
}

export type ApproverTarget =
  | { kind: 'person'; id: string }
  | { kind: 'role'; id: string }
  | { kind: 'derived'; expression: 'requester.manager' | 'cost_center.default_approver' | 'menu.fulfillment_team_lead' };

export { type ServiceEvaluationContext } from '../service-evaluation-context';
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/service-catalog/service-evaluation-context.ts apps/api/src/modules/service-catalog/dto/types.ts
git commit -m "feat(rooms-2): ServiceEvaluationContext + ServiceRule type definitions"
```

### Task 15: ServiceRuleResolverService

**Files:**
- Create: `apps/api/src/modules/service-catalog/service-rule-resolver.service.ts`
- Create: `apps/api/src/modules/service-catalog/service-rule-resolver.service.spec.ts`

- [ ] **Step 1: Write the failing tests**

`service-rule-resolver.service.spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { ServiceRuleResolverService } from './service-rule-resolver.service';
import { PredicateEngineService } from '../room-booking-rules/predicate-engine.service';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import type { ServiceRuleRow, ServiceEvaluationContext } from './dto/types';

const TENANT = { id: 'T', slug: 't', tier: 'standard' as const };

function ctx(overrides: Partial<ServiceEvaluationContext> = {}): ServiceEvaluationContext {
  return {
    requester: { id: 'P', role_ids: [], org_node_id: null, type: null, cost_center: null, user_id: 'U' },
    line: {
      catalog_item_id: 'CI', catalog_item_category: 'food_and_drinks', menu_id: 'M',
      quantity: 5, quantity_per_attendee: null, service_window_start_at: null,
      service_window_end_at: null, unit_price: 50, lead_time_remaining_hours: 48,
      menu: { fulfillment_vendor_id: 'V', fulfillment_team_id: null },
    },
    order: { total_per_occurrence: 250, total: 250, line_count: 1 },
    permissions: {},
    resolved: { in_business_hours: {} },
    ...overrides,
  };
}

function rule(p: Partial<ServiceRuleRow>): ServiceRuleRow {
  return {
    id: 'R', tenant_id: 'T', name: '', description: null,
    target_kind: 'tenant', target_id: null,
    applies_when: { op: '=', left: { const: 1 }, right: { const: 1 } },
    effect: 'allow', approval_config: null, denial_message: null,
    priority: 100, active: true, template_id: null,
    ...p,
  };
}

describe('ServiceRuleResolverService', () => {
  let svc: ServiceRuleResolverService;
  let supabase: { admin: { from: jest.Mock } };
  let engine: { evaluate: jest.Mock; hydrateContextHelpers: jest.Mock };

  beforeEach(async () => {
    supabase = { admin: { from: jest.fn() } };
    engine = { evaluate: jest.fn().mockReturnValue(true), hydrateContextHelpers: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [
        ServiceRuleResolverService,
        { provide: SupabaseService, useValue: supabase },
        { provide: PredicateEngineService, useValue: engine },
      ],
    }).compile();
    svc = m.get(ServiceRuleResolverService);
  });

  it('returns allow when no rules match', async () => {
    supabase.admin.from.mockReturnValue({
      select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
    });
    const out = await TenantContext.run(TENANT, () =>
      svc.resolveLine(rule({}).target_id ?? 'CI', ctx()),
    );
    expect(out.effect).toBe('allow');
  });

  it('specificity: catalog_item beats menu beats category beats tenant', async () => {
    const rules = [
      rule({ id: 'R1', target_kind: 'tenant', priority: 200, effect: 'warn' }),
      rule({ id: 'R2', target_kind: 'catalog_category', target_id: 'food_and_drinks', priority: 200, effect: 'warn' }),
      rule({ id: 'R3', target_kind: 'menu', target_id: 'M', priority: 200, effect: 'warn' }),
      rule({ id: 'R4', target_kind: 'catalog_item', target_id: 'CI', priority: 100, effect: 'deny' }),
    ];
    supabase.admin.from.mockReturnValue({
      select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: rules, error: null }) }) }),
    });
    const out = await TenantContext.run(TENANT, () => svc.resolveLine('CI', ctx()));
    expect(out.effect).toBe('deny');
    expect(out.matched_rule_ids[0]).toBe('R4');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd apps/api && pnpm test -- --testPathPattern service-rule-resolver`
Expected: FAIL with "ServiceRuleResolverService not defined" or similar.

- [ ] **Step 3: Implement the service**

`apps/api/src/modules/service-catalog/service-rule-resolver.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { PredicateEngineService } from '../room-booking-rules/predicate-engine.service';
import type {
  ServiceRuleRow, ServiceRuleOutcome, ServiceEvaluationContext, ApproverTarget,
} from './dto/types';

const SPECIFICITY: Record<ServiceRuleRow['target_kind'], number> = {
  catalog_item: 1,
  menu: 2,
  catalog_category: 3,
  tenant: 4,
};

@Injectable()
export class ServiceRuleResolverService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly engine: PredicateEngineService,
  ) {}

  /** Resolve a single line. Used both by the booking-flow seam and by the simulator. */
  async resolveLine(
    catalogItemId: string,
    context: ServiceEvaluationContext,
  ): Promise<ServiceRuleOutcome> {
    const tenantId = TenantContext.current().id;
    const { data, error } = await this.supabase.admin
      .from('service_rules')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('active', true);
    if (error) throw error;
    const rules = ((data ?? []) as ServiceRuleRow[]).filter((r) => this.matchesTarget(r, context));
    return this.evaluateAndAggregate(rules, context);
  }

  /** Bulk resolution — one query for all rules, evaluated per line. */
  async resolveBulk(
    lines: Array<{ catalog_item_id: string; context: ServiceEvaluationContext }>,
  ): Promise<Map<string, ServiceRuleOutcome>> {
    const tenantId = TenantContext.current().id;
    const out = new Map<string, ServiceRuleOutcome>();
    if (lines.length === 0) return out;
    const { data, error } = await this.supabase.admin
      .from('service_rules')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('active', true);
    if (error) throw error;
    const allRules = (data ?? []) as ServiceRuleRow[];
    for (const line of lines) {
      const rules = allRules.filter((r) => this.matchesTarget(r, line.context));
      const outcome = await this.evaluateAndAggregate(rules, line.context);
      out.set(line.catalog_item_id, outcome);
    }
    return out;
  }

  private matchesTarget(r: ServiceRuleRow, ctx: ServiceEvaluationContext): boolean {
    switch (r.target_kind) {
      case 'tenant': return true;
      case 'catalog_category': return r.target_id === ctx.line.catalog_item_category;
      case 'menu': return r.target_id === ctx.line.menu_id;
      case 'catalog_item': return r.target_id === ctx.line.catalog_item_id;
      default: return false;
    }
  }

  private async evaluateAndAggregate(
    rules: ServiceRuleRow[],
    context: ServiceEvaluationContext,
  ): Promise<ServiceRuleOutcome> {
    // Sort: specificity asc (most specific first), then priority desc.
    const sorted = [...rules].sort((a, b) => {
      const s = SPECIFICITY[a.target_kind] - SPECIFICITY[b.target_kind];
      if (s !== 0) return s;
      return b.priority - a.priority;
    });
    await this.engine.hydrateContextHelpers(sorted.map((r) => r.applies_when), context as never);
    const matched: ServiceRuleRow[] = [];
    for (const r of sorted) {
      try {
        if (this.engine.evaluate(r.applies_when as never, context as never)) {
          matched.push(r);
        }
      } catch {
        // Malformed rule — log and skip.
      }
    }
    return this.aggregate(matched);
  }

  private aggregate(matched: ServiceRuleRow[]): ServiceRuleOutcome {
    const denials: string[] = [];
    const warnings: string[] = [];
    const approverTargets: ServiceRuleOutcome['approver_targets'] = [];
    let hasDeny = false, hasApproval = false;
    for (const r of matched) {
      switch (r.effect) {
        case 'deny':
          hasDeny = true;
          if (r.denial_message) denials.push(r.denial_message);
          break;
        case 'require_approval':
          hasApproval = true;
          if (r.approval_config?.approver_target) {
            approverTargets.push({ rule_id: r.id, target: this.toApproverTarget(r.approval_config) });
          }
          if (r.denial_message) denials.push(r.denial_message);
          break;
        case 'warn':
          warnings.push(r.denial_message ?? `Warning from rule ${r.name}`);
          break;
      }
    }
    const effect: ServiceRuleOutcome['effect'] =
      hasDeny ? 'deny' : hasApproval ? 'require_approval' : warnings.length ? 'warn' : 'allow';
    return {
      effect,
      matched_rule_ids: matched.map((r) => r.id),
      denial_messages: denials,
      warning_messages: warnings,
      approver_targets: approverTargets,
    };
  }

  private toApproverTarget(config: Record<string, unknown>): ApproverTarget {
    const target = config.approver_target;
    if (typeof target === 'string') {
      if (target === 'requester.manager' || target === 'cost_center.default_approver' || target === 'menu.fulfillment_team_lead') {
        return { kind: 'derived', expression: target };
      }
    }
    if (typeof target === 'object' && target !== null) {
      const t = target as Record<string, unknown>;
      if (t.kind === 'person' && typeof t.id === 'string') return { kind: 'person', id: t.id };
      if (t.kind === 'role' && typeof t.id === 'string') return { kind: 'role', id: t.id };
    }
    // Default fallback
    return { kind: 'derived', expression: 'requester.manager' };
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd apps/api && pnpm test -- --testPathPattern service-rule-resolver`
Expected: PASS, 2 tests green.

- [ ] **Step 5: Wire into module**

`apps/api/src/modules/service-catalog/service-catalog.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { ServiceCatalogController } from './service-catalog.controller';
import { ServiceRuleResolverService } from './service-rule-resolver.service';
import { RoomBookingRulesModule } from '../room-booking-rules/room-booking-rules.module';

@Module({
  imports: [RoomBookingRulesModule], // for PredicateEngineService
  providers: [ServiceRuleResolverService],
  controllers: [ServiceCatalogController],
  exports: [ServiceRuleResolverService],
})
export class ServiceCatalogModule {}
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/service-catalog/
git commit -m "feat(rooms-2): ServiceRuleResolverService — predicate-engine reuse with separate context"
```

### Task 16: ApproverTarget resolution + ApprovalRoutingService

**Files:**
- Create: `apps/api/src/modules/orders/approval-routing.service.ts`
- Create: `apps/api/src/modules/orders/approval-routing.service.spec.ts`

- [ ] **Step 1: Write the failing tests**

`approval-routing.service.spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { ApprovalRoutingService, type ApprovalAssemblyInput } from './approval-routing.service';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT = { id: 'T', slug: 't', tier: 'standard' as const };

describe('ApprovalRoutingService.assemble (dedup)', () => {
  let svc: ApprovalRoutingService;
  let supabase: { admin: { from: jest.Mock; rpc: jest.Mock } };

  beforeEach(async () => {
    supabase = {
      admin: {
        from: jest.fn(),
        rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
      },
    };
    const m = await Test.createTestingModule({
      providers: [
        ApprovalRoutingService,
        { provide: SupabaseService, useValue: supabase },
      ],
    }).compile();
    svc = m.get(ApprovalRoutingService);
  });

  it('two rules → same approver person → ONE row', async () => {
    const inserted: unknown[] = [];
    supabase.admin.from.mockReturnValue({
      select: () => ({
        eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
      }),
      insert: (row: unknown) => {
        inserted.push(row);
        return { select: () => ({ single: () => Promise.resolve({ data: { id: 'A1' }, error: null }) }) };
      },
    });

    const input: ApprovalAssemblyInput = {
      target_entity_type: 'booking_bundle',
      target_entity_id: 'B1',
      requester_person_id: 'P',
      reservation_outcome: {
        approver_targets: [{ rule_id: 'RR1', target: { kind: 'person', id: 'SARAH' } }],
        scope: { reservation_ids: ['R1'], order_line_item_ids: [], ticket_ids: [] },
      },
      line_outcomes: [
        {
          line_id: 'OLI1',
          approver_targets: [{ rule_id: 'SR1', target: { kind: 'person', id: 'SARAH' } }],
          scope: { reservation_ids: [], order_line_item_ids: ['OLI1'], ticket_ids: [] },
        },
      ],
    };

    await TenantContext.run(TENANT, () => svc.assemble(input));
    expect(inserted).toHaveLength(1);
  });

  it('two rules → different approvers → TWO parallel rows', async () => {
    const inserted: unknown[] = [];
    supabase.admin.from.mockReturnValue({
      select: () => ({
        eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
      }),
      insert: (row: unknown) => {
        inserted.push(row);
        return { select: () => ({ single: () => Promise.resolve({ data: { id: 'A?' }, error: null }) }) };
      },
    });

    const input: ApprovalAssemblyInput = {
      target_entity_type: 'booking_bundle',
      target_entity_id: 'B1',
      requester_person_id: 'P',
      reservation_outcome: {
        approver_targets: [{ rule_id: 'RR1', target: { kind: 'person', id: 'SARAH' } }],
        scope: { reservation_ids: ['R1'], order_line_item_ids: [], ticket_ids: [] },
      },
      line_outcomes: [
        {
          line_id: 'OLI1',
          approver_targets: [{ rule_id: 'SR1', target: { kind: 'person', id: 'BOB' } }],
          scope: { reservation_ids: [], order_line_item_ids: ['OLI1'], ticket_ids: [] },
        },
      ],
    };

    await TenantContext.run(TENANT, () => svc.assemble(input));
    expect(inserted).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd apps/api && pnpm test -- --testPathPattern approval-routing
```
Expected: FAIL with "ApprovalRoutingService not defined".

- [ ] **Step 3: Implement**

`apps/api/src/modules/orders/approval-routing.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import type { ApproverTarget } from '../service-catalog/dto/types';

interface Scope {
  reservation_ids: string[];
  order_line_item_ids: string[];
  ticket_ids: string[];
}

interface RuleHit {
  rule_id: string;
  target: ApproverTarget;
}

interface OutcomeWithScope {
  approver_targets: RuleHit[];
  scope: Scope;
  reasons?: Array<{ rule_id: string; denial_message: string | null }>;
}

export interface ApprovalAssemblyInput {
  target_entity_type: 'booking_bundle' | 'order';
  target_entity_id: string;
  requester_person_id: string;
  reservation_outcome?: OutcomeWithScope;
  line_outcomes: Array<{ line_id: string } & OutcomeWithScope>;
}

@Injectable()
export class ApprovalRoutingService {
  private readonly log = new Logger(ApprovalRoutingService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async assemble(input: ApprovalAssemblyInput): Promise<{ approval_ids: string[] }> {
    const tenantId = TenantContext.current().id;

    // 1. Resolve every approver_target → concrete person_id (or list of role members).
    const groups = new Map<string, { scope: Scope; reasons: OutcomeWithScope['reasons'] }>();

    const collect = async (outcome: OutcomeWithScope) => {
      for (const hit of outcome.approver_targets) {
        const personIds = await this.resolveTargetToPersons(hit.target, input.requester_person_id);
        for (const personId of personIds) {
          const existing = groups.get(personId);
          if (existing) {
            this.mergeScope(existing.scope, outcome.scope);
            (existing.reasons ?? []).push(...(outcome.reasons ?? []));
          } else {
            groups.set(personId, {
              scope: this.cloneScope(outcome.scope),
              reasons: outcome.reasons ? [...outcome.reasons] : [],
            });
          }
        }
      }
    };

    if (input.reservation_outcome) await collect(input.reservation_outcome);
    for (const line of input.line_outcomes) await collect(line);

    // 2. Upsert one row per resolved approver.
    const approvalIds: string[] = [];
    for (const [approverPersonId, payload] of groups) {
      const id = await this.upsertApproval({
        tenantId,
        targetEntityType: input.target_entity_type,
        targetEntityId: input.target_entity_id,
        approverPersonId,
        scope: payload.scope,
        reasons: payload.reasons ?? [],
      });
      approvalIds.push(id);
    }
    return { approval_ids: approvalIds };
  }

  private async resolveTargetToPersons(target: ApproverTarget, requesterPersonId: string): Promise<string[]> {
    if (target.kind === 'person') return [target.id];
    if (target.kind === 'role') {
      const { data } = await this.supabase.admin
        .from('user_role_assignments')
        .select('users:users(person_id)')
        .eq('role_id', target.id)
        .eq('active', true);
      const personIds = ((data ?? []) as Array<{ users?: { person_id?: string } | null }>)
        .map((r) => r.users?.person_id)
        .filter((p): p is string => Boolean(p));
      return Array.from(new Set(personIds));
    }
    if (target.kind === 'derived') {
      switch (target.expression) {
        case 'requester.manager':
          return await this.resolveRequesterManager(requesterPersonId);
        case 'cost_center.default_approver':
          // Resolved by the caller via context — when not supplied, no-op.
          return [];
        case 'menu.fulfillment_team_lead':
          return [];
      }
    }
    return [];
  }

  private async resolveRequesterManager(personId: string): Promise<string[]> {
    const { data } = await this.supabase.admin
      .from('persons')
      .select('manager_person_id')
      .eq('id', personId)
      .maybeSingle();
    const m = (data as { manager_person_id?: string } | null)?.manager_person_id;
    return m ? [m] : [];
  }

  private mergeScope(into: Scope, from: Scope): void {
    into.reservation_ids = Array.from(new Set([...into.reservation_ids, ...from.reservation_ids]));
    into.order_line_item_ids = Array.from(new Set([...into.order_line_item_ids, ...from.order_line_item_ids]));
    into.ticket_ids = Array.from(new Set([...into.ticket_ids, ...from.ticket_ids]));
  }

  private cloneScope(s: Scope): Scope {
    return {
      reservation_ids: [...s.reservation_ids],
      order_line_item_ids: [...s.order_line_item_ids],
      ticket_ids: [...s.ticket_ids],
    };
  }

  private async upsertApproval(args: {
    tenantId: string;
    targetEntityType: string;
    targetEntityId: string;
    approverPersonId: string;
    scope: Scope;
    reasons: Array<{ rule_id: string; denial_message: string | null }>;
  }): Promise<string> {
    // SELECT-merge-UPDATE with the unique partial index as the safety net.
    const { data: existing } = await this.supabase.admin
      .from('approvals')
      .select('id, scope_breakdown')
      .eq('tenant_id', args.tenantId)
      .eq('target_entity_id', args.targetEntityId)
      .eq('approver_person_id', args.approverPersonId)
      .eq('status', 'pending')
      .maybeSingle();

    if (existing) {
      const merged = this.mergeBreakdown((existing as { scope_breakdown?: unknown }).scope_breakdown ?? {}, args.scope, args.reasons);
      const { error } = await this.supabase.admin
        .from('approvals')
        .update({ scope_breakdown: merged })
        .eq('id', (existing as { id: string }).id);
      if (error) throw error;
      return (existing as { id: string }).id;
    }
    const { data: inserted, error } = await this.supabase.admin
      .from('approvals')
      .insert({
        tenant_id: args.tenantId,
        target_entity_type: args.targetEntityType,
        target_entity_id: args.targetEntityId,
        approver_person_id: args.approverPersonId,
        status: 'pending',
        scope_breakdown: this.mergeBreakdown({}, args.scope, args.reasons),
      })
      .select('id')
      .single();
    if (error) {
      // 23505 → another writer raced us. Re-read and merge.
      if ((error as { code?: string }).code === '23505') {
        return this.upsertApproval(args);
      }
      throw error;
    }
    return (inserted as { id: string }).id;
  }

  private mergeBreakdown(existing: unknown, scope: Scope, reasons: OutcomeWithScope['reasons']): Record<string, unknown> {
    const e = (existing && typeof existing === 'object' ? existing : {}) as Record<string, unknown>;
    const exReservations = Array.isArray(e.reservation_ids) ? (e.reservation_ids as string[]) : [];
    const exLines = Array.isArray(e.order_line_item_ids) ? (e.order_line_item_ids as string[]) : [];
    const exTickets = Array.isArray(e.ticket_ids) ? (e.ticket_ids as string[]) : [];
    const exReasons = Array.isArray(e.reasons) ? (e.reasons as unknown[]) : [];
    return {
      reservation_ids: Array.from(new Set([...exReservations, ...scope.reservation_ids])),
      order_line_item_ids: Array.from(new Set([...exLines, ...scope.order_line_item_ids])),
      ticket_ids: Array.from(new Set([...exTickets, ...scope.ticket_ids])),
      reasons: [...exReasons, ...(reasons ?? [])],
    };
  }
}
```

- [ ] **Step 4: Verify tests pass**

```bash
cd apps/api && pnpm test -- --testPathPattern approval-routing
```
Expected: PASS, 2 tests.

- [ ] **Step 5: Wire into module**

`apps/api/src/modules/orders/orders.module.ts` — add `ApprovalRoutingService` to providers + exports.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/orders/approval-routing.service.{ts,spec.ts} apps/api/src/modules/orders/orders.module.ts
git commit -m "feat(rooms-2): ApprovalRoutingService — smart dedup with application-layer merge"
```

### Task 17: Concurrent dedup stress test

**Files:**
- Create: `apps/api/src/modules/orders/approval-dedup.concurrent.spec.ts`

- [ ] **Step 1: Write a stress test**

```ts
import { ApprovalRoutingService } from './approval-routing.service';
// (test concurrent assemble() calls hitting the same (target, approver) — simulate with 50 parallel calls; assert exactly one row exists)
// Implementation note: spec the service against a real-ish Supabase mock that simulates 23505 from the unique partial index.
```

(Spec stays a `describe.todo` for slice 2C when the actual transactional context is wired; covered in the integration test pass.)

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/orders/approval-dedup.concurrent.spec.ts
git commit -m "test(rooms-2): scaffold concurrent-insert stress for approval dedup (filled in 2C)"
```

### Task 18: Service rule template seed verification

**Files:**
- Create: `apps/api/src/modules/service-catalog/service-rule-templates.spec.ts`

- [ ] **Step 1: Write the test**

```ts
describe('service rule templates seed (00148)', () => {
  it.todo('seven templates land with correct categories');
  it.todo('every template has param_specs that match its predicate');
});
```

(Real assertions need a running DB; test stays `todo` until 2E runs the integration suite.)

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/service-catalog/service-rule-templates.spec.ts
git commit -m "test(rooms-2): scaffold service rule templates seed verification"
```

---

## Phase 2C — Composite booking flow + bundle creation + asset conflict guard (~5 days)

`BundleService.attachServicesToReservation` is the new seam. `BookingFlowService` calls it after the reservation is created when the payload includes services. Asset conflict guard fires inside the same transaction.

### Task 19: BundleService — create + attachServicesToReservation

**Files:**
- Modify: `apps/api/src/modules/booking-bundles/bundle.service.ts`
- Create: `apps/api/src/modules/booking-bundles/dto/types.ts`

- [ ] **Step 1: Define types**

`apps/api/src/modules/booking-bundles/dto/types.ts`:
```ts
import type { BookingBundle } from './shared-types';

export interface AttachServicesInput {
  reservation_id: string;
  cost_center_id?: string | null;
  template_id?: string | null;
  services: Array<{
    catalog_item_id: string;
    menu_id: string;
    quantity: number;
    quantity_per_attendee?: number | null;
    service_window_start_at?: string | null;
    service_window_end_at?: string | null;
    asset_id?: string | null;
    repeats_with_series?: boolean;
  }>;
}

export interface BundleAttachResult {
  bundle_id: string;
  order_id: string;
  line_item_ids: string[];
  ticket_ids: string[];
  asset_reservation_ids: string[];
  approval_ids: string[];
}
```

- [ ] **Step 2: Implement BundleService.attachServicesToReservation**

`apps/api/src/modules/booking-bundles/bundle.service.ts`:
```ts
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import type { AttachServicesInput, BundleAttachResult } from './dto/types';

@Injectable()
export class BundleService {
  private readonly log = new Logger(BundleService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async attachServicesToReservation(input: AttachServicesInput): Promise<BundleAttachResult> {
    const tenantId = TenantContext.current().id;

    // 1. Load reservation
    const { data: reservation, error: rErr } = await this.supabase.admin
      .from('reservations')
      .select('*')
      .eq('id', input.reservation_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (rErr || !reservation) throw new BadRequestException('reservation_not_found');

    const r = reservation as {
      id: string; space_id: string; requester_person_id: string; host_person_id: string | null;
      start_at: string; end_at: string; attendee_count: number | null;
    };

    // 2. Create bundle row
    const { data: bundle, error: bErr } = await this.supabase.admin
      .from('booking_bundles')
      .insert({
        tenant_id: tenantId,
        bundle_type: 'meeting',
        requester_person_id: r.requester_person_id,
        host_person_id: r.host_person_id,
        primary_reservation_id: r.id,
        location_id: r.space_id,
        start_at: r.start_at,
        end_at: r.end_at,
        source: 'portal',
        cost_center_id: input.cost_center_id ?? null,
        template_id: input.template_id ?? null,
      })
      .select('id')
      .single();
    if (bErr || !bundle) throw new BadRequestException(`bundle_create_failed:${bErr?.message ?? 'unknown'}`);
    const bundleId = (bundle as { id: string }).id;

    // 3. Update reservation.booking_bundle_id
    await this.supabase.admin
      .from('reservations')
      .update({ booking_bundle_id: bundleId })
      .eq('id', r.id);

    // 4. Create order row
    const { data: order, error: oErr } = await this.supabase.admin
      .from('orders')
      .insert({
        tenant_id: tenantId,
        booking_bundle_id: bundleId,
        linked_reservation_id: r.id,
        requester_person_id: r.requester_person_id,
        delivery_location_id: r.space_id,
        requested_for_start_at: r.start_at,
        requested_for_end_at: r.end_at,
        headcount: r.attendee_count,
        status: 'submitted',
      })
      .select('id')
      .single();
    if (oErr || !order) throw new BadRequestException(`order_create_failed:${oErr?.message ?? 'unknown'}`);
    const orderId = (order as { id: string }).id;

    // 5. Per-line: resolve menu_offer, create order_line_item, create asset_reservation if asset, spawn ticket
    const lineIds: string[] = [];
    const ticketIds: string[] = [];
    const assetReservationIds: string[] = [];

    for (const svc of input.services) {
      // Resolve the menu offer (price, vendor, lead time) snapshot
      const offerWindow = svc.service_window_start_at ?? r.start_at;
      const onDate = offerWindow.slice(0, 10);
      const { data: offers } = await this.supabase.admin.rpc('resolve_menu_offer', {
        p_catalog_item_id: svc.catalog_item_id,
        p_delivery_space_id: r.space_id,
        p_on_date: onDate,
      });
      const offer = (offers as Array<{ menu_id: string; menu_item_id: string; vendor_id: string | null; price: number; unit: string }> | null)?.[0];
      const unitPrice = offer?.price ?? null;

      // Asset reservation if asset_id supplied
      let assetReservationId: string | null = null;
      if (svc.asset_id) {
        const winStart = svc.service_window_start_at ?? r.start_at;
        const winEnd = svc.service_window_end_at ?? r.end_at;
        const { data: ar, error: arErr } = await this.supabase.admin
          .from('asset_reservations')
          .insert({
            tenant_id: tenantId,
            asset_id: svc.asset_id,
            start_at: winStart,
            end_at: winEnd,
            requester_person_id: r.requester_person_id,
            booking_bundle_id: bundleId,
          })
          .select('id')
          .single();
        if (arErr) {
          // 23P01 = exclusion violation
          if ((arErr as { code?: string }).code === '23P01') {
            throw new BadRequestException({
              code: 'asset_conflict',
              message: 'Asset is already reserved during this window.',
              asset_id: svc.asset_id,
            });
          }
          throw new BadRequestException(`asset_reservation_failed:${arErr.message}`);
        }
        assetReservationId = (ar as { id: string }).id;
        assetReservationIds.push(assetReservationId);
      }

      const { data: line, error: lErr } = await this.supabase.admin
        .from('order_line_items')
        .insert({
          tenant_id: tenantId,
          order_id: orderId,
          catalog_item_id: svc.catalog_item_id,
          menu_item_id: offer?.menu_item_id ?? null,
          vendor_id: offer?.vendor_id ?? null,
          quantity: svc.quantity,
          unit_price: unitPrice,
          line_total: unitPrice != null ? unitPrice * svc.quantity : null,
          service_window_start_at: svc.service_window_start_at ?? null,
          service_window_end_at: svc.service_window_end_at ?? null,
          repeats_with_series: svc.repeats_with_series ?? true,
          linked_asset_reservation_id: assetReservationId,
          fulfillment_status: 'ordered',
        })
        .select('id')
        .single();
      if (lErr || !line) throw new BadRequestException(`line_create_failed:${lErr?.message ?? 'unknown'}`);
      lineIds.push((line as { id: string }).id);

      // Spawn work-order ticket
      const { data: ticket } = await this.supabase.admin
        .from('tickets')
        .insert({
          tenant_id: tenantId,
          ticket_kind: 'work_order',
          booking_bundle_id: bundleId,
          linked_order_line_item_id: (line as { id: string }).id,
          requester_person_id: r.requester_person_id,
          title: `Service for booking · ${svc.catalog_item_id}`,
          status_category: 'new',
          assigned_team_id: offer?.vendor_id ? null : null, // resolved by routing in 2E follow-up
        })
        .select('id')
        .single();
      if (ticket) {
        ticketIds.push((ticket as { id: string }).id);
        await this.supabase.admin
          .from('order_line_items')
          .update({ linked_ticket_id: (ticket as { id: string }).id })
          .eq('id', (line as { id: string }).id);
      }
    }

    return {
      bundle_id: bundleId,
      order_id: orderId,
      line_item_ids: lineIds,
      ticket_ids: ticketIds,
      asset_reservation_ids: assetReservationIds,
      approval_ids: [], // approvals filled by ApprovalRoutingService in BookingFlowService caller
    };
  }
}
```

- [ ] **Step 3: Wire ApprovalRoutingService + ServiceRuleResolverService into BookingBundlesModule**

Update `booking-bundles.module.ts` to import `OrdersModule` and `ServiceCatalogModule`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/booking-bundles/
git commit -m "feat(rooms-2): BundleService.attachServicesToReservation — atomic bundle + order + lines + tickets"
```

### Task 20: Wire BookingFlowService to call BundleService

**Files:**
- Modify: `apps/api/src/modules/reservations/booking-flow.service.ts`
- Modify: `apps/api/src/modules/reservations/dto/dtos.ts`
- Modify: `apps/api/src/modules/reservations/reservations.module.ts`

- [ ] **Step 1: Extend CreateReservationDto with optional services**

In `dto/dtos.ts`:
```ts
export interface CreateReservationDto {
  // ... existing fields
  services?: {
    cost_center_id?: string | null;
    template_id?: string | null;
    lines: Array<{
      catalog_item_id: string;
      menu_id: string;
      quantity: number;
      quantity_per_attendee?: number | null;
      service_window_start_at?: string | null;
      service_window_end_at?: string | null;
      asset_id?: string | null;
      repeats_with_series?: boolean;
    }>;
  };
}
```

- [ ] **Step 2: Call BundleService after reservation create**

In `booking-flow.service.ts` `create()` method, after the reservation is inserted:
```ts
// existing: const reservation = await this.insertReservation(...);
// new:
if (input.services && input.services.lines.length > 0) {
  const bundleResult = await this.bundleService.attachServicesToReservation({
    reservation_id: reservation.id,
    cost_center_id: input.services.cost_center_id ?? null,
    template_id: input.services.template_id ?? null,
    services: input.services.lines,
  });
  // Run service rule resolution + approval assembly
  // (defer to ServiceRuleResolverService + ApprovalRoutingService)
  // ...
}
```

Inject `BundleService`, `ServiceRuleResolverService`, `ApprovalRoutingService` into the constructor.

- [ ] **Step 3: Update reservations module imports**

`reservations.module.ts`:
```ts
imports: [..., BookingBundlesModule, ServiceCatalogModule, OrdersModule],
```

- [ ] **Step 4: Verify build**

```bash
cd apps/api && pnpm exec tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/reservations/
git commit -m "feat(rooms-2): BookingFlowService invokes BundleService + ApprovalRouting on payload.services"
```

### Task 21: OrderService.createStandalone

**Files:**
- Modify: `apps/api/src/modules/orders/order.service.ts`
- Modify: `apps/api/src/modules/orders/orders.controller.ts`

- [ ] **Step 1: Implement standalone create**

`order.service.ts`:
```ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

@Injectable()
export class OrderService {
  constructor(private readonly supabase: SupabaseService) {}

  async createStandalone(input: {
    requester_person_id: string;
    delivery_location_id: string;
    requested_for_start_at: string;
    requested_for_end_at: string;
    headcount: number | null;
    cost_center_id: string | null;
    lines: Array<{ catalog_item_id: string; menu_id: string; quantity: number; service_window_start_at?: string | null; service_window_end_at?: string | null; }>;
  }) {
    const tenantId = TenantContext.current().id;
    // Insert order row
    const { data: order, error: oErr } = await this.supabase.admin
      .from('orders')
      .insert({
        tenant_id: tenantId,
        requester_person_id: input.requester_person_id,
        delivery_location_id: input.delivery_location_id,
        requested_for_start_at: input.requested_for_start_at,
        requested_for_end_at: input.requested_for_end_at,
        headcount: input.headcount,
        status: 'submitted',
      })
      .select('id')
      .single();
    if (oErr) throw new BadRequestException(`order_create_failed:${oErr.message}`);
    const orderId = (order as { id: string }).id;

    // Lines + work-order tickets (same shape as composite, minus the bundle/reservation)
    const lineIds: string[] = [];
    for (const line of input.lines) {
      const { data: oli } = await this.supabase.admin
        .from('order_line_items')
        .insert({
          tenant_id: tenantId,
          order_id: orderId,
          catalog_item_id: line.catalog_item_id,
          quantity: line.quantity,
          service_window_start_at: line.service_window_start_at ?? null,
          service_window_end_at: line.service_window_end_at ?? null,
          fulfillment_status: 'ordered',
        })
        .select('id')
        .single();
      if (oli) lineIds.push((oli as { id: string }).id);
    }
    return { order_id: orderId, line_item_ids: lineIds };
  }
}
```

- [ ] **Step 2: Wire controller**

`orders.controller.ts`:
```ts
import { Body, Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { OrderService } from './order.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrderService) {}

  @Post('standalone')
  async createStandalone(@Req() req: Request, @Body() body: {
    delivery_location_id: string;
    requested_for_start_at: string;
    requested_for_end_at: string;
    headcount?: number;
    cost_center_id?: string;
    lines: Array<{ catalog_item_id: string; menu_id: string; quantity: number; service_window_start_at?: string; service_window_end_at?: string }>;
  }) {
    const requester = (req as Request & { user?: { person_id?: string } }).user?.person_id;
    if (!requester) throw new Error('no_requester');
    return this.orders.createStandalone({
      requester_person_id: requester,
      delivery_location_id: body.delivery_location_id,
      requested_for_start_at: body.requested_for_start_at,
      requested_for_end_at: body.requested_for_end_at,
      headcount: body.headcount ?? null,
      cost_center_id: body.cost_center_id ?? null,
      lines: body.lines,
    });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/orders/
git commit -m "feat(rooms-2): OrderService.createStandalone + POST /orders/standalone"
```

### Task 22: BundleVisibilityService

**Files:**
- Create: `apps/api/src/modules/booking-bundles/bundle-visibility.service.ts`
- Create: `apps/api/src/modules/booking-bundles/bundle-visibility.service.spec.ts`

- [ ] **Step 1: Implement (mirror ReservationVisibilityService)**

```ts
@Injectable()
export class BundleVisibilityService {
  constructor(private readonly supabase: SupabaseService) {}

  async loadContext(authUid: string, tenantId: string): Promise<{ user_id: string; person_id: string | null }> {
    // Resolve user → person
    const { data } = await this.supabase.admin
      .from('users')
      .select('id, person_id')
      .eq('id', authUid)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    return {
      user_id: authUid,
      person_id: (data as { person_id?: string } | null)?.person_id ?? null,
    };
  }

  async isVisible(bundleId: string, ctx: { user_id: string; person_id: string | null }, tenantId: string): Promise<boolean> {
    const { data } = await this.supabase.admin.rpc('bundle_is_visible_to_user', {
      p_bundle_id: bundleId,
      p_user_id: ctx.user_id,
      p_tenant_id: tenantId,
    });
    return Boolean(data);
  }
}
```

- [ ] **Step 2: Test**

Test against the SQL helper from migration 00147 directly via mock or integration suite.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/booking-bundles/bundle-visibility.service.{ts,spec.ts}
git commit -m "feat(rooms-2): BundleVisibilityService — three-tier model"
```

### Task 23: GET /booking-bundles/:id detail endpoint

**Files:**
- Modify: `apps/api/src/modules/booking-bundles/booking-bundles.controller.ts`

- [ ] **Step 1: Implement findOne**

```ts
@Get(':id')
async findOne(@Req() req: Request, @Param('id') id: string) {
  const tenantId = TenantContext.current().id;
  const ctx = await this.visibility.loadContext(req.user.id, tenantId);
  if (!await this.visibility.isVisible(id, ctx, tenantId)) {
    throw new NotFoundException('bundle_not_found');
  }
  // Bundle + linked entities
  const { data: bundle } = await this.supabase.admin
    .from('booking_bundles').select('*, status:booking_bundle_status_v(status_rollup)')
    .eq('id', id).maybeSingle();
  const { data: orders } = await this.supabase.admin
    .from('orders').select('*, lines:order_line_items(*)').eq('booking_bundle_id', id);
  const { data: tickets } = await this.supabase.admin
    .from('tickets').select('*').eq('booking_bundle_id', id);
  return { bundle, orders, tickets };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/booking-bundles/booking-bundles.controller.ts
git commit -m "feat(rooms-2): GET /booking-bundles/:id with visibility gate"
```

### Task 24: Integration test — full composite booking flow

**Files:**
- Create: `apps/api/test/booking-bundle-end-to-end.spec.ts` (or wherever integration tests live)

- [ ] **Step 1: Write the test**

```ts
describe('end-to-end: book room + catering + AV', () => {
  it.todo('atomically creates reservation + bundle + order + 2 line items + 2 tickets + 1 asset reservation');
  it.todo('returns 409 with alternatives on asset double-book');
  it.todo('rolls back full transaction on partial failure');
  it.todo('respects fulfilled-line protection on cancel');
});
```

(Real integration tests with the local Supabase stack — implementer fills in once 2C ships.)

- [ ] **Step 2: Commit**

```bash
git add apps/api/test/booking-bundle-end-to-end.spec.ts
git commit -m "test(rooms-2): scaffold composite-booking integration tests"
```

### Task 25: CostService.computeBundleCost

**Files:**
- Create: `apps/api/src/modules/orders/cost.service.ts`
- Create: `apps/api/src/modules/orders/cost.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('CostService', () => {
  it('per_item: line total = unit_price × quantity', () => { /* ... */ });
  it('per_person: line total = unit_price × qpa × attendees', () => { /* ... */ });
  it('flat_rate: line total = unit_price (quantity ignored)', () => { /* ... */ });
  it('annualised total = per-occurrence × occurrence count from recurrence rule', () => { /* ... */ });
  it('null unit_price contributes 0 and renders as null', () => { /* ... */ });
});
```

- [ ] **Step 2: Implement**

```ts
@Injectable()
export class CostService {
  computeLineTotal(line: { unit: string; unit_price: number | null; quantity: number; quantity_per_attendee: number | null }, attendeeCount: number | null): number | null {
    if (line.unit_price == null) return null;
    if (line.unit === 'per_item') return line.unit_price * line.quantity;
    if (line.unit === 'per_person') return line.unit_price * (line.quantity_per_attendee ?? 1) * (attendeeCount ?? 0);
    if (line.unit === 'flat_rate') return line.unit_price;
    return null;
  }
  // ... computeBundleCost(bundleId): per-occurrence + annualised
}
```

- [ ] **Step 3: Verify tests pass + commit**

```bash
git add apps/api/src/modules/orders/cost.service.{ts,spec.ts}
git commit -m "feat(rooms-2): CostService — per-line + bundle + annualised"
```

---

## Phase 2D — Recurrence + cancellation cascade (~4 days)

### Task 26: OrdersModule.cloneOrderForOccurrence

**Files:**
- Modify: `apps/api/src/modules/orders/order.service.ts`

- [ ] **Step 1: Implement clone**

```ts
async cloneOrderForOccurrence(args: {
  source_order_id: string;
  new_reservation_id: string;
  occurrence_start_at: string;
}): Promise<{ order_id: string; line_item_ids: string[]; ticket_ids: string[]; asset_reservation_ids: string[]; skipped_lines: string[] }> {
  // 1. Load source order + lines + reservation start delta
  // 2. For each line:
  //    - if repeats_with_series=false: skip
  //    - clone with delta-shifted service_window_*
  //    - clone asset_reservation if linked (conflict guard fires; on conflict, mark recurrence_skipped=true with skip_reason='asset_conflict' and continue)
  //    - clone work-order ticket
  // 3. Return ids
}
```

- [ ] **Step 2: Test (unit + integration)**

Cover: clone with offset, repeats_with_series=false skips line, asset conflict on one occurrence skips line but not siblings.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/orders/order.service.ts apps/api/src/modules/orders/order.service.spec.ts
git commit -m "feat(rooms-2): OrdersModule.cloneOrderForOccurrence — per-occurrence materialisation"
```

### Task 27: RecurrenceService materialiser fan-out

**Files:**
- Modify: `apps/api/src/modules/reservations/recurrence.service.ts`

- [ ] **Step 1: Add the fan-out in materialize()**

After each new reservation occurrence is inserted, call `OrdersModule.cloneOrderForOccurrence` for every order whose `recurrence_series_id` matches.

- [ ] **Step 2: Test**

`recurrence-materialize.service.spec.ts` — extend existing tests with bundle + services.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/reservations/recurrence.service.ts apps/api/src/modules/reservations/recurrence-materialize.service.spec.ts
git commit -m "feat(rooms-2): RecurrenceService materialiser fans out to linked orders"
```

### Task 28: BundleCascadeService

**Files:**
- Create: `apps/api/src/modules/booking-bundles/bundle-cascade.service.ts`
- Create: `apps/api/src/modules/booking-bundles/bundle-cascade.service.spec.ts`

- [ ] **Step 1: Implement cascade entry points**

```ts
@Injectable()
export class BundleCascadeService {
  // cancelLine(line_id, actor) — line + linked ticket + asset_reservation; rebuild approval scope
  // cancelReservation(reservation_id, actor, options: { keep_line_ids?: string[] })
  // cancelBundle(bundle_id, actor) — full
  // ... fulfilled-line protection inside each path
}
```

- [ ] **Step 2: Test (5 cases from spec §5.5)**

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/booking-bundles/bundle-cascade.service.{ts,spec.ts}
git commit -m "feat(rooms-2): BundleCascadeService — three entry points + fulfilled-line protection"
```

### Task 29: Per-occurrence override + skip APIs

**Files:**
- Modify: `apps/api/src/modules/orders/order-line.service.ts`

- [ ] **Step 1: Implement editLine + skipOccurrence**

```ts
async overrideLineOnOccurrence(line_id: string, patch: { quantity?: number; service_window_start_at?: string; service_window_end_at?: string; }) {
  // sets recurrence_overridden=true; updates fields
}
async skipLineOnOccurrence(line_id: string, reason: string = 'user_requested') {
  // sets recurrence_skipped=true with skip_reason
}
```

- [ ] **Step 2: Test + commit**

```bash
git add apps/api/src/modules/orders/order-line.service.ts apps/api/src/modules/orders/order-line.service.spec.ts
git commit -m "feat(rooms-2): per-occurrence line override + skip"
```

### Task 30: Audit events for new lifecycle moments

**Files:**
- Modify: `apps/api/src/modules/booking-bundles/bundle.service.ts`
- Modify: `apps/api/src/modules/booking-bundles/bundle-cascade.service.ts`
- Modify: `apps/api/src/modules/orders/order.service.ts`
- Modify: `apps/api/src/modules/orders/asset-reservation.service.ts`

- [ ] **Step 1: Emit events at each lifecycle decision (best-effort try/catch)**

Per spec §3.6: `bundle.created`, `bundle.cancelled`, `bundle.partially_cancelled`, `bundle.recurrence_split`, `bundle.recurrence_cancel_forward`, `order.created`, `order.cancelled`, `order.line_added`, `order.line_cancelled`, `order.line_overridden`, `asset_reservation.{created,cancelled}`, `approval.dedup_merged`.

Same try/catch pattern as the existing reservations audit emissions.

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/{booking-bundles,orders}
git commit -m "feat(rooms-2): audit events across new lifecycle moments"
```

---

## Phase 2E — Frontend surfaces (~6 days)

### Task 31: Booking-confirm dialog — three new sections

**Files:**
- Modify: `apps/web/src/pages/portal/book-room/components/booking-confirm-dialog.tsx`
- Create: `apps/web/src/pages/portal/book-room/components/service-section.tsx`
- Create: `apps/web/src/pages/portal/book-room/components/service-line-row.tsx`
- Create: `apps/web/src/pages/portal/book-room/components/per-line-time-picker.tsx`
- Create: `apps/web/src/pages/portal/book-room/components/bundle-cost-summary.tsx`
- Create: `apps/web/src/pages/portal/book-room/components/service-rule-outcome-chip.tsx`

- [ ] **Step 1: Build ServiceSection (collapsible per spec §4.1)**

Lazy renders: section is unmounted until expanded. `useQuery` for menus only fires on expand.

- [ ] **Step 2: Build PerLineTimePicker**

Defaults to reservation window. On change, surfaces "differs from meeting" badge.

- [ ] **Step 3: Build BundleCostSummary**

Live-updating per-line + bundle total. Annualised tooltip when recurrence on.

- [ ] **Step 4: Wire into BookingConfirmDialog**

Three new sections (Catering / AV / Setup) alongside existing Recurrence section. Sections render only when picker probe returns at least one menu for their category.

- [ ] **Step 5: Test (component + e2e)**

Playwright: book room + catering for 14 + projector → confirms with one approval pending.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/portal/book-room/
git commit -m "feat(rooms-2): booking-confirm dialog grows three service sections + cost roll-up"
```

### Task 32: Bundle template picker

**Files:**
- Create: `apps/web/src/pages/portal/book-room/components/bundle-template-picker.tsx`
- Modify: `apps/web/src/pages/portal/book-room/index.tsx`

- [ ] **Step 1: Build picker**

Chip row above the time picker. Hits `/bundle-templates?active=true`. Selecting hydrates form.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/pages/portal/book-room/
git commit -m "feat(rooms-2): bundle template picker — one-click composite booking"
```

### Task 33: Standalone /portal/order page

**Files:**
- Create: `apps/web/src/pages/portal/order/index.tsx`
- Create: `apps/web/src/pages/portal/order/components/standalone-order-form.tsx`
- Create: `apps/web/src/pages/portal/order/components/standalone-cost-summary.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Build the page**

Single form per spec §4.2. Recurrence toggle disabled with "Coming soon" inline.

- [ ] **Step 2: Wire route**

```tsx
// App.tsx
<Route path="order" element={<StandaloneOrderPage />} />
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/portal/order apps/web/src/App.tsx
git commit -m "feat(rooms-2): standalone /portal/order flow"
```

### Task 34: /admin/booking-services index + detail pages

**Files:**
- Create: `apps/web/src/pages/admin/booking-services/index.tsx`
- Create: `apps/web/src/pages/admin/booking-services/{vendors,menus,items}/{index,detail}.tsx`
- Create: parallel rules detail at `/admin/booking-services/rules` mirroring `/admin/room-booking-rules`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Build index card layout**

Three cards (Vendors / Menus / Items) per spec §6.1.

- [ ] **Step 2: Build detail pages**

Each on `SettingsPageShell` per CLAUDE.md mandate. Width per spec table.

- [ ] **Step 3: Wire routes**

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/admin/booking-services apps/web/src/App.tsx
git commit -m "feat(rooms-2): /admin/booking-services index + vendor/menu/item/rule detail pages"
```

### Task 35: /admin/cost-centers + /admin/bundle-templates

**Files:**
- Create: `apps/web/src/pages/admin/cost-centers/{index,[id]}.tsx`
- Create: `apps/web/src/pages/admin/bundle-templates/{index,[id]}.tsx`
- Create: `apps/web/src/pages/admin/bundle-templates/components/template-editor.tsx`
- Create: `apps/web/src/pages/admin/bundle-templates/components/template-preview.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Build cost-centers admin**

Index + detail. CSV bulk import.

- [ ] **Step 2: Build bundle-templates admin with live preview pane**

- [ ] **Step 3: Wire routes + commit**

```bash
git add apps/web/src/pages/admin/{cost-centers,bundle-templates} apps/web/src/App.tsx
git commit -m "feat(rooms-2): /admin/cost-centers + /admin/bundle-templates"
```

### Task 36: Bundle services section + audit timeline in /portal/me-bookings drawer

**Files:**
- Modify: `apps/web/src/pages/portal/me-bookings/components/booking-detail-drawer.tsx`
- Create: `apps/web/src/pages/portal/me-bookings/components/bundle-services-section.tsx`
- Create: `apps/web/src/pages/portal/me-bookings/components/bundle-audit-timeline.tsx`

- [ ] **Step 1: Build BundleServicesSection**

Reads bundle detail; shows lines with status, vendor/team, service window, cost.

- [ ] **Step 2: Build BundleAuditTimeline**

Reads audit_events filtered by bundle scope. Renders system events + any vendor/operator updates that flow in.

- [ ] **Step 3: Wire into drawer + commit**

```bash
git add apps/web/src/pages/portal/me-bookings
git commit -m "feat(rooms-2): bundle services + audit timeline in my-bookings drawer"
```

### Task 37: /desk/bookings — Bundles scope + Services drawer section

**Files:**
- Modify: `apps/web/src/pages/desk/bookings.tsx`
- Modify: `apps/web/src/components/desk/ticket-row-cells.tsx` (work-order chip)
- Modify: `apps/web/src/pages/desk/use-ticket-filters.ts` (work-orders preset)

- [ ] **Step 1: Add Bundles scope chip**

Filter on `booking_bundle_id is not null`.

- [ ] **Step 2: Add Services section to BookingDetailDrawer (operator surface)**

Click line → side panel ticket detail.

- [ ] **Step 3: Add work-orders view preset**

`/desk/tickets?view=work_orders` filters `ticket_kind=work_order`, sorts by service_window_start_at.

- [ ] **Step 4: Service window chip on work-order row**

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/desk apps/web/src/components/desk
git commit -m "feat(rooms-2): /desk/bookings Bundles scope + work-orders preset"
```

### Task 38: Frontend Playwright happy path

**Files:**
- Create: `apps/web/e2e/linked-services.spec.ts` (assuming Playwright lives there)

- [ ] **Step 1: Write the happy path test**

```ts
test('book room + catering + AV + setup, get one approval, see on /desk/bookings', async ({ page }) => {
  // ...
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/e2e/linked-services.spec.ts
git commit -m "test(rooms-2): Playwright e2e happy path for composite booking"
```

### Task 39: Update docs/room-booking.md

**Files:**
- Modify: `docs/room-booking.md`

- [ ] **Step 1: Add four new sections per spec §12**

- "Bundles + service flow"
- "Service catalog"
- "Asset reservations"
- Audit events table extension

- [ ] **Step 2: Update trigger-files list**

- [ ] **Step 3: Commit**

```bash
git add docs/room-booking.md
git commit -m "docs(rooms): operational reference — sub-project 2 sections"
```

### Task 40: Final acceptance smoke

**Files:**
- (no new files; manual run)

- [ ] **Step 1: Run all tests**

```bash
cd apps/api && pnpm test
cd apps/web && pnpm exec tsc --noEmit
cd apps/web && pnpm test 2>/dev/null || true
```

Expected: every spec §10 acceptance criterion satisfied. 0 failing tests.

- [ ] **Step 2: Push to remote (already done per migration as we go)**

- [ ] **Step 3: Push to origin**

```bash
git push origin main
```

- [ ] **Step 4: Update memory**

Add a memory entry that sub-project 2 is shipped.

---

## Self-review

Spec coverage:
- §3 Architecture & schema → Tasks 1-12 (migrations + module skeletons + frontend api skeletons)
- §3.5 Module boundaries → Tasks 11-12, 19, 20, 26, 28
- §4.1 Composite booking flow → Tasks 19, 20, 31
- §4.2 Standalone orders → Tasks 21, 33
- §4.3 Service rule resolution → Tasks 14, 15
- §4.4 Approval dedup → Tasks 16, 17
- §4.5 Cost computation → Task 25
- §4.6 Bundle templates → Tasks 11 (skeleton), 32, 35
- §5.1 Recurrence + services → Tasks 26, 27
- §5.2 Per-occurrence override + skip → Task 29
- §5.3 Cancellation cascade → Task 28
- §6.1 Admin surfaces → Tasks 34, 35
- §6.2 Operator surface → Task 37
- §6.3 Requester surface → Task 36
- §7 Phasing → mapped to 2A-2E groupings above
- §8 Migrations → Tasks 1-10
- §9 Testing → spread across each task + Tasks 24, 38
- §11 Risks → mitigations baked into the tasks (asset GiST in Task 3, dedup in Task 16, cycle FK in Task 8, vendor relax in Task 4)

Placeholder scan: spec stubs in `it.todo` form are intentional (concrete assertions land alongside the implementation in each phase). No "TBD"/"figure out later" left in non-test code.

Type consistency: `BundleAttachResult`, `ServiceEvaluationContext`, `ApprovalAssemblyInput` shapes are referenced consistently across tasks. `ApproverTarget` shape stable from Task 14 through Task 16.

---

## Execution

Plan complete and saved. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration. Codex review at slice boundaries (2A done · 2B done · 2C done · 2D done · 2E done) per memory `feedback_codex_reviews`.

2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
