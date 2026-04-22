-- 00071_service_catalog_rt_update_mirror.sql
-- Phase-2 codex review round-2: auto-pair INSERT trigger alone isn't enough —
-- legacy request-type UPDATE path (PATCH /request-types/:id) keeps writing
-- name/description/icon/keywords/display_order/active/form_schema_id. Mirror
-- those edits into the paired service_item so v2 reads don't drift.
-- See codex phase-2 round-2 review, fix #2.

create or replace function public.mirror_request_type_update_to_service_item()
returns trigger language plpgsql as $$
declare
  v_service_item_id uuid;
begin
  select service_item_id into v_service_item_id
  from public.request_type_service_item_bridge
  where request_type_id = new.id;

  if v_service_item_id is null then
    -- No paired service item (shouldn't happen post-backfill + INSERT trigger).
    -- Attempt to auto-pair now so subsequent updates land correctly.
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
  else
    -- Propagate only the portal-facing columns that overlap.
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

  -- Keep the default form variant in sync with request_types.form_schema_id.
  -- When the RT points at a form schema, ensure exactly one default variant
  -- (criteria_set_id IS NULL) exists for the paired service item with that schema.
  -- When form_schema_id is cleared, deactivate any default variant.
  if new.form_schema_id is distinct from old.form_schema_id then
    if new.form_schema_id is null then
      update public.service_item_form_variants
      set active = false, updated_at = now()
      where service_item_id = v_service_item_id
        and criteria_set_id is null
        and active = true;
    else
      -- Upsert: if a default variant exists, update; else insert.
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

create trigger trg_mirror_rt_update_to_si
  after update on public.request_types
  for each row execute function public.mirror_request_type_update_to_service_item();

-- Note: service_item_form_variants has no updated_at column by design;
-- the `update ... set active = false, updated_at = now()` above is guarded
-- by the `where active = true` clause and only sets `active` + nothing else
-- if the column doesn't exist. Safer: check the column and use plain SQL.

-- Actually the form_variants table does NOT have updated_at. Patch the
-- function to not reference it, to avoid a runtime error on legacy edits.

create or replace function public.mirror_request_type_update_to_service_item()
returns trigger language plpgsql as $$
declare
  v_service_item_id uuid;
begin
  select service_item_id into v_service_item_id
  from public.request_type_service_item_bridge
  where request_type_id = new.id;

  if v_service_item_id is null then
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
  else
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

notify pgrst, 'reload schema';
