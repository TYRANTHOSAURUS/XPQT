-- B.2.A.Step12 codex-S12-I2 remediation — start_sla_timers v2.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.11 line 3166 + §3.9.3 line 2564.
-- Builds on: 00347_start_sla_timers_rpc.sql.
--
-- ── Why v2 ──────────────────────────────────────────────────────────────
--
-- F-IMP-2 (codex-S12-I2) — `started_at` was re-stamped at RPC INSERT time
-- instead of honouring the value the handler computed from the event
-- payload.
--
-- The event payload carries `started_at` per spec v9 / P-I2 — path-
-- dependent:
--   * post-create  → `ticket.created_at` (SLA clock starts when customer
--                    asked, not when the worker happens to drain the event).
--   * post-grant   → `now()` at grant time.
--   * post-reclassify → `now()` at reclassify time.
--
-- `SlaTimerHandler.handle` (apps/api/src/modules/outbox/handlers/sla-
-- timer-recompute.handler.ts:185-198) reads the payload value, defaults
-- to `now()` only if the payload omits it (producer bug), and uses that
-- value to compute `due_at` via `BusinessHoursService.addBusinessMinutes`.
-- The computed `due_at` is correct relative to the path-dependent start
-- time.
--
-- Pre-v2 (00347:137) the RPC INSERTed `started_at = now()` regardless of
-- when the handler computed `due_at`. Result: if outbox processing lags
-- by N seconds, the persisted `sla_timers.started_at` is N seconds AFTER
-- the canonical clock-start. Downstream SLA at-risk math
-- (apps/api/src/modules/sla/sla.service.ts:523 — `(now - started_at) /
-- (due_at - started_at)`) skews: `due_at` is fixed but `started_at` is
-- pushed forward, so `total = due_at - started_at` shrinks → percentage
-- used inflates → spurious at-risk flips.
--
-- v2 fix: accept `p_started_at timestamptz` as a 5th argument. Handler
-- passes the value it used to compute `due_at`; RPC writes the same
-- value into `sla_timers.started_at`. `due_at` and `started_at` now
-- come from the same instant. Default `null` keeps the legacy-shape
-- callable but defends with `coalesce(p_started_at, now())` so an
-- accidental null doesn't NULL the column (it's NOT NULL on 00011).
--
-- Other 00347 behavior preserved verbatim — same ON CONFLICT predicate
-- against `sla_timers_active_unique_idx` (00346), same polymorphic
-- (entity_kind='case', case_id=p_ticket_id) per 00227.

-- v3 ordering / Supabase PostgREST function-overload safety: PostgREST
-- caches the function signature. Drop the legacy 4-arg flavor explicitly
-- so the new (5-arg) shape becomes the unambiguous default. The handler
-- always sends `p_started_at` by name post-cutover.
drop function if exists public.start_sla_timers(uuid, uuid, uuid, jsonb);

create or replace function public.start_sla_timers(
  p_tenant_id      uuid,
  p_ticket_id      uuid,
  p_sla_policy_id  uuid,
  p_timers         jsonb,
  p_started_at     timestamptz default null
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_ticket_exists      boolean;
  v_timers_count       int;
  v_inserted_count     int := 0;
  v_response_due_at    timestamptz;
  v_resolution_due_at  timestamptz;
  -- v2 / codex-S12-I2: honour caller's started_at (handler computed
  -- due_at from this value). Default to now() so a buggy caller passing
  -- null doesn't violate sla_timers.started_at NOT NULL.
  v_effective_started_at timestamptz := coalesce(p_started_at, now());
begin
  -- ── 0. Argument shape checks ────────────────────────────────────────────
  if p_tenant_id is null then
    raise exception 'start_sla_timers: p_tenant_id required';
  end if;
  if p_ticket_id is null then
    raise exception 'start_sla_timers: p_ticket_id required';
  end if;
  if p_sla_policy_id is null then
    raise exception 'start_sla_timers: p_sla_policy_id required';
  end if;
  if p_timers is null
     or jsonb_typeof(p_timers) <> 'array'
     or jsonb_array_length(p_timers) = 0 then
    raise exception 'start_sla_timers.timers_required: payload must be a non-empty jsonb array'
      using errcode = 'P0001';
  end if;
  v_timers_count := jsonb_array_length(p_timers);

  -- ── 1. Validate sla_policy_id is tenant-owned (00340 helper) ───────────
  perform public.validate_entity_in_tenant(p_tenant_id, 'sla_policy', p_sla_policy_id);

  -- ── 2. Validate ticket exists in tenant ────────────────────────────────
  -- The handler already re-read ticket.sla_id at fire time, but defense-
  -- in-depth: the RPC re-asserts the case row exists before we attach
  -- timers + UPDATE due-date columns. Hard-delete between handler dispatch
  -- and RPC commit would otherwise leave orphan timers.
  select exists (
    select 1 from public.tickets
    where id = p_ticket_id and tenant_id = p_tenant_id
  ) into v_ticket_exists;
  if not v_ticket_exists then
    raise exception 'start_sla_timers.ticket_not_found: id=% tenant=%', p_ticket_id, p_tenant_id
      using errcode = 'P0002';
  end if;

  -- ── 3. Validate every timer_type in the payload is in allowlist ────────
  -- Schema (00008_sla_policies + 00011_tickets) only defines 'response' and
  -- 'resolution'. Reject anything else loudly so a buggy handler can't
  -- write a timer the breach cron silently ignores.
  if exists (
    select 1
    from jsonb_array_elements(p_timers) t
    where t->>'timer_type' not in ('response', 'resolution')
  ) then
    raise exception 'start_sla_timers.unknown_timer_type: timer_type outside {response, resolution}'
      using errcode = 'P0001';
  end if;

  -- ── 4. INSERT timer rows atomically (ON CONFLICT DO NOTHING on 00346) ──
  --
  -- Matches the structure of 00328 update_entity_sla (lines 297-323).
  -- recompute_pending=false on fresh inserts (handler computed real
  -- due_at via BusinessHoursService). paused=false. entity_kind='case'
  -- + case_id=p_ticket_id per the 00227 polymorphic convention;
  -- ticket_id stays as the legacy bridge column.
  --
  -- v2 / codex-S12-I2: started_at = v_effective_started_at (caller value
  -- with now() fallback). Was hardcoded now() in 00347 which produced
  -- skewed at-risk percent when the outbox worker lagged.
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
  -- ON CONFLICT against the partial unique index 00346 (matching its
  -- index_predicate so PG infers the right arbiter index).
  on conflict (tenant_id, ticket_id, sla_policy_id, timer_type)
    where stopped_at is null and completed_at is null
  do nothing;

  get diagnostics v_inserted_count = row_count;

  -- ── 5. UPDATE ticket due-date columns from the inserted timers ─────────
  --
  -- Read back the due_at for response + resolution timer (whatever was
  -- inserted just now OR what already existed on a replay). We always
  -- mirror the canonical active timer's due_at onto the ticket row so
  -- the UI is consistent regardless of whether the insert hit ON CONFLICT.
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
     set sla_response_due_at   = coalesce(v_response_due_at,   sla_response_due_at),
         sla_resolution_due_at = coalesce(v_resolution_due_at, sla_resolution_due_at),
         updated_at            = now()
   where id = p_ticket_id and tenant_id = p_tenant_id;

  return jsonb_build_object(
    'ticket_id',       p_ticket_id,
    'sla_policy_id',   p_sla_policy_id,
    'timers_inserted', v_inserted_count,
    'timers_requested', v_timers_count
  );
end;
$$;

revoke execute on function public.start_sla_timers(uuid, uuid, uuid, jsonb, timestamptz) from public;
grant  execute on function public.start_sla_timers(uuid, uuid, uuid, jsonb, timestamptz) to service_role;

comment on function public.start_sla_timers(uuid, uuid, uuid, jsonb, timestamptz) is
  'B.2.A.Step12 §3.11 v2 (codex-S12-I2) — atomic SLA-timer start. Accepts p_started_at so the handler''s computed due_at and the persisted started_at come from the same instant (was hardcoded now() in 00347, which skewed at-risk math when the outbox worker lagged). Idempotent via ON CONFLICT DO NOTHING against sla_timers_active_unique_idx (00346). Polymorphic per 00227 (entity_kind=''case'', case_id=p_ticket_id).';

notify pgrst, 'reload schema';
