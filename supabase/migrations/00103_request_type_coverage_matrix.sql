-- 00103_request_type_coverage_matrix.sql
-- Coverage-matrix aggregator for the admin catalog UI (live-doc §8).
-- Per-site effective state: offering source + scope-override winner +
-- request_types defaults in one call so the panel doesn't N+1 the DB.
-- Read-only. Does not touch the resolver; this is a *view* of what the
-- resolver would compute for each site, no side effects.

create or replace function public.request_type_coverage_matrix(
  p_tenant_id uuid,
  p_request_type_id uuid
) returns table (
  site_id uuid,
  site_name text,
  site_type text,
  parent_id uuid,
  offering jsonb,           -- first matched coverage rule for this site, or null
  override jsonb,           -- result of request_type_effective_scope_override, or null
  rt_defaults jsonb         -- { default_team_id, default_vendor_id, workflow_definition_id, sla_policy_id }
) language sql stable as $$
  with rt as (
    select
      rt.id,
      jsonb_build_object(
        'default_team_id', rt.default_team_id,
        'default_vendor_id', rt.default_vendor_id,
        'workflow_definition_id', rt.workflow_definition_id,
        'sla_policy_id', rt.sla_policy_id
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
      select to_jsonb(o)
      from public.request_type_offering_matches(p_request_type_id, s.id, p_tenant_id) o
      order by
        case o.scope_kind
          when 'tenant' then 2
          when 'space_group' then 1
          when 'space' then 0
          else 3
        end,
        o.created_at
      limit 1
    ) as offering,
    public.request_type_effective_scope_override(p_tenant_id, p_request_type_id, s.id) as override,
    rt.defaults as rt_defaults
  from sites s
  cross join rt
  order by s.name;
$$;

notify pgrst, 'reload schema';
