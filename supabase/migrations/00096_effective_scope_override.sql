-- 00095_effective_scope_override.sql
-- Phase G / scope-override resolver integration (2026-04-23).
-- Shared precedence resolver for request_type_scope_overrides per live-doc
-- §6.3: exact_space > ancestor_space (inherit) > space_group > tenant.
-- Used by the case-owner resolver (handler_kind), TicketService (workflow +
-- case SLA), DispatchService (executor SLA), and RoutingEvaluatorService
-- (case/child policy entity ids). Single source of truth so the four call
-- sites cannot drift.

create or replace function public.request_type_effective_scope_override(
  p_tenant_id uuid,
  p_request_type_id uuid,
  p_selected_space_id uuid
) returns jsonb language plpgsql stable as $$
declare
  v_hit record;
begin
  with recursive ancestors(id, depth) as (
    select p_selected_space_id, 0
    where p_selected_space_id is not null
    union all
    select s.parent_id, a.depth + 1
    from public.spaces s
    join ancestors a on s.id = a.id
    where a.depth < 20 and s.parent_id is not null and s.tenant_id = p_tenant_id
  ),
  ancestor_ids as (select id, depth from ancestors where id is not null),
  candidates as (
    -- exact space match (depth 0 always wins over inherited)
    select o.*, 'exact_space'::text as precedence, 0 as depth
    from public.request_type_scope_overrides o
    where o.tenant_id = p_tenant_id
      and o.request_type_id = p_request_type_id
      and o.active = true
      and (o.starts_at is null or o.starts_at <= now())
      and (o.ends_at   is null or o.ends_at   >  now())
      and o.scope_kind = 'space'
      and p_selected_space_id is not null
      and o.space_id = p_selected_space_id

    union all

    -- ancestor space match with inherit_to_descendants
    select o.*, 'ancestor_space'::text as precedence, a.depth
    from public.request_type_scope_overrides o
    join ancestor_ids a on a.id = o.space_id
    where o.tenant_id = p_tenant_id
      and o.request_type_id = p_request_type_id
      and o.active = true
      and (o.starts_at is null or o.starts_at <= now())
      and (o.ends_at   is null or o.ends_at   >  now())
      and o.scope_kind = 'space'
      and o.inherit_to_descendants = true
      and a.depth > 0

    union all

    -- space group match
    select o.*, 'space_group'::text as precedence, 100 as depth
    from public.request_type_scope_overrides o
    join public.space_group_members m on m.space_group_id = o.space_group_id
    where o.tenant_id = p_tenant_id
      and o.request_type_id = p_request_type_id
      and o.active = true
      and (o.starts_at is null or o.starts_at <= now())
      and (o.ends_at   is null or o.ends_at   >  now())
      and o.scope_kind = 'space_group'
      and p_selected_space_id is not null
      and m.space_id = p_selected_space_id

    union all

    -- tenant scope
    select o.*, 'tenant'::text as precedence, 200 as depth
    from public.request_type_scope_overrides o
    where o.tenant_id = p_tenant_id
      and o.request_type_id = p_request_type_id
      and o.active = true
      and (o.starts_at is null or o.starts_at <= now())
      and (o.ends_at   is null or o.ends_at   >  now())
      and o.scope_kind = 'tenant'
  )
  select
    c.id, c.scope_kind, c.space_id, c.space_group_id,
    c.inherit_to_descendants, c.starts_at, c.ends_at,
    c.handler_kind, c.handler_team_id, c.handler_vendor_id,
    c.workflow_definition_id, c.case_sla_policy_id,
    c.case_owner_policy_entity_id, c.child_dispatch_policy_entity_id,
    c.executor_sla_policy_id,
    c.precedence
  into v_hit
  from candidates c
  order by
    case c.precedence
      when 'exact_space' then 0
      when 'ancestor_space' then 1
      when 'space_group' then 2
      when 'tenant' then 3
    end,
    c.depth asc,
    c.id asc
  limit 1;

  if v_hit.id is null then return null; end if;

  return jsonb_build_object(
    'id', v_hit.id,
    'scope_kind', v_hit.scope_kind,
    'space_id', v_hit.space_id,
    'space_group_id', v_hit.space_group_id,
    'inherit_to_descendants', v_hit.inherit_to_descendants,
    'starts_at', v_hit.starts_at,
    'ends_at', v_hit.ends_at,
    'handler_kind', v_hit.handler_kind,
    'handler_team_id', v_hit.handler_team_id,
    'handler_vendor_id', v_hit.handler_vendor_id,
    'workflow_definition_id', v_hit.workflow_definition_id,
    'case_sla_policy_id', v_hit.case_sla_policy_id,
    'case_owner_policy_entity_id', v_hit.case_owner_policy_entity_id,
    'child_dispatch_policy_entity_id', v_hit.child_dispatch_policy_entity_id,
    'executor_sla_policy_id', v_hit.executor_sla_policy_id,
    'precedence', v_hit.precedence
  );
end;
$$;

notify pgrst, 'reload schema';
