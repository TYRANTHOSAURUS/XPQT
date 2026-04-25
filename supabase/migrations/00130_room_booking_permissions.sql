-- 00130_room_booking_permissions.sql
-- Permission keys recognised for the room booking module.
-- The permission system in this product stores tokens on roles.permissions (jsonb).
-- This migration is a no-op at the schema layer — the keys themselves are validated by
-- application code; we document them here so the schema is self-describing and so role
-- templates / seeds can grant them.
--
--   rooms.read              → implicit for any authenticated portal user
--   rooms.read_all          → operators / service desk (see other tenants' bookings, no edit)
--   rooms.admin             → admin module access (rules, rooms, calendars, sync health)
--   rooms.book_on_behalf    → service desk + designated assistants
--   rooms.override_rules    → service desk only — bypass `deny` with reason; high-visibility audit
--
-- If the project has a permissions registry table (see 00109_permissions_wildcards),
-- application seed code is responsible for inserting these keys into the registry on boot.

-- Concrete: this migration just emits a marker comment so a grep for the permission
-- names lands here, plus reloads schema.

comment on table public.room_booking_rules is
  'Predicate-driven booking rules. Permission keys: rooms.read, rooms.read_all, rooms.admin, rooms.book_on_behalf, rooms.override_rules.';

notify pgrst, 'reload schema';
