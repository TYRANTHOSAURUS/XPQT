-- 00072_rt_update_defensive_branch.sql
-- Phase-2 round-3 codex review: the defensive "no paired service_item" branch
-- in mirror_request_type_update_to_service_item (00071) created the service_item
-- + bridge but skipped offerings + default form variant. An RT created between
-- the phase-1 backfill (00068) and the auto-pair INSERT trigger (00070) could
-- still end up with zero offerings (= invisible in v2) and no default variant
-- after the admin's first PATCH. Make the defensive branch do the full
-- auto-pair job.

create or replace function public.mirror_request_type_update_to_service_item()
returns trigger language plpgsql as $$
declare
  v_service_item_id uuid;
begin
  select service_item_id into v_service_item_id
  from public.request_type_service_item_bridge
  where request_type_id = new.id;

  if v_service_item_id is null then
    -- Full defensive auto-pair (matches auto_pair_service_item_for_request_type).
    insert into public.service_items (
      tenant_id, key, name, description, icon, search_terms,
      on_behalf_policy, fulfillment_type_id, display_order, active,
      created_at, updated_at
    ) values (
      new.tenant_id,
      lower(regexp_replace(
        regexp_replace(coalesce(new.name, 'untitled'), '[^a-zA-Z0-9]+', '-', 'g'),
        '(^-+|-+$)', '', 'g'
      )) || '-' || substr(new.id::text, 1, 8),
      new.name, new.description, new.icon, coalesce(new.keywords, '{}'),
      'self_only', new.id, coalesce(new.display_order, 0), coalesce(new.active, true),
      coalesce(new.created_at, now()), coalesce(new.updated_at, now())
    ) returning id into v_service_item_id;

    insert into public.request_type_service_item_bridge (tenant_id, request_type_id, service_item_id)
    values (new.tenant_id, new.id, v_service_item_id);

    -- Offerings: one per active site/building with granularity-eligible descendants.
    insert into public.service_item_offerings (
      tenant_id, service_item_id, scope_kind, space_id, inherit_to_descendants, active
    )
    select new.tenant_id, v_service_item_id, 'space', s.id, true, true
    from public.spaces s
    where s.tenant_id = new.tenant_id
      and s.active = true
      and s.type in ('site','building')
      and public.portal_request_type_has_eligible_descendant(s.id, new.location_granularity, new.tenant_id);

    -- Default form variant when form_schema_id is set on the NEW row.
    if new.form_schema_id is not null then
      insert into public.service_item_form_variants (
        tenant_id, service_item_id, criteria_set_id, form_schema_id, priority, active
      ) values (
        new.tenant_id, v_service_item_id, null, new.form_schema_id, 0, true
      );
    end if;
  else
    -- Normal path: mirror portal-facing columns.
    update public.service_items
    set
      name = coalesce(new.name, name),
      description = new.description,
      icon = new.icon,
      search_terms = coalesce(new.keywords, search_terms),
      display_order = coalesce(new.display_order, display_order),
      active = coalesce(new.active, active),
      updated_at = now()
    where id = v_service_item_id;
  end if;

  -- Keep the default form variant in sync with request_types.form_schema_id
  -- whenever it changes (applies to both paths — the defensive branch covers
  -- the INITIAL seed, but a subsequent change should still propagate).
  if new.form_schema_id is distinct from old.form_schema_id then
    if new.form_schema_id is null then
      update public.service_item_form_variants
      set active = false
      where service_item_id = v_service_item_id
        and criteria_set_id is null
        and active = true;
    else
      update public.service_item_form_variants
      set form_schema_id = new.form_schema_id, active = true
      where service_item_id = v_service_item_id
        and criteria_set_id is null;
      if not found then
        insert into public.service_item_form_variants (
          tenant_id, service_item_id, criteria_set_id, form_schema_id, priority, active
        ) values (
          new.tenant_id, v_service_item_id, null, new.form_schema_id, 0, true
        );
      end if;
    end if;
  end if;

  return new;
end;
$$;
