-- 00207_extend_service_desk_lead_permissions.sql
--
-- Adds `rooms.admin` and `vendors.admin` to the seeded "Service Desk Lead"
-- role template across all tenants. Aligns the database with the canonical
-- TypeScript source of truth in packages/shared/src/role-defaults.ts.
--
-- Why: prior to this slice, the room-booking subsystem (rules, bundle
-- templates, simulation) and the daglijst admin (regenerate / resend) gated
-- with `rooms.admin` and `vendors.admin` — but neither key existed in
-- PERMISSION_CATALOG, so those endpoints only resolved true for `*.*`
-- superadmin. The catalog was extended in this slice; this migration
-- assigns the keys to the closest existing role (Service Desk Lead =
-- "agent + team admin + reporting + workplace config").
--
-- Idempotent — uses jsonb_array_elements_text + array_agg to dedupe the
-- permissions array, so re-running this migration is safe.
--
-- Tenant isolation: per-tenant rows updated in place; no cross-tenant data
-- movement. RLS on `public.roles` (tenant_id NOT NULL FK) enforces scope.

begin;

update public.roles r
set permissions = coalesce(
  (
    select jsonb_agg(distinct p order by p)
    from (
      select jsonb_array_elements_text(coalesce(r.permissions, '[]'::jsonb)) as p
      union
      select unnest(array['rooms.admin', 'vendors.admin'])
    ) merged
  ),
  '[]'::jsonb
)
where lower(r.name) = 'service desk lead';

commit;

notify pgrst, 'reload schema';
