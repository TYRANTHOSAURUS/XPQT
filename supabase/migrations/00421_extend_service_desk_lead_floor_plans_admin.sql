-- 00421_extend_service_desk_lead_floor_plans_admin.sql
--
-- Adds `floor_plans.admin` to the seeded "Service Desk Lead" role template
-- across all existing tenants. Aligns the database with the TypeScript SoT
-- in packages/shared/src/role-defaults.ts (updated in commit f5d0e857).
--
-- Why: A.7 added the new permission key to the TS catalog + role-defaults,
-- but role-defaults only applies to NEW tenant/role creation. Existing roles
-- in existing tenants don't pick up the new key automatically. The smoke gate
-- (P2–P19) was failing 15/20 because user_has_permission returned false
-- for every existing admin user on every floor-plan endpoint.
--
-- Mirror of the 00207 pattern (which added rooms.admin + vendors.admin).
-- Idempotent: jsonb_array_elements_text + dedup ensures re-runs are safe.

begin;

update public.roles r
set permissions = coalesce(
  (
    select jsonb_agg(distinct p order by p)
    from (
      select jsonb_array_elements_text(coalesce(r.permissions, '[]'::jsonb)) as p
      union
      select unnest(array['floor_plans.admin'])
    ) merged
  ),
  '[]'::jsonb
)
where lower(r.name) = 'service desk lead';

commit;

notify pgrst, 'reload schema';
