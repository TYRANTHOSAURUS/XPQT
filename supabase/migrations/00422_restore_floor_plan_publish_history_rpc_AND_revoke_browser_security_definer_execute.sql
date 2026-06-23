-- 00422_restore_floor_plan_publish_history_rpc_AND_revoke_browser_security_definer_execute.sql
-- BUNDLED migration: two files previously both claimed version 00422.
-- Supabase tracks by version prefix; duplicate breaks schema_migrations
-- PK on CI db:reset. Remote prod has both contents applied via direct
-- psql; this bundle is a no-op there. Locally, both sections apply
-- atomically at 00422.
--
-- Section 1: restore_floor_plan_publish_history_rpc (originally 00422_restore_floor_plan_publish_history_rpc.sql)
-- Section 2: revoke_browser_security_definer_execute (originally 00422_revoke_browser_security_definer_execute.sql)

-- ============ SECTION 1: restore_floor_plan_publish_history_rpc ============
-- 00422_restore_floor_plan_publish_history_rpc.sql
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

-- ============ SECTION 2: revoke_browser_security_definer_execute ============
-- 00422 — Browser EXECUTE hardening for app-owned SECURITY DEFINER routines.
--
-- 00417 tried to solve the browser-direct RPC leak by revoking EXECUTE on
-- every public routine. That broke normal browser/PostgREST reads because RLS
-- policies execute helper functions such as current_tenant_id() as the
-- querying role. 00420 correctly restored helper EXECUTE and narrowly blocked
-- the proven tickets_distinct_tags(uuid) leak.
--
-- This migration completes the posture without repeating 00417's mistake:
-- browser roles keep EXECUTE on the RLS/bearer-token allowlist, but lose
-- EXECUTE on every other app-owned SECURITY DEFINER routine. Those functions
-- bypass RLS/table grants and are intended for NestJS service_role/postgres
-- callers or trigger execution, not direct browser RPC.
--
-- Deliberately not a schema-wide/default-privilege blanket revoke. Future RLS
-- helper functions must remain callable by browser roles; the smoke gate owns
-- the "no risky SECURITY DEFINER browser EXECUTE" regression check.

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.prosecdef
      and p.proname not in (
        -- Anonymous/bearer-token flows, reviewed in Audit 04 P2.
        'validate_invitation_token',
        'peek_invitation_token',
        'validate_kiosk_token',
        -- RLS helper used by GDPR policies. Revoking it breaks normal reads.
        'gdpr_caller_has'
      )
  loop
    execute format(
      'revoke execute on function %s from public, anon, authenticated',
      fn.signature
    );
  end loop;
end $$;

-- Re-assert the allowlist explicitly so the migration is safe after either a
-- fresh reset or a hand-restored remote state.
grant execute on function public.validate_invitation_token(text, text)
  to anon, authenticated;
grant execute on function public.peek_invitation_token(text, text)
  to anon, authenticated;
grant execute on function public.validate_kiosk_token(text)
  to anon, authenticated;
grant execute on function public.gdpr_caller_has(text)
  to anon, authenticated;

-- Preserve the API path for all app-owned SECURITY DEFINER routines.
grant execute on all routines in schema public to service_role;

notify pgrst, 'reload schema';
