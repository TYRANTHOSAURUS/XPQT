-- 00418_publish_floor_plan_draft_rpc.sql
-- Atomic publish flow per CLAUDE.md ("multi-step writes via PL/pgSQL").
-- Single-execution guarantee via DELETE ... RETURNING * at the start (codex CRITICAL #1).
-- Writes a snapshot to floor_plan_publish_history (for rollback), updates floor_plans
-- + spaces.floor_plan_polygon, deletes the draft. Spec §6.2.

create or replace function public.publish_floor_plan_draft(p_draft_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_draft public.floor_plan_drafts%rowtype;
  v_tenant_id uuid;
  v_floor_id uuid;
  v_polygon jsonb;
  v_space_ids uuid[];
  v_history_id uuid;
  v_prev_image text;
  v_prev_w int;
  v_prev_h int;
  v_prev_labels jsonb;
  v_prev_polygons jsonb;
  v_invalid_count int;
begin
  -- Single-execution claim: DELETE atomically locks + removes the draft. A concurrent
  -- caller for the same draft_id sees 0 rows and the not_found branch fires.
  delete from public.floor_plan_drafts
   where id = p_draft_id
  returning * into v_draft;

  if v_draft.id is null then
    raise exception 'floor_plan.draft.not_found' using errcode = 'P0002';
  end if;

  v_tenant_id := v_draft.tenant_id;
  v_floor_id  := v_draft.floor_space_id;

  if v_tenant_id <> public.current_tenant_id() then
    raise exception 'floor_plan.draft.cross_tenant' using errcode = '42501';
  end if;

  -- Required-fields preflight: floor_plans canonical columns are NOT NULL in 00127.
  if v_draft.image_url is null or v_draft.width_px is null or v_draft.height_px is null then
    raise exception 'floor_plan.publish.image_required' using errcode = '23502';
  end if;

  -- Validate every polygon: non-empty uuid + child-of-floor + same tenant + non-duplicate.
  select count(*) into v_invalid_count
    from jsonb_array_elements(v_draft.polygons) p
   where (p->>'space_id') is null
      or (p->>'space_id') = ''
      or not (p->>'space_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      or (p->'points') is null
      or jsonb_typeof(p->'points') <> 'array'
      or jsonb_array_length(p->'points') < 3;
  if v_invalid_count > 0 then
    raise exception 'floor_plan.publish.invalid_polygons' using errcode = '22023';
  end if;

  -- Duplicate space_id check at the RPC layer (DTO catches it client-side too)
  if (select count(distinct (p->>'space_id')) <> count(*)
        from jsonb_array_elements(v_draft.polygons) p) then
    raise exception 'floor_plan.publish.duplicate_space_id' using errcode = '22023';
  end if;

  -- Verify every space_id is a child of this floor in this tenant
  if exists (
    select 1 from jsonb_array_elements(v_draft.polygons) p
     where not exists (
       select 1 from public.spaces s
        where s.id = (p->>'space_id')::uuid
          and s.tenant_id = v_tenant_id
          and s.parent_id = v_floor_id
     )
  ) then
    raise exception 'floor_plan.publish.polygon_not_child' using errcode = '22023';
  end if;

  -- 1. Snapshot the current published state (for rollback)
  select image_url, width_px, height_px, labels
    into v_prev_image, v_prev_w, v_prev_h, v_prev_labels
    from public.floor_plans
   where space_id = v_floor_id;

  select coalesce(
           jsonb_agg(jsonb_build_object(
             'space_id', s.id,
             'points',   s.floor_plan_polygon->'points',
             'render_hint', s.floor_plan_render_hint
           )),
           '[]'::jsonb
         )
    into v_prev_polygons
    from public.spaces s
   where s.tenant_id = v_tenant_id
     and s.parent_id = v_floor_id
     and s.floor_plan_polygon is not null;

  insert into public.floor_plan_publish_history
    (tenant_id, floor_space_id, image_url, width_px, height_px, labels, polygons, published_by, published_at)
  values
    (v_tenant_id, v_floor_id, v_prev_image, v_prev_w, v_prev_h,
     coalesce(v_prev_labels, '[]'::jsonb), v_prev_polygons, v_draft.created_by, now())
  returning id into v_history_id;

  -- 2. Upsert canonical floor_plans row
  insert into public.floor_plans (tenant_id, space_id, image_url, width_px, height_px, labels)
  values (v_tenant_id, v_floor_id, v_draft.image_url, v_draft.width_px, v_draft.height_px,
          coalesce(v_draft.labels, '[]'::jsonb))
  on conflict (space_id) do update
    set image_url  = excluded.image_url,
        width_px   = excluded.width_px,
        height_px  = excluded.height_px,
        labels     = excluded.labels,
        updated_at = now();

  -- 3. Collect space_ids referenced in the draft
  select coalesce(array_agg((p->>'space_id')::uuid), '{}'::uuid[])
    into v_space_ids
    from jsonb_array_elements(v_draft.polygons) p;

  -- 4. Detach orphans (spaces previously had a polygon on this floor but aren't in the new draft)
  update public.spaces
     set floor_plan_polygon = null,
         floor_plan_render_hint = 'default'
   where tenant_id = v_tenant_id
     and parent_id = v_floor_id
     and floor_plan_polygon is not null
     and id <> all(v_space_ids);

  -- 5. Apply new polygons. Re-wrap into {points:[…]} shape per CHECK constraint.
  for v_polygon in select jsonb_array_elements(v_draft.polygons) loop
    update public.spaces
       set floor_plan_polygon = jsonb_build_object('points', v_polygon->'points'),
           floor_plan_render_hint = coalesce(v_polygon->>'render_hint', 'default')
     where id = (v_polygon->>'space_id')::uuid
       and tenant_id = v_tenant_id
       and parent_id = v_floor_id;
  end loop;

  -- 6. Audit (correct audit_events shape per 00019)
  insert into public.audit_events
    (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
  values
    (v_tenant_id, 'floor_plan.published', 'floor_plan', v_floor_id, v_draft.created_by,
     jsonb_build_object(
       'draft_id', p_draft_id,
       'history_id', v_history_id,
       'polygon_count', jsonb_array_length(v_draft.polygons)
     ));

  -- 7. Draft already deleted at the top via DELETE ... RETURNING *.

  return jsonb_build_object('history_id', v_history_id);
end;
$$;

revoke all on function public.publish_floor_plan_draft(uuid) from public;
grant execute on function public.publish_floor_plan_draft(uuid) to authenticated;

notify pgrst, 'reload schema';
