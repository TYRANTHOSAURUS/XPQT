-- 00060_criteria_sets.sql
-- Reusable employee-attribute rules. Bounded-depth grammar (depth ≤ 3).
-- Absent-attribute semantics: eq/in → false, neq/not_in → true.
-- See docs/service-catalog-redesign.md §3.4

create table public.criteria_sets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  expression jsonb not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

alter table public.criteria_sets enable row level security;
create policy "tenant_isolation" on public.criteria_sets
  using (tenant_id = public.current_tenant_id());

create index idx_criteria_sets_tenant on public.criteria_sets (tenant_id);

create trigger set_criteria_sets_updated_at before update on public.criteria_sets
  for each row execute function public.set_updated_at();

-- ── criteria_matches ─────────────────────────────────────────────────────
-- Evaluates an expression against an actor's attributes. Preloads the
-- person row once and walks the bounded-depth expression tree inline.
-- Phase-1 attribute set: type, department, division, cost_center, manager_person_id.
-- is_manager deferred; manager_person_id is referenced only by the built-in
-- direct_reports on-behalf policy (not by criteria expressions in phase 1).

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

  select p.type, p.department, p.division, p.cost_center, p.manager_person_id
    into v_person
  from public.persons p
  where p.id = p_person_id and p.tenant_id = p_tenant_id;

  if v_person is null then return false; end if;

  return public._criteria_eval_node(v_expr, v_person);
end;
$$;

-- Recursive evaluator. Separated so the public function can preload the
-- person row once per call. Bounded-depth enforced by the admin UI; runaway
-- nesting would still terminate (PL/pgSQL default recursion limit).

create or replace function public._criteria_eval_node(
  p_node jsonb,
  p_person record
) returns boolean language plpgsql stable as $$
declare
  v_op text;
  v_children jsonb;
  v_child jsonb;
  v_attr text;
  v_value text;
  v_values jsonb;
  v_actor_value text;
  v_present boolean;
  v_result boolean;
begin
  -- Composite: all_of | any_of | not
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

  -- Leaf: { attr, op, value | values }
  v_attr := p_node->>'attr';
  v_op := p_node->>'op';

  v_actor_value := case v_attr
    when 'type' then p_person.type
    when 'department' then p_person.department
    when 'division' then p_person.division
    when 'cost_center' then p_person.cost_center
    when 'manager_person_id' then p_person.manager_person_id::text
    else null
  end;
  v_present := v_actor_value is not null;

  -- Absent-attribute semantics — explicit per §3.4a:
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

  -- Unknown op → deny (conservative).
  return false;
end;
$$;
