-- 00325_transition_entity_status_v2.sql
--
-- B.2.A §3.1 review fix I1 — coalesce resolved_at / closed_at when
-- entering a terminal status_category. The 00323 body unconditionally
-- set them to now() on terminal entry, overwriting an earlier stamp
-- (e.g. case closed → reopened → reclosed loses its first close-time
-- audit). The TS path at apps/api/src/modules/ticket/ticket.service.ts
-- :1103 has always preserved the existing stamp:
--
--     if (updateData.status_category === 'resolved' && !current.resolved_at) {
--       updateData.resolved_at = new Date().toISOString();
--     }
--     if (updateData.status_category === 'closed' && !current.closed_at) {
--       updateData.closed_at = new Date().toISOString();
--     }
--
-- This v2 of the RPC matches that behaviour: terminal entry does
-- coalesce(<existing>, now()). Transitions BETWEEN terminal categories
-- (closed → resolved or resolved → closed) preserve both stamps as-is
-- — neither is cleared, so the first close/resolve time stays
-- auditable. Leaving terminal still clears both stamps so a future
-- re-entry gets a fresh `now()`.
--
-- Implementation: CREATE OR REPLACE FUNCTION on the same signature
-- 00323 declared. The original migration file stays unchanged on
-- remote (it's already applied); this one swaps the body in place.
-- All other contracts (advisory lock, command_operations gate,
-- has_open_children guard, SLA pause/resume, ticket_activities row,
-- outbox emit) are preserved verbatim.
--
-- Citations:
--   - apps/api/src/modules/ticket/ticket.service.ts:1103-1108 — TS
--     coalesce contract this aligns with.
--   - supabase/migrations/00323_transition_entity_status_rpc.sql:
--     211-221 — the unconditional now() the v2 replaces.

create or replace function public.transition_entity_status(
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
  v_new_status             text;
  v_new_status_category    text;
  v_new_waiting_reason     text;
  v_prev_status            text;
  v_prev_status_category   text;
  v_prev_waiting_reason    text;
  v_prev_resolved_at       timestamptz;
  v_prev_closed_at         timestamptz;
  v_resolved_at            timestamptz;
  v_closed_at              timestamptz;
  v_terminal_categories    text[] := array['resolved','closed'];
  v_open_children          int;
  v_is_terminal_new        boolean;
  v_was_terminal           boolean;
  v_pause_reasons          text[];
  v_should_pause           boolean := false;
  v_action                 text;
  v_actor_person_id        uuid;
  v_result                 jsonb;
begin
  -- ── 0. Argument shape checks ────────────────────────────────────────────
  if p_tenant_id is null then
    raise exception 'transition_entity_status: p_tenant_id required';
  end if;
  if p_entity_id is null then
    raise exception 'transition_entity_status: p_entity_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'transition_entity_status: p_idempotency_key required';
  end if;
  if p_entity_kind is null or p_entity_kind not in ('case','work_order') then
    raise exception 'transition_entity_status.unknown_kind: kind=%', coalesce(p_entity_kind, '<null>')
      using errcode = 'P0001';
  end if;

  -- p_actor_user_id semantics: this is the Supabase auth UID
  -- (`users.auth_uid` per 00003:39), NOT `users.id`. Existing TS
  -- callers thread it as `actorAuthUid` (e.g. reclassify.service.ts
  -- :87, :212, :261). The parameter name predates §3.1 and is kept
  -- for signature stability; future RPCs (Step 4+) should rename to
  -- p_actor_auth_uid for self-documentation. Spec §3.1 line 1922.

  -- ── 1. Advisory lock (mirror 00309:86-88) ───────────────────────────────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 2. command_operations idempotency gate (00316) ──────────────────────
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

  -- ── 3. SELECT FOR UPDATE on the right entity table ──────────────────────
  if p_entity_kind = 'case' then
    select id, status, status_category, waiting_reason, resolved_at, closed_at
      into v_current
      from public.tickets
     where id = p_entity_id and tenant_id = p_tenant_id
     for update;
  else
    select id, status, status_category, waiting_reason, resolved_at, closed_at
      into v_current
      from public.work_orders
     where id = p_entity_id and tenant_id = p_tenant_id
     for update;
  end if;

  if not found then
    raise exception 'transition_entity_status.not_found: kind=% id=%', p_entity_kind, p_entity_id
      using errcode = 'P0001';
  end if;

  v_prev_status          := v_current.status;
  v_prev_status_category := v_current.status_category;
  v_prev_waiting_reason  := v_current.waiting_reason;
  v_prev_resolved_at     := v_current.resolved_at;
  v_prev_closed_at       := v_current.closed_at;

  -- ── 4. Compute target field values (undefined keys = no change) ─────────
  v_new_status :=
    case when p_payload ? 'status' then p_payload->>'status' else v_prev_status end;
  v_new_status_category :=
    case when p_payload ? 'status_category' then p_payload->>'status_category' else v_prev_status_category end;
  v_new_waiting_reason :=
    case when p_payload ? 'waiting_reason' then nullif(p_payload->>'waiting_reason', '') else v_prev_waiting_reason end;

  if v_new_status is null or length(v_new_status) = 0 then
    raise exception 'transition_entity_status.invalid_status: status must be a non-empty string';
  end if;
  if v_new_status_category is null or length(v_new_status_category) = 0 then
    raise exception 'transition_entity_status.invalid_status_category: status_category must be a non-empty string';
  end if;

  v_is_terminal_new := v_new_status_category = any(v_terminal_categories);
  v_was_terminal    := v_prev_status_category = any(v_terminal_categories);

  -- ── 5. State-machine guards ─────────────────────────────────────────────
  if p_entity_kind = 'case' and v_is_terminal_new and not v_was_terminal then
    select count(*) into v_open_children
      from public.work_orders
     where parent_ticket_id = p_entity_id
       and tenant_id        = p_tenant_id
       and status_category not in ('resolved','closed');
    if v_open_children > 0 then
      raise exception
        'transition_entity_status.has_open_children: case=% open_children=%',
        p_entity_id, v_open_children
        using errcode = 'P0001';
    end if;
  end if;

  -- ── 6. Synthesize resolved_at / closed_at (v2: coalesce on entry) ───────
  --
  -- Contract delta vs. 00323:211-221:
  --   * Entering 'resolved' from a non-terminal state → coalesce(prev, now())
  --     so a re-entry doesn't overwrite an existing audit stamp.
  --   * Entering 'closed' from a non-terminal state → coalesce(prev, now()).
  --   * Transitions BETWEEN terminal categories (closed ↔ resolved):
  --     preserve BOTH stamps as-is. Neither is cleared. This matches the
  --     TS path's behaviour where the unset side simply isn't touched.
  --   * Leaving terminal: clear both stamps so a future re-entry stamps
  --     fresh (matches 00323's existing semantics).
  v_resolved_at := v_prev_resolved_at;
  v_closed_at   := v_prev_closed_at;

  if v_was_terminal and not v_is_terminal_new then
    -- Leaving terminal: clear stamps so a future re-entry stamps fresh.
    v_resolved_at := null;
    v_closed_at   := null;
  else
    if v_new_status_category = 'resolved' and v_prev_status_category <> 'resolved' then
      v_resolved_at := coalesce(v_prev_resolved_at, now());
    end if;
    if v_new_status_category = 'closed' and v_prev_status_category <> 'closed' then
      v_closed_at := coalesce(v_prev_closed_at, now());
    end if;
  end if;

  -- ── 7. No-op fast path ─────────────────────────────────────────────────
  if v_new_status            = v_prev_status
     and v_new_status_category = v_prev_status_category
     and v_new_waiting_reason  is not distinct from v_prev_waiting_reason then

    v_result := jsonb_build_object(
      'entity_id',                p_entity_id,
      'entity_kind',              p_entity_kind,
      'previous_status',          v_prev_status,
      'new_status',               v_new_status,
      'previous_status_category', v_prev_status_category,
      'new_status_category',      v_new_status_category,
      'previous_waiting_reason',  v_prev_waiting_reason,
      'new_waiting_reason',       v_new_waiting_reason,
      'noop',                     true
    );

    update public.command_operations
       set outcome = 'success', cached_result = v_result, completed_at = now()
     where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

    return v_result;
  end if;

  -- ── 8. UPDATE the row ─────────────────────────────────────────────────
  if p_entity_kind = 'case' then
    update public.tickets
       set status          = v_new_status,
           status_category = v_new_status_category,
           waiting_reason  = v_new_waiting_reason,
           resolved_at     = v_resolved_at,
           closed_at       = v_closed_at,
           updated_at      = now()
     where id = p_entity_id and tenant_id = p_tenant_id;
  else
    update public.work_orders
       set status          = v_new_status,
           status_category = v_new_status_category,
           waiting_reason  = v_new_waiting_reason,
           resolved_at     = v_resolved_at,
           closed_at       = v_closed_at,
           updated_at      = now()
     where id = p_entity_id and tenant_id = p_tenant_id;
  end if;

  -- ── 9. SLA pause/resume (option b — outbox-mediated, spec §3.1) ─────────
  if v_new_status_category = 'waiting' then
    if p_entity_kind = 'case' then
      select sp.pause_on_waiting_reasons into v_pause_reasons
        from public.tickets t
        join public.sla_policies sp on sp.id = t.sla_id and sp.tenant_id = t.tenant_id
       where t.id = p_entity_id and t.tenant_id = p_tenant_id;
    else
      select sp.pause_on_waiting_reasons into v_pause_reasons
        from public.work_orders w
        join public.sla_policies sp on sp.id = w.sla_id and sp.tenant_id = w.tenant_id
       where w.id = p_entity_id and w.tenant_id = p_tenant_id;
    end if;

    v_should_pause := v_new_waiting_reason is not null
                      and v_pause_reasons  is not null
                      and v_new_waiting_reason = any(v_pause_reasons);
  end if;

  if v_should_pause then
    v_action := 'pause';
  elsif v_was_terminal is false
        and v_prev_status_category = 'waiting'
        and v_new_status_category   <> 'waiting' then
    v_action := 'resume';
  elsif v_is_terminal_new and not v_was_terminal then
    v_action := 'stop';
  else
    v_action := null;
  end if;

  if v_action is not null then
    update public.sla_timers
       set recompute_pending = true
     where tenant_id = p_tenant_id
       and ticket_id = p_entity_id
       and stopped_at   is null
       and completed_at is null;

    perform outbox.emit(
      p_tenant_id      => p_tenant_id,
      p_event_type     => 'sla.timer_recompute_required',
      p_aggregate_type => p_entity_kind,
      p_aggregate_id   => p_entity_id,
      p_payload        => jsonb_build_object(
        'entity_id',         p_entity_id,
        'entity_kind',       p_entity_kind,
        'action',            v_action,
        'waiting_reason',    v_new_waiting_reason,
        'previous_status',   v_prev_status,
        'new_status',        v_new_status,
        'new_status_category', v_new_status_category
      ),
      p_idempotency_key => 'sla.timer_recompute_required:' || p_entity_id::text || ':' || p_idempotency_key,
      p_event_version  => 1,
      p_available_at   => null
    );
  end if;

  -- ── 10. INSERT into ticket_activities (system_event) ────────────────────
  if p_actor_user_id is not null then
    select u.person_id into v_actor_person_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;
  end if;

  insert into public.ticket_activities
    (tenant_id, ticket_id, activity_type, author_person_id, visibility, metadata)
  values (
    p_tenant_id,
    p_entity_id,
    'system_event',
    v_actor_person_id,
    'system',
    jsonb_build_object(
      'event', 'status_changed',
      'previous', jsonb_build_object(
        'status',          v_prev_status,
        'status_category', v_prev_status_category,
        'waiting_reason',  v_prev_waiting_reason
      ),
      'next', jsonb_build_object(
        'status',          v_new_status,
        'status_category', v_new_status_category,
        'waiting_reason',  v_new_waiting_reason
      )
    )
  );

  -- ── 11. Emit ticket_status_changed / work_order_status_changed event ───
  perform outbox.emit(
    p_tenant_id      => p_tenant_id,
    p_event_type     => case when p_entity_kind = 'case' then 'ticket_status_changed'
                              else 'work_order_status_changed' end,
    p_aggregate_type => p_entity_kind,
    p_aggregate_id   => p_entity_id,
    p_payload        => jsonb_build_object(
      'entity_id',                p_entity_id,
      'entity_kind',              p_entity_kind,
      'previous_status',          v_prev_status,
      'new_status',               v_new_status,
      'previous_status_category', v_prev_status_category,
      'new_status_category',      v_new_status_category,
      'previous_waiting_reason',  v_prev_waiting_reason,
      'new_waiting_reason',       v_new_waiting_reason,
      'actor_user_id',            p_actor_user_id
    ),
    p_idempotency_key => p_idempotency_key || ':status_event',
    p_event_version  => 1,
    p_available_at   => null
  );

  -- ── 12. Mark command_operations success and return ─────────────────────
  v_result := jsonb_build_object(
    'entity_id',                p_entity_id,
    'entity_kind',              p_entity_kind,
    'previous_status',          v_prev_status,
    'new_status',               v_new_status,
    'previous_status_category', v_prev_status_category,
    'new_status_category',      v_new_status_category,
    'previous_waiting_reason',  v_prev_waiting_reason,
    'new_waiting_reason',       v_new_waiting_reason,
    'noop',                     false
  );

  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = now()
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

comment on function public.transition_entity_status(uuid, text, uuid, uuid, text, jsonb) is
  'v2 (00325): preserves resolved_at/closed_at on terminal re-entry via coalesce; clears both on leaving terminal. Otherwise identical to 00323. Spec: docs/follow-ups/b2-survey-and-design.md §3.1.';

notify pgrst, 'reload schema';
