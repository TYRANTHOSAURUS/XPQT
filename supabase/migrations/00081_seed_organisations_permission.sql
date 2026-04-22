-- 00081_seed_organisations_permission.sql
-- Adds organisations:manage to admin roles. Mirrors the pattern in
-- 00054_seed_portal_scope_permissions.sql. Idempotent.
-- See spec §7.

update public.roles
set permissions =
  case
    when permissions is null or jsonb_typeof(permissions) <> 'array' then
      '["organisations:manage"]'::jsonb
    else (
      select jsonb_agg(distinct elem)
      from (
        select jsonb_array_elements_text(permissions) as elem
        union
        select unnest(array['organisations:manage'])
      ) t
    )
  end,
  updated_at = now()
where lower(name) = 'admin'
   or (permissions is not null and permissions ? 'people:manage');

notify pgrst, 'reload schema';
