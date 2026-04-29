-- 00192_collapse_role_audit_events.sql
--
-- `role_audit_events` (00111) was effectively a specialized partition of
-- `audit_events` (00019) — same shape (tenant + actor + event_type + entity
-- ref + jsonb payload + created_at), same retention, same audience. The
-- separation cost a duplicate table, separate RLS policy, separate indexes,
-- and one extra place to look when answering "what changed?".
--
-- Rollout strategy — safe two-phase cutover:
--   PHASE 1 (this migration): backfill historical rows into audit_events
--   and add the partial indexes the listing query needs. The TS layer
--   (`UserManagementService.emitAudit` / `listRoleAuditEvents`) writes/reads
--   audit_events from this point on. We DO NOT drop `role_audit_events`
--   here — old API binaries still in flight during a rolling deploy would
--   otherwise crash on writes/reads of a missing table.
--   PHASE 2 (follow-up migration, after every API instance is on the new
--   code): drop `role_audit_events`. The dormant table is a no-op until
--   that follow-up lands.
--
-- The API response shape stays identical (target_role_id / target_user_id /
-- target_assignment_id / payload) by reshaping in the service layer.

begin;

-- 1. Move historical rows into audit_events. We preserve the original `id`
--    so any external references (e.g. log exports) keep matching, and we
--    map event_type → entity_type/_id by inspecting the prefix:
--      role.*       → entity_type='role',                 entity_id=target_role_id
--      assignment.* → entity_type='user_role_assignment', entity_id=target_assignment_id
--    The original target_user_id, target_role_id, target_assignment_id are
--    kept in `details` so the read path can reshape back to the original
--    columns without losing information.
insert into public.audit_events (
  id, tenant_id, event_type, entity_type, entity_id,
  actor_user_id, details, created_at
)
select
  rae.id,
  rae.tenant_id,
  rae.event_type,
  case
    when rae.event_type like 'role.%'       then 'role'
    when rae.event_type like 'assignment.%' then 'user_role_assignment'
    else null
  end as entity_type,
  case
    when rae.event_type like 'role.%'       then rae.target_role_id
    when rae.event_type like 'assignment.%' then rae.target_assignment_id
    else null
  end as entity_id,
  rae.actor_user_id,
  jsonb_build_object(
    'target_role_id',       rae.target_role_id,
    'target_user_id',       rae.target_user_id,
    'target_assignment_id', rae.target_assignment_id
  ) || coalesce(rae.payload, '{}'::jsonb) as details,
  rae.created_at
from public.role_audit_events rae
on conflict (id) do nothing;

-- 2. Indexes to keep the listing query fast against the consolidated table.
--    `details->>'target_role_id'` and `details->>'target_user_id'` are the
--    two filter shapes used by `UserManagementService.listRoleAuditEvents`.
--    Multi-column with `created_at desc` so the planner can serve
--    "filter by target + sort by created_at desc + limit N" without a
--    separate sort step — same query shape the old role_audit_events
--    dedicated indexes (00111) supported. Partial on the role/assignment
--    event_type prefixes keeps the indexes scoped to the ~5% of audit
--    rows that are role/assignment events.
create index if not exists audit_events_role_target_role_idx
  on public.audit_events ((details->>'target_role_id'), created_at desc)
  where event_type like 'role.%' or event_type like 'assignment.%';

create index if not exists audit_events_role_target_user_idx
  on public.audit_events ((details->>'target_user_id'), created_at desc)
  where event_type like 'role.%' or event_type like 'assignment.%';

commit;

notify pgrst, 'reload schema';
