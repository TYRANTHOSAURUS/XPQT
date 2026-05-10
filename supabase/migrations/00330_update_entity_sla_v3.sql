-- B.2.A.7 — update_entity_sla v3.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.3 (lines 2040-2160).
-- Supersedes: 00329 (same function signature; CREATE OR REPLACE).
-- Schema citations: supabase/migrations/00011_tickets.sql:32-39
--   confirms `tickets` carries the same SLA-derived columns the
--   work_order branch already clears (sla_response_breached_at,
--   sla_resolution_breached_at, sla_at_risk, sla_paused, sla_paused_at)
--   alongside sla_response_due_at + sla_resolution_due_at.
--
-- ── Why v3 (post-§3.3 review) ──────────────────────────────────────────
--
-- Three review findings folded in:
--
-- C1. Case branch was missing the breach/at_risk/paused column resets
--     that the work_order branch already cleared. After an SLA swap or
--     clear on a CASE, stale `sla_at_risk=true` / `sla_paused=true` /
--     `sla_*_breached_at` could leave the desk UI showing breach badges
--     against a brand-new SLA policy. The TS-layer
--     `apps/api/src/modules/sla/sla.service.ts:310` already clears the
--     wider set on both kinds; the case branch on the RPC must do the
--     same to preserve parity. Schema confirms tickets carries all five
--     columns (00011_tickets.sql:32-39).
--
-- I1. A `{}` payload (or any payload missing `sla_id`) used to silently
--     parse to `nullif(NULL, '')::uuid = null` and write `sla_id=null`
--     into the entity, clearing the SLA without any explicit caller
--     intent. v3 adds an early guard that raises
--     `update_entity_sla.sla_id_required` so a malformed payload errors
--     loudly. Caller wishing to clear MUST send `{ sla_id: null }`
--     explicitly.
--
-- I3. Spec line 2095-2097 referenced future migration 00335 with a
--     partial unique index on `sla_timers` for `INSERT ... ON CONFLICT
--     DO NOTHING` replay safety. That migration does not yet exist (and
--     its canonical predicate is undecided pending the controller
--     cutover). Until 00335 ships, this RPC relies on:
--       (a) the per-(tenant_id, idempotency_key) advisory lock to
--           serialise honest callers behind one writer at a time, AND
--       (b) the command_operations idempotency gate (00316) to make
--           same-key replays return the cached result without re-
--           writing rows.
--     A unique constraint added now without the canonical predicate
--     would be premature; the harness scenario 1 already verifies that
--     advisory-lock + cached-result combine to prevent duplicate
--     INSERTs from a same-key replay. Different-key concurrent writers
--     converge on row state via the SELECT FOR UPDATE row lock (see
--     scenario 8 in the harness).
--     TODO(b2.a-controller-cutover): replace this comment block + add
--     `INSERT ... ON CONFLICT DO NOTHING` once 00335's predicate lands.
--
-- All other behaviour from 00329 (advisory lock, command_operations
-- gate, no-op fast path BEFORE timers_required guard, stop existing
-- timers, fresh INSERT, due_at repopulation, ticket_activities,
-- domain_events) is preserved verbatim.

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
  v_inserted_count         int;
  v_actor_person_id        uuid;
  v_response_due_at        timestamptz;
  v_resolution_due_at      timestamptz;
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

  -- ── 0.5. Payload sla_id presence guard (v3 / I1) ──────────────────────
  --
  -- A payload without an explicit `sla_id` key (e.g. `{}` or a typo'd
  -- field name) used to silently fall through to `nullif(NULL, '')::uuid
  -- = null` and clear the entity's SLA. Now we error so the caller's
  -- intent is unambiguous. To clear an SLA, send `{ "sla_id": null }`.
  if p_payload is null or not (p_payload ? 'sla_id') then
    raise exception 'update_entity_sla.sla_id_required: payload must include sla_id (uuid or null)'
      using errcode = 'P0001',
            hint = 'Send {"sla_id": null} to clear; {"sla_id": "<uuid>", "timers": [...]} to install';
  end if;

  -- ── 1. Advisory lock ───────────────────────────────────────────────────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 2. command_operations idempotency gate ─────────────────────────────
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

  -- ── 3. Parse payload (no validation yet — guards run after the row read)
  v_new_sla_id := nullif(p_payload->>'sla_id', '')::uuid;
  v_has_timers_payload :=
    (p_payload ? 'timers')
    and jsonb_typeof(p_payload->'timers') = 'array'
    and jsonb_array_length(p_payload->'timers') > 0;

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

  -- ── 5. No-op fast path (BEFORE timers_required guard — v2 fix) ──────────
  --
  -- Same sla_id as current AND no timers payload → caller is replaying a
  -- settle / re-confirm with no actual change. Skip the timers_required
  -- guard (no install happening) and the cross-tenant validate (the
  -- existing sla_id was validated when it was first set) and short-circuit.
  --   * sla_id unchanged + non-null + no timers → noop
  --   * sla_id unchanged + null + no timers → noop (stays SLA-free)
  --   * sla_id unchanged + timers present → NOT a noop; fall through and
  --     re-stop + re-insert per spec §3.3 step 6 atomicity contract.
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

  -- ── 6. timers_required guard (only on actual install path) ─────────────
  --
  -- Reached only when sla_id is non-null AND either (a) sla_id is changing,
  -- or (b) sla_id is unchanged but timers were supplied (which is
  -- consistent — falls through scenario 6's noop). Schema's NOT NULL on
  -- sla_timers.due_at means we can't insert without TS plan-build values.
  if v_new_sla_id is not null and not v_has_timers_payload then
    raise exception 'update_entity_sla.timers_required: sla_id=% but payload.timers missing or empty', v_new_sla_id
      using errcode = 'P0001',
            hint = 'TS plan-build must compute timer due_at values via business-hours calendar before calling RPC';
  end if;

  -- ── 7. Validate sla_id is tenant-owned ─────────────────────────────────
  if v_new_sla_id is not null then
    perform public.validate_entity_in_tenant(p_tenant_id, 'sla_policy', v_new_sla_id);
  end if;

  -- ── 8. STOP existing active timers atomically ─────────────────────────
  update public.sla_timers
     set stopped_at     = now(),
         stopped_reason = 'sla_changed'
   where tenant_id    = p_tenant_id
     and ticket_id    = p_entity_id
     and stopped_at   is null
     and completed_at is null;

  -- ── 9. UPDATE entity row — clear SLA-derived columns first (v3 / C1) ───
  --
  -- Both branches now clear the same set of columns. Schema parity per
  -- 00011_tickets.sql:32-39 + 00136_work_orders.sql:* — both tables
  -- carry sla_response_breached_at / sla_resolution_breached_at /
  -- sla_at_risk / sla_paused / sla_paused_at. Pre-v3 the case branch
  -- only cleared the two due_at columns, leaving stale breach/risk
  -- flags on swap or clear.
  if p_entity_kind = 'case' then
    update public.tickets
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

  -- ── 10. INSERT fresh timer rows ───────────────────────────────────────
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

    -- ── 11. Repopulate entity row's response/resolution due_at ───────────
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

  -- ── 12. Resolve actor_person_id for ticket_activities ─────────────────
  if p_actor_user_id is not null then
    select u.person_id into v_actor_person_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;
  end if;

  -- ── 13. INSERT ticket_activities (system_event, sla_changed) ──────────
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

  -- ── 14. INSERT public.domain_events (ticket_sla_changed) ──────────────
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

  -- ── 15. Mark command_operations success and return ───────────────────
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
  'Atomic SLA change for cases (tickets) and work_orders. v3 (00330) adds (a) parity reset of breach/at_risk/paused columns on the case branch matching the work_order branch (00011_tickets.sql:32-39 confirms the schema) and (b) explicit `update_entity_sla.sla_id_required` guard so a payload missing the sla_id key errors instead of silently clearing. ON CONFLICT replay safety deferred to migration 00335 once its canonical predicate is decided post controller cutover; until then advisory lock + command_operations gate cover honest callers (harness scenarios 1 + 8 verify). Single transaction commits row UPDATE (sla_id + cleared SLA-derived columns) + sla_timers stop + optional fresh sla_timers INSERT (TS-computed due_at) + entity due_at repopulated + ticket_activities (sla_changed, visibility=system) + domain_events (ticket_sla_changed). Idempotent on (tenant_id, idempotency_key) via command_operations (00316). recompute_pending=false on fresh inserts per spec §3.3 line 2154-2159. Spec: docs/follow-ups/b2-survey-and-design.md §3.3.';

notify pgrst, 'reload schema';
