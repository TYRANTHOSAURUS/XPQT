-- 00195_setup_routing_hardening.sql
-- Self-review hardening on 00194:
--
--   1. Drop the EXECUTE grant to `authenticated`. The function takes
--      p_tenant_id as a parameter and is SECURITY DEFINER — anyone calling
--      it could pass any tenant_id and read that tenant's routing config.
--      No code path needs PostgREST/authenticated access today; it's
--      called from supabase.admin (service_role) only. Forward-compat the
--      grant when there's a real consumer that needs it (and add a
--      session-tenant check at that point).
--
--   2. Add a depth limit to the recursive CTE in resolve_setup_routing.
--      Defensive: if spaces.parent_id ever forms a cycle (data corruption,
--      manual fix gone wrong), the recursion currently loops without
--      termination. Postgres has internal recursion limits but they're
--      stack-blowing protection, not a clean error. Capping at 50 is
--      orders of magnitude beyond the deepest realistic location tree
--      (continent → country → city → site → building → floor → room).

revoke execute on function public.resolve_setup_routing(uuid, uuid, text)
  from authenticated;

create or replace function public.resolve_setup_routing(
  p_tenant_id uuid,
  p_location_id uuid,
  p_service_category text
) returns table (
  internal_team_id uuid,
  default_lead_time_minutes int,
  sla_policy_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
  with recursive location_chain as (
    select s.id, s.parent_id, 0 as depth
    from public.spaces s
    where s.id = p_location_id
      and s.tenant_id = p_tenant_id
    union all
    select s.id, s.parent_id, lc.depth + 1
    from public.spaces s
    join location_chain lc on lc.parent_id = s.id
    where s.tenant_id = p_tenant_id
      and lc.depth < 50
  ),
  matched as (
    select
      lsr.internal_team_id,
      lsr.default_lead_time_minutes,
      lsr.sla_policy_id,
      lc.depth as match_rank
    from public.location_service_routing lsr
    join location_chain lc on lc.id = lsr.location_id
    where lsr.tenant_id = p_tenant_id
      and lsr.service_category = p_service_category
      and lsr.active = true
    union all
    select
      lsr.internal_team_id,
      lsr.default_lead_time_minutes,
      lsr.sla_policy_id,
      1000000 as match_rank
    from public.location_service_routing lsr
    where lsr.tenant_id = p_tenant_id
      and lsr.location_id is null
      and lsr.service_category = p_service_category
      and lsr.active = true
  )
  select internal_team_id, default_lead_time_minutes, sla_policy_id
  from matched
  order by match_rank asc
  limit 1;
$$;

notify pgrst, 'reload schema';
