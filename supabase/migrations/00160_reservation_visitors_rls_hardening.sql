-- Defense-in-depth for `reservation_visitors`. Migration 00159 left only a
-- tenant_isolation policy in place, which let any tenant member SELECT
-- through PostgREST and discover that visitor X attended reservation Y
-- — even when the caller has no visibility on that reservation. This
-- migration adds:
--
--   1. A surrogate `id` PK so future audit / GDPR-removal flows can
--      reference a specific attach event without composite-key gymnastics.
--      The composite (reservation_id, visitor_id) becomes a UNIQUE
--      constraint (the upsert key).
--   2. A SELECT policy gated through `reservation_visibility_ids` so the
--      row is only readable when the caller can see the reservation.
--      Backstop the existing `tenant_isolation` policy by scoping it to
--      INSERT/UPDATE/DELETE only.
--   3. A grant lockdown so direct PostgREST callers (anon/authenticated)
--      can't bypass the API layer; service-role only, mirroring the
--      pattern used for `search_global` (00151).
--
-- Drops the legacy `tenant_isolation` ALL-policy and re-creates per-verb
-- policies so SELECT can use a tighter predicate than write.

-- Add surrogate id (defaults make it safe even if rows already exist).
alter table public.reservation_visitors
  add column if not exists id uuid not null default gen_random_uuid();

-- Replace the composite PK with the surrogate. The composite stays as a
-- UNIQUE constraint to preserve idempotent upsert behaviour.
alter table public.reservation_visitors
  drop constraint if exists reservation_visitors_pkey;

alter table public.reservation_visitors
  add primary key (id);

alter table public.reservation_visitors
  add constraint reservation_visitors_unique_per_reservation
  unique (reservation_id, visitor_id);

-- Tighten RLS. Drop the legacy ALL policy in favour of per-verb policies.
drop policy if exists "tenant_isolation" on public.reservation_visitors;

-- Read: per-row gate via reservation visibility. Returns 0 rows for
-- reservations the caller can't see; combined with the API-layer check,
-- this is defense-in-depth.
create policy "reservation_visitors_select" on public.reservation_visitors
  for select
  using (
    tenant_id = public.current_tenant_id()
    and reservation_id in (
      select id from public.reservation_visibility_ids(
        (select u.id from public.users u
          where u.auth_uid = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
            and u.tenant_id = public.current_tenant_id()
          limit 1),
        public.current_tenant_id()
      )
    )
  );

-- Writes are tenant-scoped only at the SQL layer; the API layer enforces
-- the additional write gate (admin / write_all / participant).
create policy "reservation_visitors_insert" on public.reservation_visitors
  for insert
  with check (tenant_id = public.current_tenant_id());

create policy "reservation_visitors_update" on public.reservation_visitors
  for update
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy "reservation_visitors_delete" on public.reservation_visitors
  for delete
  using (tenant_id = public.current_tenant_id());

-- Grant lockdown — direct PostgREST traffic can't bypass /api routes.
revoke all on public.reservation_visitors from public, anon, authenticated;
grant all on public.reservation_visitors to service_role;

notify pgrst, 'reload schema';
