-- 00374_restore_floor_plan_publish_history_rpc.sql
-- Restore a previous publish snapshot. Atomic. Creates its own history row
-- of the current state before applying the snapshot.

create or replace function public.restore_floor_plan_publish(p_history_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_h public.floor_plan_publish_history%rowtype;
  v_tenant_id uuid;
  v_floor_id uuid;
  v_polygon jsonb;
  v_space_ids uuid[];
  v_current_polygons jsonb;
  v_current_floor public.floor_plans%rowtype;
  v_new_history uuid;
begin
  -- Lock the history row to serialize concurrent restores of the same snapshot.
  select * into v_h from public.floor_plan_publish_history where id = p_history_id for update;
  if v_h.id is null then raise exception 'floor_plan.history.not_found' using errcode = 'P0002'; end if;
  if v_h.tenant_id <> public.current_tenant_id() then raise exception 'floor_plan.history.cross_tenant' using errcode = '42501'; end if;

  v_tenant_id := v_h.tenant_id;
  v_floor_id  := v_h.floor_space_id;

  -- snapshot current state first (so the restore itself is reversible)
  select * into v_current_floor from public.floor_plans where space_id = v_floor_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'space_id', s.id,
    'points',   s.floor_plan_polygon->'points',
    'render_hint', s.floor_plan_render_hint
  )), '[]'::jsonb)
    into v_current_polygons
    from public.spaces s
   where s.tenant_id = v_tenant_id and s.parent_id = v_floor_id and s.floor_plan_polygon is not null;

  insert into public.floor_plan_publish_history
    (tenant_id, floor_space_id, image_url, width_px, height_px, labels, polygons, published_by, published_at)
  values
    (v_tenant_id, v_floor_id,
     v_current_floor.image_url, v_current_floor.width_px, v_current_floor.height_px,
     coalesce(v_current_floor.labels, '[]'::jsonb), v_current_polygons,
     null, now())
  returning id into v_new_history;

  -- apply snapshot to floor_plans
  insert into public.floor_plans (tenant_id, space_id, image_url, width_px, height_px, labels)
  values (v_tenant_id, v_floor_id, v_h.image_url, v_h.width_px, v_h.height_px, v_h.labels)
  on conflict (space_id) do update
    set image_url = excluded.image_url,
        width_px = excluded.width_px,
        height_px = excluded.height_px,
        labels = excluded.labels,
        updated_at = now();

  -- collect space_ids present in the snapshot
  select coalesce(array_agg((p->>'space_id')::uuid), '{}'::uuid[])
    into v_space_ids
    from jsonb_array_elements(v_h.polygons) p;

  -- detach polygons for spaces NOT in the snapshot
  update public.spaces
     set floor_plan_polygon = null, floor_plan_render_hint = 'default'
   where tenant_id = v_tenant_id and parent_id = v_floor_id
     and floor_plan_polygon is not null and id <> all(v_space_ids);

  -- apply snapshot polygons in canonical {points:[...]} shape
  for v_polygon in select jsonb_array_elements(v_h.polygons) loop
    update public.spaces
       set floor_plan_polygon = jsonb_build_object('points', v_polygon->'points'),
           floor_plan_render_hint = coalesce(v_polygon->>'render_hint', 'default')
     where id = (v_polygon->>'space_id')::uuid
       and tenant_id = v_tenant_id and parent_id = v_floor_id;
  end loop;

  -- audit trail
  insert into public.audit_events
    (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
  values
    (v_tenant_id, 'floor_plan.restored', 'floor_plan', v_floor_id, null,
     jsonb_build_object('source_history_id', p_history_id, 'new_history_id', v_new_history));
end;
$$;

revoke all on function public.restore_floor_plan_publish(uuid) from public;
grant execute on function public.restore_floor_plan_publish(uuid) to authenticated;

notify pgrst, 'reload schema';
