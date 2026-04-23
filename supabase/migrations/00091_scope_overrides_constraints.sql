-- 00091_scope_overrides_constraints.sql
-- Phase A / service-catalog collapse (2026-04-23) — codex review fix.
-- 00090 shipped with three gaps on request_type_scope_overrides:
--   1. handler_kind accepted 'user' but there's no handler_user_id column.
--   2. The CHECK let rows slip through with handler_kind IS NULL and a
--      populated handler_team_id/handler_vendor_id (semantically contradictory).
--   3. Nothing prevented two active rows for the same request_type + scope
--      (live-doc §6.3 assumes a single effective override per scope) and
--      nothing required at least one override field to be set.
-- This migration tightens all three. request_type_scope_overrides is empty
-- today (net-new table from 00090) so the ALTER is safe.

alter table public.request_type_scope_overrides
  drop constraint if exists request_type_scope_overrides_handler_kind_check;

alter table public.request_type_scope_overrides
  drop constraint if exists request_type_scope_overrides_check1;
alter table public.request_type_scope_overrides
  drop constraint if exists request_type_scope_overrides_check2;
alter table public.request_type_scope_overrides
  drop constraint if exists request_type_scope_overrides_check;

-- handler_kind: drop 'user' (live-doc §5.5 defines team/vendor/none only).
alter table public.request_type_scope_overrides
  add constraint request_type_scope_overrides_handler_kind_check
  check (handler_kind is null or handler_kind in ('team','vendor','none'));

-- Re-add the scope XOR check that 00090 defined anonymously (we dropped it above).
alter table public.request_type_scope_overrides
  add constraint request_type_scope_overrides_scope_xor_check
  check (
    (scope_kind = 'tenant'       and space_id is null and space_group_id is null) or
    (scope_kind = 'space'        and space_id is not null and space_group_id is null) or
    (scope_kind = 'space_group'  and space_id is null and space_group_id is not null)
  );

-- Re-add the temporal sanity check.
alter table public.request_type_scope_overrides
  add constraint request_type_scope_overrides_time_sanity_check
  check (starts_at is null or ends_at is null or starts_at < ends_at);

-- Handler columns are internally consistent: a handler_kind value requires the
-- matching column to be set (and only that one); null handler_kind requires
-- both columns null.
alter table public.request_type_scope_overrides
  add constraint request_type_scope_overrides_handler_shape_check
  check (
    (handler_kind is null     and handler_team_id is null and handler_vendor_id is null) or
    (handler_kind = 'none'    and handler_team_id is null and handler_vendor_id is null) or
    (handler_kind = 'team'    and handler_team_id is not null and handler_vendor_id is null) or
    (handler_kind = 'vendor'  and handler_vendor_id is not null and handler_team_id is null)
  );

-- A row must set at least one override. No-op rows (all override fields null)
-- are disallowed. 'none' counts as a handler override (explicitly unassigns).
alter table public.request_type_scope_overrides
  add constraint request_type_scope_overrides_nonempty_check
  check (
    handler_kind is not null
    or workflow_definition_id is not null
    or case_sla_policy_id is not null
    or case_owner_policy_entity_id is not null
    or child_dispatch_policy_entity_id is not null
    or executor_sla_policy_id is not null
  );

-- One active override per (request_type, scope, scope-target). The resolver
-- in live-doc §6.3 assumes a single match; deactivate or delete the prior row
-- before creating a replacement. Scheduled overrides (starts_at in the future)
-- that do not overlap are not prevented here because they're typically
-- tenant-scoped outage banners, not handler reassignments. Time-range overlap
-- detection is left to the service layer.
create unique index uniq_rt_override_active_tenant
  on public.request_type_scope_overrides (request_type_id)
  where active = true and scope_kind = 'tenant';

create unique index uniq_rt_override_active_space
  on public.request_type_scope_overrides (request_type_id, space_id)
  where active = true and scope_kind = 'space';

create unique index uniq_rt_override_active_group
  on public.request_type_scope_overrides (request_type_id, space_group_id)
  where active = true and scope_kind = 'space_group';

notify pgrst, 'reload schema';
