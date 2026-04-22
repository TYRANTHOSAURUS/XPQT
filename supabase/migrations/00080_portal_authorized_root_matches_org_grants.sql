-- 00080_portal_authorized_root_matches_org_grants.sql
-- Portal scope: union default + person grants + org-node grants (ancestor-walked).
-- Tie-break in match_authorized_root extended: default > grant > org_grant.
-- See spec §4.

create or replace function public.org_node_ancestors(p_node_id uuid)
returns setof uuid language sql stable as $$
  with recursive walk(id, depth) as (
    select p_node_id, 0
    union all
    select n.parent_id, w.depth + 1
    from public.org_nodes n
    join walk w on n.id = w.id
    where n.parent_id is not null and w.depth < 20
  )
  select id from walk where id is not null;
$$;

create or replace function public.portal_authorized_root_matches(
  p_person_id uuid,
  p_tenant_id uuid
) returns table (root_id uuid, source text, grant_id uuid) language sql stable as $$
  select p.default_location_id, 'default'::text, null::uuid
  from public.persons p
  join public.spaces s on s.id = p.default_location_id
  where p.id = p_person_id and p.tenant_id = p_tenant_id
    and s.active = true

  union all

  select g.space_id, 'grant'::text, g.id
  from public.person_location_grants g
  join public.spaces s on s.id = g.space_id
  where g.person_id = p_person_id and g.tenant_id = p_tenant_id
    and s.active = true

  union all

  select ongl.space_id, 'org_grant'::text, ongl.id
  from public.person_org_memberships pom
  cross join lateral public.org_node_ancestors(pom.org_node_id) as a(node_id)
  join public.org_node_location_grants ongl on ongl.org_node_id = a.node_id
  join public.spaces s on s.id = ongl.space_id
  where pom.person_id = p_person_id
    and pom.tenant_id = p_tenant_id
    and ongl.tenant_id = p_tenant_id
    and s.active = true;
$$;

-- Replace match_authorized_root tie-break: default > grant > org_grant.
create or replace function public.portal_match_authorized_root(
  p_person_id uuid,
  p_effective_space_id uuid,
  p_tenant_id uuid
) returns table (root_id uuid, source text, grant_id uuid) language plpgsql stable as $$
declare
  r record;
  best_root uuid; best_source text; best_grant uuid; best_distance int := null;
  v_selected_active boolean;
  v_distance int;
  -- lower number = higher precedence
  v_r_priority int; v_best_priority int;
begin
  if p_effective_space_id is null then return; end if;

  select active into v_selected_active
  from public.spaces where id = p_effective_space_id and tenant_id = p_tenant_id;
  if v_selected_active is null or v_selected_active = false then return; end if;

  for r in
    select * from public.portal_authorized_root_matches(p_person_id, p_tenant_id)
  loop
    with recursive chain(id, depth) as (
      select p_effective_space_id, 0
      union all
      select s.parent_id, c.depth + 1
      from public.spaces s
      join chain c on s.id = c.id
      where c.depth < 12 and s.parent_id is not null and s.tenant_id = p_tenant_id
    )
    select depth into v_distance from chain where id = r.root_id;

    if v_distance is not null then
      v_r_priority := case r.source
        when 'default'   then 1
        when 'grant'     then 2
        when 'org_grant' then 3
        else 9
      end;
      v_best_priority := case best_source
        when 'default'   then 1
        when 'grant'     then 2
        when 'org_grant' then 3
        else 9
      end;

      if best_distance is null
         or v_distance < best_distance
         or (v_distance = best_distance and v_r_priority < v_best_priority) then
        best_root := r.root_id;
        best_source := r.source;
        best_grant := r.grant_id;
        best_distance := v_distance;
      end if;
    end if;
  end loop;

  if best_root is not null then
    root_id := best_root; source := best_source; grant_id := best_grant;
    return next;
  end if;
end;
$$;
