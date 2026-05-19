-- audit-02 RECONCILE (canonical=C) — forward-only restore of main's
-- canonical set_entity_assignment v3 body on the shared remote.
--
-- ── Why this migration exists ───────────────────────────────────────────
--
-- Two divergent audit-02 remediations existed. origin/main carries the
-- CANONICAL lineage: set_entity_assignment ==
-- supabase/migrations/00425_set_entity_assignment_v3_clear_routing_status.sql
-- (audit-02 P1-2; v3 opt-in routing_status clear folded into the RPC tx).
--
-- A different branch (feature/booking-audit-remediation) shipped a
-- DIVERGENT lineage (00416/00418/00419) and OUT-OF-BAND pushed its 00419
-- function body to the SHARED REMOTE. The live remote
-- public.set_entity_assignment is therefore now that foreign v3.2 body,
-- NOT main's 00425 body that origin/main's deployed code expects. The
-- foreign body emits spurious activity / ticket_assigned events on pure
-- status-clears (ACTIVE-BREAK: timeline noise + spurious notification /
-- MS-Graph wakes on every routing re-eval that re-picks the current
-- assignee).
--
-- codex 2026-05-19 decision = canonical C: keep main's lineage. This
-- migration is the forward-only restore so the orchestrator's gated
-- remote-apply brings the live remote back to main's 00425 body. The
-- 00425 file is the SOURCE-OF-TRUTH body; the create-or-replace below is
-- reproduced byte-faithfully from it (same signature, same body, same
-- grant/comment/NOTIFY tail). The ONLY difference vs 00425 is this header
-- comment block. Do NOT bring 00416/00418/00419 or any other
-- divergent-lineage change.
--
-- Source-of-truth body: supabase/migrations/00425_set_entity_assignment_v3_clear_routing_status.sql
-- Reconcile decision: codex 2026-05-19 canonical=C
-- See also: docs/follow-ups/audits/02-tickets-work-orders.md (Closure Ledger).

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
  v_team_changed           boolean;
  v_user_changed           boolean;
  v_vendor_changed         boolean;
  v_changed_axes           int;
  v_reason                 text;
  v_actor_person_id        uuid;
  v_payload_actor_person   uuid;
  v_activity_event         text;
  v_metadata_previous      jsonb;
  v_metadata_next          jsonb;
  v_event_type             text;
  v_result                 jsonb;
  -- D1 (v3): opt-in flag — fold the routing-evaluation handler's
  -- tickets.routing_status/routing_failure_reason clear into this tx.
  -- Absent / non-boolean → false → byte-identical-to-v2 behaviour.
  v_clear_routing_status   boolean := coalesce((p_payload->>'clear_routing_status')::boolean, false);
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

  -- D5 (v3): work_orders has no routing_status/routing_failure_reason
  -- columns (00320 adds them only to public.tickets). Reject the
  -- combination loudly rather than silently no-op'ing or erroring on a
  -- missing column. Unreachable today (no WO routing.evaluation_required
  -- producer); the guard is for a future WO producer.
  if p_entity_kind = 'work_order' and v_clear_routing_status then
    raise exception 'set_entity_assignment.routing_status_unsupported_for_work_order'
      using errcode = 'P0001',
            hint = 'work_orders has no routing_status/routing_failure_reason columns; clear_routing_status is case-only';
  end if;

  -- ── 1. Reject rerun_resolver at this layer (spec lines 2012-2017) ──────
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
  --
  -- D3 (v3): `and not v_clear_routing_status` added to the early-return
  -- guard. When the flag is set we MUST NOT take this shortcut even on an
  -- assignee-unchanged + no-reason call — otherwise a routing
  -- re-evaluation that re-picks the SAME assignee the row already has
  -- would skip the UPDATE and leave routing_status pinned at 'pending'
  -- forever (the audit-02 P1-2 bug, relocated). Falling through routes to
  -- the §10 UPDATE which (with the flag) at minimum writes
  -- routing_status='idle' / routing_failure_reason=null / updated_at even
  -- when assignees are unchanged. When the flag is false this guard is
  -- byte-identical to v2 (00327:212-237).
  if v_new_team   is not distinct from v_prev_team
     and v_new_user   is not distinct from v_prev_user
     and v_new_vendor is not distinct from v_prev_vendor
     and v_reason is null
     and not v_clear_routing_status then

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
  -- D4 (v3): when v_clear_routing_status, the case UPDATE also folds the
  -- routing_status='idle' / routing_failure_reason=null clear into the
  -- SAME atomic row write (audit-02 P1-2). Assignee columns may be
  -- unchanged here (the §9 no-op shortcut was skipped because the flag is
  -- set) — the assignee CASE-WHENs are no-ops in that case and the
  -- routing_status/updated_at writes are the meaningful change.
  if p_entity_kind = 'case' then
    update public.tickets
       set assigned_team_id   = case when v_has_team_key   then v_new_team   else assigned_team_id   end,
           assigned_user_id   = case when v_has_user_key   then v_new_user   else assigned_user_id   end,
           assigned_vendor_id = case when v_has_vendor_key then v_new_vendor else assigned_vendor_id end,
           status_category    = v_new_status_category,
           routing_status         = case when v_clear_routing_status then 'idle' else routing_status         end,
           routing_failure_reason = case when v_clear_routing_status then null   else routing_failure_reason end,
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
  if v_reason is not null then
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
  if v_payload_actor_person is not null then
    v_actor_person_id := v_payload_actor_person;
  elsif p_actor_user_id is not null then
    select u.person_id into v_actor_person_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;
  end if;

  -- ── 13. Build metadata.previous + metadata.next per event ─────────────
  --
  -- C3 alignment with TS callers:
  --
  --  * assignment_changed (silent path; ticket.service.ts:1193-1216):
  --    previous + next include ONLY changed fields with the long
  --    `assigned_*_id` keys.
  --
  --  * reassigned (with-reason; ticket.service.ts:1431-1443):
  --    previous is short keys {team, user, vendor} (all three).
  --    next is {kind, id} for the single non-null target axis.
  --    If multiple axes are simultaneously set, fall back to the
  --    assignment_changed shape so the audit row carries everything.
  v_team_changed   := v_new_team   is distinct from v_prev_team;
  v_user_changed   := v_new_user   is distinct from v_prev_user;
  v_vendor_changed := v_new_vendor is distinct from v_prev_vendor;
  v_changed_axes := (
      (case when v_new_team   is not null then 1 else 0 end)
    + (case when v_new_user   is not null then 1 else 0 end)
    + (case when v_new_vendor is not null then 1 else 0 end)
  );

  v_activity_event := case when v_reason is not null then 'reassigned' else 'assignment_changed' end;

  if v_activity_event = 'reassigned' and v_changed_axes <= 1 then
    -- Canonical reassign shape: short-keyed previous, {kind,id} next.
    v_metadata_previous := jsonb_build_object(
      'team',   v_prev_team,
      'user',   v_prev_user,
      'vendor', v_prev_vendor
    );
    if v_new_team is not null then
      v_metadata_next := jsonb_build_object('kind', 'team', 'id', v_new_team);
    elsif v_new_user is not null then
      v_metadata_next := jsonb_build_object('kind', 'user', 'id', v_new_user);
    elsif v_new_vendor is not null then
      v_metadata_next := jsonb_build_object('kind', 'vendor', 'id', v_new_vendor);
    else
      v_metadata_next := 'null'::jsonb;
    end if;
  else
    -- assignment_changed shape (or reassigned multi-axis fallback):
    -- only changed fields appear, keys are long-form assigned_*_id.
    v_metadata_previous := '{}'::jsonb;
    v_metadata_next     := '{}'::jsonb;
    if v_team_changed then
      v_metadata_previous := v_metadata_previous || jsonb_build_object('assigned_team_id', v_prev_team);
      v_metadata_next     := v_metadata_next     || jsonb_build_object('assigned_team_id', v_new_team);
    end if;
    if v_user_changed then
      v_metadata_previous := v_metadata_previous || jsonb_build_object('assigned_user_id', v_prev_user);
      v_metadata_next     := v_metadata_next     || jsonb_build_object('assigned_user_id', v_new_user);
    end if;
    if v_vendor_changed then
      v_metadata_previous := v_metadata_previous || jsonb_build_object('assigned_vendor_id', v_prev_vendor);
      v_metadata_next     := v_metadata_next     || jsonb_build_object('assigned_vendor_id', v_new_vendor);
    end if;
  end if;

  -- ── 14+15 gate (v3 / audit-02 P1-2, review Code-I2) ───────────────────
  -- §9's no-op early-return is skipped when v_clear_routing_status is set
  -- (D3), so a routing re-evaluation that re-picks the SAME assignee falls
  -- through to here purely to clear routing_status. WITHOUT this gate that
  -- pure-status-clear path would insert a BLANK `assignment_changed`
  -- ticket_activities row (previous={} / next={}) and a no-op
  -- `ticket_assigned` domain_events row (previous == new) on every such
  -- re-eval — timeline noise + spurious notification/MS-Graph wakes. Emit
  -- the activity + domain event ONLY when something substantive actually
  -- changed (an assignee axis moved) or a reason was supplied. This does
  -- NOT regress the flag=false callers: with the flag false §9 already
  -- early-returns on no-change+no-reason, so reaching here implies
  -- substantive change or reason → the gate is true → identical to v2.
  if v_team_changed or v_user_changed or v_vendor_changed or v_reason is not null then
    -- ── 14. INSERT ticket_activities (system_event) ─────────────────────
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
        'previous', v_metadata_previous,
        'next',     v_metadata_next,
        'reason',   v_reason
      )
    );

    -- ── 15. INSERT public.domain_events (ticket_assigned) ───────────────
    --
    -- C1+C2 fix: write to domain_events instead of outbox.events. Both case
    -- and work_order side use event_type='ticket_assigned' + entity_type='ticket'
    -- — entity_id disambiguates per work-order.service.ts:1923-1929 + spec
    -- line 2024. actor_user_id stays NULL (existing TS callers don't fill
    -- it; ticket.service.ts:1685-1692).
    v_event_type := 'ticket_assigned';

    insert into public.domain_events
      (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id)
    values (
      p_tenant_id,
      v_event_type,
      'ticket',
      p_entity_id,
      jsonb_build_object(
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
      null
    );
  end if;

  -- ── 16. Mark command_operations success and return ───────────────────
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
  'Atomic assignment change for cases (tickets) and work_orders. Single transaction commits the row UPDATE (assignment columns + status_category inheritance) + ticket_activities (assignment_changed | reassigned) + optional routing_decisions audit row (when payload.reason present) + domain_events (ticket_assigned). v3 (audit-02 P1-2) adds an opt-in payload.clear_routing_status boolean (default false): when true on a case, the SAME row UPDATE also sets routing_status=''idle'' / routing_failure_reason=null AND the no-op fast path is skipped (so a re-evaluation that re-picks the current assignee still clears routing_status); folds the routing-evaluation handler''s previously-non-atomic post-RPC clear into this tx. Flag absent → byte-identical to v2. work_order + clear_routing_status raises set_entity_assignment.routing_status_unsupported_for_work_order (work_orders has no such columns; case-only producers). v2 (00327) corrected 00326: domain_events insert per spec line 2024 (was outbox.emit, no handler); metadata.previous+next shape aligned with TS callers (ticket.service.ts:1208-1216 + :1431-1443). Idempotent on (tenant_id, idempotency_key) via command_operations (00316). Resolver-rerun rejected at this layer per spec lines 2012-2017. SLA-free per spec lines 2027-2030. Spec: docs/follow-ups/b2-survey-and-design.md §3.2.';

notify pgrst, 'reload schema';
