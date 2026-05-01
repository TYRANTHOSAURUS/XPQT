-- 00106_request_type_routing_chain_handler.sql
-- Admin coverage-matrix helper: for a given (tenant, request_type, space)
-- compute the deterministic portion of the resolver's handler answer —
-- the location-teams chain + space-group fallback + domain-parent fallback.
-- Routing rules are NOT evaluated here because they depend on requester
-- attributes (actor, assets, on-behalf) that the matrix has no way to know.
-- Callers should label the return value accordingly: "routing rules could
-- still override this at runtime".
--
-- Resolution order mirrors ResolverService + ResolverRepository:
--   1. walk the space ancestor chain (including the site itself)
--   2. for each ancestor, try every domain in the domain_parents chain
--      (domain → parent → grandparent…)
--   3. check location_teams(space_id, domain) and space_group_teams
--   4. closest-ancestor + closest-domain wins
-- No hit → NULL; the caller falls back to request_types defaults, then
-- unassigned.

create or replace function public.request_type_routing_chain_handler(
  p_tenant_id uuid,
  p_request_type_id uuid,
  p_space_id uuid
) returns jsonb language plpgsql stable as $$
declare
  v_domain text;
  v_hit record;
begin
  if p_space_id is null then return null; end if;

  select domain into v_domain
  from public.request_types
  where id = p_request_type_id and tenant_id = p_tenant_id;

  if v_domain is null then return null; end if;

  with recursive ancestors(id, depth) as (
    select p_space_id, 0
    union all
    select s.parent_id, a.depth + 1
    from public.spaces s
    join ancestors a on s.id = a.id
    where a.depth < 20
      and s.parent_id is not null
      and s.tenant_id = p_tenant_id
  ),
  ancestor_ids as (select id, depth from ancestors where id is not null),
  domains(domain, depth) as (
    select v_domain, 0
    union all
    select dp.parent_domain, d.depth + 1
    from public.domain_parents dp
    join domains d on dp.domain = d.domain
    where dp.tenant_id = p_tenant_id and d.depth < 10
  ),
  space_hits as (
    -- location_teams anchored directly on an ancestor space
    select lt.team_id, lt.vendor_id, 'location_team'::text as source,
           a.depth as space_depth, d.depth as domain_depth
    from public.location_teams lt
    join ancestor_ids a on a.id = lt.space_id
    join domains d on d.domain = lt.domain
    where lt.tenant_id = p_tenant_id
  ),
  group_hits as (
    -- location_teams anchored on a space_group that contains an ancestor
    select lt.team_id, lt.vendor_id, 'space_group_team'::text as source,
           a.depth + 1 as space_depth, d.depth as domain_depth
    from public.space_group_members m
    join ancestor_ids a on a.id = m.space_id
    join public.location_teams lt on lt.space_group_id = m.space_group_id
    join domains d on d.domain = lt.domain
    where m.tenant_id = p_tenant_id and lt.tenant_id = p_tenant_id
  ),
  all_hits as (
    select * from space_hits
    union all
    select * from group_hits
  )
  select team_id, vendor_id, source, space_depth, domain_depth
    into v_hit
  from all_hits
  order by space_depth asc, domain_depth asc
  limit 1;

  if v_hit.team_id is not null then
    return jsonb_build_object(
      'kind', 'team',
      'id', v_hit.team_id,
      'source', v_hit.source,
      'space_depth', v_hit.space_depth,
      'domain_depth', v_hit.domain_depth
    );
  end if;
  if v_hit.vendor_id is not null then
    return jsonb_build_object(
      'kind', 'vendor',
      'id', v_hit.vendor_id,
      'source', v_hit.source,
      'space_depth', v_hit.space_depth,
      'domain_depth', v_hit.domain_depth
    );
  end if;
  return null;
end;
$$;

-- Extend request_type_coverage_matrix so each site row carries the routing
-- chain answer alongside the override + defaults. The backend composer can
-- then present a real team/vendor to the admin instead of a bare
-- "routing chain" placeholder.
--
-- The 7-col version was created in 00103. Postgres rejects CREATE OR REPLACE
-- when the return type changes (routing_chain column added) with SQLSTATE
-- 42P13, so we drop the prior signature first. On remote this is a no-op
-- net change (function is already in 8-col shape); locally / in CI it's the
-- only way `db:reset` from scratch can cross this migration.
drop function if exists public.request_type_coverage_matrix(uuid, uuid);

create or replace function public.request_type_coverage_matrix(
  p_tenant_id uuid,
  p_request_type_id uuid
) returns table (
  site_id uuid,
  site_name text,
  site_type text,
  parent_id uuid,
  offering jsonb,
  override jsonb,
  routing_chain jsonb,
  rt_defaults jsonb
) language sql stable as $$
  with rt as (
    select
      rt.id,
      jsonb_build_object(
        'default_team_id', rt.default_team_id,
        'default_vendor_id', rt.default_vendor_id,
        'workflow_definition_id', rt.workflow_definition_id,
        'sla_policy_id', rt.sla_policy_id,
        'case_owner_policy_entity_id', rt.case_owner_policy_entity_id,
        'child_dispatch_policy_entity_id', rt.child_dispatch_policy_entity_id
      ) as defaults
    from public.request_types rt
    where rt.tenant_id = p_tenant_id and rt.id = p_request_type_id
  ),
  sites as (
    select s.id, s.name, s.type, s.parent_id
    from public.spaces s
    where s.tenant_id = p_tenant_id
      and s.type in ('site', 'building')
      and coalesce(s.active, true) = true
  )
  select
    s.id,
    s.name,
    s.type,
    s.parent_id,
    (
      -- Most-specific offering rule: exact-space > inherited-ancestor >
      -- space-group > tenant-wide. Older rules break ties within the tier.
      select to_jsonb(o)
      from public.request_type_offering_matches(p_request_type_id, s.id, p_tenant_id) o
      order by
        case
          when o.scope_kind = 'space' and o.space_id = s.id then 0
          when o.scope_kind = 'space' then 1
          when o.scope_kind = 'space_group' then 2
          when o.scope_kind = 'tenant' then 3
          else 4
        end,
        o.created_at
      limit 1
    ) as offering,
    public.request_type_effective_scope_override(p_tenant_id, p_request_type_id, s.id) as override,
    public.request_type_routing_chain_handler(p_tenant_id, p_request_type_id, s.id) as routing_chain,
    rt.defaults as rt_defaults
  from sites s
  cross join rt
  order by s.name;
$$;

notify pgrst, 'reload schema';
