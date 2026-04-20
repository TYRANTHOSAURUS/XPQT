-- 00035_vendor_participant_dormant.sql
-- Security hotfix: the vendor-participant clause in 00033 matched any vendor for any
-- vendor-linked person. Phase 4 will formalize the person ↔ vendor link. Until then,
-- the clause returns no rows (truly dormant).

create or replace function public.ticket_visibility_ids(p_user_id uuid, p_tenant_id uuid)
returns setof uuid
language sql stable
as $$
  with
    actor as (
      select u.id as user_id, u.person_id
      from public.users u
      where u.id = p_user_id and u.tenant_id = p_tenant_id
    ),
    team_ids as (
      select tm.team_id
      from public.team_members tm
      where tm.tenant_id = p_tenant_id and tm.user_id = p_user_id
    ),
    role_paths as (
      select
        coalesce(ura.domain_scope, '{}'::text[]) as domain_scope,
        coalesce(ura.location_scope, '{}'::uuid[]) as location_scope
      from public.user_role_assignments ura
      where ura.user_id = p_user_id
        and ura.tenant_id = p_tenant_id
        and ura.active = true
    ),
    role_location_closures as (
      select
        r.domain_scope,
        case
          when array_length(r.location_scope, 1) is null then '{}'::uuid[]
          else (select array_agg(x) from public.expand_space_closure(r.location_scope) x)
        end as location_closure
      from role_paths r
    ),
    base as (
      select t.id, t.requester_person_id, t.assigned_user_id, t.assigned_team_id,
             t.assigned_vendor_id, t.watchers, t.location_id,
             rt.domain
      from public.tickets t
      left join public.request_types rt on rt.id = t.ticket_type_id
      where t.tenant_id = p_tenant_id
    )
  select distinct b.id
  from base b
  cross join actor a
  where
    b.requester_person_id = a.person_id
    or b.assigned_user_id = a.user_id
    or a.person_id = any(b.watchers)
    or b.assigned_team_id in (select team_id from team_ids)
    -- Vendor-participant path is dormant until Phase 4 formalizes person ↔ vendor linking.
    -- The previous version here matched any vendor for any vendor-external person, which
    -- was a cross-vendor leak. To re-enable correctly: join vendors.id to a per-person
    -- vendor_id column once that schema exists, then replace the "false" below.
    or (false and b.assigned_vendor_id is not null)
    or exists (
      select 1 from role_location_closures rc
      where
        (array_length(rc.domain_scope, 1) is null or b.domain = any(rc.domain_scope))
        and (
          array_length(rc.location_closure, 1) is null
          or b.location_id = any(rc.location_closure)
          or b.location_id is null
        )
    );
$$;

notify pgrst, 'reload schema';
