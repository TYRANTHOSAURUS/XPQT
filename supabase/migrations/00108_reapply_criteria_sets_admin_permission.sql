-- 00108_reapply_criteria_sets_admin_permission.sql
-- Re-apply the 00067 seed: grant `criteria_sets:manage` (and its companion
-- `service_catalog:manage`) to the admin role, idempotent merge. The original
-- 00067 was applied locally but appears to have never reached the remote
-- database this repo points at — every /criteria-sets endpoint 403s for users
-- on the admin role, because PermissionGuard can't find the permission key on
-- their role record. This migration is a no-op when the keys are already
-- present; run it against remote whenever admins see 403s on criteria sets.

update public.roles
set permissions = (
      select jsonb_agg(distinct elem)
      from (
        select jsonb_array_elements_text(coalesce(permissions, '[]'::jsonb)) as elem
        union
        select unnest(array['service_catalog:manage','criteria_sets:manage'])
      ) t
    ),
    updated_at = now()
where lower(name) = 'admin';

notify pgrst, 'reload schema';
