-- 00067_seed_service_catalog_permissions.sql
-- Seed admin role with service-catalog admin permissions.
-- Idempotent merge pattern (matches 00054).
-- See docs/service-catalog-redesign.md §5.3–§5.4

update public.roles
set permissions =
  case
    when permissions is null or jsonb_typeof(permissions) <> 'array' then
      '["service_catalog:manage","criteria_sets:manage"]'::jsonb
    else (
      select jsonb_agg(distinct elem)
      from (
        select jsonb_array_elements_text(permissions) as elem
        union
        select unnest(array['service_catalog:manage','criteria_sets:manage'])
      ) t
    )
  end,
  updated_at = now()
where lower(name) = 'admin';

notify pgrst, 'reload schema';
