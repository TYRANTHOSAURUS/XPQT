-- 00099_criteria_sets_org_support.sql
-- The live criteria evaluator still referenced persons.department/division even
-- though 00079 dropped those columns and made org membership the source of
-- truth. Replace it with an org-aware evaluator so request-type audience and
-- on-behalf rules can safely use org-based targeting in local/demo seeds.

create or replace function public.criteria_matches(
  p_set_id uuid,
  p_person_id uuid,
  p_tenant_id uuid
) returns boolean language plpgsql stable as $$
declare
  v_expr jsonb;
  v_person record;
begin
  select expression into v_expr
  from public.criteria_sets
  where id = p_set_id and tenant_id = p_tenant_id and active = true;

  if v_expr is null then return false; end if;

  with primary_org as (
    select o.id, o.code, o.name
    from public.person_org_memberships pom
    join public.org_nodes o on o.id = pom.org_node_id
    where pom.person_id = p_person_id
      and pom.tenant_id = p_tenant_id
      and pom.is_primary = true
    limit 1
  )
  select
    p.type,
    p.cost_center,
    p.manager_person_id,
    po.id   as primary_org_node_id,
    po.code as primary_org_node_code,
    po.name as primary_org_node_name
    into v_person
  from public.persons p
  left join primary_org po on true
  where p.id = p_person_id and p.tenant_id = p_tenant_id;

  if v_person is null then return false; end if;

  return public._criteria_eval_node(v_expr, v_person);
end
$$;

create or replace function public._criteria_eval_node(
  p_node jsonb,
  p_person record
) returns boolean language plpgsql stable as $$
declare
  v_op text;
  v_children jsonb;
  v_child jsonb;
  v_attr text;
  v_values jsonb;
  v_actor_value text;
  v_present boolean;
begin
  if p_node ? 'all_of' then
    v_children := p_node->'all_of';
    for v_child in select * from jsonb_array_elements(v_children) loop
      if not public._criteria_eval_node(v_child, p_person) then return false; end if;
    end loop;
    return true;
  end if;

  if p_node ? 'any_of' then
    v_children := p_node->'any_of';
    for v_child in select * from jsonb_array_elements(v_children) loop
      if public._criteria_eval_node(v_child, p_person) then return true; end if;
    end loop;
    return false;
  end if;

  if p_node ? 'not' then
    return not public._criteria_eval_node(p_node->'not', p_person);
  end if;

  v_attr := p_node->>'attr';
  v_op := p_node->>'op';

  v_actor_value := case v_attr
    when 'type' then p_person.type
    when 'cost_center' then p_person.cost_center
    when 'manager_person_id' then p_person.manager_person_id::text
    when 'org_node_id' then p_person.primary_org_node_id::text
    when 'org_node_code' then p_person.primary_org_node_code
    when 'org_node_name' then p_person.primary_org_node_name
    else null
  end;
  v_present := v_actor_value is not null;

  if not v_present then
    return v_op in ('neq','not_in');
  end if;

  if v_op = 'eq' then
    return v_actor_value = (p_node->>'value');
  elsif v_op = 'neq' then
    return v_actor_value <> (p_node->>'value');
  elsif v_op = 'in' then
    v_values := p_node->'values';
    return exists (
      select 1 from jsonb_array_elements_text(v_values) x where x = v_actor_value
    );
  elsif v_op = 'not_in' then
    v_values := p_node->'values';
    return not exists (
      select 1 from jsonb_array_elements_text(v_values) x where x = v_actor_value
    );
  end if;

  return false;
end
$$;

notify pgrst, 'reload schema';
