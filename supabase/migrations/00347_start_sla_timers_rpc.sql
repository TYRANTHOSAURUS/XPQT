-- B.2.A.Step12 commit 1 — start_sla_timers RPC.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.11 lines 286-291,
--       3166 + §3.9.3 line 2564 (SlaTimerHandler contract).
--
-- ── Why ───────────────────────────────────────────────────────────────────
--
-- Called by `SlaTimerHandler` (apps/api/src/modules/outbox/handlers/sla-
-- timer-recompute.handler.ts) for the post-create + post-grant SLA
-- timer flows. INSERTs timer rows + UPDATEs ticket due-dates in ONE
-- PG transaction (spec §3.9.3 line 2564 "INSERT timer rows + UPDATE
-- tickets.sla_response_due_at / sla_resolution_due_at in one PG
-- transaction"). v6 / C2 — eliminates the legacy TS multi-write.
--
-- Idempotency: `INSERT ... ON CONFLICT DO NOTHING` against the partial
-- unique index in 00346 (sla_timers_active_unique_idx). Replay-safe:
-- a second call with the same (tenant, ticket, policy, timer_type)
-- skips the row. The ticket-row due_at UPDATEs only fire if a fresh
-- insert happened, so retried events don't reset due_at on a
-- repointed-then-replayed timer.
--
-- Polymorphic columns (v9 / C-Nit per migration 00227):
--   entity_kind='case', case_id=p_ticket_id, work_order_id=null,
--   ticket_id=p_ticket_id (legacy bridge column).
-- This RPC is case-only (post-create SLA timers attach to the case, not
-- a child work_order — child WO timers go through dispatch).
--
-- Input contract — p_timers jsonb array shape (same as 00328 update_entity_sla):
--   [{ timer_type: 'response'|'resolution',
--      target_minutes: int,
--      due_at: timestamptz,
--      business_hours_calendar_id: uuid|null }]
--
-- Output (jsonb):
--   { ticket_id, sla_policy_id, timers_inserted: int }
--
-- Validation rejection codes:
--   * start_sla_timers.ticket_not_found      — ticket missing in tenant
--   * start_sla_timers.timers_required       — payload empty (caller bug)
--   * start_sla_timers.unknown_timer_type    — timer_type outside allowlist
--   * validate_entity_in_tenant.sla_policy_not_in_tenant — cross-tenant
--     sla_policy_id (helper raises 42501)
--
-- SECURITY INVOKER, p_tenant_id explicit. Service-role only via grants.

create or replace function public.start_sla_timers(
  p_tenant_id      uuid,
  p_ticket_id      uuid,
  p_sla_policy_id  uuid,
  p_timers         jsonb
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
    now()
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

revoke execute on function public.start_sla_timers(uuid, uuid, uuid, jsonb) from public;
grant  execute on function public.start_sla_timers(uuid, uuid, uuid, jsonb) to service_role;

comment on function public.start_sla_timers(uuid, uuid, uuid, jsonb) is
  'B.2.A.Step12 commit 1 (spec §3.11 line 3166) — atomic SLA-timer start. INSERTs timer rows + UPDATEs tickets.sla_response_due_at / sla_resolution_due_at in one PG transaction. Idempotent via ON CONFLICT DO NOTHING against sla_timers_active_unique_idx (00346). Called by SlaTimerHandler (apps/api/src/modules/outbox/handlers/sla-timer-recompute.handler.ts) on sla.timer_recompute_required events. Polymorphic per 00227 (entity_kind=''case'', case_id=p_ticket_id). Spec §3.9.3 line 2564.';

notify pgrst, 'reload schema';
