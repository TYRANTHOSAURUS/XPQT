-- 00054_seed_portal_scope_permissions.sql
-- Portal scope slice: seed admin-role permissions for the new management endpoints.
-- Idempotent (merges; does not replace).

update public.roles
set permissions =
  case
    when permissions is null or jsonb_typeof(permissions) <> 'array' then
      '["people:manage","request_types:manage","routing_studio:access"]'::jsonb
    else (
      select jsonb_agg(distinct elem)
      from (
        select jsonb_array_elements_text(permissions) as elem
        union
        select unnest(array['people:manage','request_types:manage','routing_studio:access'])
      ) t
    )
  end,
  updated_at = now()
where lower(name) = 'admin';

notify pgrst, 'reload schema';
