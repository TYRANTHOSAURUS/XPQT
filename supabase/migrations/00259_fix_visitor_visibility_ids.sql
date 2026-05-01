-- 00259_fix_visitor_visibility_ids.sql
-- Visitor Management v1 — fix Tier 2 empty-scope leak in visitor_visibility_ids.
--
-- Bug fixed:
--   In 00255 the Tier 2 (operators with `visitors.reception`) branch used
--     array_length(rc.location_closure, 1) is null
--       or v.building_id = any(rc.location_closure)
--       or v.building_id is null
--   array_length on an empty array returns NULL, so a user holding
--   `visitors.reception` with NULL or `'{}'::uuid[]` location_scope was
--   matching the first disjunct and seeing every visitor in the tenant —
--   effectively a Tier 3 (`visitors.read_all`) escalation without the
--   permission.
--
-- Fix:
--   Treat empty/null location_closure as NO ACCESS (Tier 2 returns no rows
--   for users without a real location scope). Use cardinality(...) > 0 — it
--   returns 0, not NULL, on an empty array, so the predicate is unambiguous.
--   The `OR v.building_id IS NULL` clause is preserved (matches tickets'
--   00033 behaviour: location-less rows are visible to anyone with an
--   in-scope role).
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.9
-- Reference shape: 00033_ticket_visibility.sql

drop function if exists public.visitor_visibility_ids(uuid, uuid);

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
  -- Tier 2: operators with visitors.reception in their location scope.
  -- Empty/null location_closure = NO ACCESS (cardinality > 0 guard).
  select v.id
    from public.visitors v
   where v.tenant_id = p_tenant_id
     and public.user_has_permission(p_user_id, p_tenant_id, 'visitors.reception')
     and exists (
       select 1
         from role_location_closures rc
        where cardinality(rc.location_closure) > 0
          and (
            v.building_id = any(rc.location_closure)
            or v.building_id is null
          )
     )
  union
  -- Tier 3: read-all override
  select v.id
    from public.visitors v
   where v.tenant_id = p_tenant_id
     and public.user_has_permission(p_user_id, p_tenant_id, 'visitors.read_all');
$$;

comment on function public.visitor_visibility_ids(uuid, uuid) is
  '3-tier visitor visibility per docs/visibility.md: Tier 1 hosts (primary + co-hosts), Tier 2 operators (visitors.reception + non-empty location_scope), Tier 3 read-all override (visitors.read_all). Empty/null location_scope yields zero Tier 2 rows (fixed in 00259). Used by VisitorService.list as the canonical predicate.';

notify pgrst, 'reload schema';
