-- 00033_ticket_visibility.sql
-- Visibility predicate used by the API and (optionally later) by RLS.
-- Returns the set of ticket ids the given user can READ inside the given tenant.

-- Supporting indexes for the 6 visibility paths.
create index if not exists idx_tickets_requester_tenant on public.tickets (tenant_id, requester_person_id);
create index if not exists idx_tickets_assigned_user_tenant on public.tickets (tenant_id, assigned_user_id);
-- assigned_team_id already indexed in 00011
-- assigned_vendor_id already indexed in 00027
create index if not exists idx_tickets_watchers_gin on public.tickets using gin (watchers);
create index if not exists idx_tickets_tenant_domain_loc on public.tickets (tenant_id, ticket_type_id, location_id);

-- Helper: expand a set of space ids into the closure of all descendant space ids.
-- Uses recursive CTE on spaces.parent_id. Caps depth at 20 for safety.
create or replace function public.expand_space_closure(p_roots uuid[])
returns setof uuid
language sql stable
as $$
  with recursive chain(id, depth) as (
    select unnest(p_roots), 0
    union all
    select s.id, c.depth + 1
    from public.spaces s
    join chain c on s.parent_id = c.id
    where c.depth < 20
  )
  select distinct id from chain;
$$;

-- Main visibility predicate.
-- Takes a user id and tenant id, returns ids of visible tickets.
-- Read-only; no side effects.
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
    or b.assigned_vendor_id in (
      select v.id from public.vendors v
      join public.persons p on p.id = a.person_id
      where v.tenant_id = p_tenant_id and p.external_source = 'vendor'
    )
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

-- Does the user hold the given permission? Checks permissions jsonb across all active roles.
create or replace function public.user_has_permission(p_user_id uuid, p_tenant_id uuid, p_permission text)
returns boolean
language sql stable
as $$
  select exists (
    select 1
    from public.user_role_assignments ura
    join public.roles r on r.id = ura.role_id
    where ura.user_id = p_user_id
      and ura.tenant_id = p_tenant_id
      and ura.active = true
      and r.active = true
      and r.permissions ? p_permission
  );
$$;

notify pgrst, 'reload schema';
