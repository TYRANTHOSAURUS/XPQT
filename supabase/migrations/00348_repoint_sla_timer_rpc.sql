-- B.2.A.Step12 commit 1 — repoint_sla_timer RPC.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.10 line 2565 +
--       §3.11 line 3167 + §3.9.3 line 2565 (SlaTimerRepointHandler).
--
-- ── Why ───────────────────────────────────────────────────────────────────
--
-- Called by `SlaTimerRepointHandler` on the
-- `sla.timer_repointed_required` outbox event emitted by §3.10
-- reclassify_ticket when the effective SLA policy changes. STOP old
-- active timers (scoped to the OLD policy, not the new one) + INSERT
-- fresh timers under the new policy + UPDATE ticket due-date columns,
-- all in ONE PG transaction.
--
-- Idempotency short-circuit (v7 / I3, spec line 2565): the RPC opens
-- with an existence check on (tenant, ticket, new_policy). If active
-- timers already exist under the NEW policy, the handler is replaying
-- after a previous successful repoint — return {kind:'already_repointed'}
-- without touching state. This keeps a re-fired event from re-stopping
-- the new policy's timers (which would then look like they were
-- stopped + restarted, polluting `stopped_reason`).
--
-- STOP scope (spec line 2565): UPDATE existing active timers
-- `SET stopped_at=now(), stopped_reason=p_reason` WHERE
-- `sla_policy_id IS DISTINCT FROM p_sla_policy_id AND stopped_at IS NULL
-- AND completed_at IS NULL` — scoped to the OLD policy so a re-execution
-- wouldn't stop the new policy's timers. This is the structural
-- defense against a "stop then start" race producing a transient
-- no-active-timer window the breach cron would skip.
--
-- recompute_pending=false on fresh inserts (handler computed real
-- due_at via BusinessHoursService).
--
-- Polymorphic columns: same convention as 00347 — entity_kind='case',
-- case_id=p_ticket_id, work_order_id=null.
--
-- Input contract:
--   p_timers — same shape as 00347 / 00328 (jsonb array of
--   { timer_type, target_minutes, due_at, business_hours_calendar_id }).
--   p_reason — text recorded on the OLD timers' stopped_reason column.
--
-- Output (jsonb):
--   kind='already_repointed' on idempotent replay; else
--   kind='repointed' with counts.
--
-- Validation rejection codes:
--   * repoint_sla_timer.ticket_not_found     — ticket missing in tenant
--   * repoint_sla_timer.timers_required      — payload empty (caller bug)
--   * repoint_sla_timer.unknown_timer_type   — timer_type outside allowlist
--   * validate_entity_in_tenant.sla_policy_not_in_tenant — cross-tenant
--     sla_policy_id (helper raises 42501)
--
-- SECURITY INVOKER, p_tenant_id explicit. Service-role only via grants.

create or replace function public.repoint_sla_timer(
  p_tenant_id      uuid,
  p_ticket_id      uuid,
  p_sla_policy_id  uuid,
  p_timers         jsonb,
  p_reason         text
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
  -- repointed — return early. The handler is replaying after a previous
  -- successful run. Without this, a re-fire would re-STOP the new
  -- policy's timers (since the WHERE clause in step 5 is "DISTINCT FROM
  -- p_sla_policy_id" but a previous repoint already promoted the new
  -- policy to active — wait, no, that's backwards. Let me re-read spec
  -- line 2565 — yes, the short-circuit is correct: replay returns
  -- {already_repointed} so we don't stop+restart the same timers).
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
  --
  -- Scoped to "any active timer under a policy other than the new one".
  -- This is the structural difference from 00328's STOP — there the new
  -- sla_id replaces the old one + all active timers are unconditionally
  -- stopped. Here, repoint specifically wants to leave any pre-existing
  -- new-policy timers alone (handled by the short-circuit in step 4)
  -- and only stop the OLD policy's timers.
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

revoke execute on function public.repoint_sla_timer(uuid, uuid, uuid, jsonb, text) from public;
grant  execute on function public.repoint_sla_timer(uuid, uuid, uuid, jsonb, text) to service_role;

comment on function public.repoint_sla_timer(uuid, uuid, uuid, jsonb, text) is
  'B.2.A.Step12 commit 1 (spec §3.11 line 3167) — atomic SLA-timer repoint. STOP old active timers (DISTINCT FROM new policy) + INSERT fresh timers under the new policy + UPDATE ticket due-date columns in one PG transaction. v7 / I3 idempotent short-circuit: if active timers already exist under the new policy, return {kind:''already_repointed''} without touching state. Spec §3.9.3 line 2565.';

notify pgrst, 'reload schema';
