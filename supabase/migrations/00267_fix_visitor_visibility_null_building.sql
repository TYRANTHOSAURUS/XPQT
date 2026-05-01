-- 00267_fix_visitor_visibility_null_building.sql
-- Visitor management v1 — close Tier 2 admit-all branch for NULL building_id.
--
-- Post-shipping review C4:
--   00259 fixed an empty-scope leak but kept the predicate
--     v.building_id = ANY(rc.location_closure) OR v.building_id IS NULL
--   That OR-clause means a Tier 2 operator (visitors.reception + non-empty
--   location scope) sees EVERY visitor whose building_id is NULL. Visitors
--   with NULL building_id are walk-ups that haven't been assigned a building
--   yet (or rare malformed inserts). They should NOT cross scope just because
--   they have no location — that's exactly the inverse of the intended
--   tightening.
--
-- Fix:
--   Tier 2 now requires v.building_id = ANY(rc.location_closure). NULL
--   building rows are visible only to Tier 1 (the host) and Tier 3
--   (visitors.read_all override). This matches how tickets handle null
--   location: hosts always see, location-scoped operators do NOT.
--
-- Reference shape: 00187_tickets_visible_for_actor.sql, 00259_fix_visitor_visibility_ids.sql.
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.9.

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
  -- Tier 1: hosts (primary or co-host) always see their own visitors,
  --         regardless of building_id.
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
  --         Empty/null location_closure = NO ACCESS (cardinality > 0).
  --         NULL building_id = NO ACCESS (admit-all branch removed in 00267).
  select v.id
    from public.visitors v
   where v.tenant_id = p_tenant_id
     and public.user_has_permission(p_user_id, p_tenant_id, 'visitors.reception')
     and exists (
       select 1
         from role_location_closures rc
        where cardinality(rc.location_closure) > 0
          and v.building_id = any(rc.location_closure)
     )
  union
  -- Tier 3: read-all override. Sees every row regardless of building.
  select v.id
    from public.visitors v
   where v.tenant_id = p_tenant_id
     and public.user_has_permission(p_user_id, p_tenant_id, 'visitors.read_all');
$$;

comment on function public.visitor_visibility_ids(uuid, uuid) is
  '3-tier visitor visibility per docs/visibility.md: '
  'Tier 1 hosts (primary + co-hosts) — always visible regardless of building. '
  'Tier 2 operators (visitors.reception + non-empty location_scope) — only visitors whose building is in the operator''s closure; NULL building_id is NOT admitted (fixed in 00267). '
  'Tier 3 read-all override (visitors.read_all) — every row.';

notify pgrst, 'reload schema';
