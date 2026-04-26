-- 00142_asset_reservations.sql
-- Conflict guard for assets attached to service line items. Mirrors the
-- pattern used on `reservations` (sub-project 1).

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
  -- linked_order_line_item_id FK lands in 00144 (the order_line_items column
  -- additions migration) — order_line_items.linked_asset_reservation_id
  -- references this table; per-line linkage is established there. We add
  -- this side of the FK now so cascade-delete works in either direction.
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
