-- B.2.A.6 — set_entity_assignment combined RPC.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.2 (lines 1986-2037).
--
-- ONE atomic RPC for assignment changes on cases (tickets) and
-- work_orders. Covers BOTH the "silent PATCH" assignment change AND
-- the "reassign-with-reason" variant (the latter writes a
-- routing_decisions audit row + uses metadata.event='reassigned').
-- Composed by the §3.0 update_entity_combined orchestrator
-- (00328 / Step 6 cutover); also called directly from the
-- TS-side reassign-with-resolver-rerun path (the TS preflight
-- runs RoutingService.evaluate, picks the next target, then calls
-- this RPC with the resolved assignees + a reason snapshot —
-- per spec lines 2012-2017).
--
-- Inputs:
--   p_entity_id        — case (tickets.id) or work_order (work_orders.id).
--   p_entity_kind      — 'case' | 'work_order' (allowlist).
--   p_tenant_id        — tenant scope.
--   p_actor_user_id    — Supabase auth uid (users.auth_uid). Nullable for
--                        SYSTEM_ACTOR (cron, outbox handlers). Resolved to
--                        users.person_id for ticket_activities.author_person_id;
--                        same convention as 00323:347-358.
--   p_idempotency_key  — operation-level key per command_operations (00316).
--   p_payload          — { assigned_team_id?, assigned_user_id?,
--                          assigned_vendor_id?, reason?, actor_person_id?,
--                          rerun_resolver? }
--
-- Output (jsonb cached_result):
--   { entity_id, entity_kind,
--     previous_assigned_team_id, previous_assigned_user_id, previous_assigned_vendor_id,
--     new_assigned_team_id,       new_assigned_user_id,       new_assigned_vendor_id,
--     previous_status_category, new_status_category,
--     reason, noop }
--
-- Concurrency contract — same as 00323:
--   1. pg_advisory_xact_lock(hashtextextended(tenant_id || ':' || idem, 0))
--      so two concurrent retries on the same key serialise.
--   2. command_operations row INSERTed with outcome='in_progress'; on commit
--      the RPC UPDATEs to outcome='success' with cached_result. Same key +
--      same payload_hash returns cached_result; same key + different payload
--      raises 'command_operations.payload_mismatch'.
--
-- Resolver-rerun rejection (spec lines 2012-2017):
--   The resolver depends on routing rules + asset/space-group expansion +
--   scope overrides — too much logic to port to PG. The RPC rejects any
--   payload with rerun_resolver=true; TS handles the rerun as a higher-
--   level orchestration that invokes this RPC with the resolved assignees.
--   This raises 'set_entity_assignment.resolver_rerun_not_supported_at_rpc'
--   — an internal-only signal that an orchestration layer skipped a step.
--
-- SLA: NO churn on assignment per spec lines 2027-2030 (case-side update
-- doesn't touch SLA on assignment; only on status / sla_id). 00325 covers
-- status; 00327 (planned) covers sla_id.
--
-- Diff semantics — undefined vs null:
--   * key absent from payload     → no change (current value preserved).
--   * key present, value null     → clear assignment (column becomes null).
--   * key present, value uuid     → set assignment (validated tenant-scoped).
--   The jsonb `?` operator distinguishes "key present" from "key absent";
--   `?` returns true even when value is jsonb null.
--
-- status_category inheritance:
--   When ANY non-null assignee is being set AND the row currently sits at
--   status_category='new', elevate to 'assigned'. Mirrors the existing TS
--   surface (ticket.service.ts:1394-1402 + work-order.service.ts assignment
--   path). NOT the inverse: clearing all assignees does NOT demote back to
--   'new' — that would invalidate state-machine invariants downstream.
--
-- routing_decisions schema: the polymorphic columns (case_id /
-- work_order_id / entity_kind) were added in 00232; legacy ticket_id is
-- retained as a soft pointer (FK dropped 00233). Convention from
-- ticket.service.ts:1414-1420 — set polymorphic columns explicitly even
-- though the BEFORE-INSERT trigger derive_polymorphic_entity_from_ticket_id
-- (00232) remains as a defensive fallback. Strategy column is required
-- non-null; we use 'manual' (matches TS reassign default at
-- ticket.service.ts:1317) with chosen_by='manual_reassign'.
--
-- ticket_activities check constraint allows only
-- {'internal_note','external_comment','system_event'}. We use
-- 'system_event' with metadata.event = 'assignment_changed' (silent
-- PATCH) or 'reassigned' (with reason) — same TS pattern at
-- ticket.service.ts:1208-1216 + ticket.service.ts:1431-1443.
--
-- SECURITY INVOKER, p_tenant_id explicit. Service-role only via grants.

create or replace function public.set_entity_assignment(
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
  v_prev_team              uuid;
  v_prev_user              uuid;
  v_prev_vendor            uuid;
  v_prev_status_category   text;
  v_new_team               uuid;
  v_new_user               uuid;
  v_new_vendor             uuid;
  v_new_status_category    text;
  v_has_team_key           boolean;
  v_has_user_key           boolean;
  v_has_vendor_key         boolean;
  v_any_new_assignee       boolean;
  v_reason                 text;
  v_actor_person_id        uuid;
  v_payload_actor_person   uuid;
  v_target_kind            text;
  v_target_id              uuid;
  v_activity_event         text;
  v_event_type             text;
  v_result                 jsonb;
begin
  -- ── 0. Argument shape checks ────────────────────────────────────────────
  if p_tenant_id is null then
    raise exception 'set_entity_assignment: p_tenant_id required';
  end if;
  if p_entity_id is null then
    raise exception 'set_entity_assignment: p_entity_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'set_entity_assignment: p_idempotency_key required';
  end if;
  if p_entity_kind is null or p_entity_kind not in ('case','work_order') then
    raise exception 'set_entity_assignment.unknown_kind: kind=%', coalesce(p_entity_kind, '<null>')
      using errcode = 'P0001';
  end if;

  -- ── 1. Reject rerun_resolver at this layer (spec lines 2012-2017) ──────
  --
  -- Resolver rerun is a TS-only orchestration. The RPC raises so a buggy
  -- caller doesn't silently lose the resolver step.
  if (p_payload ? 'rerun_resolver') and (p_payload->>'rerun_resolver') = 'true' then
    raise exception 'set_entity_assignment.resolver_rerun_not_supported_at_rpc'
      using errcode = 'P0001',
            hint = 'TS layer must call RoutingService.evaluate then re-invoke this RPC with the resolved assignees';
  end if;

  -- ── 2. Advisory lock (mirror 00323:104-106) ────────────────────────────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 3. command_operations idempotency gate (00316) ─────────────────────
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

  -- ── 4. Detect which assignment keys are present in payload ─────────────
  v_has_team_key   := p_payload ? 'assigned_team_id';
  v_has_user_key   := p_payload ? 'assigned_user_id';
  v_has_vendor_key := p_payload ? 'assigned_vendor_id';

  -- ── 5. SELECT FOR UPDATE on the right entity table ─────────────────────
  if p_entity_kind = 'case' then
    select id, assigned_team_id, assigned_user_id, assigned_vendor_id, status_category
      into v_current
      from public.tickets
     where id = p_entity_id and tenant_id = p_tenant_id
     for update;
  else
    select id, assigned_team_id, assigned_user_id, assigned_vendor_id, status_category
      into v_current
      from public.work_orders
     where id = p_entity_id and tenant_id = p_tenant_id
     for update;
  end if;

  if not found then
    raise exception 'set_entity_assignment.not_found: kind=% id=%', p_entity_kind, p_entity_id
      using errcode = 'P0001';
  end if;

  v_prev_team            := v_current.assigned_team_id;
  v_prev_user            := v_current.assigned_user_id;
  v_prev_vendor          := v_current.assigned_vendor_id;
  v_prev_status_category := v_current.status_category;

  -- ── 6. Compute target values (key-absent = no change) ──────────────────
  v_new_team   := case when v_has_team_key   then nullif(p_payload->>'assigned_team_id',   '')::uuid else v_prev_team   end;
  v_new_user   := case when v_has_user_key   then nullif(p_payload->>'assigned_user_id',   '')::uuid else v_prev_user   end;
  v_new_vendor := case when v_has_vendor_key then nullif(p_payload->>'assigned_vendor_id', '')::uuid else v_prev_vendor end;

  -- ── 7. Validate non-null assignees are tenant-owned (00317 helper) ─────
  --
  -- Cross-tenant FK leak is a P0 security concern (memory:
  -- feedback_tenant_id_ultimate_rule). The helper raises 42501 with a
  -- field-specific message; let it bubble.
  perform public.validate_assignees_in_tenant(p_tenant_id, v_new_team, v_new_user, v_new_vendor);

  -- ── 8. status_category inheritance ─────────────────────────────────────
  v_any_new_assignee := (v_new_team is not null or v_new_user is not null or v_new_vendor is not null);
  v_new_status_category :=
    case
      when v_any_new_assignee and v_prev_status_category = 'new' then 'assigned'
      else v_prev_status_category
    end;

  -- Reason + actor_person_id from payload.
  v_reason := nullif(p_payload->>'reason', '');
  v_payload_actor_person := nullif(p_payload->>'actor_person_id', '')::uuid;

  -- ── 9. No-op fast path ────────────────────────────────────────────────
  --
  -- All three target assignees match current AND no reason present →
  -- nothing to write. Return noop=true and mark command_operations success.
  -- NOTE: a present-with-reason payload always proceeds (the reason itself
  -- is the audit signal, even if assignees haven't changed) — this matches
  -- the manual reassign UX where an admin records a reason for keeping the
  -- same assignee.
  if v_new_team   is not distinct from v_prev_team
     and v_new_user   is not distinct from v_prev_user
     and v_new_vendor is not distinct from v_prev_vendor
     and v_reason is null then

    v_result := jsonb_build_object(
      'entity_id',                   p_entity_id,
      'entity_kind',                 p_entity_kind,
      'previous_assigned_team_id',   v_prev_team,
      'previous_assigned_user_id',   v_prev_user,
      'previous_assigned_vendor_id', v_prev_vendor,
      'new_assigned_team_id',        v_new_team,
      'new_assigned_user_id',        v_new_user,
      'new_assigned_vendor_id',      v_new_vendor,
      'previous_status_category',    v_prev_status_category,
      'new_status_category',         v_new_status_category,
      'reason',                      null,
      'noop',                        true
    );

    update public.command_operations
       set outcome = 'success', cached_result = v_result, completed_at = now()
     where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

    return v_result;
  end if;

  -- ── 10. UPDATE the row ────────────────────────────────────────────────
  --
  -- Conditional UPDATE — only touch the columns whose key was present in
  -- payload. Avoids gratuitous "column rewritten to its current value"
  -- which would still trigger any triggers watching that column.
  if p_entity_kind = 'case' then
    update public.tickets
       set assigned_team_id   = case when v_has_team_key   then v_new_team   else assigned_team_id   end,
           assigned_user_id   = case when v_has_user_key   then v_new_user   else assigned_user_id   end,
           assigned_vendor_id = case when v_has_vendor_key then v_new_vendor else assigned_vendor_id end,
           status_category    = v_new_status_category,
           updated_at         = now()
     where id = p_entity_id and tenant_id = p_tenant_id;
  else
    update public.work_orders
       set assigned_team_id   = case when v_has_team_key   then v_new_team   else assigned_team_id   end,
           assigned_user_id   = case when v_has_user_key   then v_new_user   else assigned_user_id   end,
           assigned_vendor_id = case when v_has_vendor_key then v_new_vendor else assigned_vendor_id end,
           status_category    = v_new_status_category,
           updated_at         = now()
     where id = p_entity_id and tenant_id = p_tenant_id;
  end if;

  -- ── 11. routing_decisions audit row (only if reason present) ──────────
  --
  -- Strategy='manual', chosen_by='manual_reassign' — same shape as
  -- ticket.service.ts:1414-1426 emits today. Polymorphic columns set
  -- explicitly per ticket.service.ts:1414 convention; the 00232 BEFORE-
  -- INSERT trigger remains as a defensive fallback. Target kind/id is
  -- the SINGLE non-null assignee being set (chosen_team_id /
  -- chosen_user_id / chosen_vendor_id reflect the actual assignment).
  if v_reason is not null then
    -- Pick the "primary" target for the chosen_* trio. If multiple
    -- assignees are set (e.g. team + user), populate all corresponding
    -- chosen_* columns so the audit row is self-describing.
    insert into public.routing_decisions (
      tenant_id, ticket_id,
      entity_kind,
      case_id, work_order_id,
      strategy, chosen_team_id, chosen_user_id, chosen_vendor_id,
      chosen_by, trace, context
    ) values (
      p_tenant_id,
      p_entity_id,
      p_entity_kind,
      case when p_entity_kind = 'case'       then p_entity_id else null end,
      case when p_entity_kind = 'work_order' then p_entity_id else null end,
      'manual',
      v_new_team,
      v_new_user,
      v_new_vendor,
      'manual_reassign',
      '[]'::jsonb,
      jsonb_build_object(
        'reason',   v_reason,
        'previous', jsonb_build_object(
          'assigned_team_id',   v_prev_team,
          'assigned_user_id',   v_prev_user,
          'assigned_vendor_id', v_prev_vendor
        ),
        'actor',    v_payload_actor_person
      )
    );
  end if;

  -- ── 12. Resolve actor_person_id for ticket_activities ─────────────────
  --
  -- Same author-resolution convention as 00323:347-358 — p_actor_user_id
  -- is users.auth_uid. If the payload carries an explicit actor_person_id
  -- (the reassign-with-reason path threads it for attribution), prefer
  -- that; else resolve from auth_uid.
  if v_payload_actor_person is not null then
    v_actor_person_id := v_payload_actor_person;
  elsif p_actor_user_id is not null then
    select u.person_id into v_actor_person_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;
  end if;

  -- ── 13. INSERT ticket_activities (system_event) ───────────────────────
  --
  -- ticket_activities.activity_type check constraint allows only
  -- {internal_note, external_comment, system_event}. Use system_event
  -- with metadata.event='assignment_changed' (silent) or 'reassigned'
  -- (with reason). Mirrors ticket.service.ts:1208-1216 (silent) and
  -- :1431-1443 (reassigned).
  --
  -- Visibility is 'system' for silent assignment changes, 'internal' for
  -- reassign-with-reason (so the reason content is visible to internal
  -- audit but never to the requester).
  v_activity_event := case when v_reason is not null then 'reassigned' else 'assignment_changed' end;

  insert into public.ticket_activities
    (tenant_id, ticket_id, activity_type, author_person_id, visibility, content, metadata)
  values (
    p_tenant_id,
    p_entity_id,
    'system_event',
    v_actor_person_id,
    case when v_reason is not null then 'internal' else 'system' end,
    v_reason,
    jsonb_build_object(
      'event',    v_activity_event,
      'previous', jsonb_build_object(
        'assigned_team_id',   v_prev_team,
        'assigned_user_id',   v_prev_user,
        'assigned_vendor_id', v_prev_vendor
      ),
      'next', jsonb_build_object(
        'assigned_team_id',   v_new_team,
        'assigned_user_id',   v_new_user,
        'assigned_vendor_id', v_new_vendor
      ),
      'reason', v_reason
    )
  );

  -- ── 14. Emit ticket_assigned / work_order_assigned outbox event ───────
  --
  -- The spec body sketch (line 2024) mentions domain_events but the §3.1
  -- RPC (00323:383-404) uses outbox.emit for the equivalent status event;
  -- match that pattern here. Idempotency suffix `:assignment_event` keeps
  -- outbox-level dedupe per spec note in 00323:401.
  v_event_type := case when p_entity_kind = 'case' then 'ticket_assigned' else 'work_order_assigned' end;

  perform outbox.emit(
    p_tenant_id      => p_tenant_id,
    p_event_type     => v_event_type,
    p_aggregate_type => p_entity_kind,
    p_aggregate_id   => p_entity_id,
    p_payload        => jsonb_build_object(
      'entity_id',                   p_entity_id,
      'entity_kind',                 p_entity_kind,
      'previous_assigned_team_id',   v_prev_team,
      'previous_assigned_user_id',   v_prev_user,
      'previous_assigned_vendor_id', v_prev_vendor,
      'new_assigned_team_id',        v_new_team,
      'new_assigned_user_id',        v_new_user,
      'new_assigned_vendor_id',      v_new_vendor,
      'previous_status_category',    v_prev_status_category,
      'new_status_category',         v_new_status_category,
      'reason',                      v_reason,
      'actor_user_id',               p_actor_user_id,
      'actor_person_id',             v_payload_actor_person
    ),
    p_idempotency_key => p_idempotency_key || ':assignment_event',
    p_event_version  => 1,
    p_available_at   => null
  );

  -- ── 15. Mark command_operations success and return ───────────────────
  v_result := jsonb_build_object(
    'entity_id',                   p_entity_id,
    'entity_kind',                 p_entity_kind,
    'previous_assigned_team_id',   v_prev_team,
    'previous_assigned_user_id',   v_prev_user,
    'previous_assigned_vendor_id', v_prev_vendor,
    'new_assigned_team_id',        v_new_team,
    'new_assigned_user_id',        v_new_user,
    'new_assigned_vendor_id',      v_new_vendor,
    'previous_status_category',    v_prev_status_category,
    'new_status_category',         v_new_status_category,
    'reason',                      v_reason,
    'noop',                        false
  );

  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = now()
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

revoke execute on function public.set_entity_assignment(uuid, text, uuid, uuid, text, jsonb) from public;
grant  execute on function public.set_entity_assignment(uuid, text, uuid, uuid, text, jsonb) to service_role;

comment on function public.set_entity_assignment(uuid, text, uuid, uuid, text, jsonb) is
  'Atomic assignment change for cases (tickets) and work_orders. Single transaction commits the row UPDATE (assignment columns + status_category inheritance) + ticket_activities (assignment_changed | reassigned) + optional routing_decisions audit row (when payload.reason present) + outbox.events (ticket_assigned | work_order_assigned). Idempotent on (tenant_id, idempotency_key) via command_operations (00316). Resolver-rerun is rejected at this layer per spec lines 2012-2017. SLA-free per spec lines 2027-2030. Spec: docs/follow-ups/b2-survey-and-design.md §3.2.';

notify pgrst, 'reload schema';
