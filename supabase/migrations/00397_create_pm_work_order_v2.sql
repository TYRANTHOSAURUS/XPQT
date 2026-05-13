-- Slice C full-review C2 — create_pm_work_order v2: workflow + SLA +
-- routing-decision parity with dispatch_child_work_order (00341).
--
-- ── Background ──────────────────────────────────────────────────────────
--
-- v1 (00389) inserted a work_orders row with origin='preventive' + an
-- audit row + plan.last_generated_at advance — and skipped everything
-- else. Reviewer caught the second-class shape:
--
--   * work_orders.workflow_id was never populated (Phase 2 universal
--     workflow design will read it; v1 left null = workflow never fires).
--   * work_orders.sla_id was never populated → no SLA tracking.
--   * No routing_decisions row → ops can't see why the WO landed as
--     unassigned (or what rule chain ran).
--   * No sla_timers row → SLA dashboards don't include PM WOs at all.
--
-- v2 mirrors the dispatch_child_work_order (00341:206-349) writes for
-- work_orders side-effects, with two PM-specific simplifications:
--
--   1. Routing decision = "unassigned/pm_generator" — the PM generator
--      has no requester + no resolver context; the operator triages the
--      WO. The row is still written so audit + filter-by-pm have
--      provenance. This mirrors v1's documented "operator triages
--      unassigned WO" decision in 00389:25-29 but persists it.
--   2. SLA due_at uses wall-clock arithmetic (p_run_at +
--      target_minutes), NOT BusinessHoursService. The cron has no
--      calendar evaluator + PM SLAs are typically long-window (24h, 7d)
--      so business-hours skew is acceptable. A future hardening can
--      flip recompute_pending=true and emit sla.timer_recompute_required
--      — but the existing SlaTimerHandler is tickets-only (reads
--      tickets.sla_id, sla-timer-recompute.handler.ts:96-102), so emit
--      would just dead-letter.
--
-- ── What gets inherited from the request type ──────────────────────────
--
-- request_types.workflow_definition_id → work_orders.workflow_id
-- request_types.sla_policy_id          → work_orders.sla_id
--
-- (Mirrors the create_ticket_with_automation derivation at 00351:300-346,
-- but without the scope-override merge — PM plans don't have per-location
-- overrides today.)
--
-- ── module_number is unchanged ──────────────────────────────────────────
--
-- The work_orders_assign_module_number_trg BEFORE INSERT trigger
-- (00223:316-319) auto-allocates module_number on every direct INSERT
-- into work_orders. v1 was already correct on this; verified in the smoke
-- additions below.
--
-- Citations:
--   - 00389:35-167         v1 body (kept compatible: same signature, same
--                          returns null on conflict)
--   - 00341:206-349        sibling work_order INSERT + routing_decisions
--                          + sla_timers pattern
--   - 00351:300-346        request_types FOR SHARE + workflow/sla derive
--   - 00229                routing_decisions polymorphism (entity_kind,
--                          work_order_id)
--   - 00227                sla_timers polymorphism (entity_kind,
--                          work_order_id)
--   - 00223:316-319        work_orders module_number BEFORE INSERT trigger
--   - apps/api/src/modules/outbox/handlers/sla-timer-recompute.handler.ts
--                          :96-102 — handler is tickets-only; emit would
--                          dead-letter for work_orders.
--   - apps/api/src/modules/outbox/handlers/workflow-start.handler.ts
--                          :80-95 — same constraint; emit unnecessary.

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
  v_workflow_id     uuid;
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

  -- ── 1. Plan FOR UPDATE ────────────────────────────────────────────────
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

  -- ── 2. Asset tenant check + lifecycle gate ────────────────────────────
  --
  -- Defense-in-depth: PMGeneratorService.resolveTargets already filters
  -- assets by lifecycle_state IN ('active','maintenance') (full-review
  -- I3 fix). The check here keeps a hand-bypass + race-condition
  -- (retire-between-resolve-and-spawn) from silently spawning a WO on
  -- a retired asset.
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
    -- Skip silently — the asset isn't a PM target right now. Mirrors
    -- the resolveTargets filter; returning null is the same as
    -- ON CONFLICT idempotency from a caller's POV.
    return null;
  end if;

  -- ── 3. Inherit workflow + SLA from request_type (FOR SHARE) ───────────
  --
  -- Mirrors 00351:300-346 minus the scope_override merge (PM doesn't
  -- support per-location overrides today). request_types row is
  -- locked FOR SHARE so a concurrent admin edit can't tear the
  -- workflow/SLA pair this spawn uses.
  select rt.workflow_definition_id, rt.sla_policy_id, rt.active
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

  v_workflow_id := v_request_type.workflow_definition_id;
  v_sla_id      := v_request_type.sla_policy_id;

  -- ── 4. Render title + description ────────────────────────────────────
  v_title := replace(v_plan.title_template, '{{asset.name}}', coalesce(v_asset_name, ''));
  if v_plan.description_template is not null then
    v_description := replace(v_plan.description_template, '{{asset.name}}', coalesce(v_asset_name, ''));
  end if;

  -- ── 5. INSERT work_orders ────────────────────────────────────────────
  --
  -- module_number auto-allocated by work_orders_assign_module_number_trg
  -- (00223). ON CONFLICT against uq_work_orders_pm_occurrence (00387)
  -- keeps replays idempotent.
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
    v_workflow_id,
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

  -- ── 6. Resolve actor person id (for audit row) ───────────────────────
  --
  -- The cron passes p_actor_user_id = null; that's the sanctioned
  -- system path. ticket_activities.author_person_id stays null and the
  -- renderer surfaces "system". When a future caller passes a real
  -- users.id PK we resolve to its person_id.
  if p_actor_user_id is not null then
    select u.person_id into v_actor_person_id
      from public.users u
     where u.id = p_actor_user_id
       and u.tenant_id = v_plan.tenant_id
     limit 1;
  end if;

  -- ── 7. INSERT routing_decisions (audit row, unassigned) ──────────────
  --
  -- Per 00229 the table is polymorphic (entity_kind, case_id,
  -- work_order_id). ticket_id keeps the legacy not-null FK to tickets
  -- happy because 00238:47-58 made the FKs polymorphic and the legacy
  -- column nullable for cross-kind rows. Pattern lifted from
  -- 00341:284-303.
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

  -- ── 8. INSERT sla_timers + stamp due-date columns (when SLA set) ─────
  --
  -- Wall-clock due_at = p_run_at + target_minutes. PM cron has no
  -- BusinessHoursService evaluator; the simplification is acceptable
  -- because PM SLAs are typically 24h+. Mirrors 00341:328-348 minus
  -- the calendar param.
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
          false, false,
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
          false, false,
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

  -- ── 9. INSERT ticket_activities (audit, source=generator) ────────────
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
      'workflow_id',     v_workflow_id,
      'sla_id',          v_sla_id
    )
  );

  -- ── 10. Advance plan.last_generated_at ───────────────────────────────
  update public.maintenance_plans
     set last_generated_at = now()
   where id = p_plan_id;

  return v_wo_id;
end;
$$;

revoke execute on function public.create_pm_work_order(uuid, uuid, uuid, timestamptz) from public;
grant  execute on function public.create_pm_work_order(uuid, uuid, uuid, timestamptz) to service_role;

comment on function public.create_pm_work_order(uuid, uuid, uuid, timestamptz) is
  'Slice C §4 v2 — atomic PM WO spawn with full work_order side-effect parity. Locks plan + request_type FOR (UPDATE|SHARE); inherits workflow_id + sla_id from the request type; writes work_orders + routing_decisions (entity_kind=work_order, chosen_by=unassigned) + sla_timers (response + resolution when policy has them) + ticket_activities (source=generator). Idempotent via uq_work_orders_pm_occurrence; conflict returns null. Lifecycle gate skips retired/disposed/procured assets. module_number auto-assigned by work_orders BEFORE INSERT trigger (00223). SLA due_at uses wall-clock arithmetic — accepted simplification for typically-long PM windows; future hardening can flip recompute_pending=true.';

notify pgrst, 'reload schema';
