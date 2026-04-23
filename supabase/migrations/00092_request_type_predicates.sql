-- 00092_request_type_predicates.sql
-- Phase B / service-catalog collapse (2026-04-23).
-- Four request-type-native predicates. They answer directly off request_type_*
-- tables (no bridge, no service_items). Ship alongside the service-item-backed
-- set so every current caller keeps working; phase C rewires callers, phase E
-- drops the legacy predicates.
-- See docs/service-catalog-live.md §6 and plan §Phase B.

-- ── B.1 request_type_offering_matches ─────────────────────────────────────
-- Returns every active coverage rule on (request_type, selected_space). Used
-- by the trace to populate matched_coverage_rule_id. Mirrors the shape of the
-- service-item predecessor so consumers can swap 1:1.
create or replace function public.request_type_offering_matches(
  p_request_type_id uuid,
  p_selected_space_id uuid,
  p_tenant_id uuid
) returns table (
  id uuid,
  scope_kind text,
  space_id uuid,
  space_group_id uuid,
  created_at timestamptz
) language sql stable as $$
  select c.id, c.scope_kind, c.space_id, c.space_group_id, c.created_at
  from public.request_type_coverage_rules c
  where c.tenant_id = p_tenant_id
    and c.request_type_id = p_request_type_id
    and c.active = true
    and (c.starts_at is null or c.starts_at <= now())
    and (c.ends_at   is null or c.ends_at   >  now())
    and (
      c.scope_kind = 'tenant'
      or (
        c.scope_kind = 'space'
        and p_selected_space_id is not null
        and (
          (c.inherit_to_descendants = true
            and p_selected_space_id in (
              select * from public.expand_space_closure(array[c.space_id])
            ))
          or (c.inherit_to_descendants = false and c.space_id = p_selected_space_id)
        )
      )
      or (
        c.scope_kind = 'space_group'
        and p_selected_space_id is not null
        and exists (
          select 1 from public.space_group_members m
          where m.space_group_id = c.space_group_id
            and m.space_id = p_selected_space_id
        )
      )
    );
$$;

-- ── B.2 request_type_visible_ids ──────────────────────────────────────────
-- Live-doc §6.1. visible(rt, actor, selected_location) is true iff:
--   1. rt is active
--   2. a coverage rule matches the selected location
--   3. no visible_deny audience rule matches actor
--   4. either no visible_allow rule exists, or actor matches one
-- Scope authorization (portal_authorized_root_matches) is the trace's concern,
-- not this predicate's, matching the service-item-backed counterpart's split.
create or replace function public.request_type_visible_ids(
  p_actor_person_id uuid,
  p_selected_space_id uuid,
  p_tenant_id uuid
) returns setof uuid language sql stable as $$
  with
    active_rt as (
      select rt.id from public.request_types rt
      where rt.tenant_id = p_tenant_id and rt.active = true
    ),
    coverage_match as (
      select distinct c.request_type_id as id
      from public.request_type_coverage_rules c
      where c.tenant_id = p_tenant_id and c.active = true
        and (c.starts_at is null or c.starts_at <= now())
        and (c.ends_at   is null or c.ends_at   >  now())
        and (
          c.scope_kind = 'tenant'
          or (
            c.scope_kind = 'space'
            and p_selected_space_id is not null
            and (
              (c.inherit_to_descendants = true
                and p_selected_space_id in (select * from public.expand_space_closure(array[c.space_id])))
              or (c.inherit_to_descendants = false and c.space_id = p_selected_space_id)
            )
          )
          or (
            c.scope_kind = 'space_group'
            and p_selected_space_id is not null
            and exists (
              select 1 from public.space_group_members m
              where m.space_group_id = c.space_group_id and m.space_id = p_selected_space_id
            )
          )
        )
    ),
    deny_hit as (
      select distinct a.request_type_id as id
      from public.request_type_audience_rules a
      where a.tenant_id = p_tenant_id and a.mode = 'visible_deny' and a.active = true
        and (a.starts_at is null or a.starts_at <= now())
        and (a.ends_at   is null or a.ends_at   >  now())
        and public.criteria_matches(a.criteria_set_id, p_actor_person_id, p_tenant_id)
    ),
    allow_required as (
      select distinct a.request_type_id as id
      from public.request_type_audience_rules a
      where a.tenant_id = p_tenant_id and a.mode = 'visible_allow' and a.active = true
        and (a.starts_at is null or a.starts_at <= now())
        and (a.ends_at   is null or a.ends_at   >  now())
    ),
    allow_hit as (
      select distinct a.request_type_id as id
      from public.request_type_audience_rules a
      where a.tenant_id = p_tenant_id and a.mode = 'visible_allow' and a.active = true
        and (a.starts_at is null or a.starts_at <= now())
        and (a.ends_at   is null or a.ends_at   >  now())
        and public.criteria_matches(a.criteria_set_id, p_actor_person_id, p_tenant_id)
    )
  select rt.id
  from active_rt rt
  where rt.id in (select id from coverage_match)
    and rt.id not in (select id from deny_hit)
    and (
      rt.id not in (select id from allow_required)
      or rt.id in (select id from allow_hit)
    );
$$;

-- ── B.3 request_type_requestable_trace ────────────────────────────────────
-- Port of portal_requestable_trace (00070 + 00074). Keyed by request_type_id
-- instead of service_item_id; reads audience/variants/on-behalf/coverage from
-- the request_type_* tables; response jsonb drops service_item_id and
-- fulfillment_type_id and gains request_type_id + matched_coverage_rule_id.
create or replace function public.request_type_requestable_trace(
  p_actor_person_id uuid,
  p_request_type_id uuid,
  p_requested_for_person_id uuid,
  p_effective_space_id uuid,
  p_asset_id uuid,
  p_tenant_id uuid
) returns jsonb language plpgsql stable as $$
declare
  v_rt record;
  v_authorized boolean;
  v_has_scope boolean;
  v_matched_root_id uuid;
  v_matched_root_source text;
  v_grant_id uuid;
  v_visible boolean;
  v_matched_coverage_rule_id uuid;
  v_matched_form_variant_id uuid;
  v_granularity_ok boolean;
  v_location_required boolean;
  v_granularity text;
  v_visible_allow_required boolean;
  v_visible_allow_ok boolean;
  v_visible_deny_ok boolean;
  v_request_allow_required boolean;
  v_request_allow_ok boolean;
  v_request_deny_ok boolean;
  v_on_behalf_ok boolean;
  v_on_behalf_policy text;
  v_asset_required boolean;
  v_asset_required_ok boolean;
  v_asset_type_filter_ok boolean;
  v_asset_type_filter uuid[];
  v_asset_type_id uuid;
  v_effective_location_id uuid;
  v_overall boolean;
  v_failure text;
  v_target_valid boolean;
begin
  select id, active, location_required, location_granularity,
         requires_asset, asset_required, asset_type_filter, on_behalf_policy
    into v_rt
  from public.request_types
  where id = p_request_type_id and tenant_id = p_tenant_id;

  if v_rt.id is null or v_rt.active = false then
    return jsonb_build_object(
      'authorized', false, 'has_any_scope', false,
      'effective_location_id', p_effective_space_id,
      'matched_root_id', null, 'matched_root_source', null, 'grant_id', null,
      'visible', false, 'location_required', false, 'granularity', null, 'granularity_ok', false,
      'overall_valid', false, 'failure_reason', 'request type not found or inactive',
      'request_type_id', p_request_type_id,
      'matched_coverage_rule_id', null, 'matched_form_variant_id', null,
      'criteria', jsonb_build_object(
        'visible_allow_required', false, 'visible_allow_ok', true,
        'visible_deny_ok', true,
        'request_allow_required', false, 'request_allow_ok', true,
        'request_deny_ok', true
      ),
      'on_behalf_ok', false, 'asset_type_filter_ok', true
    );
  end if;

  v_location_required := coalesce(v_rt.location_required, false);
  v_granularity := v_rt.location_granularity;
  v_asset_required := coalesce(v_rt.asset_required, false);
  v_asset_type_filter := coalesce(v_rt.asset_type_filter, '{}');
  v_on_behalf_policy := coalesce(v_rt.on_behalf_policy, 'self_only');

  v_has_scope := exists (
    select 1 from public.portal_authorized_root_matches(p_actor_person_id, p_tenant_id)
  );
  v_effective_location_id := p_effective_space_id;

  if not v_has_scope then
    v_authorized := false;
  elsif p_effective_space_id is null then
    v_authorized := true;
  else
    select root_id, source, grant_id into v_matched_root_id, v_matched_root_source, v_grant_id
    from public.portal_match_authorized_root(p_actor_person_id, p_effective_space_id, p_tenant_id);
    v_authorized := v_matched_root_id is not null;
  end if;

  v_visible := exists (
    select 1 from public.request_type_visible_ids(p_actor_person_id, p_effective_space_id, p_tenant_id) x
    where x = p_request_type_id
  );

  select o.id into v_matched_coverage_rule_id
  from public.request_type_offering_matches(p_request_type_id, p_effective_space_id, p_tenant_id) o
  order by
    case o.scope_kind when 'space' then 0 when 'space_group' then 1 when 'tenant' then 2 end,
    o.created_at
  limit 1;

  -- Form variant: conditional first, default (criteria_set_id IS NULL) last.
  select v.id into v_matched_form_variant_id
  from public.request_type_form_variants v
  where v.request_type_id = p_request_type_id
    and v.tenant_id = p_tenant_id
    and v.active = true
    and (v.starts_at is null or v.starts_at <= now())
    and (v.ends_at   is null or v.ends_at   >  now())
    and (
      v.criteria_set_id is null
      or public.criteria_matches(v.criteria_set_id, p_actor_person_id, p_tenant_id)
    )
  order by
    (v.criteria_set_id is null) asc,
    v.priority desc nulls last,
    v.created_at asc
  limit 1;

  v_visible_allow_required := exists (
    select 1 from public.request_type_audience_rules a
    where a.request_type_id = p_request_type_id and a.mode = 'visible_allow' and a.active = true
      and (a.starts_at is null or a.starts_at <= now())
      and (a.ends_at   is null or a.ends_at   >  now())
  );
  v_visible_allow_ok := (not v_visible_allow_required) or exists (
    select 1 from public.request_type_audience_rules a
    where a.request_type_id = p_request_type_id and a.mode = 'visible_allow' and a.active = true
      and (a.starts_at is null or a.starts_at <= now())
      and (a.ends_at   is null or a.ends_at   >  now())
      and public.criteria_matches(a.criteria_set_id, p_actor_person_id, p_tenant_id)
  );
  v_visible_deny_ok := not exists (
    select 1 from public.request_type_audience_rules a
    where a.request_type_id = p_request_type_id and a.mode = 'visible_deny' and a.active = true
      and (a.starts_at is null or a.starts_at <= now())
      and (a.ends_at   is null or a.ends_at   >  now())
      and public.criteria_matches(a.criteria_set_id, p_actor_person_id, p_tenant_id)
  );
  v_request_allow_required := exists (
    select 1 from public.request_type_audience_rules a
    where a.request_type_id = p_request_type_id and a.mode = 'request_allow' and a.active = true
      and (a.starts_at is null or a.starts_at <= now())
      and (a.ends_at   is null or a.ends_at   >  now())
  );
  v_request_allow_ok := (not v_request_allow_required) or exists (
    select 1 from public.request_type_audience_rules a
    where a.request_type_id = p_request_type_id and a.mode = 'request_allow' and a.active = true
      and (a.starts_at is null or a.starts_at <= now())
      and (a.ends_at   is null or a.ends_at   >  now())
      and public.criteria_matches(a.criteria_set_id, p_actor_person_id, p_tenant_id)
  );
  v_request_deny_ok := not exists (
    select 1 from public.request_type_audience_rules a
    where a.request_type_id = p_request_type_id and a.mode = 'request_deny' and a.active = true
      and (a.starts_at is null or a.starts_at <= now())
      and (a.ends_at   is null or a.ends_at   >  now())
      and public.criteria_matches(a.criteria_set_id, p_actor_person_id, p_tenant_id)
  );

  v_target_valid := exists (
    select 1 from public.persons p
    where p.id = p_requested_for_person_id and p.tenant_id = p_tenant_id and p.active = true
  );

  if v_on_behalf_policy = 'self_only' then
    v_on_behalf_ok := p_requested_for_person_id = p_actor_person_id and v_target_valid;
  elsif v_on_behalf_policy = 'any_person' then
    v_on_behalf_ok := v_target_valid;
  elsif v_on_behalf_policy = 'direct_reports' then
    v_on_behalf_ok := v_target_valid and (
      p_requested_for_person_id = p_actor_person_id
      or exists (
        select 1 from public.persons p
        where p.id = p_requested_for_person_id
          and p.tenant_id = p_tenant_id
          and p.active = true
          and p.manager_person_id = p_actor_person_id
      )
    );
  elsif v_on_behalf_policy = 'configured_list' then
    v_on_behalf_ok := v_target_valid and (
      not exists (
        select 1 from public.request_type_on_behalf_rules r
        where r.request_type_id = p_request_type_id and r.role = 'actor' and r.tenant_id = p_tenant_id
      )
      or exists (
        select 1 from public.request_type_on_behalf_rules r
        where r.request_type_id = p_request_type_id and r.role = 'actor' and r.tenant_id = p_tenant_id
          and public.criteria_matches(r.criteria_set_id, p_actor_person_id, p_tenant_id)
      )
    ) and (
      not exists (
        select 1 from public.request_type_on_behalf_rules r
        where r.request_type_id = p_request_type_id and r.role = 'target' and r.tenant_id = p_tenant_id
      )
      or exists (
        select 1 from public.request_type_on_behalf_rules r
        where r.request_type_id = p_request_type_id and r.role = 'target' and r.tenant_id = p_tenant_id
          and public.criteria_matches(r.criteria_set_id, p_requested_for_person_id, p_tenant_id)
      )
    );
  else
    v_on_behalf_ok := false;
  end if;

  if v_location_required and p_effective_space_id is null then
    v_granularity_ok := false;
  else
    v_granularity_ok := public.portal_submit_location_valid(p_effective_space_id, v_granularity, p_tenant_id);
  end if;

  if v_asset_required and p_asset_id is null then
    v_asset_required_ok := false;
  else
    v_asset_required_ok := true;
  end if;

  if array_length(v_asset_type_filter, 1) is null or p_asset_id is null then
    v_asset_type_filter_ok := true;
  else
    select asset_type_id into v_asset_type_id
    from public.assets where id = p_asset_id and tenant_id = p_tenant_id;
    v_asset_type_filter_ok := v_asset_type_id = any(v_asset_type_filter);
  end if;

  v_overall := v_has_scope and v_authorized and v_visible and v_granularity_ok
    and v_visible_allow_ok and v_visible_deny_ok
    and v_request_allow_ok and v_request_deny_ok
    and v_on_behalf_ok and v_asset_required_ok and v_asset_type_filter_ok;

  v_failure := case
    when not v_has_scope then 'no authorized scope — contact your admin to set your work location'
    when v_location_required and p_effective_space_id is null then 'this service requires a location'
    when not v_authorized then 'selected location is not in the requester''s authorized scope'
    when not v_visible_deny_ok then 'your role is excluded from this service'
    when not v_visible_allow_ok then 'your role is not permitted to see this service'
    when not v_visible then 'service is not available at the selected location'
    when not v_request_deny_ok then 'your role is excluded from submitting this service'
    when not v_request_allow_ok then 'your role is not permitted to submit this service'
    when not v_on_behalf_ok then 'you are not permitted to submit this on behalf of the chosen person'
    when not v_asset_required_ok then 'this service requires an asset'
    when not v_asset_type_filter_ok then 'the chosen asset type is not allowed for this service'
    when not v_granularity_ok then format('selected location does not satisfy required depth (%s)', v_granularity)
    else null
  end;

  return jsonb_build_object(
    'authorized', v_authorized,
    'has_any_scope', v_has_scope,
    'effective_location_id', v_effective_location_id,
    'matched_root_id', v_matched_root_id,
    'matched_root_source', v_matched_root_source,
    'grant_id', v_grant_id,
    'visible', v_visible,
    'location_required', v_location_required,
    'granularity', v_granularity,
    'granularity_ok', v_granularity_ok,
    'overall_valid', v_overall,
    'failure_reason', v_failure,
    'request_type_id', p_request_type_id,
    'matched_coverage_rule_id', v_matched_coverage_rule_id,
    'matched_form_variant_id', v_matched_form_variant_id,
    'criteria', jsonb_build_object(
      'visible_allow_required', v_visible_allow_required,
      'visible_allow_ok', v_visible_allow_ok,
      'visible_deny_ok', v_visible_deny_ok,
      'request_allow_required', v_request_allow_required,
      'request_allow_ok', v_request_allow_ok,
      'request_deny_ok', v_request_deny_ok
    ),
    'on_behalf_ok', v_on_behalf_ok,
    'asset_type_filter_ok', v_asset_type_filter_ok
  );
end;
$$;

-- ── B.4 request_type_onboardable_space_ids ────────────────────────────────
-- Port of portal_onboardable_space_ids_v2 reading request_type_coverage_rules
-- + request_type_audience_rules. Returns sites/buildings where at least one
-- request type is visible for the actor (ignoring authorized scope — the
-- whole point of onboarding is the actor has none yet).
create or replace function public.request_type_onboardable_space_ids(
  p_tenant_id uuid,
  p_actor_person_id uuid
) returns setof uuid language sql stable as $$
  select distinct s.id
  from public.spaces s
  where s.tenant_id = p_tenant_id
    and s.active = true
    and s.type in ('site','building')
    and exists (
      select 1 from public.request_types rt
      where rt.tenant_id = p_tenant_id and rt.active = true
        and exists (
          select 1 from public.request_type_coverage_rules c
          where c.request_type_id = rt.id and c.tenant_id = p_tenant_id and c.active = true
            and (c.starts_at is null or c.starts_at <= now())
            and (c.ends_at   is null or c.ends_at   >  now())
            and (
              c.scope_kind = 'tenant'
              or (c.scope_kind = 'space' and (
                (c.inherit_to_descendants and s.id in (select * from public.expand_space_closure(array[c.space_id])))
                or (not c.inherit_to_descendants and c.space_id = s.id)
              ))
              or (c.scope_kind = 'space_group' and exists (
                select 1 from public.space_group_members m
                where m.space_group_id = c.space_group_id and m.space_id = s.id
              ))
            )
        )
        and not exists (
          select 1 from public.request_type_audience_rules a
          where a.request_type_id = rt.id and a.mode = 'visible_deny' and a.active = true
            and (a.starts_at is null or a.starts_at <= now())
            and (a.ends_at   is null or a.ends_at   >  now())
            and public.criteria_matches(a.criteria_set_id, p_actor_person_id, p_tenant_id)
        )
        and (
          not exists (
            select 1 from public.request_type_audience_rules a
            where a.request_type_id = rt.id and a.mode = 'visible_allow' and a.active = true
              and (a.starts_at is null or a.starts_at <= now())
              and (a.ends_at   is null or a.ends_at   >  now())
          )
          or exists (
            select 1 from public.request_type_audience_rules a
            where a.request_type_id = rt.id and a.mode = 'visible_allow' and a.active = true
              and (a.starts_at is null or a.starts_at <= now())
              and (a.ends_at   is null or a.ends_at   >  now())
              and public.criteria_matches(a.criteria_set_id, p_actor_person_id, p_tenant_id)
          )
        )
    );
$$;

notify pgrst, 'reload schema';
