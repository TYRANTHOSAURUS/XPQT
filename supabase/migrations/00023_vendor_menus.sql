-- Vendor menus: per-vendor, per-building, date-bounded offering sheets.
-- Mental model: each vendor publishes menus like a hotel banqueting sheet. A menu is
-- scoped to one service_type (catering / av_equipment / ...) and optionally to a specific
-- building. Order-time resolution picks the best menu for (item, delivery_space, date).
--
-- Coexists with catalog_items (product definition — name, image, unit). catalog_items.
-- price_per_unit and fulfillment_team_id remain as the *default* offering when no menu
-- row applies. Menus override.
--
-- v1 skips package/bundle decomposition. Add a catalog_item_components table later when
-- banqueting packages are requested.

-- ---------------------------------------------------------------------------
-- 1. Vendors (first-class external party; distinct from internal teams)
-- ---------------------------------------------------------------------------
create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  contact_email text,
  contact_phone text,
  website text,
  notes text,
  -- Internal team that owns the vendor relationship (comms, contracts, escalations).
  -- order_line_items.fulfillment_team_id keeps pointing here on fulfillment.
  owning_team_id uuid references public.teams(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vendors enable row level security;
create policy "tenant_isolation" on public.vendors
  using (tenant_id = public.current_tenant_id());

create index idx_vendors_tenant on public.vendors (tenant_id);
create index idx_vendors_tenant_active on public.vendors (tenant_id, active) where active = true;

create trigger set_vendors_updated_at before update on public.vendors
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Vendor service areas (which vendor serves which building, for which service)
-- ---------------------------------------------------------------------------
-- One vendor row per (building, service_type). Lets "Vendor X does catering in A & B
-- but only AV in C" be expressed without overloading menus. default_priority breaks
-- ties when multiple vendors serve the same building + service (lower wins).
create table public.vendor_service_areas (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  space_id uuid not null references public.spaces(id),
  service_type text not null check (service_type in (
    'catering', 'av_equipment', 'supplies', 'facilities_services',
    'cleaning', 'maintenance', 'transport', 'other'
  )),
  default_priority integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (vendor_id, space_id, service_type)
);

alter table public.vendor_service_areas enable row level security;
create policy "tenant_isolation" on public.vendor_service_areas
  using (tenant_id = public.current_tenant_id());

create index idx_vsa_tenant on public.vendor_service_areas (tenant_id);
create index idx_vsa_space_service on public.vendor_service_areas (space_id, service_type)
  where active = true;
create index idx_vsa_vendor on public.vendor_service_areas (vendor_id);

-- ---------------------------------------------------------------------------
-- 3. Catalog menus (the admin's unit of work — "Spring 2026 Lunch Menu")
-- ---------------------------------------------------------------------------
-- space_id null  → applies to every building this vendor serves for this service_type
-- space_id set   → building-specific menu (takes precedence over the vendor's null menu)
-- effective_until null → open-ended
create table public.catalog_menus (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  space_id uuid references public.spaces(id),
  service_type text not null check (service_type in (
    'catering', 'av_equipment', 'supplies', 'facilities_services',
    'cleaning', 'maintenance', 'transport', 'other'
  )),
  name text not null,
  description text,
  effective_from date not null,
  effective_until date,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_until is null or effective_until >= effective_from)
);

alter table public.catalog_menus enable row level security;
create policy "tenant_isolation" on public.catalog_menus
  using (tenant_id = public.current_tenant_id());

create index idx_menus_tenant on public.catalog_menus (tenant_id);
create index idx_menus_vendor on public.catalog_menus (vendor_id);
create index idx_menus_service_space on public.catalog_menus (service_type, space_id)
  where status = 'published';
-- Active-window lookups: the resolver joins on this
create index idx_menus_active_window on public.catalog_menus (tenant_id, service_type, effective_from, effective_until)
  where status = 'published';

create trigger set_menus_updated_at before update on public.catalog_menus
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Menu items (the priced offering — vendor X sells item Y for $Z on this menu)
-- ---------------------------------------------------------------------------
create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  menu_id uuid not null references public.catalog_menus(id) on delete cascade,
  catalog_item_id uuid not null references public.catalog_items(id),
  price numeric(10,2) not null,
  unit text not null default 'per_item' check (unit in ('per_person', 'per_item', 'flat_rate')),
  minimum_quantity integer,
  maximum_quantity integer,
  lead_time_hours integer,
  -- Weekly/time-of-day availability. null = always within menu window.
  available_days_of_week smallint[], -- 0=Sun..6=Sat
  available_from_time time,
  available_until_time time,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (menu_id, catalog_item_id)
);

alter table public.menu_items enable row level security;
create policy "tenant_isolation" on public.menu_items
  using (tenant_id = public.current_tenant_id());

create index idx_menu_items_tenant on public.menu_items (tenant_id);
create index idx_menu_items_menu on public.menu_items (menu_id) where active = true;
create index idx_menu_items_catalog_item on public.menu_items (catalog_item_id) where active = true;

create trigger set_menu_items_updated_at before update on public.menu_items
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Order provenance: snapshot which menu/vendor fulfilled each line
-- ---------------------------------------------------------------------------
-- Historical integrity: if a menu is later archived or repriced, the order still
-- knows what it came from. order_line_items.unit_price already captures price at
-- order time — we just add the source pointers.
alter table public.order_line_items
  add column if not exists vendor_id uuid references public.vendors(id),
  add column if not exists menu_item_id uuid references public.menu_items(id);

create index if not exists idx_oli_vendor on public.order_line_items (vendor_id)
  where vendor_id is not null;

-- ---------------------------------------------------------------------------
-- 6. Resolver: given (item, delivery space, date) → pick the right menu row
-- ---------------------------------------------------------------------------
-- Resolution order:
--   1. Menus whose vendor serves the delivery space for that service_type
--   2. Prefer menus with space_id = delivery_space (building-specific override)
--      over menus with space_id = null (vendor default)
--   3. Prefer vendor with lowest default_priority in vendor_service_areas
--   4. Prefer lowest price if still tied
-- Returns zero rows if no offering exists — caller falls back to catalog_items defaults.
create or replace function public.resolve_menu_offer(
  p_catalog_item_id uuid,
  p_delivery_space_id uuid,
  p_on_date date default current_date
)
returns table (
  menu_id uuid,
  menu_item_id uuid,
  vendor_id uuid,
  owning_team_id uuid,
  price numeric,
  unit text,
  lead_time_hours integer,
  service_type text
)
language sql
stable
as $$
  with candidate_space as (
    -- Include the delivery space and any ancestor (floor → building → site), so a
    -- catering menu scoped to "Building A" applies to an order delivered to a room in A.
    with recursive ancestry as (
      select id, parent_id, 0 as depth from public.spaces where id = p_delivery_space_id
      union all
      select s.id, s.parent_id, a.depth + 1
      from public.spaces s
      join ancestry a on s.id = a.parent_id
      where a.depth < 10
    )
    select id from ancestry
  )
  select
    m.id            as menu_id,
    mi.id           as menu_item_id,
    v.id            as vendor_id,
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
    and (
      m.space_id is null
      or m.space_id in (select id from candidate_space)
    )
  order by
    (m.space_id is not null) desc,  -- building-specific wins over vendor-default
    vsa.default_priority asc,
    mi.price asc
  limit 1;
$$;
