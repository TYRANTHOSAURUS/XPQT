-- Slice C — PM generator §4: create_pm_work_order RPC.
--
-- Spec: ai/slice-c-plan.md §4 (lines 176-207).
--
-- Sibling of public.create_ticket_with_automation (00351) but writes to
-- public.work_orders. Atomic plan-lock + WO insert + audit + plan
-- last_generated_at advance. Idempotent at the row layer via
-- uq_work_orders_pm_occurrence (00387) — replays skip silently.
--
-- Contract:
--   p_plan_id        — maintenance_plans.id (locked FOR UPDATE)
--   p_actor_user_id  — users.id (PK), NOT auth.users.uid. The caller is
--                       the generator cron, which threads a service
--                       user; conform to that contract here (the
--                       audit row's author_person_id is resolved via
--                       users.person_id lookup).
--   p_asset_id       — the specific asset to spawn against; for an
--                       asset-type plan, called once per asset in the
--                       set.
--   p_run_at         — planned_start_at to stamp on the spawned WO.
--
-- Returns: uuid of the inserted WO, or null if the occurrence already
-- existed (ON CONFLICT DO NOTHING fired).
--
-- v1 routing decision: left null. The work order surfaces unassigned
-- on the planning board for an operator to triage. Inlining the
-- resolver would significantly expand scope (asset-branch resolution
-- + scope-override merge + routing_rules + routing_decisions write)
-- and is deferred to v1.5.
--
-- Title template v1: simple `replace(title_template, '{{asset.name}}',
-- asset.name)`. No nested tokens, no conditionals — full template
-- engine deferred to v1.5.

create or replace function public.create_pm_work_order(
  p_plan_id        uuid,
  p_actor_user_id  uuid,
  p_asset_id       uuid,
  p_run_at         timestamptz
) returns uuid
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_plan            public.maintenance_plans;
  v_asset_name      text;
  v_asset_space_id  uuid;
  v_title           text;
  v_description     text;
  v_actor_person_id uuid;
  v_wo_id           uuid;
begin
  if p_plan_id is null then
    raise exception 'create_pm_work_order: p_plan_id required';
  end if;
  if p_asset_id is null then
    raise exception 'create_pm_work_order: p_asset_id required';
  end if;
  if p_run_at is null then
    raise exception 'create_pm_work_order: p_run_at required';
  end if;

  select * into v_plan
    from public.maintenance_plans
   where id = p_plan_id
   for update;

  if not found then
    raise exception 'create_pm_work_order.plan_not_found: id=%', p_plan_id
      using errcode = 'P0002';
  end if;

  if v_plan.active is not true then
    return null;
  end if;

  select a.name, a.assigned_space_id
    into v_asset_name, v_asset_space_id
    from public.assets a
   where a.id = p_asset_id
     and a.tenant_id = v_plan.tenant_id;

  if not found then
    raise exception 'create_pm_work_order.asset_not_in_tenant: asset=% tenant=%',
      p_asset_id, v_plan.tenant_id
      using errcode = 'P0001';
  end if;

  v_title := replace(v_plan.title_template, '{{asset.name}}', coalesce(v_asset_name, ''));
  if v_plan.description_template is not null then
    v_description := replace(v_plan.description_template, '{{asset.name}}', coalesce(v_asset_name, ''));
  end if;

  insert into public.work_orders (
    tenant_id,
    title,
    description,
    status,
    status_category,
    priority,
    interaction_mode,
    ticket_type_id,
    asset_id,
    location_id,
    planned_start_at,
    planned_duration_minutes,
    origin,
    maintenance_plan_id,
    source_asset_id
  ) values (
    v_plan.tenant_id,
    v_title,
    v_description,
    'new',
    'new',
    v_plan.priority,
    'internal',
    v_plan.request_type_id,
    p_asset_id,
    coalesce(v_plan.location_id, v_asset_space_id),
    p_run_at,
    v_plan.planned_duration_minutes,
    'preventive',
    p_plan_id,
    p_asset_id
  )
  on conflict (tenant_id, maintenance_plan_id, source_asset_id, planned_start_at)
    where maintenance_plan_id is not null
    do nothing
  returning id into v_wo_id;

  if v_wo_id is null then
    return null;
  end if;

  if p_actor_user_id is not null then
    select u.person_id into v_actor_person_id
      from public.users u
     where u.id = p_actor_user_id
       and u.tenant_id = v_plan.tenant_id
     limit 1;
  end if;

  insert into public.ticket_activities
    (tenant_id, ticket_id, activity_type, author_person_id, visibility, metadata)
  values (
    v_plan.tenant_id,
    v_wo_id,
    'system_event',
    v_actor_person_id,
    'system',
    jsonb_build_object(
      'source',   'generator',
      'event',    'plan_spawned',
      'plan_id',  p_plan_id,
      'asset_id', p_asset_id
    )
  );

  update public.maintenance_plans
     set last_generated_at = now()
   where id = p_plan_id;

  return v_wo_id;
end;
$$;

revoke execute on function public.create_pm_work_order(uuid, uuid, uuid, timestamptz) from public;
grant  execute on function public.create_pm_work_order(uuid, uuid, uuid, timestamptz) to service_role;

comment on function public.create_pm_work_order(uuid, uuid, uuid, timestamptz) is
  'Slice C §4 — atomic PM WO spawn. Locks plan FOR UPDATE, inserts work_order with origin=preventive, stamps audit metadata.source=generator, advances plan.last_generated_at. Idempotent via uq_work_orders_pm_occurrence; conflict returns null. Routing decision left null in v1 — operator triages unassigned WO.';

notify pgrst, 'reload schema';
