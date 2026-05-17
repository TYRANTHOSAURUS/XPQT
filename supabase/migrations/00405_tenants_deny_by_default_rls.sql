-- 00405_tenants_deny_by_default_rls.sql
--
-- docs/follow-ups/audits/04-rls-security.md Slice 6 (P2).
--
-- The `public.tenants` table historically has NO RLS. Per the
-- 00001_tenants.sql:25-26 comment, "accessed by the service role" —
-- documented intent, but enforced only by application discipline.
-- Any future controller that exposes `tenants` via supabase.admin
-- (service-role) or DbService (postgres superuser) would leak the
-- full tenant list. Today there is no such leak (only TenantService
-- reads `tenants` during slug / id resolution), but the absence of
-- any RLS policy on a top-level platform table is a foot-gun.
--
-- This migration enables RLS with a `USING (false) WITH CHECK (false)`
-- deny-by-default policy. Both API connection paths bypass RLS:
--   - DbService:           postgres role → superuser bypass
--   - SupabaseService.admin: service-role key → service-role bypass
-- so existing reads/writes continue to work without change.
--
-- The policy closes the door on any future client that connects as
-- a non-superuser, non-service-role role (eg. a future direct
-- PostgREST surface, or a non-superuser app role per
-- docs/visibility.md §8.4): such a client now gets zero rows from
-- `tenants` and cannot insert / update / delete.
--
-- Reference: docs/visibility.md §8 (RLS as perimeter, not policy).

alter table public.tenants enable row level security;

create policy "tenants_deny_all_by_default" on public.tenants
  for all
  using (false)
  with check (false);

comment on policy "tenants_deny_all_by_default" on public.tenants is
  'Defense-in-depth: postgres superuser and service-role bypass RLS, so '
  'this policy is a no-op for current API paths. It blocks any future '
  'non-superuser, non-service-role client that hits this table. See '
  'docs/visibility.md §8 for the broader posture.';

-- Schema cache reload so PostgREST sees the policy.
notify pgrst, 'reload schema';
