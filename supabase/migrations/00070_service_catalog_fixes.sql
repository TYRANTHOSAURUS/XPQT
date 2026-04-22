-- 00070_service_catalog_fixes.sql
-- Phase-2 codex review fixes:
--   1. configured_list + direct_reports: enforce tenant + active on target person
--   2. Auto-bridge newly inserted request_types (keeps legacy callers alive)
--   3. Mirror request_type_categories ↔ service_item_categories on write
--   4. Reorder portal_requestable_trace failure_reason so "requires a location"
--      wins over "not available at location" when location is null.
-- See codex phase-2 review findings 1-3.

-- ── Fix 1 + 3: portal_requestable_trace ────────────────────────────────
create or replace function public.portal_requestable_trace(
  p_actor_person_id uuid,
  p_service_item_id uuid,
  p_requested_for_person_id uuid,
  p_effective_space_id uuid,
  p_asset_id uuid,
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
  v_requires_asset boolean;
  v_asset_type_filter uuid[];
  v_asset_type_id uuid;
  v_effective_location_id uuid;
  v_overall boolean;
  v_failure text;
  v_target_valid boolean;  -- active + tenant-matched target person
begin
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
    select 1 from public.portal_visible_service_item_ids(p_actor_person_id, p_effective_space_id, p_tenant_id) x
    where x = p_service_item_id
  );

  select o.id into v_matched_offering_id
  from public.service_item_offering_matches(p_service_item_id, p_effective_space_id, p_tenant_id) o
  order by
    case o.scope_kind when 'space' then 0 when 'space_group' then 1 when 'tenant' then 2 end,
    o.created_at
  limit 1;

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

  -- On-behalf — ALL paths validate target is active + tenant-matched (codex fix #1).
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
        select 1 from public.service_item_on_behalf_rules r
        where r.service_item_id = p_service_item_id and r.role = 'actor' and r.tenant_id = p_tenant_id
      )
      or exists (
        select 1 from public.service_item_on_behalf_rules r
        where r.service_item_id = p_service_item_id and r.role = 'actor' and r.tenant_id = p_tenant_id
          and public.criteria_matches(r.criteria_set_id, p_actor_person_id, p_tenant_id)
      )
    ) and (
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

  -- Failure-reason cascade fix (codex fix #3): "requires a location" wins over
  -- "not available at location" when the service needs a location and none was supplied.
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

-- ── Fix 2: Auto-bridge newly inserted request_types (+ offerings + default form variant).
-- Fires AFTER INSERT. Skips if a bridge row already exists (idempotent with
-- the one-shot backfill migration 00068).
create or replace function public.auto_pair_service_item_for_request_type()
returns trigger language plpgsql as $$
declare
  v_service_item_id uuid;
  v_key text;
begin
  if exists (
    select 1 from public.request_type_service_item_bridge
    where request_type_id = new.id
  ) then
    return new;
  end if;

  v_key := lower(regexp_replace(
    regexp_replace(coalesce(new.name, 'untitled'), '[^a-zA-Z0-9]+', '-', 'g'),
    '(^-+|-+$)', '', 'g'
  )) || '-' || substr(new.id::text, 1, 8);

  insert into public.service_items (
    tenant_id, key, name, description, icon, search_terms,
    on_behalf_policy, fulfillment_type_id, display_order, active,
    created_at, updated_at
  ) values (
    new.tenant_id, v_key, new.name, new.description, new.icon, coalesce(new.keywords, '{}'),
    'self_only', new.id, coalesce(new.display_order, 0), coalesce(new.active, true),
    coalesce(new.created_at, now()), coalesce(new.updated_at, now())
  ) returning id into v_service_item_id;

  insert into public.request_type_service_item_bridge (tenant_id, request_type_id, service_item_id)
  values (new.tenant_id, new.id, v_service_item_id);

  -- Offerings matching current visibility semantics: one space-scope offering
  -- per active site/building with a granularity-eligible descendant.
  insert into public.service_item_offerings (
    tenant_id, service_item_id, scope_kind, space_id, inherit_to_descendants, active
  )
  select new.tenant_id, v_service_item_id, 'space', s.id, true, true
  from public.spaces s
  where s.tenant_id = new.tenant_id
    and s.active = true
    and s.type in ('site','building')
    and public.portal_request_type_has_eligible_descendant(s.id, new.location_granularity, new.tenant_id);

  -- Default form variant when form_schema_id is set.
  if new.form_schema_id is not null then
    insert into public.service_item_form_variants (
      tenant_id, service_item_id, criteria_set_id, form_schema_id, priority, active
    ) values (
      new.tenant_id, v_service_item_id, null, new.form_schema_id, 0, true
    );
  end if;

  return new;
end;
$$;

create trigger trg_auto_pair_service_item
  after insert on public.request_types
  for each row execute function public.auto_pair_service_item_for_request_type();

-- ── Category mirror: request_type_categories ↔ service_item_categories ──
create or replace function public.mirror_request_type_category_insert()
returns trigger language plpgsql as $$
declare v_service_item_id uuid;
begin
  select service_item_id into v_service_item_id
  from public.request_type_service_item_bridge
  where request_type_id = new.request_type_id;
  if v_service_item_id is null then return new; end if;

  insert into public.service_item_categories (tenant_id, service_item_id, category_id, display_order)
  values (new.tenant_id, v_service_item_id, new.category_id, 0)
  on conflict (service_item_id, category_id) do nothing;

  return new;
end;
$$;

create or replace function public.mirror_request_type_category_delete()
returns trigger language plpgsql as $$
declare v_service_item_id uuid;
begin
  select service_item_id into v_service_item_id
  from public.request_type_service_item_bridge
  where request_type_id = old.request_type_id;
  if v_service_item_id is null then return old; end if;

  delete from public.service_item_categories
  where service_item_id = v_service_item_id and category_id = old.category_id;

  return old;
end;
$$;

create trigger trg_mirror_rtc_insert
  after insert on public.request_type_categories
  for each row execute function public.mirror_request_type_category_insert();

create trigger trg_mirror_rtc_delete
  after delete on public.request_type_categories
  for each row execute function public.mirror_request_type_category_delete();

notify pgrst, 'reload schema';
