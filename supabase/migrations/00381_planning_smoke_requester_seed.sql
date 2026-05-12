-- 00381_planning_smoke_requester_seed.sql
--
-- Seed a deterministic requester-only user for the planning-board smoke
-- gate. Closes the P0-3 gap surfaced by codex (commit 5a689110): 00380's
-- operator-only predicate (`work_orders_planning_visible_for_actor`) was
-- shipped without end-to-end exclusion coverage, because the smoke gate
-- only minted an Admin JWT (read_all override) — the predicate's
-- requester/watcher exclusion branch never ran in CI.
--
-- This seed creates one user in the existing test tenant (Solana Inc.,
-- 00000000-0000-0000-0000-000000000001) with:
--   - persons row (employee type, deterministic uuid).
--   - public.users row linked via auth_uid (deterministic).
--   - ZERO team_members rows.
--   - ZERO user_role_assignments rows.
--   - ZERO permissions anywhere (no tickets.read_all override).
--
-- The matching `auth.users` row is bootstrapped at smoke-script startup
-- via `auth.admin.createUser` (idempotent — find-or-create by id). Raw
-- SQL inserts into `auth.users` + `auth.identities` were attempted and
-- abandoned because GoTrue's user-load path fails on hand-rolled rows
-- ("Database error loading user") — there's internal state (encrypted
-- password format, schema_migrations baseline) that only the GoTrue
-- admin endpoint sets correctly. The fixed user uuid below is the one
-- the smoke script asks GoTrue to assign.
--
-- A fixture work_order is created with `requester_person_id` set to this
-- seed person AND `planned_start_at` inside today's planning window so
-- the smoke probe can call GET /work-orders/planning?from=...&to=...
-- and verify the row is excluded. Without this fixture, the probe would
-- be vacuous (empty assertion on empty data).
--
-- tenant_id is invariant #0 — every insert here pins it explicitly.

begin;

-- 1. persons — operational representation. type='employee' matches the
--    other seed users in 00102.
insert into public.persons (
  id,
  tenant_id,
  type,
  first_name,
  last_name,
  email,
  active
) values (
  'aa000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-000000000001',
  'employee',
  'Planning',
  'Smoke Requester',
  'planning-smoke-requester@example.test',
  true
)
on conflict (id) do update set
  email = excluded.email,
  first_name = excluded.first_name,
  last_name = excluded.last_name,
  active = excluded.active,
  updated_at = now();

-- 2. public.users — links auth_uid → tenant. NO role assignment, NO team
--    membership inserted. Adding either would defeat the smoke probe.
insert into public.users (
  id,
  tenant_id,
  person_id,
  auth_uid,
  email,
  username,
  status
) values (
  'aa000000-0000-0000-0000-0000000000a2',
  '00000000-0000-0000-0000-000000000001',
  'aa000000-0000-0000-0000-0000000000a1',
  'aa000000-0000-0000-0000-00000000a001',
  'planning-smoke-requester@example.test',
  'planning.smoke.requester',
  'active'
)
on conflict (id) do update set
  auth_uid = excluded.auth_uid,
  email = excluded.email,
  status = excluded.status,
  updated_at = now();

-- 3. Fixture work_order — requester-only visibility path. Ticket type
--    + location reuse the existing centralised-example seed (00102) to
--    avoid creating orphan dimensions. `requester_person_id` points at
--    the seed person above, so the smoke probe is non-vacuous: an
--    operator predicate that fails to exclude the requester branch
--    would surface this row in the planning response.
--
--    `planned_start_at` is set 1 hour into the future on a deterministic
--    date well inside the planning window. The smoke probe asserts
--    `planned: []` for this user — if the predicate leaks the requester
--    branch, the probe will see this row.
insert into public.work_orders (
  id,
  tenant_id,
  ticket_type_id,
  title,
  status,
  status_category,
  priority,
  requester_person_id,
  location_id,
  planned_start_at,
  planned_duration_minutes,
  source_channel
) values (
  'aa000000-0000-0000-0000-0000000000b1',
  '00000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000003',
  'planning-smoke-requester-fixture',
  'new',
  'new',
  'medium',
  'aa000000-0000-0000-0000-0000000000a1',
  '93000000-0000-0000-0000-000000000001',
  date_trunc('day', now() at time zone 'utc') + interval '12 hours',
  60,
  'portal'
)
on conflict (id) do update set
  requester_person_id = excluded.requester_person_id,
  planned_start_at = excluded.planned_start_at,
  planned_duration_minutes = excluded.planned_duration_minutes,
  status = excluded.status,
  status_category = excluded.status_category;

commit;

notify pgrst, 'reload schema';
