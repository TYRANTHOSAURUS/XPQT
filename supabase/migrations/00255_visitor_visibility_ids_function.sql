-- 00255_visitor_visibility_ids_function.sql
-- Visitor Management v1 — 3-tier visibility predicate.
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.9, §13.2
-- Reference shape: 00033_ticket_visibility.sql / 00187_tickets_visible_for_actor.sql
--
-- Three tiers (UNION):
--   1. Hosts            — visits where user.person_id is the primary host or
--                         appears in visitor_hosts.
--   2. Operators        — users with permission `visitors.reception` whose
--                         user_role_assignments.location_scope (expanded
--                         through expand_space_closure) covers the visitor's
--                         building_id.
--   3. Read-all override — users with permission `visitors.read_all` see every
--                         visitor in the tenant.
--
-- Permission keys use dot-notation per the catalog SoT (packages/shared/src/permissions.ts).
-- Spec narrative uses colon-form (`visitors:reception`); user_has_permission
-- accepts both for backward compatibility (00109).

create or replace function public.visitor_visibility_ids(p_user_id uuid, p_tenant_id uuid)
  returns setof uuid
  language sql stable security invoker
as $$
  with
    actor as (
      select u.id as user_id, u.person_id
        from public.users u
       where u.id = p_user_id
         and u.tenant_id = p_tenant_id
    ),
    role_paths as (
      select coalesce(ura.location_scope, '{}'::uuid[]) as location_scope
        from public.user_role_assignments ura
       where ura.user_id = p_user_id
         and ura.tenant_id = p_tenant_id
         and ura.active = true
    ),
    role_location_closures as (
      select case
               when array_length(r.location_scope, 1) is null then '{}'::uuid[]
               else (select array_agg(x) from public.expand_space_closure(r.location_scope) x)
             end as location_closure
        from role_paths r
    )
  -- Tier 1: hosts
  select v.id
    from public.visitors v
    cross join actor a
   where v.tenant_id = p_tenant_id
     and (
       v.primary_host_person_id = a.person_id
       or v.host_person_id = a.person_id
       or exists (
         select 1
           from public.visitor_hosts vh
          where vh.visitor_id = v.id
            and vh.person_id = a.person_id
       )
     )
  union
  -- Tier 2: operators with visitors.reception in their location scope
  select v.id
    from public.visitors v
   where v.tenant_id = p_tenant_id
     and public.user_has_permission(p_user_id, p_tenant_id, 'visitors.reception')
     and exists (
       select 1
         from role_location_closures rc
        where array_length(rc.location_closure, 1) is null
           or v.building_id = any(rc.location_closure)
           or v.building_id is null
     )
  union
  -- Tier 3: read-all override
  select v.id
    from public.visitors v
   where v.tenant_id = p_tenant_id
     and public.user_has_permission(p_user_id, p_tenant_id, 'visitors.read_all');
$$;

comment on function public.visitor_visibility_ids(uuid, uuid) is
  '3-tier visitor visibility per docs/visibility.md: Tier 1 hosts (primary + co-hosts), Tier 2 operators (visitors.reception + location_scope), Tier 3 read-all override (visitors.read_all). Used by VisitorService.list as the canonical predicate.';

notify pgrst, 'reload schema';
