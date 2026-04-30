-- Step 2 + Step 4 — alias views for the planned table renames.
--
-- These views provide the new canonical names from the redesign doc:
--   service_orders       → today's `orders`
--   service_order_lines  → today's `order_line_items`
--   bookings             → today's `booking_bundles`
--
-- The underlying tables stay named the same. Future code can reference
-- either the old or new name (resolves to the same rows). The actual
-- table renames happen at the destructive step 6 cutover with full
-- application-code coordination.
--
-- Why ship these now: they unblock new code from coupling to the legacy
-- names. Any future feature that adds a query against `orders` can use
-- `service_orders` instead, so when the rename happens the new code
-- doesn't need updating.
--
-- The original tables retain all RLS, FKs, triggers, indexes. Views
-- inherit the underlying RLS from the table (Postgres views run with
-- view-owner privileges; revoke direct view access matches the cases /
-- work_orders posture).

-- ── Step 2: service_orders + service_order_lines ──────────────
create or replace view public.service_orders as
select * from public.orders;

comment on view public.service_orders is
  'Step 2 alias of public.orders. Same rows, same shape — exists so future code can reference the canonical name. Becomes the table itself at step 6 destructive rename.';

create or replace view public.service_order_lines as
select * from public.order_line_items;

comment on view public.service_order_lines is
  'Step 2 alias of public.order_line_items. Same rows, same shape. Becomes the table itself at step 6.';

revoke all on public.service_orders from anon, authenticated, public;
revoke all on public.service_order_lines from anon, authenticated, public;
grant select on public.service_orders to service_role;
grant select on public.service_order_lines to service_role;

-- ── Step 4: bookings ──────────────────────────────────────────
create or replace view public.bookings as
select * from public.booking_bundles;

comment on view public.bookings is
  'Step 4 alias of public.booking_bundles. Same rows, same shape. Becomes the table itself at step 6 destructive rename.';

revoke all on public.bookings from anon, authenticated, public;
grant select on public.bookings to service_role;

notify pgrst, 'reload schema';
