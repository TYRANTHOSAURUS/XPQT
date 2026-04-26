-- 00145_tickets_bundle_columns.sql
-- tickets.ticket_kind ('case','work_order') already exists from 00030.
-- We do NOT add a 'kind' column. Just the bundle linkage so work-order
-- tickets can roll up to a bundle and be sorted by service window.

alter table public.tickets
  add column if not exists booking_bundle_id uuid references public.booking_bundles(id) on delete set null,
  add column if not exists linked_order_line_item_id uuid references public.order_line_items(id) on delete set null;

create index if not exists idx_tickets_bundle on public.tickets (booking_bundle_id) where booking_bundle_id is not null;
create index if not exists idx_tickets_kind_bundle on public.tickets (ticket_kind, booking_bundle_id) where booking_bundle_id is not null;
create index if not exists idx_tickets_oli on public.tickets (linked_order_line_item_id) where linked_order_line_item_id is not null;

notify pgrst, 'reload schema';
