-- 00144_orders_bundle_columns.sql
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
