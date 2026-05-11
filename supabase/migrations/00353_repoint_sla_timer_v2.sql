-- B.2.A.Step11 commit 1 — repoint_sla_timer v2 (accept p_started_at).
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.10 line 2754 +
--       §3.9.3 line 2771-2777 (SlaTimerRepointHandler contract).
-- Builds on: 00348_repoint_sla_timer_rpc.sql.
--
-- ── Why v2 ──────────────────────────────────────────────────────────────
--
-- Mirrors the Step 12 codex-S12-I2 remediation that introduced p_started_at
-- to start_sla_timers (00352). Pre-v2 (00348:182) the RPC stamped
-- `started_at = now()` at INSERT time regardless of when the handler
-- computed `due_at`. For the post-reclassify path the event payload
-- carries `started_at = now() at reclassify time` (spec §3.10 step 10);
-- if the outbox lags N seconds the persisted `started_at` is N seconds
-- AFTER the canonical clock-start, skewing `at-risk` percent math
-- (sla.service.ts:523 — `(now - started_at) / (due_at - started_at)`).
--
-- v2 accepts `p_started_at timestamptz default null` as a 6th argument.
-- Handler passes the value it used to compute `due_at`; RPC writes the
-- same value into `sla_timers.started_at`. Default `null` falls back to
-- `now()` via `coalesce` so a buggy caller doesn't NULL-violate the
-- NOT NULL column (00011).
--
-- All other 00348 behavior preserved verbatim:
--   * idempotent short-circuit on (tenant, ticket, new_policy) (v7 / I3)
--   * STOP DISTINCT FROM new policy (leave new-policy timers alone)
--   * ON CONFLICT against sla_timers_active_unique_idx (00346)
--   * polymorphic entity_kind='case' per 00227
--
-- v3 ordering / Supabase PostgREST function-overload safety: PostgREST
-- caches the function signature. Drop the legacy 5-arg flavor explicitly
-- so the new (6-arg) shape becomes the unambiguous default. The handler
-- always sends `p_started_at` by name post-cutover.
drop function if exists public.repoint_sla_timer(uuid, uuid, uuid, jsonb, text);

create or replace function public.repoint_sla_timer(
  p_tenant_id      uuid,
  p_ticket_id      uuid,
  p_sla_policy_id  uuid,
  p_timers         jsonb,
  p_reason         text,
  p_started_at     timestamptz default null
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_ticket_exists      boolean;
  v_timers_count       int;
  v_stopped_count      int := 0;
  v_inserted_count     int := 0;
  v_response_due_at    timestamptz;
  v_resolution_due_at  timestamptz;
  v_already_repointed  boolean;
  -- v2 / Step11-C1: honour caller's started_at. Default to now() so a
  -- buggy caller passing null doesn't violate sla_timers.started_at
  -- NOT NULL.
  v_effective_started_at timestamptz := coalesce(p_started_at, now());
begin
  -- ── 0. Argument shape checks ────────────────────────────────────────────
  if p_tenant_id is null then
    raise exception 'repoint_sla_timer: p_tenant_id required';
  end if;
  if p_ticket_id is null then
    raise exception 'repoint_sla_timer: p_ticket_id required';
  end if;
  if p_sla_policy_id is null then
    raise exception 'repoint_sla_timer: p_sla_policy_id required';
  end if;
  if p_timers is null
     or jsonb_typeof(p_timers) <> 'array'
     or jsonb_array_length(p_timers) = 0 then
    raise exception 'repoint_sla_timer.timers_required: payload must be a non-empty jsonb array'
      using errcode = 'P0001';
  end if;
  v_timers_count := jsonb_array_length(p_timers);

  -- ── 1. Validate sla_policy_id is tenant-owned (00340 helper) ───────────
  perform public.validate_entity_in_tenant(p_tenant_id, 'sla_policy', p_sla_policy_id);

  -- ── 2. Validate ticket exists in tenant ────────────────────────────────
  select exists (
    select 1 from public.tickets
    where id = p_ticket_id and tenant_id = p_tenant_id
  ) into v_ticket_exists;
  if not v_ticket_exists then
    raise exception 'repoint_sla_timer.ticket_not_found: id=% tenant=%', p_ticket_id, p_tenant_id
      using errcode = 'P0002';
  end if;

  -- ── 3. Validate timer_type allowlist (same as 00347) ───────────────────
  if exists (
    select 1
    from jsonb_array_elements(p_timers) t
    where t->>'timer_type' not in ('response', 'resolution')
  ) then
    raise exception 'repoint_sla_timer.unknown_timer_type: timer_type outside {response, resolution}'
      using errcode = 'P0001';
  end if;

  -- ── 4. Idempotency short-circuit (v7 / I3) ─────────────────────────────
  --
  -- If active timers already exist under the NEW policy, we've already
  -- repointed — return early.
  select exists (
    select 1 from public.sla_timers
    where tenant_id     = p_tenant_id
      and ticket_id     = p_ticket_id
      and sla_policy_id = p_sla_policy_id
      and stopped_at    is null
      and completed_at  is null
  ) into v_already_repointed;

  if v_already_repointed then
    return jsonb_build_object(
      'kind',            'already_repointed',
      'ticket_id',       p_ticket_id,
      'sla_policy_id',   p_sla_policy_id,
      'timers_inserted', 0,
      'timers_stopped',  0
    );
  end if;

  -- ── 5. STOP old active timers (DISTINCT FROM new policy) ────────────────
  update public.sla_timers
     set stopped_at     = now(),
         stopped_reason = p_reason
   where tenant_id    = p_tenant_id
     and ticket_id    = p_ticket_id
     and sla_policy_id is distinct from p_sla_policy_id
     and stopped_at   is null
     and completed_at is null;
  get diagnostics v_stopped_count = row_count;

  -- ── 6. INSERT fresh timers under the NEW policy ────────────────────────
  --
  -- v2 / Step11-C1: started_at = v_effective_started_at (caller-provided
  -- with now() fallback). Was hardcoded now() in 00348 which produced
  -- the same skewed at-risk math regression as 00347 had — fixed by
  -- 00352 for start_sla_timers; this mirrors that fix.
  insert into public.sla_timers (
    tenant_id, ticket_id, sla_policy_id, timer_type, target_minutes,
    due_at, business_hours_calendar_id,
    paused, recompute_pending,
    entity_kind, case_id, work_order_id, started_at
  )
  select
    p_tenant_id,
    p_ticket_id,
    p_sla_policy_id,
    t.timer_type,
    t.target_minutes,
    t.due_at,
    t.business_hours_calendar_id,
    false,
    false,
    'case',
    p_ticket_id,
    null,
    v_effective_started_at
  from jsonb_to_recordset(p_timers) as t(
    timer_type                 text,
    target_minutes             int,
    due_at                     timestamptz,
    business_hours_calendar_id uuid
  )
  on conflict (tenant_id, ticket_id, sla_policy_id, timer_type)
    where stopped_at is null and completed_at is null
  do nothing;
  get diagnostics v_inserted_count = row_count;

  -- ── 7. UPDATE ticket due-date columns ──────────────────────────────────
  select due_at into v_response_due_at
    from public.sla_timers
   where tenant_id     = p_tenant_id
     and ticket_id     = p_ticket_id
     and sla_policy_id = p_sla_policy_id
     and timer_type    = 'response'
     and stopped_at    is null
     and completed_at  is null
   order by started_at desc
   limit 1;

  select due_at into v_resolution_due_at
    from public.sla_timers
   where tenant_id     = p_tenant_id
     and ticket_id     = p_ticket_id
     and sla_policy_id = p_sla_policy_id
     and timer_type    = 'resolution'
     and stopped_at    is null
     and completed_at  is null
   order by started_at desc
   limit 1;

  update public.tickets
     set sla_response_due_at   = v_response_due_at,
         sla_resolution_due_at = v_resolution_due_at,
         updated_at            = now()
   where id = p_ticket_id and tenant_id = p_tenant_id;

  return jsonb_build_object(
    'kind',            'repointed',
    'ticket_id',       p_ticket_id,
    'sla_policy_id',   p_sla_policy_id,
    'timers_inserted', v_inserted_count,
    'timers_stopped',  v_stopped_count,
    'timers_requested', v_timers_count
  );
end;
$$;

revoke execute on function public.repoint_sla_timer(uuid, uuid, uuid, jsonb, text, timestamptz) from public;
grant  execute on function public.repoint_sla_timer(uuid, uuid, uuid, jsonb, text, timestamptz) to service_role;

comment on function public.repoint_sla_timer(uuid, uuid, uuid, jsonb, text, timestamptz) is
  'B.2.A.Step11 commit 1 (spec §3.10) — v2: accepts p_started_at so the handler''s computed due_at and the persisted started_at come from the same instant. Mirrors the Step 12 codex-S12-I2 fix for start_sla_timers (00352). All 00348 behavior preserved verbatim (idempotent short-circuit, STOP DISTINCT FROM new policy, ON CONFLICT DO NOTHING).';

notify pgrst, 'reload schema';
