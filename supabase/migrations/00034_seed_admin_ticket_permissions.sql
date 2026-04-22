-- 00034_seed_admin_ticket_permissions.sql
-- Idempotent: grant tickets:read_all + tickets:write_all to any role whose name is 'admin'
-- (case-insensitive). Existing permissions arrays are merged, not replaced.

update public.roles
set permissions =
  case
    when permissions is null or jsonb_typeof(permissions) <> 'array' then
      '["tickets:read_all","tickets:write_all"]'::jsonb
    else (
      select jsonb_agg(distinct elem)
      from (
        select jsonb_array_elements_text(permissions) as elem
        union
        select unnest(array['tickets:read_all','tickets:write_all'])
      ) t
    )
  end,
  updated_at = now()
where lower(name) = 'admin';

notify pgrst, 'reload schema';
