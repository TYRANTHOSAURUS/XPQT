-- Slice C codex remediation — create_pm_work_order v3:
--   * v1 HONESTY: do NOT stamp work_orders.workflow_id
--   * sla_timers.recompute_pending = true (forward-compat with a future
--     polymorphic SLA recompute handler)
--
-- ── Why workflow_id stays NULL on PM-WOs in v1 ──────────────────────────
--
-- WorkflowStartHandler (apps/api/src/modules/outbox/handlers/workflow-
-- start.handler.ts:80-95) reads `tickets.workflow_id` only. It does NOT
-- read `work_orders.workflow_id`. v2 (00397) inherited workflow_id from
-- request_types — which made PM-WOs APPEAR workflow-configured while
-- silently never starting an instance.
--
-- Two ways to close that gap:
--   (a) Stamp workflow_id on PM-WOs + ALSO ship a polymorphic workflow-
--       start path for work_orders. That's a Phase 2 universal-workflow
--       deliverable (see memory project_universal_workflow_phase1_
--       complete) — out of scope for Slice C v1.
--   (b) DON'T stamp workflow_id on PM-WOs in v1. Admins see NULL +
--       know workflows don't fire for PM today. Phase 2 closes the gap.
--
-- v3 picks (b). When polymorphic workflow handlers land, this RPC will
-- be revisited to stamp workflow_id again.
--
-- sla_id continues to be inherited. The SLA-timer-recompute handler
-- (sla-timer-recompute.handler.ts) is tickets-only TODAY, but the
-- timers themselves render correctly off `due_at` regardless — the
-- only loss is business-hours recompute on the first run, which a
-- future polymorphic SLA handler will back-fill via `recompute_pending`.
--
-- ── Why recompute_pending = true on the sla_timers inserts ──────────
--
-- 00397 set recompute_pending=false based on the (true) observation
-- that no work_order-aware recompute handler exists today. But the
-- column is a marker for "this timer's due_at is wall-clock; recompute
-- when a calendar-aware handler can". Flipping it to TRUE means the
-- future polymorphic handler back-fills business-hours adjustment
-- automatically — no second migration needed. Downside is zero today
-- (no handler reads it).
--
-- Citations:
--   - 00397                  v2 body (replaced wholesale here)
--   - workflow-start.handler.ts:80-95  reads tickets.workflow_id only
--   - sla-timer-recompute.handler.ts   ticket-shaped recompute handler
--   - memory project_universal_workflow_phase1_complete  Phase 2 plan
--   - ai/slice-c-plan.md     v1 limitation tracked

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
  v_asset_lifecycle text;
  v_title           text;
  v_description     text;
  v_actor_person_id uuid;
  v_wo_id           uuid;
  v_request_type    record;
  v_sla_id          uuid;
  v_sla_policy      record;
  v_response_due_at timestamptz;
  v_resolution_due_at timestamptz;
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

  select a.name, a.assigned_space_id, a.lifecycle_state
    into v_asset_name, v_asset_space_id, v_asset_lifecycle
    from public.assets a
   where a.id = p_asset_id
     and a.tenant_id = v_plan.tenant_id;

  if not found then
    raise exception 'create_pm_work_order.asset_not_in_tenant: asset=% tenant=%',
      p_asset_id, v_plan.tenant_id
      using errcode = 'P0001';
  end if;

  if v_asset_lifecycle not in ('active', 'maintenance') then
    return null;
  end if;

  -- Inherit sla only (workflow_id intentionally left NULL — see header).
  select rt.sla_policy_id, rt.active
    into v_request_type
    from public.request_types rt
   where rt.id = v_plan.request_type_id
     and rt.tenant_id = v_plan.tenant_id
   for share;

  if not found or not coalesce(v_request_type.active, false) then
    raise exception 'create_pm_work_order.request_type_inactive: id=%',
      v_plan.request_type_id
      using errcode = 'P0002';
  end if;

  v_sla_id := v_request_type.sla_policy_id;

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
    workflow_id,
    sla_id,
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
    null,
    v_sla_id,
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

  insert into public.routing_decisions (
    tenant_id, ticket_id,
    entity_kind, case_id, work_order_id,
    strategy, chosen_team_id, chosen_user_id, chosen_vendor_id,
    chosen_by, rule_id, trace, context
  ) values (
    v_plan.tenant_id,
    v_wo_id,
    'work_order',
    null,
    v_wo_id,
    'pm_generator',
    null, null, null,
    'unassigned',
    null,
    '[]'::jsonb,
    jsonb_build_object(
      'source',          'pm_generator',
      'plan_id',         p_plan_id,
      'asset_id',        p_asset_id,
      'request_type_id', v_plan.request_type_id,
      'location_id',     coalesce(v_plan.location_id, v_asset_space_id)
    )
  );

  if v_sla_id is not null then
    select sp.response_time_minutes, sp.resolution_time_minutes,
           sp.business_hours_calendar_id
      into v_sla_policy
      from public.sla_policies sp
     where sp.id = v_sla_id
       and sp.tenant_id = v_plan.tenant_id;

    if found then
      if v_sla_policy.response_time_minutes is not null then
        v_response_due_at := p_run_at + (v_sla_policy.response_time_minutes || ' minutes')::interval;
        insert into public.sla_timers (
          tenant_id, ticket_id, sla_policy_id, timer_type,
          target_minutes, due_at, business_hours_calendar_id,
          paused, recompute_pending,
          entity_kind, case_id, work_order_id, started_at
        ) values (
          v_plan.tenant_id, v_wo_id, v_sla_id, 'response',
          v_sla_policy.response_time_minutes, v_response_due_at,
          v_sla_policy.business_hours_calendar_id,
          false, true,
          'work_order', null, v_wo_id, p_run_at
        );
      end if;

      if v_sla_policy.resolution_time_minutes is not null then
        v_resolution_due_at := p_run_at + (v_sla_policy.resolution_time_minutes || ' minutes')::interval;
        insert into public.sla_timers (
          tenant_id, ticket_id, sla_policy_id, timer_type,
          target_minutes, due_at, business_hours_calendar_id,
          paused, recompute_pending,
          entity_kind, case_id, work_order_id, started_at
        ) values (
          v_plan.tenant_id, v_wo_id, v_sla_id, 'resolution',
          v_sla_policy.resolution_time_minutes, v_resolution_due_at,
          v_sla_policy.business_hours_calendar_id,
          false, true,
          'work_order', null, v_wo_id, p_run_at
        );
      end if;

      update public.work_orders
         set sla_response_due_at   = coalesce(v_response_due_at, sla_response_due_at),
             sla_resolution_due_at = coalesce(v_resolution_due_at, sla_resolution_due_at),
             updated_at            = now()
       where id = v_wo_id and tenant_id = v_plan.tenant_id;
    end if;
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
      'source',          'generator',
      'event',           'plan_spawned',
      'plan_id',         p_plan_id,
      'asset_id',        p_asset_id,
      'workflow_id',     null,
      'sla_id',          v_sla_id
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
  'Slice C codex remediation v3 — workflow_id intentionally NULL (WorkflowStartHandler reads tickets only; stamping work_orders.workflow_id silently no-ops in v1). sla_timers stamped with recompute_pending=true for forward-compat with future polymorphic SLA recompute handler. Identical otherwise to v2 (00397) — atomic spawn locks plan + request_type, inherits sla_id, writes routing_decisions (strategy=pm_generator, chosen_by=unassigned), sla_timers (response + resolution), ticket_activities, advances last_generated_at. Idempotent via uq_work_orders_pm_occurrence; ON CONFLICT returns null.';

notify pgrst, 'reload schema';
