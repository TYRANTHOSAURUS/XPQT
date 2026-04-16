-- Order catalog and orders (unified: food, equipment, supplies, services)

create table public.catalog_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  category text not null check (category in ('food_and_drinks', 'equipment', 'supplies', 'services')),
  subcategory text, -- e.g. within food: beverages, breakfast, lunch, snacks
  price_per_unit numeric(10,2),
  unit text not null default 'per_item' check (unit in ('per_person', 'per_item', 'flat_rate')),
  minimum_quantity integer,
  maximum_quantity integer,
  lead_time_hours integer,
  dietary_tags text[] default '{}',
  fulfillment_team_id uuid references public.teams(id),
  image_url text,
  display_order integer not null default 0,
  active boolean not null default true,
  -- Availability rules
  available_at_locations uuid[] default null, -- space IDs; null = everywhere
  available_for_roles uuid[] default null, -- role IDs; null = everyone
  available_for_departments text[] default null, -- department names; null = all
  excluded_from_locations uuid[] default null,
  -- Asset pool linkage (for loanable equipment)
  linked_asset_type_id uuid references public.asset_types(id),
  requires_return boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.catalog_items enable row level security;
create policy "tenant_isolation" on public.catalog_items
  using (tenant_id = public.current_tenant_id());

create index idx_ci_tenant on public.catalog_items (tenant_id);
create index idx_ci_tenant_category on public.catalog_items (tenant_id, category);
create index idx_ci_tenant_active on public.catalog_items (tenant_id, active) where active = true;

create trigger set_ci_updated_at before update on public.catalog_items
  for each row execute function public.set_updated_at();

-- Orders (the cart)
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  requester_person_id uuid not null references public.persons(id),
  linked_reservation_id uuid, -- FK added after reservations table
  delivery_location_id uuid references public.spaces(id),
  delivery_date date,
  delivery_time time,
  headcount integer,
  dietary_notes text,
  total_estimated_cost numeric(12,2),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'confirmed', 'fulfilled', 'cancelled')),
  approval_id uuid references public.approvals(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.orders enable row level security;
create policy "tenant_isolation" on public.orders
  using (tenant_id = public.current_tenant_id());

create index idx_orders_tenant on public.orders (tenant_id);
create index idx_orders_requester on public.orders (requester_person_id);
create index idx_orders_reservation on public.orders (linked_reservation_id) where linked_reservation_id is not null;

create trigger set_orders_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

-- Order line items
create table public.order_line_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id),
  catalog_item_id uuid not null references public.catalog_items(id),
  quantity integer not null default 1,
  unit_price numeric(10,2), -- captured at order time
  line_total numeric(10,2),
  dietary_notes text,
  fulfillment_status text not null default 'ordered' check (fulfillment_status in ('ordered', 'confirmed', 'preparing', 'delivered', 'cancelled')),
  fulfillment_team_id uuid references public.teams(id),
  fulfillment_notes text,
  linked_asset_id uuid references public.assets(id), -- set when a pooled asset is reserved
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.order_line_items enable row level security;
create policy "tenant_isolation" on public.order_line_items
  using (tenant_id = public.current_tenant_id());

create index idx_oli_order on public.order_line_items (order_id);
create index idx_oli_tenant on public.order_line_items (tenant_id);
create index idx_oli_fulfillment on public.order_line_items (fulfillment_team_id, fulfillment_status) where fulfillment_status not in ('delivered', 'cancelled');

create trigger set_oli_updated_at before update on public.order_line_items
  for each row execute function public.set_updated_at();

-- Now add FK from assets to order_line_items
alter table public.assets
  add constraint fk_assets_order_line_item
  foreign key (linked_order_line_item_id)
  references public.order_line_items(id);
