-- 00391_align_maintenance_plans_permissions.sql
--
-- Slice C — PM (preventive-maintenance) generator. Aligns existing
-- tenants' seeded role permissions with the TypeScript source of truth
-- in packages/shared/src/role-defaults.ts.
--
-- TS state added in this slice:
--   FM Agent          += maintenance_plans.read
--   Service Desk Lead += maintenance_plans.*  (wildcard — covered by 00112
--                        catalog growth; nothing to backfill literally,
--                        the wildcard string itself doesn't need an
--                        explicit row).
--
-- Mirrors 00284's idempotent pg_temp.merge_role_permissions pattern so a
-- replay is a no-op. Union-dedupes; jsonb_typeof guard skips rows that
-- ever held a non-array value.
--
-- Tenant isolation: per-tenant rows updated in place; no cross-tenant
-- write. RLS on public.roles (tenant_id NOT NULL FK) enforces scope.
--
-- KNOWN GAP (carried over from 00284): new tenants seeded by
-- 00112_seed_role_templates.sql still receive the pre-slice template.
-- Tracked as the destructive-role-rebuild follow-up.

begin;

create or replace function pg_temp.merge_role_permissions(
  p_existing jsonb,
  p_new text[]
) returns jsonb
language sql
immutable
as $$
  select coalesce(
    (
      select jsonb_agg(distinct p order by p)
      from (
        select elem as p
        from jsonb_array_elements_text(coalesce(p_existing, '[]'::jsonb)) as elem
        where elem is not null
        union
        select unnest(p_new)
      ) merged
    ),
    '[]'::jsonb
  );
$$;

update public.roles r
set permissions = pg_temp.merge_role_permissions(
  r.permissions,
  array['maintenance_plans.read']
)
where lower(r.name) = 'fm agent'
  and jsonb_typeof(coalesce(r.permissions, '[]'::jsonb)) = 'array';

commit;

notify pgrst, 'reload schema';
