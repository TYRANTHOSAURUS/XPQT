-- B.2.A.7 — update_entity_sla combined RPC.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.3 (lines 2040-2160).
--
-- ONE atomic RPC for SLA changes on cases (tickets) and work_orders.
-- Stops existing active timers, swaps tickets/work_orders.sla_id,
-- optionally inserts fresh sla_timers rows with TS-computed due_at
-- values, writes a ticket_activities system_event row, and emits a
-- public.domain_events 'ticket_sla_changed' record. Composed by the
-- §3.0 update_entity_combined orchestrator (Step 6 cutover).
--
-- Inputs:
--   p_entity_id        — case (tickets.id) or work_order (work_orders.id).
--   p_entity_kind      — 'case' | 'work_order' (allowlist).
--   p_tenant_id        — tenant scope.
--   p_actor_user_id    — Supabase auth uid (users.auth_uid). Nullable for
--                        SYSTEM_ACTOR. Resolved to users.person_id for
--                        ticket_activities.author_person_id; same convention
--                        as 00323:347-358 + 00326:340-348.
--   p_idempotency_key  — operation-level key per command_operations (00316).
--   p_payload          — { sla_id: uuid|null,
--                          timers?: [{ timer_type, target_minutes, due_at,
--                                      business_hours_calendar_id }] }
--
-- Output (jsonb cached_result):
--   { entity_id, entity_kind,
--     previous_sla_id, new_sla_id,
--     timers_inserted, noop }
--
-- Concurrency contract — same as 00323 / 00327:
--   1. pg_advisory_xact_lock(hashtextextended(tenant || ':' || idem, 0))
--      so two concurrent retries on the same key serialise.
--   2. command_operations row INSERTed with outcome='in_progress'; on commit
--      the RPC UPDATEs to outcome='success' with cached_result. Same key +
--      same payload_hash returns cached_result; same key + different payload
--      raises 'command_operations.payload_mismatch'.
--
-- Why TS computes due_at (not the RPC):
--   sla_timers.due_at is NOT NULL by schema. Business-hours math (calendar
--   weekdays / holidays / time zones via the business_hours_calendar) lives
--   in apps/api/src/modules/sla/business-hours.service.ts and isn't ported
--   to PG. Spec §3.3 line 2096-2097 explicitly mandates: TS plan-build
--   computes the new due_at; RPC just inserts. recompute_pending stays
--   false on fresh inserts (spec §3.3 v5 / C2 line 2154-2159).
--
-- Why no outbox event for fresh timers:
--   Spec §3.3 line 2101-2109 inverts the v4 design (which emitted
--   sla.timer_recompute_required and let the worker fill due_at). Schema's
--   NOT NULL on due_at made that incompatible. recompute_pending remains
--   for the existing-timer pause/resume case (called by §3.1 status branch).
--
-- Stop-existing-timers semantics (spec §3.3 line 2080-2086):
--   stopped_at + stopped_reason='sla_changed' (NOT completed_at — mirrors
--   the reclassify_ticket pattern at supabase/migrations/00044:115-125).
--   Filters: stopped_at IS NULL AND completed_at IS NULL — only active
--   timers stop. Idempotent on a re-call (already-stopped rows skip).
--
-- domain_events vs outbox (00327 C1+C2 lesson):
--   We write directly to public.domain_events (not outbox.events). 00326
--   shipped with outbox.emit and 00327 patched it after review found no
--   handler is registered for the assignment events; same applies here.
--   event_type='ticket_sla_changed', entity_type='ticket' uniformly across
--   case + work_order side (entity_id disambiguates) — same convention as
--   00327:387-410 + ticket.service.ts:1682-1693.
--
-- ticket_activities (00326:351-386 pattern):
--   activity_type='system_event' (only allowed value for synthetic rows
--   per ticket_activities_activity_type_check). visibility='system'
--   (sla changes are operator-internal — never leak to requesters).
--   metadata.event='sla_changed' matches the existing TS surface at
--   ticket.service.ts:1148-1156 (preserved on §3.0 cutover).
--
-- No-op fast path:
--   New sla_id matches current AND no timers in payload (or timers payload
--   absent because new sla_id is null and current is null too). The RPC
--   marks command_operations success, returns {noop: true}, doesn't touch
--   sla_timers. Avoids gratuitous activity-row spam on retried calls.
--
-- Validation rejection codes:
--   * update_entity_sla.unknown_kind         — p_entity_kind not in allowlist
--   * update_entity_sla.not_found            — entity row missing for tenant
--   * update_entity_sla.timers_required      — sla_id non-null but
--                                              payload.timers absent / empty
--   * validate_entity_in_tenant.sla_policy_not_in_tenant — cross-tenant
--                                              sla_id (helper raises 42501)
--
-- SECURITY INVOKER, p_tenant_id explicit. Service-role only via grants.

create or replace function public.update_entity_sla(
  p_entity_id        uuid,
  p_entity_kind      text,
  p_tenant_id        uuid,
  p_actor_user_id    uuid,
  p_idempotency_key  text,
  p_payload          jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public, outbox
as $$
declare
  v_existing               public.command_operations;
  v_payload_hash           text;
  v_lock_key               bigint;
  v_current                record;
  v_prev_sla_id            uuid;
  v_new_sla_id             uuid;
  v_has_timers_payload     boolean;
  v_timers_count           int;
  v_inserted_count         int;
  v_actor_person_id        uuid;
  v_response_due_at        timestamptz;
  v_resolution_due_at      timestamptz;
  v_active_timer_count     int;
  v_result                 jsonb;
begin
  -- ── 0. Argument shape checks ────────────────────────────────────────────
  if p_tenant_id is null then
    raise exception 'update_entity_sla: p_tenant_id required';
  end if;
  if p_entity_id is null then
    raise exception 'update_entity_sla: p_entity_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'update_entity_sla: p_idempotency_key required';
  end if;
  if p_entity_kind is null or p_entity_kind not in ('case','work_order') then
    raise exception 'update_entity_sla.unknown_kind: kind=%', coalesce(p_entity_kind, '<null>')
      using errcode = 'P0001';
  end if;

  -- ── 1. Advisory lock (mirror 00323:104-106 + 00326:151-152) ────────────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 2. command_operations idempotency gate (00316) ─────────────────────
  v_payload_hash := md5(coalesce(p_payload::text, ''));

  select * into v_existing
    from public.command_operations
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.outcome = 'success' and v_existing.payload_hash = v_payload_hash then
      return v_existing.cached_result;
    elsif v_existing.payload_hash <> v_payload_hash then
      raise exception 'command_operations.payload_mismatch'
        using errcode = 'P0001',
              hint = 'Idempotency key reused with different payload';
    else
      raise exception 'command_operations.unexpected_state outcome=% hash_match=%',
        v_existing.outcome,
        (v_existing.payload_hash = v_payload_hash)
        using errcode = 'P0001';
    end if;
  end if;

  insert into public.command_operations
    (tenant_id, idempotency_key, payload_hash, outcome)
  values (p_tenant_id, p_idempotency_key, v_payload_hash, 'in_progress');

  -- ── 3. Detect timers payload presence + parse new sla_id ────────────────
  v_new_sla_id := nullif(p_payload->>'sla_id', '')::uuid;
  v_has_timers_payload :=
    (p_payload ? 'timers')
    and jsonb_typeof(p_payload->'timers') = 'array'
    and jsonb_array_length(p_payload->'timers') > 0;

  if v_has_timers_payload then
    v_timers_count := jsonb_array_length(p_payload->'timers');
  else
    v_timers_count := 0;
  end if;

  -- New sla_id requires accompanying timers (TS plan-build computed them).
  -- Schema's NOT NULL on sla_timers.due_at means we can't insert a placeholder.
  if v_new_sla_id is not null and not v_has_timers_payload then
    raise exception 'update_entity_sla.timers_required: sla_id=% but payload.timers missing or empty', v_new_sla_id
      using errcode = 'P0001',
            hint = 'TS plan-build must compute timer due_at values via business-hours calendar before calling RPC';
  end if;

  -- ── 4. SELECT FOR UPDATE on the right entity table ─────────────────────
  if p_entity_kind = 'case' then
    select id, sla_id, sla_response_due_at, sla_resolution_due_at
      into v_current
      from public.tickets
     where id = p_entity_id and tenant_id = p_tenant_id
     for update;
  else
    select id, sla_id, sla_response_due_at, sla_resolution_due_at
      into v_current
      from public.work_orders
     where id = p_entity_id and tenant_id = p_tenant_id
     for update;
  end if;

  if not found then
    raise exception 'update_entity_sla.not_found: kind=% id=%', p_entity_kind, p_entity_id
      using errcode = 'P0001';
  end if;

  v_prev_sla_id := v_current.sla_id;

  -- ── 5. Validate sla_id is tenant-owned (00321 helper) ──────────────────
  --
  -- Cross-tenant FK leak is a P0 security concern (memory:
  -- feedback_tenant_id_ultimate_rule). Helper raises 42501 with
  -- 'validate_entity_in_tenant.sla_policy_not_in_tenant' on miss.
  if v_new_sla_id is not null then
    perform public.validate_entity_in_tenant(p_tenant_id, 'sla_policy', v_new_sla_id);
  end if;

  -- ── 6. No-op fast path ────────────────────────────────────────────────
  --
  -- Same sla_id as current. We still need to consider the timers payload:
  --   * sla_id unchanged + non-null + no timers → noop (caller is replaying
  --     a settle / re-confirm with no actual change).
  --   * sla_id unchanged + null + no timers → noop (stays SLA-free).
  --   * sla_id unchanged + timers present → the caller wants fresh timer
  --     rows for the same policy; not a noop, fall through and re-stop +
  --     re-insert.
  -- The "same sla_id but new timers" case is rare in practice but kept
  -- correct: spec §3.3 step 6 mandates atomic stop+start when timers are
  -- in the payload, regardless of whether sla_id changed.
  if v_new_sla_id is not distinct from v_prev_sla_id and not v_has_timers_payload then
    v_result := jsonb_build_object(
      'entity_id',       p_entity_id,
      'entity_kind',     p_entity_kind,
      'previous_sla_id', v_prev_sla_id,
      'new_sla_id',      v_new_sla_id,
      'timers_inserted', 0,
      'noop',            true
    );

    update public.command_operations
       set outcome = 'success', cached_result = v_result, completed_at = now()
     where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

    return v_result;
  end if;

  -- ── 7. STOP existing active timers atomically ─────────────────────────
  --
  -- Mirrors the reclassify_ticket pattern at 00044:115-125 and the TS
  -- restartTimers() flow at sla.service.ts:306-323. Filters: stopped_at
  -- IS NULL AND completed_at IS NULL so we only stop currently-active
  -- timers. ticket_id is the historic discriminator on sla_timers (kept
  -- for both case + work_order rows; case_id / work_order_id are the
  -- polymorphic columns added in step 1c).
  update public.sla_timers
     set stopped_at     = now(),
         stopped_reason = 'sla_changed'
   where tenant_id    = p_tenant_id
     and ticket_id    = p_entity_id
     and stopped_at   is null
     and completed_at is null;

  -- ── 8. UPDATE entity row — clear SLA-derived columns first ─────────────
  --
  -- Always clear sla_response_due_at + sla_resolution_due_at — they'll be
  -- repopulated below if new timers are inserted. Mirrors the TS
  -- restartTimers pattern at sla.service.ts:309-318. work_orders carries
  -- additional sla_at_risk / sla_paused / sla_*_breached_at columns; the
  -- TS path resets the same set, so we mirror that here for the work_order
  -- branch.
  if p_entity_kind = 'case' then
    update public.tickets
       set sla_id                = v_new_sla_id,
           sla_response_due_at   = null,
           sla_resolution_due_at = null,
           updated_at            = now()
     where id = p_entity_id and tenant_id = p_tenant_id;
  else
    update public.work_orders
       set sla_id                       = v_new_sla_id,
           sla_response_due_at          = null,
           sla_resolution_due_at        = null,
           sla_response_breached_at     = null,
           sla_resolution_breached_at   = null,
           sla_at_risk                  = false,
           sla_paused                   = false,
           sla_paused_at                = null,
           updated_at                   = now()
     where id = p_entity_id and tenant_id = p_tenant_id;
  end if;

  -- ── 9. INSERT fresh timer rows from payload (if new sla_id non-null) ──
  --
  -- jsonb_to_recordset shreds the timers array into typed rows. Spec §3.3
  -- line 2092-2097: TS computes due_at; RPC inserts. recompute_pending=false
  -- (fresh inserts always have due_at filled). paused=false (timers start
  -- counting immediately; pause math is a separate state-machine concern).
  -- entity_kind + case_id / work_order_id polymorphic columns set per the
  -- step 1c convention. ticket_id keeps the legacy non-null shape.
  v_inserted_count := 0;
  if v_new_sla_id is not null and v_has_timers_payload then
    insert into public.sla_timers (
      tenant_id, ticket_id, sla_policy_id, timer_type, target_minutes,
      due_at, business_hours_calendar_id,
      paused, recompute_pending,
      entity_kind, case_id, work_order_id, started_at
    )
    select
      p_tenant_id,
      p_entity_id,
      v_new_sla_id,
      t.timer_type,
      t.target_minutes,
      t.due_at,
      t.business_hours_calendar_id,
      false,
      false,
      case when p_entity_kind = 'case' then 'case' else 'work_order' end,
      case when p_entity_kind = 'case'       then p_entity_id end,
      case when p_entity_kind = 'work_order' then p_entity_id end,
      now()
    from jsonb_to_recordset(p_payload->'timers') as t(
      timer_type                  text,
      target_minutes              int,
      due_at                      timestamptz,
      business_hours_calendar_id  uuid
    );

    get diagnostics v_inserted_count = row_count;

    -- ── 10. Repopulate entity row's response/resolution due_at ───────────
    --
    -- Find the response + resolution timer rows we just inserted and copy
    -- their due_at to the parent entity row's denorm columns. Mirrors the
    -- TS startTimers shape at sla.service.ts:101-104 + 118-121 (one
    -- entity-row UPDATE per timer_type).
    select due_at
      into v_response_due_at
      from public.sla_timers
     where tenant_id     = p_tenant_id
       and ticket_id     = p_entity_id
       and sla_policy_id = v_new_sla_id
       and timer_type    = 'response'
       and stopped_at    is null
       and completed_at  is null
     order by started_at desc
     limit 1;

    select due_at
      into v_resolution_due_at
      from public.sla_timers
     where tenant_id     = p_tenant_id
       and ticket_id     = p_entity_id
       and sla_policy_id = v_new_sla_id
       and timer_type    = 'resolution'
       and stopped_at    is null
       and completed_at  is null
     order by started_at desc
     limit 1;

    if p_entity_kind = 'case' then
      update public.tickets
         set sla_response_due_at   = v_response_due_at,
             sla_resolution_due_at = v_resolution_due_at
       where id = p_entity_id and tenant_id = p_tenant_id;
    else
      update public.work_orders
         set sla_response_due_at   = v_response_due_at,
             sla_resolution_due_at = v_resolution_due_at
       where id = p_entity_id and tenant_id = p_tenant_id;
    end if;
  end if;

  -- ── 11. Resolve actor_person_id for ticket_activities ─────────────────
  if p_actor_user_id is not null then
    select u.person_id into v_actor_person_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;
  end if;

  -- ── 12. INSERT ticket_activities (system_event, sla_changed) ──────────
  --
  -- Matches the TS surface at ticket.service.ts:1148-1156. visibility=
  -- 'system' — sla changes are operator-internal and must not surface to
  -- requesters via the activity feed.
  insert into public.ticket_activities
    (tenant_id, ticket_id, activity_type, author_person_id, visibility, metadata)
  values (
    p_tenant_id,
    p_entity_id,
    'system_event',
    v_actor_person_id,
    'system',
    jsonb_build_object(
      'event',           'sla_changed',
      'previous_sla_id', v_prev_sla_id,
      'new_sla_id',      v_new_sla_id,
      'actor_user_id',   p_actor_user_id
    )
  );

  -- ── 13. INSERT public.domain_events (ticket_sla_changed) ──────────────
  --
  -- entity_type='ticket' uniformly across case + work_order side; entity_id
  -- disambiguates. Mirrors 00327:387-410 (ticket_assigned) + spec §3.3
  -- step 12. actor_user_id stamped onto the event row (existing TS callers
  -- leave the column NULL — see 00327:384 — but the parameter is available
  -- so we record it for downstream auditing).
  insert into public.domain_events
    (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id)
  values (
    p_tenant_id,
    'ticket_sla_changed',
    'ticket',
    p_entity_id,
    jsonb_build_object(
      'entity_id',       p_entity_id,
      'entity_kind',     p_entity_kind,
      'previous_sla_id', v_prev_sla_id,
      'new_sla_id',      v_new_sla_id,
      'timers_inserted', v_inserted_count,
      'actor_user_id',   p_actor_user_id
    ),
    p_actor_user_id
  );

  -- ── 14. Mark command_operations success and return ───────────────────
  v_result := jsonb_build_object(
    'entity_id',       p_entity_id,
    'entity_kind',     p_entity_kind,
    'previous_sla_id', v_prev_sla_id,
    'new_sla_id',      v_new_sla_id,
    'timers_inserted', v_inserted_count,
    'noop',            false
  );

  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = now()
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

revoke execute on function public.update_entity_sla(uuid, text, uuid, uuid, text, jsonb) from public;
grant  execute on function public.update_entity_sla(uuid, text, uuid, uuid, text, jsonb) to service_role;

comment on function public.update_entity_sla(uuid, text, uuid, uuid, text, jsonb) is
  'Atomic SLA change for cases (tickets) and work_orders. Single transaction commits the row UPDATE (sla_id + cleared SLA-derived columns) + sla_timers stop on existing active rows (stopped_reason=sla_changed) + optional fresh sla_timers INSERT (TS-computed due_at) + entity due_at columns repopulated from inserted timers + ticket_activities (sla_changed, visibility=system) + domain_events (ticket_sla_changed). Idempotent on (tenant_id, idempotency_key) via command_operations (00316). recompute_pending=false on fresh inserts per spec §3.3 line 2154-2159 (NOT NULL due_at honored). Spec: docs/follow-ups/b2-survey-and-design.md §3.3.';

notify pgrst, 'reload schema';
