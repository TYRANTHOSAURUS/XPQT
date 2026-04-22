-- 00069_service_catalog_predicates.sql
-- Phase 2 predicates for the service-catalog model.
-- See docs/service-catalog-redesign.md §4

-- ── service_item_offering_matches ──────────────────────────────────────
-- Returns 1 row per (item, offering) that covers (selected_space).
-- Internal helper used by the visibility predicate; callers typically use
-- portal_visible_service_item_ids instead.

create or replace function public.service_item_offering_matches(
  p_service_item_id uuid,
  p_selected_space_id uuid,      -- may be null (pre-scope preview)
  p_tenant_id uuid
) returns setof public.service_item_offerings language sql stable as $$
  select o.*
  from public.service_item_offerings o
  where o.service_item_id = p_service_item_id
    and o.tenant_id = p_tenant_id
    and o.active = true
    and (o.starts_at is null or o.starts_at <= now())
    and (o.ends_at   is null or o.ends_at   >  now())
    and (
      -- tenant scope: always matches (including null selected)
      o.scope_kind = 'tenant'
      or (
        o.scope_kind = 'space'
        and p_selected_space_id is not null
        and (
          (o.inherit_to_descendants = true
            and p_selected_space_id in (
              select * from public.expand_space_closure(array[o.space_id])
            ))
          or (o.inherit_to_descendants = false and o.space_id = p_selected_space_id)
        )
      )
      or (
        o.scope_kind = 'space_group'
        and p_selected_space_id is not null
        and exists (
          select 1 from public.space_group_members m
          where m.space_group_id = o.space_group_id
            and m.space_id = p_selected_space_id
        )
      )
    );
$$;

-- ── portal_visible_service_item_ids ────────────────────────────────────
-- Visibility rule per design §4.1:
--   item.active
--   AND ≥1 effective-dated offering matches the selected location
--   AND no effective-dated visible_deny criteria match
--   AND (no effective-dated visible_allow configured OR ≥1 matches)

create or replace function public.portal_visible_service_item_ids(
  p_actor_person_id uuid,
  p_selected_space_id uuid,      -- may be null (pre-scope preview)
  p_tenant_id uuid
) returns setof uuid language sql stable as $$
  with
    items as (
      select si.id
      from public.service_items si
      where si.tenant_id = p_tenant_id
        and si.active = true
    ),
    offer_match as (
      select distinct o.service_item_id
      from public.service_item_offerings o
      where o.tenant_id = p_tenant_id and o.active = true
        and (o.starts_at is null or o.starts_at <= now())
        and (o.ends_at   is null or o.ends_at   >  now())
        and (
          o.scope_kind = 'tenant'
          or (
            o.scope_kind = 'space'
            and p_selected_space_id is not null
            and (
              (o.inherit_to_descendants and
                p_selected_space_id in (select * from public.expand_space_closure(array[o.space_id])))
              or (not o.inherit_to_descendants and o.space_id = p_selected_space_id)
            )
          )
          or (
            o.scope_kind = 'space_group'
            and p_selected_space_id is not null
            and exists (
              select 1 from public.space_group_members m
              where m.space_group_id = o.space_group_id
                and m.space_id = p_selected_space_id
            )
          )
        )
    ),
    deny_hit as (
      select sic.service_item_id
      from public.service_item_criteria sic
      where sic.tenant_id = p_tenant_id and sic.mode = 'visible_deny'
        and sic.active = true
        and (sic.starts_at is null or sic.starts_at <= now())
        and (sic.ends_at   is null or sic.ends_at   >  now())
        and public.criteria_matches(sic.criteria_set_id, p_actor_person_id, p_tenant_id)
    ),
    allow_required as (
      select sic.service_item_id
      from public.service_item_criteria sic
      where sic.tenant_id = p_tenant_id and sic.mode = 'visible_allow'
        and sic.active = true
        and (sic.starts_at is null or sic.starts_at <= now())
        and (sic.ends_at   is null or sic.ends_at   >  now())
    ),
    allow_hit as (
      select sic.service_item_id
      from public.service_item_criteria sic
      where sic.tenant_id = p_tenant_id and sic.mode = 'visible_allow'
        and sic.active = true
        and (sic.starts_at is null or sic.starts_at <= now())
        and (sic.ends_at   is null or sic.ends_at   >  now())
        and public.criteria_matches(sic.criteria_set_id, p_actor_person_id, p_tenant_id)
    )
  select i.id
  from items i
  where i.id in (select service_item_id from offer_match)
    and i.id not in (select service_item_id from deny_hit)
    and (
      i.id not in (select service_item_id from allow_required)
      or i.id in (select service_item_id from allow_hit)
    );
$$;

-- ── portal_onboardable_space_ids_v2 ────────────────────────────────────
-- Replacement for portal_onboardable_locations(tenant). Returns
-- sites/buildings where at least one VISIBLE service item has an offering
-- covering the space. Effective-dating filters applied on offerings +
-- criteria, matching the catalog-render predicate.

create or replace function public.portal_onboardable_space_ids_v2(
  p_tenant_id uuid,
  p_actor_person_id uuid
) returns setof uuid language sql stable as $$
  select distinct s.id
  from public.spaces s
  where s.tenant_id = p_tenant_id
    and s.active = true
    and s.type in ('site','building')
    and exists (
      select 1 from public.service_items si
      where si.tenant_id = p_tenant_id and si.active = true
        -- offering match
        and exists (
          select 1 from public.service_item_offerings o
          where o.service_item_id = si.id and o.tenant_id = p_tenant_id and o.active = true
            and (o.starts_at is null or o.starts_at <= now())
            and (o.ends_at   is null or o.ends_at   >  now())
            and (
              o.scope_kind = 'tenant'
              or (o.scope_kind = 'space' and (
                (o.inherit_to_descendants and s.id in (select * from public.expand_space_closure(array[o.space_id])))
                or (not o.inherit_to_descendants and o.space_id = s.id)
              ))
              or (o.scope_kind = 'space_group' and exists (
                select 1 from public.space_group_members m
                where m.space_group_id = o.space_group_id and m.space_id = s.id
              ))
            )
        )
        -- criteria pass (deny short-circuits; allow defaults to true)
        and not exists (
          select 1 from public.service_item_criteria sic
          where sic.service_item_id = si.id and sic.mode = 'visible_deny'
            and sic.active = true
            and (sic.starts_at is null or sic.starts_at <= now())
            and (sic.ends_at   is null or sic.ends_at   >  now())
            and public.criteria_matches(sic.criteria_set_id, p_actor_person_id, p_tenant_id)
        )
        and (
          not exists (
            select 1 from public.service_item_criteria sic
            where sic.service_item_id = si.id and sic.mode = 'visible_allow'
              and sic.active = true
              and (sic.starts_at is null or sic.starts_at <= now())
              and (sic.ends_at   is null or sic.ends_at   >  now())
          )
          or exists (
            select 1 from public.service_item_criteria sic
            where sic.service_item_id = si.id and sic.mode = 'visible_allow'
              and sic.active = true
              and (sic.starts_at is null or sic.starts_at <= now())
              and (sic.ends_at   is null or sic.ends_at   >  now())
              and public.criteria_matches(sic.criteria_set_id, p_actor_person_id, p_tenant_id)
          )
        )
    );
$$;

-- ── portal_requestable_trace ───────────────────────────────────────────
-- Strict superset of portal_availability_trace (shipped). Returns all
-- existing fields PLUS service-item-specific fields. Single source of truth
-- for submit validation + admin simulator.

create or replace function public.portal_requestable_trace(
  p_actor_person_id uuid,
  p_service_item_id uuid,
  p_requested_for_person_id uuid,   -- pass same as actor for self-submit
  p_effective_space_id uuid,         -- may be null
  p_asset_id uuid,                   -- may be null
  p_tenant_id uuid
) returns jsonb language plpgsql stable as $$
declare
  v_si record;
  v_ft record;
  v_fulfillment_type_id uuid;
  v_authorized boolean;
  v_has_scope boolean;
  v_matched_root_id uuid;
  v_matched_root_source text;
  v_grant_id uuid;
  v_visible boolean;
  v_matched_offering_id uuid;
  v_matched_form_variant_id uuid;
  v_granularity_ok boolean;
  v_location_required boolean;
  v_granularity text;
  -- criteria flags
  v_visible_allow_required boolean;
  v_visible_allow_ok boolean;
  v_visible_deny_ok boolean;
  v_request_allow_required boolean;
  v_request_allow_ok boolean;
  v_request_deny_ok boolean;
  -- on-behalf
  v_on_behalf_ok boolean;
  v_on_behalf_policy text;
  -- asset
  v_asset_required boolean;
  v_asset_required_ok boolean;
  v_asset_type_filter_ok boolean;
  v_requires_asset boolean;
  v_asset_type_filter uuid[];
  v_asset_type_id uuid;
  v_effective_location_id uuid;
  v_overall boolean;
  v_failure text;
begin
  -- Load service_item + fulfillment_type
  select id, fulfillment_type_id, on_behalf_policy, active into v_si
  from public.service_items
  where id = p_service_item_id and tenant_id = p_tenant_id;
  if v_si.id is null or v_si.active = false then
    return jsonb_build_object(
      'authorized', false, 'has_any_scope', false,
      'effective_location_id', p_effective_space_id,
      'matched_root_id', null, 'matched_root_source', null, 'grant_id', null,
      'visible', false, 'location_required', false, 'granularity', null, 'granularity_ok', false,
      'overall_valid', false, 'failure_reason', 'service item not found or inactive',
      'service_item_id', p_service_item_id, 'fulfillment_type_id', null,
      'matched_offering_id', null, 'matched_form_variant_id', null,
      'criteria', jsonb_build_object(
        'visible_allow_required', false, 'visible_allow_ok', true,
        'visible_deny_ok', true,
        'request_allow_required', false, 'request_allow_ok', true,
        'request_deny_ok', true
      ),
      'on_behalf_ok', false, 'asset_type_filter_ok', true
    );
  end if;
  v_on_behalf_policy := v_si.on_behalf_policy;
  v_fulfillment_type_id := v_si.fulfillment_type_id;

  select id, location_required, location_granularity, requires_asset, asset_required, asset_type_filter
    into v_ft
  from public.request_types
  where id = v_fulfillment_type_id and tenant_id = p_tenant_id;
  v_location_required := coalesce(v_ft.location_required, false);
  v_granularity := v_ft.location_granularity;
  v_requires_asset := coalesce(v_ft.requires_asset, false);
  v_asset_required := coalesce(v_ft.asset_required, false);
  v_asset_type_filter := coalesce(v_ft.asset_type_filter, '{}');

  -- Scope / authorization step (reuses portal-scope primitives)
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

  -- Visibility (service item must be in the visible set)
  v_visible := exists (
    select 1 from public.portal_visible_service_item_ids(p_actor_person_id, p_effective_space_id, p_tenant_id) x
    where x = p_service_item_id
  );

  -- Matched offering (best — for trace only; UI may ignore)
  select o.id into v_matched_offering_id
  from public.service_item_offering_matches(p_service_item_id, p_effective_space_id, p_tenant_id) o
  order by
    case o.scope_kind when 'space' then 0 when 'space_group' then 1 when 'tenant' then 2 end,
    o.created_at
  limit 1;

  -- Matched form variant (highest priority active variant whose criteria match, or NULL default)
  select v.id into v_matched_form_variant_id
  from public.service_item_form_variants v
  where v.service_item_id = p_service_item_id
    and v.tenant_id = p_tenant_id
    and v.active = true
    and (v.starts_at is null or v.starts_at <= now())
    and (v.ends_at   is null or v.ends_at   >  now())
    and (
      v.criteria_set_id is null
      or public.criteria_matches(v.criteria_set_id, p_actor_person_id, p_tenant_id)
    )
  order by v.priority desc nulls last, v.created_at asc
  limit 1;

  -- Criteria flags (visibility was folded into v_visible; expose explicit flags for trace)
  v_visible_allow_required := exists (
    select 1 from public.service_item_criteria sic
    where sic.service_item_id = p_service_item_id and sic.mode = 'visible_allow' and sic.active = true
      and (sic.starts_at is null or sic.starts_at <= now())
      and (sic.ends_at   is null or sic.ends_at   >  now())
  );
  v_visible_allow_ok := (not v_visible_allow_required) or exists (
    select 1 from public.service_item_criteria sic
    where sic.service_item_id = p_service_item_id and sic.mode = 'visible_allow' and sic.active = true
      and (sic.starts_at is null or sic.starts_at <= now())
      and (sic.ends_at   is null or sic.ends_at   >  now())
      and public.criteria_matches(sic.criteria_set_id, p_actor_person_id, p_tenant_id)
  );
  v_visible_deny_ok := not exists (
    select 1 from public.service_item_criteria sic
    where sic.service_item_id = p_service_item_id and sic.mode = 'visible_deny' and sic.active = true
      and (sic.starts_at is null or sic.starts_at <= now())
      and (sic.ends_at   is null or sic.ends_at   >  now())
      and public.criteria_matches(sic.criteria_set_id, p_actor_person_id, p_tenant_id)
  );
  v_request_allow_required := exists (
    select 1 from public.service_item_criteria sic
    where sic.service_item_id = p_service_item_id and sic.mode = 'request_allow' and sic.active = true
      and (sic.starts_at is null or sic.starts_at <= now())
      and (sic.ends_at   is null or sic.ends_at   >  now())
  );
  v_request_allow_ok := (not v_request_allow_required) or exists (
    select 1 from public.service_item_criteria sic
    where sic.service_item_id = p_service_item_id and sic.mode = 'request_allow' and sic.active = true
      and (sic.starts_at is null or sic.starts_at <= now())
      and (sic.ends_at   is null or sic.ends_at   >  now())
      and public.criteria_matches(sic.criteria_set_id, p_actor_person_id, p_tenant_id)
  );
  v_request_deny_ok := not exists (
    select 1 from public.service_item_criteria sic
    where sic.service_item_id = p_service_item_id and sic.mode = 'request_deny' and sic.active = true
      and (sic.starts_at is null or sic.starts_at <= now())
      and (sic.ends_at   is null or sic.ends_at   >  now())
      and public.criteria_matches(sic.criteria_set_id, p_actor_person_id, p_tenant_id)
  );

  -- On-behalf policy
  if v_on_behalf_policy = 'self_only' then
    v_on_behalf_ok := p_requested_for_person_id = p_actor_person_id;
  elsif v_on_behalf_policy = 'any_person' then
    v_on_behalf_ok := exists (
      select 1 from public.persons p
      where p.id = p_requested_for_person_id and p.tenant_id = p_tenant_id and p.active = true
    );
  elsif v_on_behalf_policy = 'direct_reports' then
    v_on_behalf_ok := p_requested_for_person_id = p_actor_person_id or exists (
      select 1 from public.persons p
      where p.id = p_requested_for_person_id and p.tenant_id = p_tenant_id
        and p.manager_person_id = p_actor_person_id
    );
  elsif v_on_behalf_policy = 'configured_list' then
    -- Actor must satisfy any actor-criteria (if configured)
    v_on_behalf_ok := (
      not exists (
        select 1 from public.service_item_on_behalf_rules r
        where r.service_item_id = p_service_item_id and r.role = 'actor' and r.tenant_id = p_tenant_id
      )
      or exists (
        select 1 from public.service_item_on_behalf_rules r
        where r.service_item_id = p_service_item_id and r.role = 'actor' and r.tenant_id = p_tenant_id
          and public.criteria_matches(r.criteria_set_id, p_actor_person_id, p_tenant_id)
      )
    )
    and (
      -- Target must satisfy any target-criteria (if configured)
      not exists (
        select 1 from public.service_item_on_behalf_rules r
        where r.service_item_id = p_service_item_id and r.role = 'target' and r.tenant_id = p_tenant_id
      )
      or exists (
        select 1 from public.service_item_on_behalf_rules r
        where r.service_item_id = p_service_item_id and r.role = 'target' and r.tenant_id = p_tenant_id
          and public.criteria_matches(r.criteria_set_id, p_requested_for_person_id, p_tenant_id)
      )
    );
  else
    v_on_behalf_ok := false;
  end if;

  -- Granularity (reuses portal-scope primitive)
  if v_location_required and p_effective_space_id is null then
    v_granularity_ok := false;
  else
    v_granularity_ok := public.portal_submit_location_valid(p_effective_space_id, v_granularity, p_tenant_id);
  end if;

  -- Asset checks
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
    when not v_authorized then 'selected location is not in the requester''s authorized scope'
    when not v_visible_deny_ok then 'your role is excluded from this service'
    when not v_visible_allow_ok then 'your role is not permitted to see this service'
    when not v_visible then 'service is not available at the selected location'
    when not v_request_deny_ok then 'your role is excluded from submitting this service'
    when not v_request_allow_ok then 'your role is not permitted to submit this service'
    when not v_on_behalf_ok then 'you are not permitted to submit this on behalf of the chosen person'
    when not v_asset_required_ok then 'this service requires an asset'
    when not v_asset_type_filter_ok then 'the chosen asset type is not allowed for this service'
    when not v_granularity_ok and p_effective_space_id is null then 'this service requires a location'
    when not v_granularity_ok then format('selected location does not satisfy required depth (%s)', v_granularity)
    else null
  end;

  return jsonb_build_object(
    -- Shipped portal_availability_trace superset
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
    -- New for v2
    'service_item_id', p_service_item_id,
    'fulfillment_type_id', v_fulfillment_type_id,
    'matched_offering_id', v_matched_offering_id,
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

-- ── Back-compat wrappers (NOT views) ────────────────────────────────────
-- Shipped portal-scope slice exposes portal_visible_request_type_ids and
-- portal_availability_trace as parameterized RPCs. Rewrite them to delegate
-- through the bridge, preserving their signatures and result shapes.

create or replace function public.portal_visible_request_type_ids(
  p_person_id uuid,
  p_effective_space_id uuid,
  p_tenant_id uuid
) returns setof uuid language sql stable as $$
  select b.request_type_id
  from public.request_type_service_item_bridge b
  where b.tenant_id = p_tenant_id
    and b.service_item_id in (
      select * from public.portal_visible_service_item_ids(p_person_id, p_effective_space_id, p_tenant_id)
    );
$$;

create or replace function public.portal_availability_trace(
  p_person_id uuid,
  p_effective_space_id uuid,
  p_request_type_id uuid,
  p_tenant_id uuid
) returns jsonb language plpgsql stable as $$
declare
  v_service_item_id uuid;
  v_trace jsonb;
begin
  select service_item_id into v_service_item_id
  from public.request_type_service_item_bridge
  where request_type_id = p_request_type_id and tenant_id = p_tenant_id;

  if v_service_item_id is null then
    -- RT not in bridge (shouldn't happen post-backfill) — return the legacy "not found" shape.
    return jsonb_build_object(
      'authorized', false, 'has_any_scope', exists (
        select 1 from public.portal_authorized_root_matches(p_person_id, p_tenant_id)
      ),
      'effective_location_id', p_effective_space_id,
      'matched_root_id', null, 'matched_root_source', null, 'grant_id', null,
      'visible', false, 'location_required', false, 'granularity', null, 'granularity_ok', false,
      'overall_valid', false, 'failure_reason', 'request type not found'
    );
  end if;

  v_trace := public.portal_requestable_trace(
    p_person_id, v_service_item_id, p_person_id, p_effective_space_id, null, p_tenant_id
  );

  -- Project to the shipped shape (drop v2-only fields).
  return v_trace
    - 'service_item_id' - 'fulfillment_type_id'
    - 'matched_offering_id' - 'matched_form_variant_id'
    - 'criteria' - 'on_behalf_ok' - 'asset_type_filter_ok';
end;
$$;

-- portal_onboardable_locations stays deprecated in place (pre-v2 semantics).
-- The /portal/me/onboard-locations controller is rewired in phase-2 backend
-- code to call portal_onboardable_space_ids_v2 directly.
comment on function public.portal_onboardable_locations(uuid) is
  'DEPRECATED — retains pre-v2 semantics (site/building with granularity-eligible descendant; no per-person criteria). Controller /portal/me/onboard-locations now calls portal_onboardable_space_ids_v2 directly.';
