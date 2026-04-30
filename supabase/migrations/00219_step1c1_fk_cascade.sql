-- Step 1c.1 follow-up: change legacy_ticket_id FK from RESTRICT to CASCADE.
--
-- 00217 changed the FK from ON DELETE SET NULL to ON DELETE RESTRICT to
-- avoid ambiguous ordering with the AFTER DELETE shadow trigger. But
-- RESTRICT is too strict: a DELETE on tickets fires Postgres's FK check
-- BEFORE the AFTER trigger runs, so the FK violation aborts the delete
-- before the shadow trigger gets a chance to clean up work_orders_new.
--
-- Stress-test S8 hit this immediately:
--   DELETE on public.tickets violates FK on public.work_orders_new
--
-- CASCADE is the right answer:
--   - DELETE on tickets → FK CASCADE deletes the work_orders_new row
--   - The AFTER DELETE shadow trigger still fires but finds 0 rows
--     (already deleted by CASCADE) — harmless idempotent no-op
--   - For UPDATE-based demotes (wo→case), the shadow trigger's UPDATE
--     branch still does the explicit DELETE — CASCADE doesn't help there
--     because the ticket row isn't deleted, just modified
--
-- This is the "discovered by stress test" pattern: a soak window would
-- have eventually surfaced this when production tickets started getting
-- deleted, but stress-testing surfaced it in seconds.

alter table public.work_orders_new
  drop constraint work_orders_new_legacy_ticket_id_fkey;
alter table public.work_orders_new
  add constraint work_orders_new_legacy_ticket_id_fkey
  foreign key (legacy_ticket_id) references public.tickets(id) on delete cascade;

notify pgrst, 'reload schema';
