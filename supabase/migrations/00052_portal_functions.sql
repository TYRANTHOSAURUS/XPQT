-- 00052_portal_functions.sql
-- Portal scope slice: seven SQL primitives for portal availability.
-- Single source of truth for submit validation + simulator.
-- See docs/portal-scope-slice.md §4

-- ── 4.1 Authorized roots with provenance ────────────────────────────────────
-- Inactive roots excluded BEFORE closure expansion.
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
    and s.active = true;
$$;

-- ── 4.2 All authorized space ids (root + descendants, active + tenant-matched) ──
create or replace function public.portal_authorized_space_ids(
  p_person_id uuid,
  p_tenant_id uuid
) returns setof uuid language sql stable as $$
  with active_roots as (
    select root_id from public.portal_authorized_root_matches(p_person_id, p_tenant_id)
  ),
  expanded as (
    select * from public.expand_space_closure(array(select root_id from active_roots))
  )
  select e.id
  from expanded e(id)
  join public.spaces s on s.id = e.id
  where s.tenant_id = p_tenant_id
    and s.active = true;
$$;

-- ── 4.3 Match the scope root that contains the selected space ───────────────
-- Deterministic: most-specific (shortest walk) wins; default wins ties.
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
      if best_distance is null
         or v_distance < best_distance
         or (v_distance = best_distance and r.source = 'default' and best_source <> 'default') then
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

-- ── 4.4 Granularity check (ancestor walk; null-safe; tenant-scoped) ─────────
create or replace function public.portal_submit_location_valid(
  p_effective_space_id uuid,
  p_granularity text,
  p_tenant_id uuid
) returns boolean language plpgsql stable as $$
declare v_found boolean;
begin
  if p_effective_space_id is null then
    return p_granularity is null;
  end if;

  if not exists (
    select 1 from public.spaces
    where id = p_effective_space_id and tenant_id = p_tenant_id and active = true
  ) then
    return false;
  end if;

  if p_granularity is null then
    return true;
  end if;

  with recursive chain(id, type, depth) as (
    select s.id, s.type, 0
    from public.spaces s
    where s.id = p_effective_space_id and s.tenant_id = p_tenant_id and s.active = true
    union all
    select s.id, s.type, c.depth + 1
    from public.spaces s
    join chain c on s.id = (select parent_id from public.spaces where id = c.id)
    where c.depth < 12 and s.tenant_id = p_tenant_id and s.active = true
  )
  select exists (select 1 from chain where type = p_granularity) into v_found;

  return coalesce(v_found, false);
end;
$$;

-- ── 4.5 Dead-end filter: root has any descendant of the required type ───────
create or replace function public.portal_request_type_has_eligible_descendant(
  p_root_id uuid,
  p_granularity text,
  p_tenant_id uuid
) returns boolean language sql stable as $$
  select case
    when p_granularity is null then true
    when p_root_id is null then false
    else exists (
      select 1
      from public.expand_space_closure(array[p_root_id]) x(id)
      join public.spaces s on s.id = x.id
      where s.tenant_id = p_tenant_id
        and s.active = true
        and s.type = p_granularity
    )
  end;
$$;

-- ── 4.6 Visible request types at a given selected location ─────────────────
create or replace function public.portal_visible_request_type_ids(
  p_person_id uuid,
  p_effective_space_id uuid,
  p_tenant_id uuid
) returns setof uuid language plpgsql stable as $$
declare v_root_id uuid; v_has_scope boolean;
begin
  v_has_scope := exists (
    select 1 from public.portal_authorized_root_matches(p_person_id, p_tenant_id)
  );
  if not v_has_scope then return; end if;

  if p_effective_space_id is null then
    return query
      select rt.id
      from public.request_types rt
      where rt.tenant_id = p_tenant_id
        and rt.active = true
        and coalesce(rt.location_required, false) = false
        and rt.location_granularity is null;
    return;
  end if;

  select root_id into v_root_id
  from public.portal_match_authorized_root(p_person_id, p_effective_space_id, p_tenant_id);
  if v_root_id is null then return; end if;

  return query
    select rt.id
    from public.request_types rt
    where rt.tenant_id = p_tenant_id
      and rt.active = true
      and public.portal_request_type_has_eligible_descendant(v_root_id, rt.location_granularity, p_tenant_id);
end;
$$;

-- ── 4.7 Full availability trace (single source of truth) ────────────────────
-- Always returns all fields. p_effective_space_id is the location used for
-- validation (user-picked or asset-resolved). Intake's selected_location_id is
-- a separate concern populated only from user-picked values.
create or replace function public.portal_availability_trace(
  p_person_id uuid,
  p_effective_space_id uuid,
  p_request_type_id uuid,
  p_tenant_id uuid
) returns jsonb language plpgsql stable as $$
declare
  v_root_id uuid; v_root_source text; v_grant_id uuid;
  v_location_required boolean; v_granularity text;
  v_authorized boolean; v_visible boolean; v_granularity_ok boolean;
  v_has_scope boolean; v_failure text; v_overall boolean;
  v_rt_exists boolean := false;
begin
  v_has_scope := exists (
    select 1 from public.portal_authorized_root_matches(p_person_id, p_tenant_id)
  );

  select location_required, location_granularity, true
    into v_location_required, v_granularity, v_rt_exists
  from public.request_types
  where id = p_request_type_id and tenant_id = p_tenant_id;
  v_rt_exists := coalesce(v_rt_exists, false);

  if not v_rt_exists then
    return jsonb_build_object(
      'authorized', false, 'has_any_scope', v_has_scope,
      'effective_location_id', p_effective_space_id,
      'matched_root_id', null, 'matched_root_source', null, 'grant_id', null,
      'visible', false,
      'location_required', false, 'granularity', null, 'granularity_ok', false,
      'overall_valid', false,
      'failure_reason', 'request type not found'
    );
  end if;

  if not v_has_scope then
    v_authorized := false;
    v_root_id := null; v_root_source := null; v_grant_id := null;
  elsif p_effective_space_id is null then
    v_authorized := true;
    v_root_id := null; v_root_source := null; v_grant_id := null;
  else
    select root_id, source, grant_id into v_root_id, v_root_source, v_grant_id
    from public.portal_match_authorized_root(p_person_id, p_effective_space_id, p_tenant_id);
    v_authorized := v_root_id is not null;
  end if;

  v_visible := exists (
    select 1 from public.portal_visible_request_type_ids(p_person_id, p_effective_space_id, p_tenant_id) x(id)
    where x.id = p_request_type_id
  );

  if coalesce(v_location_required, false) and p_effective_space_id is null then
    v_granularity_ok := false;
  else
    v_granularity_ok := public.portal_submit_location_valid(p_effective_space_id, v_granularity, p_tenant_id);
  end if;

  v_overall := v_has_scope and v_authorized and v_visible and v_granularity_ok;

  v_failure := case
    when not v_has_scope                                         then 'no authorized scope — contact your admin to set your work location'
    when not v_authorized                                        then 'selected location is not in the requester''s authorized scope'
    when not v_visible and p_effective_space_id is null          then 'this request type requires a location'
    when not v_visible                                           then 'request type is not available at the selected location'
    when not v_granularity_ok and p_effective_space_id is null   then 'this request type requires a location'
    when not v_granularity_ok                                    then format('selected location does not satisfy required depth (%s)', v_granularity)
    else null
  end;

  return jsonb_build_object(
    'authorized', v_authorized,
    'has_any_scope', v_has_scope,
    'effective_location_id', p_effective_space_id,
    'matched_root_id', v_root_id,
    'matched_root_source', v_root_source,
    'grant_id', v_grant_id,
    'visible', v_visible,
    'location_required', coalesce(v_location_required, false),
    'granularity', v_granularity,
    'granularity_ok', v_granularity_ok,
    'overall_valid', v_overall,
    'failure_reason', v_failure
  );
end;
$$;
