-- B.4.A.4 — edit_booking RPC v4 (approval reconciliation; supersedes 00363).
--
-- Spec: docs/follow-ups/b4-booking-edit-pipeline.md §3.6.5.
--
-- v3 → v4 supersession. v3 deferred §3.6.5 reconciliation behind a 422 raise
-- (`edit_booking.approval_reconciliation_required` at 00363:370-373); v4
-- replaces that deferral with the 10-row decision table from §3.6.5. The
-- code `edit_booking.approval_reconciliation_required` is RETIRED — it has
-- no callers in TS (verified via grep across packages/shared,
-- apps/api/src, apps/web/src on 2026-05-12) and lives only in registries.
-- Five registry sites drop it; one new code is added in its place.
--
-- ── What's new in v4 ─────────────────────────────────────────────────────
--
-- 1. EditPlan contract extension (REPLACES `approval_outcome_changed`).
--    The plan now carries a structured `approval` object:
--      {
--        old_outcome:           'allow' | 'require_approval' | 'deny',
--        new_outcome:           'allow' | 'require_approval' | 'deny',
--        chain_config_changed:  boolean,
--        new_chain_config:      null | {
--          required_approvers: [ { type: 'person'|'team', id: uuid }, ... ],
--          threshold:          'all' | 'any'    -- mirrors booking-flow.service.ts:1268
--        }
--      }
--    `threshold: 'all'` → parallel_group = 'parallel-<booking_id>' (every
--    approver must say yes — see booking-flow.service.ts:1273). `'any'` →
--    parallel_group = null (one approver suffices). Same shape used by
--    `createApprovalRows` at booking creation, so the audit + state-machine
--    code paths are unified across create + edit. (Spec §3.6.5 mentioned a
--    `sequential` boolean + `required_count`; we adopt the existing
--    `threshold` enum instead — see B.4.A.4 prompt's INVIOLABLE rule
--    "MUST match that pattern for consistency with create".)
--
-- 2. Approval reconciliation decision table (spec §3.6.5, rows 1-10).
--    Implemented as a single CASE on `(old, new, state, chain_changed)`:
--      Row  1: allow → allow,                       none     → no-op
--      Row  2: allow → require_approval,            none     → INSERT chain; status=pending_approval; emit booking.approval_required
--      Row  3: require_approval → allow,            pending  → expire chain; status=confirmed
--      Row  4: require_approval → allow,            tApprov  → no-op (history stands)
--      Row  5: require_approval → allow,            tReject  → RAISE booking.cancelled_cannot_edit (already cancelled)
--      Row  6: require_approval → require_approval, pending, same config → preserve in-flight
--      Row  7: require_approval → require_approval, pending, diff config → expire + INSERT; status=pending_approval; emit
--      Row  8: require_approval → require_approval, tApprov, diff config → expire + INSERT (DANGEROUS GAP); status=pending_approval; emit
--      Row  9: require_approval → require_approval, tReject  → RAISE booking.cancelled_cannot_edit
--      Row 10: * → deny                                       → RAISE edit_booking.deny_on_edit (NEW)
--
--    Approval state classification (loaded BEFORE the gate via SELECT on
--    public.approvals filtered by target_entity_type='booking' +
--    target_entity_id=p_booking_id + tenant_id):
--      `none`            : zero rows.
--      `pending`         : at least one row in ('pending','delegated').
--                          May include any number of 'approved' rows.
--      `terminal_approved`: zero pending/delegated/rejected; ≥1 'approved'.
--      `terminal_rejected`: at least one row with status='rejected'.
--    Mirrors §3.6.5's definitions + the rejection-cancels-booking semantics
--    at 00310_grant_booking_approval_rpc.sql:162-172.
--
-- 3. Expiry shape (mirrors 00310_grant_booking_approval_rpc.sql:165-172,
--    extended for edit-supersession).
--    UPDATE public.approvals
--       SET status='expired',
--           responded_at=v_started_at,
--           comments='superseded_by_edit (booking edit at <ts>)'
--     WHERE target_entity_type='booking' AND target_entity_id=p_booking_id
--       AND tenant_id=p_tenant_id
--       AND status IN ('pending','delegated', /* + 'approved' for row 8 */);
--    For row 8 (DANGEROUS GAP — terminal_approved + diff config), we also
--    expire the 'approved' rows so the new chain owns the decision. Old
--    rows stay in the audit log; only their status flips.
--
-- 4. INSERT shape (mirrors booking-flow.service.ts:1275-1283).
--    INSERT INTO public.approvals
--      (tenant_id, target_entity_type, target_entity_id,
--       approval_chain_id, parallel_group,
--       approver_person_id, approver_team_id, status)
--    VALUES ( p_tenant_id, 'booking', p_booking_id,
--             v_new_chain_id, v_parallel_group,
--             <person id or null>, <team id or null>, 'pending')
--    per approver in p_plan.approval.new_chain_config.required_approvers.
--    Each approver is tenant-validated via validate_entity_in_tenant
--    BEFORE the INSERT (kinds 'person' + 'team' both available post-00360).
--    step_number is left NULL to mirror create-time (booking-flow inserts
--    don't set it either; sequential vs parallel is encoded via
--    parallel_group). Single `approval_chain_id` per edit-driven chain.
--
-- 5. New error code `edit_booking.deny_on_edit` (422).
--    The new rule resolver outcome is `deny` for the edit target. Mirror
--    CREATE: deny is a hard 422, no actor-override path here (override is
--    a separate concern, B.4.D follow-up). English: "This edit isn't allowed
--    by the rules for this room." NL: "Deze wijziging is niet toegestaan
--    voor deze ruimte volgens de regels."
--
-- 6. Outbox emit `booking.approval_required` (rows 2, 7, 8).
--    Producer-side wire shape:
--      { booking_id, chain_id, approver_ids[], started_at }
--    The event literal already exists in
--    apps/api/src/modules/reservations/event-types.ts (B.4.A.1). The
--    consumer-side handler is NOT yet shipped — emits dead-letter at the
--    worker with `no_handler_registered` per the doc comment on
--    BookingEditEventType.ApprovalRequired. Producer-before-consumer is
--    intentional: B.4.A.5 (controller cutover) is the first real caller;
--    the handler MUST land in B.4.A.5 or earlier. Tracked as a follow-up
--    in this commit; do not skip on the consumer.
--
-- ── Code removed in v4 ───────────────────────────────────────────────────
--
-- - The §0 plan-shape check for `approval_outcome_changed` (00363:201-205)
--   is replaced by a check for `approval` object presence + keyed shape.
-- - The approval-flip deferral raise (00363:369-374) is deleted — replaced
--   by the decision table.
-- - All v3 fixes (1-9) + critical 1+2 (origin+destination room scope on the
--   stale-resolution gate, booking-scope on child patches) are preserved
--   byte-identically.
--
-- ── Citation discipline ─────────────────────────────────────────────────
--
-- Every column/method/file:line referenced above was read in this session:
-- - `approvals` columns + status enum: 00012_approvals.sql:1-19 (verified
--   `parallel_group text` at :10; enum values `pending|approved|rejected|
--   delegated|expired` at :14 — NO `'cancelled'` value).
-- - `parallel_group` (not `parallel_group_id`) — same lesson learned in
--   B.2.A's 00358 hotfix on 00357.
-- - Booking-flow approval insert: booking-flow.service.ts:1266-1287.
-- - Approval-grant expire shape: 00310:165-172.
-- - Booking-status enum: 00277:50 + :143 (includes `pending_approval`).
-- - validate_entity_in_tenant kinds: 00360:173+177 (person), :229+233 (team).
-- - BookingEditEventType.ApprovalRequired literal: apps/api/src/modules/
--   reservations/event-types.ts.
-- - Approval state classification semantics: 00310_grant_booking_approval_rpc.sql:175-186
--   (the existing partial/terminal logic on the GRANT path).
--
-- Sibling RPCs (template for body shape):
--   - 00309_create_booking_with_attach_plan_rpc.sql — booking-side canonical.
--   - 00310_grant_booking_approval_rpc.sql         — approval-side canonical (expire shape).
--   - 00363_edit_booking_rpc_v3.sql                — direct predecessor.
--
-- ── Raise codes ─────────────────────────────────────────────────────────
--   (preserved from v3)
--   edit_booking.actor_not_found                       (404)
--   edit_booking.not_found                             (404)
--   edit_booking.invalid_plan_shape                    (400)
--   booking.cancelled_cannot_edit                      (422)
--   command_operations.payload_mismatch                (409)
--   command_operations.unexpected_state                (500)
--   automation_plan.stale_resolution                   (409)
--   validate_entity_in_tenant.*_not_in_tenant          (404)
--   edit_booking.work_order_not_in_booking             (404)
--   edit_booking.order_not_in_booking                  (404)
--   edit_booking.asset_reservation_not_in_booking      (404)
--
--   (REMOVED in v4)
--   edit_booking.approval_reconciliation_required      — deleted
--
--   (NEW in v4)
--   edit_booking.deny_on_edit                          (422)

drop function if exists public.edit_booking(uuid, jsonb, uuid, uuid, text);

create or replace function public.edit_booking(
  p_booking_id      uuid,
  p_plan            jsonb,
  p_tenant_id       uuid,
  p_actor_user_id   uuid,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, outbox
as $$
declare
  v_started_at         constant timestamptz := now();

  v_existing           public.command_operations;
  v_payload_hash       text;
  v_lock_key           bigint;

  v_actor_users_id     uuid;

  v_booking            record;

  v_booking_patch      jsonb;
  v_slot_patches       jsonb;
  v_asset_patches      jsonb;
  v_order_patches      jsonb;
  v_wo_patches         jsonb;

  v_slot               jsonb;
  v_asset              jsonb;
  v_order              jsonb;
  v_wo                 jsonb;
  v_rule_id            uuid;

  -- Required (must be present in the booking patch):
  v_new_location_id        uuid;
  v_new_start_at           timestamptz;
  v_new_end_at             timestamptz;
  v_new_cost_snapshot      numeric(10,2);
  v_resolution_at_ts       timestamptz;

  -- Optional (preserve-or-overwrite — computed at write-time below):
  v_new_policy_snapshot    jsonb;
  v_new_applied_rule_ids   uuid[];
  v_new_cost_center_id     uuid;
  v_new_calendar_etag      text;
  v_new_host_person_id     uuid;
  v_new_recurrence_over    boolean;
  v_new_config_release_id  uuid;

  -- Semantic re-derivation gate.
  v_rules_max_updated_at   timestamptz;

  -- v4: approval reconciliation (§3.6.5).
  v_approval_block         jsonb;
  v_old_outcome            text;
  v_new_outcome            text;
  v_chain_config_changed   boolean;
  v_new_chain_config       jsonb;
  v_approval_state         text;
  v_pending_count          int;
  v_delegated_count        int;
  v_approved_count         int;
  v_rejected_count         int;
  v_action                 text;    -- 'noop'|'expire'|'insert'|'expire_and_insert'|'deny_raise'|'cancelled_raise'
  v_status_target          text;    -- 'confirmed'|'pending_approval'|NULL (=preserve)
  v_emit_approval_required boolean := false;
  v_new_chain_id           uuid;
  v_parallel_group         text;
  v_threshold              text;
  v_approver               jsonb;
  v_approver_type          text;
  v_approver_id            uuid;
  v_approver_ids           uuid[] := '{}'::uuid[];
  v_new_booking_status     text;

  v_audit_before           jsonb;
  v_audit_after            jsonb;

  v_emitted                jsonb := '[]'::jsonb;

  v_result                 jsonb;
  v_row_count              int;
  v_orders_updated         int := 0;
  v_assets_updated         int := 0;
  v_wo_updated             int := 0;
  v_slots_updated          int := 0;
begin
  -- ── 0. Argument shape checks ─────────────────────────────────────────
  if p_tenant_id is null then
    raise exception 'edit_booking: p_tenant_id required';
  end if;
  if p_booking_id is null then
    raise exception 'edit_booking: p_booking_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'edit_booking: p_idempotency_key required';
  end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan must be a jsonb object'
      using errcode = 'P0001';
  end if;

  if not (p_plan ? 'booking') or jsonb_typeof(p_plan->'booking') <> 'object' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.booking must be a jsonb object'
      using errcode = 'P0001';
  end if;
  if not (p_plan ? 'slot_patches') or jsonb_typeof(p_plan->'slot_patches') <> 'array' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.slot_patches must be a jsonb array'
      using errcode = 'P0001';
  end if;
  if not (p_plan ? '_resolution_at') or jsonb_typeof(p_plan->'_resolution_at') <> 'string' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan._resolution_at must be an ISO timestamp string'
      using errcode = 'P0001';
  end if;

  -- v4: replace `approval_outcome_changed` shape check with the new
  -- structured approval block (§3.6.5).
  if not (p_plan ? 'approval') or jsonb_typeof(p_plan->'approval') <> 'object' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.approval must be a jsonb object (v4 §3.6.5)'
      using errcode = 'P0001';
  end if;
  v_approval_block := p_plan->'approval';

  if not (v_approval_block ? 'old_outcome')
     or jsonb_typeof(v_approval_block->'old_outcome') <> 'string' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.approval.old_outcome must be a string'
      using errcode = 'P0001';
  end if;
  if not (v_approval_block ? 'new_outcome')
     or jsonb_typeof(v_approval_block->'new_outcome') <> 'string' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.approval.new_outcome must be a string'
      using errcode = 'P0001';
  end if;
  if not (v_approval_block ? 'chain_config_changed')
     or jsonb_typeof(v_approval_block->'chain_config_changed') <> 'boolean' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.approval.chain_config_changed must be boolean'
      using errcode = 'P0001';
  end if;

  v_old_outcome          := v_approval_block->>'old_outcome';
  v_new_outcome          := v_approval_block->>'new_outcome';
  v_chain_config_changed := (v_approval_block->>'chain_config_changed')::boolean;
  v_new_chain_config     := case
                              when v_approval_block ? 'new_chain_config'
                                   and jsonb_typeof(v_approval_block->'new_chain_config') = 'object'
                              then v_approval_block->'new_chain_config'
                              else null
                            end;

  if v_old_outcome not in ('allow', 'require_approval', 'deny') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.approval.old_outcome must be allow|require_approval|deny (got %)', v_old_outcome
      using errcode = 'P0001';
  end if;
  if v_new_outcome not in ('allow', 'require_approval', 'deny') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.approval.new_outcome must be allow|require_approval|deny (got %)', v_new_outcome
      using errcode = 'P0001';
  end if;

  v_asset_patches := coalesce(p_plan->'asset_reservation_patches', '[]'::jsonb);
  v_order_patches := coalesce(p_plan->'order_patches',             '[]'::jsonb);
  v_wo_patches    := coalesce(p_plan->'work_order_sla_patches',    '[]'::jsonb);

  v_booking_patch := p_plan->'booking';
  v_slot_patches  := p_plan->'slot_patches';

  if jsonb_typeof(v_asset_patches) <> 'array' then
    raise exception 'edit_booking.invalid_plan_shape: asset_reservation_patches must be a jsonb array'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_order_patches) <> 'array' then
    raise exception 'edit_booking.invalid_plan_shape: order_patches must be a jsonb array'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_wo_patches) <> 'array' then
    raise exception 'edit_booking.invalid_plan_shape: work_order_sla_patches must be a jsonb array'
      using errcode = 'P0001';
  end if;

  -- REQUIRED booking-patch keys must be present (v2 Fix 2).
  if not (v_booking_patch ? 'location_id') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.booking.location_id is required'
      using errcode = 'P0001';
  end if;
  if not (v_booking_patch ? 'start_at') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.booking.start_at is required'
      using errcode = 'P0001';
  end if;
  if not (v_booking_patch ? 'end_at') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.booking.end_at is required'
      using errcode = 'P0001';
  end if;
  if not (v_booking_patch ? 'cost_amount_snapshot') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.booking.cost_amount_snapshot is required'
      using errcode = 'P0001';
  end if;

  -- ── 1. F-CRIT-1: auth_uid → users.id ONCE. (Unchanged from v3.)
  if p_actor_user_id is not null then
    select u.id
      into v_actor_users_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;

    if v_actor_users_id is null then
      raise exception 'edit_booking.actor_not_found: auth_uid=% not registered as a user in tenant=%',
        p_actor_user_id, p_tenant_id
        using errcode = 'P0001';
    end if;
  end if;

  -- ── 2. Advisory lock keyed on (tenant_id, idempotency_key) ───────────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 3. command_operations idempotency gate ───────────────────────────
  v_payload_hash := md5(coalesce(p_plan::text, ''));

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

  -- ── 4. Row lock on bookings + load pre-edit snapshot ─────────────────
  select id, tenant_id, title, description,
         requester_person_id, host_person_id, booked_by_user_id,
         location_id, start_at, end_at, timezone,
         status, source,
         cost_center_id, cost_amount_snapshot,
         policy_snapshot, applied_rule_ids, config_release_id,
         calendar_event_id, calendar_provider, calendar_etag,
         recurrence_series_id, recurrence_index, recurrence_overridden,
         recurrence_skipped, template_id,
         created_at, updated_at
    into v_booking
    from public.bookings
   where id = p_booking_id
     and tenant_id = p_tenant_id
   for update;

  if not found then
    raise exception 'edit_booking.not_found: booking=% tenant=%', p_booking_id, p_tenant_id
      using errcode = 'P0001';
  end if;

  -- ── 5. Cancelled-state guard ──────────────────────────────────────────
  if v_booking.status = 'cancelled' then
    raise exception 'booking.cancelled_cannot_edit: booking=% is cancelled and can no longer be edited',
      p_booking_id
      using errcode = 'P0001';
  end if;

  -- v3 Critical 1: derive v_new_location_id BEFORE the stale-resolution gate.
  v_new_location_id := (v_booking_patch->>'location_id')::uuid;

  -- ── 6. Semantic re-derivation gate (v3 Critical 1 — origin+destination)
  v_resolution_at_ts := (p_plan->>'_resolution_at')::timestamptz;
  select max(updated_at)
    into v_rules_max_updated_at
    from public.room_booking_rules
   where tenant_id = p_tenant_id
     and (
       target_scope = 'tenant'
       or (target_scope = 'room'
           and target_id in (v_booking.location_id, v_new_location_id))
       or target_scope in ('space_subtree', 'room_type')
     );

  if v_rules_max_updated_at is not null
     and v_rules_max_updated_at > v_resolution_at_ts then
    raise exception 'automation_plan.stale_resolution: room_booking_rules.updated_at=% > plan._resolution_at=%',
      v_rules_max_updated_at, v_resolution_at_ts
      using errcode = 'P0001',
            hint = 'The booking rule set changed since the plan was built. Refetch and retry.';
  end if;

  -- ── 7. Approval reconciliation gate (v4 §3.6.5 — REPLACES v3 deferral) ─
  --
  -- 7.a — classify current approvals state.
  select
    count(*) filter (where status = 'pending'),
    count(*) filter (where status = 'delegated'),
    count(*) filter (where status = 'approved'),
    count(*) filter (where status = 'rejected')
  into v_pending_count, v_delegated_count, v_approved_count, v_rejected_count
  from public.approvals
  where tenant_id = p_tenant_id
    and target_entity_type = 'booking'
    and target_entity_id = p_booking_id;

  if v_rejected_count > 0 then
    v_approval_state := 'terminal_rejected';
  elsif (v_pending_count + v_delegated_count) > 0 then
    v_approval_state := 'pending';
  elsif v_approved_count > 0 then
    v_approval_state := 'terminal_approved';
  else
    v_approval_state := 'none';
  end if;

  -- 7.b — resolve the decision table to a single action + status target.
  -- Order matches §3.6.5: terminal_rejected first (any → cancelled_raise),
  -- then deny (any → deny_raise), then the (old, new, state) branches.
  if v_approval_state = 'terminal_rejected' then
    -- Row 5 + Row 9. An edit on an already-rejected booking is an edit on
    -- a cancelled booking; refuse upstream. (00310:162-172 turns rejection
    -- into bookings.status='cancelled'; if the booking row hasn't caught up
    -- — e.g. an in-flight grant raced past — refuse here defensively.)
    v_action        := 'cancelled_raise';
    v_status_target := null;
  elsif v_new_outcome = 'deny' then
    -- Row 10. Deny on edit (NEW code in v4).
    v_action        := 'deny_raise';
    v_status_target := null;
  elsif v_old_outcome = 'allow' and v_new_outcome = 'allow' then
    -- Row 1. allow → allow, none → no-op. (State must be 'none' because
    -- old_outcome=allow means no approval chain was ever inserted.)
    v_action        := 'noop';
    v_status_target := null;
  elsif v_old_outcome = 'allow' and v_new_outcome = 'require_approval' then
    -- Row 2. INSERT new chain; status → pending_approval; emit.
    v_action        := 'insert';
    v_status_target := 'pending_approval';
    v_emit_approval_required := true;
  elsif v_old_outcome = 'require_approval' and v_new_outcome = 'allow' then
    if v_approval_state = 'pending' then
      -- Row 3. Expire in-flight; status → confirmed.
      v_action        := 'expire';
      v_status_target := 'confirmed';
    elsif v_approval_state = 'terminal_approved' then
      -- Row 4. History stands; status stays confirmed.
      v_action        := 'noop';
      v_status_target := null;
    else
      -- Defensive: require_approval → allow with state='none' means no
      -- chain was ever inserted (race / inconsistency). No-op.
      v_action        := 'noop';
      v_status_target := null;
    end if;
  elsif v_old_outcome = 'require_approval' and v_new_outcome = 'require_approval' then
    if v_approval_state = 'pending' then
      if v_chain_config_changed then
        -- Row 7. Expire old + INSERT fresh; status stays pending_approval.
        v_action        := 'expire_and_insert';
        v_status_target := 'pending_approval';
        v_emit_approval_required := true;
      else
        -- Row 6. Same config; preserve in-flight grants.
        v_action        := 'noop';
        v_status_target := null;
      end if;
    elsif v_approval_state = 'terminal_approved' then
      if v_chain_config_changed then
        -- Row 8. DANGEROUS GAP — terminal_approved + diff config. Expire
        -- the historical chain (status flips to 'expired'; row stays in
        -- audit log) + INSERT fresh chain + status flips back to
        -- pending_approval so the new approvers gate the edit.
        v_action        := 'expire_and_insert';
        v_status_target := 'pending_approval';
        v_emit_approval_required := true;
      else
        -- Same config; in-flight history stands; status remains confirmed.
        v_action        := 'noop';
        v_status_target := null;
      end if;
    else
      -- state = 'none'. The booking had require_approval at create but
      -- the chain was never inserted (edge case). Treat as Row 2 — insert
      -- fresh.
      v_action        := 'insert';
      v_status_target := 'pending_approval';
      v_emit_approval_required := true;
    end if;
  else
    -- Defensive: any unhandled (old, new) tuple. No-op + log via exception
    -- shape so the caller sees this and B.4.A.5 can fold the gap.
    v_action        := 'noop';
    v_status_target := null;
  end if;

  -- 7.c — execute terminal raises BEFORE child validation. Row 5/9 +
  -- Row 10 must short-circuit; no point validating FKs on a refused edit.
  if v_action = 'cancelled_raise' then
    raise exception 'booking.cancelled_cannot_edit: booking=% has a rejected approval and can no longer be edited',
      p_booking_id
      using errcode = 'P0001';
  end if;
  if v_action = 'deny_raise' then
    raise exception 'edit_booking.deny_on_edit: rule resolver outcome=deny for booking=% — edit not allowed by current rules',
      p_booking_id
      using errcode = 'P0001',
            hint = 'A rule on the target room denies this edit. Pick a different room or revert the change.';
  end if;

  -- 7.d — validate the new chain config + collect approver_ids BEFORE the
  -- write block, so the tenant-validate failures (cross-tenant person /
  -- team) surface as 404s and don't leave a half-applied edit behind.
  if v_action in ('insert', 'expire_and_insert') then
    if v_new_chain_config is null
       or not (v_new_chain_config ? 'required_approvers')
       or jsonb_typeof(v_new_chain_config->'required_approvers') <> 'array' then
      raise exception 'edit_booking.invalid_plan_shape: p_plan.approval.new_chain_config.required_approvers must be a jsonb array when an insert is required'
        using errcode = 'P0001';
    end if;
    v_threshold := coalesce(v_new_chain_config->>'threshold', 'all');
    if v_threshold not in ('all', 'any') then
      raise exception 'edit_booking.invalid_plan_shape: p_plan.approval.new_chain_config.threshold must be all|any (got %)', v_threshold
        using errcode = 'P0001';
    end if;
    -- parallel_group convention mirrors booking-flow.service.ts:1273:
    -- threshold='all' → every approver must say yes (parallel-<bookingId>).
    -- threshold='any' → one approver suffices (parallel_group=NULL).
    if v_threshold = 'all' then
      v_parallel_group := 'parallel-' || p_booking_id::text;
    else
      v_parallel_group := null;
    end if;

    v_new_chain_id := gen_random_uuid();
    v_approver_ids := '{}'::uuid[];

    for v_approver in
      select * from jsonb_array_elements(v_new_chain_config->'required_approvers')
    loop
      if jsonb_typeof(v_approver) <> 'object'
         or not (v_approver ? 'type')
         or not (v_approver ? 'id')
         or jsonb_typeof(v_approver->'type') <> 'string'
         or jsonb_typeof(v_approver->'id')   <> 'string' then
        raise exception 'edit_booking.invalid_plan_shape: each approver in new_chain_config.required_approvers must be { type:string, id:uuid }'
          using errcode = 'P0001';
      end if;
      v_approver_type := v_approver->>'type';
      v_approver_id   := (v_approver->>'id')::uuid;

      if v_approver_type = 'person' then
        perform public.validate_entity_in_tenant(p_tenant_id, 'person', v_approver_id);
      elsif v_approver_type = 'team' then
        perform public.validate_entity_in_tenant(p_tenant_id, 'team', v_approver_id);
      else
        raise exception 'edit_booking.invalid_plan_shape: approver type must be person|team (got %)', v_approver_type
          using errcode = 'P0001';
      end if;

      v_approver_ids := array_append(v_approver_ids, v_approver_id);
    end loop;

    if array_length(v_approver_ids, 1) is null then
      -- Empty required_approvers — INSERT would write 0 rows + the booking
      -- would flip to pending_approval with no approver to gate it. Refuse.
      raise exception 'edit_booking.invalid_plan_shape: p_plan.approval.new_chain_config.required_approvers cannot be empty when insert is required'
        using errcode = 'P0001';
    end if;
  end if;

  -- ── 8. Tenant-validate every FK in the plan ──────────────────────────
  perform public.validate_entity_in_tenant(
    p_tenant_id, 'space', (v_booking_patch->>'location_id')::uuid
  );

  if (v_booking_patch ? 'cost_center_id')
     and jsonb_typeof(v_booking_patch->'cost_center_id') = 'string' then
    perform public.validate_entity_in_tenant(
      p_tenant_id, 'cost_center', (v_booking_patch->>'cost_center_id')::uuid
    );
  end if;

  if (v_booking_patch ? 'host_person_id')
     and jsonb_typeof(v_booking_patch->'host_person_id') = 'string' then
    perform public.validate_entity_in_tenant(
      p_tenant_id, 'person', (v_booking_patch->>'host_person_id')::uuid
    );
  end if;

  if (v_booking_patch ? 'applied_rule_ids')
     and jsonb_typeof(v_booking_patch->'applied_rule_ids') = 'array' then
    for v_rule_id in
      select (value)::uuid
        from jsonb_array_elements_text(v_booking_patch->'applied_rule_ids')
    loop
      perform public.validate_entity_in_tenant(p_tenant_id, 'booking_rule', v_rule_id);
    end loop;
  end if;

  for v_slot in select * from jsonb_array_elements(v_slot_patches) loop
    perform public.validate_entity_in_tenant(
      p_tenant_id, 'space', (v_slot->>'space_id')::uuid
    );
  end loop;

  for v_asset in select * from jsonb_array_elements(v_asset_patches) loop
    if v_asset ? 'asset_id' and jsonb_typeof(v_asset->'asset_id') = 'string' then
      perform public.validate_entity_in_tenant(
        p_tenant_id, 'asset', (v_asset->>'asset_id')::uuid
      );
    end if;
  end loop;

  -- v3 Critical 2: work_order booking-scope check.
  for v_wo in select * from jsonb_array_elements(v_wo_patches) loop
    perform public.validate_entity_in_tenant(
      p_tenant_id, 'work_order', (v_wo->>'id')::uuid
    );
    if not exists (
      select 1 from public.work_orders
       where id = (v_wo->>'id')::uuid
         and tenant_id = p_tenant_id
         and booking_id = p_booking_id
    ) then
      raise exception 'edit_booking.work_order_not_in_booking: work_order=% does not belong to booking=% in tenant=%',
        (v_wo->>'id')::uuid, p_booking_id, p_tenant_id
        using errcode = 'P0001',
              hint = 'The plan referenced a work_order from a different booking. Refetch the plan and retry.';
    end if;
  end loop;

  -- v3 Critical 2: order booking-scope check.
  for v_order in select * from jsonb_array_elements(v_order_patches) loop
    if not exists (
      select 1 from public.orders
       where id = (v_order->>'id')::uuid
         and tenant_id = p_tenant_id
    ) then
      raise exception 'edit_booking.not_found: order=% does not reference a known order in tenant %',
        (v_order->>'id')::uuid, p_tenant_id
        using errcode = 'P0001';
    end if;
    if not exists (
      select 1 from public.orders
       where id = (v_order->>'id')::uuid
         and tenant_id = p_tenant_id
         and booking_id = p_booking_id
    ) then
      raise exception 'edit_booking.order_not_in_booking: order=% does not belong to booking=% in tenant=%',
        (v_order->>'id')::uuid, p_booking_id, p_tenant_id
        using errcode = 'P0001',
              hint = 'The plan referenced an order from a different booking. Refetch the plan and retry.';
    end if;
  end loop;

  -- v3 Critical 2: asset_reservation booking-scope check.
  for v_asset in select * from jsonb_array_elements(v_asset_patches) loop
    if not exists (
      select 1 from public.asset_reservations
       where id = (v_asset->>'id')::uuid
         and tenant_id = p_tenant_id
         and booking_id = p_booking_id
    ) then
      raise exception 'edit_booking.asset_reservation_not_in_booking: asset_reservation=% does not belong to booking=% in tenant=%',
        (v_asset->>'id')::uuid, p_booking_id, p_tenant_id
        using errcode = 'P0001',
              hint = 'The plan referenced an asset reservation from a different booking. Refetch the plan and retry.';
    end if;
  end loop;

  -- ── 9. Derive new booking values from the patch ──────────────────────
  v_new_start_at       := (v_booking_patch->>'start_at')::timestamptz;
  v_new_end_at         := (v_booking_patch->>'end_at')::timestamptz;
  v_new_cost_snapshot  := nullif(v_booking_patch->>'cost_amount_snapshot', '')::numeric(10,2);

  v_new_policy_snapshot := case
                             when v_booking_patch ? 'policy_snapshot'
                             then coalesce(v_booking_patch->'policy_snapshot', '{}'::jsonb)
                             else v_booking.policy_snapshot
                           end;
  v_new_applied_rule_ids := case
                              when v_booking_patch ? 'applied_rule_ids'
                              then coalesce(
                                (select array_agg(value::uuid)
                                   from jsonb_array_elements_text(v_booking_patch->'applied_rule_ids')),
                                '{}'::uuid[])
                              else v_booking.applied_rule_ids
                            end;
  v_new_cost_center_id := case
                            when v_booking_patch ? 'cost_center_id'
                            then nullif(v_booking_patch->>'cost_center_id', '')::uuid
                            else v_booking.cost_center_id
                          end;
  v_new_calendar_etag  := case
                            when v_booking_patch ? 'calendar_etag'
                            then v_booking_patch->>'calendar_etag'
                            else v_booking.calendar_etag
                          end;
  v_new_host_person_id := case
                            when v_booking_patch ? 'host_person_id'
                            then nullif(v_booking_patch->>'host_person_id', '')::uuid
                            else v_booking.host_person_id
                          end;
  v_new_recurrence_over := case
                             when v_booking_patch ? 'recurrence_overridden'
                             then coalesce((v_booking_patch->>'recurrence_overridden')::boolean,
                                           v_booking.recurrence_overridden)
                             else v_booking.recurrence_overridden
                           end;
  v_new_config_release_id := case
                               when v_booking_patch ? 'config_release_id'
                               then nullif(v_booking_patch->>'config_release_id', '')::uuid
                               else v_booking.config_release_id
                             end;

  -- v4: compute the post-edit bookings.status from the decision table.
  -- v_status_target='pending_approval' → flip to pending_approval.
  -- v_status_target='confirmed'        → flip to confirmed (allow path).
  -- v_status_target=NULL               → preserve current status.
  if v_status_target is not null then
    v_new_booking_status := v_status_target;
  else
    v_new_booking_status := v_booking.status;
  end if;

  -- ── 10. Atomic write block ───────────────────────────────────────────

  -- 10.a — booking_slots (per slot_patch).
  for v_slot in select * from jsonb_array_elements(v_slot_patches) loop
    update public.booking_slots
       set space_id                = (v_slot->>'space_id')::uuid,
           start_at                = (v_slot->>'start_at')::timestamptz,
           end_at                  = (v_slot->>'end_at')::timestamptz,
           setup_buffer_minutes    = coalesce((v_slot->>'setup_buffer_minutes')::int,
                                              setup_buffer_minutes),
           teardown_buffer_minutes = coalesce((v_slot->>'teardown_buffer_minutes')::int,
                                              teardown_buffer_minutes),
           attendee_count          = case
                                       when v_slot ? 'attendee_count'
                                       then nullif(v_slot->>'attendee_count', '')::int
                                       else attendee_count
                                     end,
           attendee_person_ids     = case
                                       when v_slot ? 'attendee_person_ids'
                                            and jsonb_typeof(v_slot->'attendee_person_ids') = 'array'
                                       then coalesce(
                                         (select array_agg(value::uuid)
                                            from jsonb_array_elements_text(v_slot->'attendee_person_ids')),
                                         '{}'::uuid[])
                                       else attendee_person_ids
                                     end
     where id        = (v_slot->>'slot_id')::uuid
       and tenant_id = p_tenant_id
       and booking_id = p_booking_id;
    get diagnostics v_row_count = row_count;
    v_slots_updated := v_slots_updated + v_row_count;
  end loop;

  -- 10.b — bookings. v4 adds status transition from §3.6.5.
  update public.bookings
     set location_id           = v_new_location_id,
         start_at              = v_new_start_at,
         end_at                = v_new_end_at,
         cost_amount_snapshot  = v_new_cost_snapshot,
         policy_snapshot       = v_new_policy_snapshot,
         applied_rule_ids      = v_new_applied_rule_ids,
         cost_center_id        = v_new_cost_center_id,
         calendar_etag         = v_new_calendar_etag,
         host_person_id        = v_new_host_person_id,
         recurrence_overridden = v_new_recurrence_over,
         config_release_id     = v_new_config_release_id,
         status                = v_new_booking_status,
         updated_at            = v_started_at
   where id        = p_booking_id
     and tenant_id = p_tenant_id;

  -- 10.c — asset_reservations.
  for v_asset in select * from jsonb_array_elements(v_asset_patches) loop
    update public.asset_reservations
       set start_at = (v_asset->>'start_at')::timestamptz,
           end_at   = (v_asset->>'end_at')::timestamptz
     where id        = (v_asset->>'id')::uuid
       and tenant_id = p_tenant_id
       and booking_id = p_booking_id;
    get diagnostics v_row_count = row_count;
    v_assets_updated := v_assets_updated + v_row_count;
  end loop;

  -- 10.d — orders.
  for v_order in select * from jsonb_array_elements(v_order_patches) loop
    update public.orders
       set delivery_location_id   = case
                                      when v_order ? 'delivery_location_id'
                                      then nullif(v_order->>'delivery_location_id', '')::uuid
                                      else delivery_location_id
                                    end,
           requested_for_start_at = case
                                      when v_order ? 'requested_for_start_at'
                                      then nullif(v_order->>'requested_for_start_at', '')::timestamptz
                                      else requested_for_start_at
                                    end,
           requested_for_end_at   = case
                                      when v_order ? 'requested_for_end_at'
                                      then nullif(v_order->>'requested_for_end_at', '')::timestamptz
                                      else requested_for_end_at
                                    end
     where id        = (v_order->>'id')::uuid
       and tenant_id = p_tenant_id
       and booking_id = p_booking_id;
    get diagnostics v_row_count = row_count;
    v_orders_updated := v_orders_updated + v_row_count;
  end loop;

  -- 10.e — approvals reconciliation writes (v4 §3.6.5).
  if v_action in ('expire', 'expire_and_insert') then
    -- Expire rows mirror 00310:165-172. For Row 3/7 (v_action='expire'
    -- alone, or 'expire_and_insert' from a `pending` state) we expire
    -- pending+delegated only. For Row 8 ('expire_and_insert' from
    -- `terminal_approved`) we additionally expire `approved` rows so the
    -- new chain owns the decision — old `approved` rows stay in the audit
    -- log with status='expired' + comments naming the supersession.
    if v_approval_state = 'terminal_approved' then
      update public.approvals
         set status       = 'expired',
             responded_at = v_started_at,
             comments     = 'superseded_by_edit (booking edit at ' || v_started_at::text || ')'
       where tenant_id          = p_tenant_id
         and target_entity_type = 'booking'
         and target_entity_id   = p_booking_id
         and status             = 'approved';
    end if;
    update public.approvals
       set status       = 'expired',
           responded_at = v_started_at,
           comments     = 'superseded_by_edit (booking edit at ' || v_started_at::text || ')'
     where tenant_id          = p_tenant_id
       and target_entity_type = 'booking'
       and target_entity_id   = p_booking_id
       and status             in ('pending', 'delegated');
  end if;

  if v_action in ('insert', 'expire_and_insert') then
    -- INSERT mirrors booking-flow.service.ts:1275-1283. One INSERT per
    -- approver; chain_id + parallel_group set once outside the loop.
    for v_approver in
      select * from jsonb_array_elements(v_new_chain_config->'required_approvers')
    loop
      v_approver_type := v_approver->>'type';
      v_approver_id   := (v_approver->>'id')::uuid;
      insert into public.approvals
        (tenant_id, target_entity_type, target_entity_id,
         approval_chain_id, parallel_group,
         approver_person_id, approver_team_id, status,
         requested_at, created_at)
      values
        (p_tenant_id, 'booking', p_booking_id,
         v_new_chain_id, v_parallel_group,
         case when v_approver_type = 'person' then v_approver_id else null end,
         case when v_approver_type = 'team'   then v_approver_id else null end,
         'pending',
         v_started_at, v_started_at);
    end loop;
  end if;

  -- 10.f — work_orders sla patches.
  for v_wo in select * from jsonb_array_elements(v_wo_patches) loop
    update public.work_orders
       set planned_start_at      = (v_wo->>'planned_start_at')::timestamptz,
           sla_resolution_due_at = case
                                     when v_wo ? 'sla_due_at'
                                     then nullif(v_wo->>'sla_due_at', '')::timestamptz
                                     else sla_resolution_due_at
                                   end,
           updated_at            = v_started_at
     where id        = (v_wo->>'id')::uuid
       and tenant_id = p_tenant_id
       and booking_id = p_booking_id;
    get diagnostics v_row_count = row_count;
    v_wo_updated := v_wo_updated + v_row_count;
  end loop;

  -- ── 11. audit_events insert ──────────────────────────────────────────
  v_audit_before := jsonb_build_object(
    'location_id',           v_booking.location_id,
    'start_at',              v_booking.start_at,
    'end_at',                v_booking.end_at,
    'cost_amount_snapshot',  v_booking.cost_amount_snapshot,
    'cost_center_id',        v_booking.cost_center_id,
    'calendar_etag',         v_booking.calendar_etag,
    'applied_rule_ids',      to_jsonb(v_booking.applied_rule_ids),
    'policy_snapshot',       v_booking.policy_snapshot,
    'host_person_id',        v_booking.host_person_id,
    'recurrence_overridden', v_booking.recurrence_overridden,
    'config_release_id',     v_booking.config_release_id,
    'status',                v_booking.status
  );
  v_audit_after := jsonb_build_object(
    'location_id',           v_new_location_id,
    'start_at',              v_new_start_at,
    'end_at',                v_new_end_at,
    'cost_amount_snapshot',  v_new_cost_snapshot,
    'cost_center_id',        v_new_cost_center_id,
    'calendar_etag',         v_new_calendar_etag,
    'applied_rule_ids',      to_jsonb(v_new_applied_rule_ids),
    'policy_snapshot',       v_new_policy_snapshot,
    'host_person_id',        v_new_host_person_id,
    'recurrence_overridden', v_new_recurrence_over,
    'config_release_id',     v_new_config_release_id,
    'status',                v_new_booking_status
  );

  insert into public.audit_events
    (tenant_id, event_type, entity_type, entity_id, actor_user_id, details, created_at)
  values (
    p_tenant_id,
    'booking.edited',
    'booking',
    p_booking_id,
    v_actor_users_id,
    jsonb_build_object(
      'before',                v_audit_before,
      'after',                 v_audit_after,
      'slots_updated',         v_slots_updated,
      'assets_updated',        v_assets_updated,
      'orders_updated',        v_orders_updated,
      'wo_updated',            v_wo_updated,
      'approval_action',       v_action,
      'approval_old_outcome',  v_old_outcome,
      'approval_new_outcome',  v_new_outcome,
      'approval_prior_state',  v_approval_state,
      'approval_chain_id',     v_new_chain_id,
      'idempotency_key',       p_idempotency_key
    ),
    v_started_at
  );

  -- ── 12. domain_events insert ─────────────────────────────────────────
  insert into public.domain_events
    (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id, created_at)
  values (
    p_tenant_id,
    'booking.edited',
    'booking',
    p_booking_id,
    jsonb_build_object(
      'booking_id',     p_booking_id,
      'started_at',     v_started_at,
      'idempotency_key', p_idempotency_key
    ),
    v_actor_users_id,
    v_started_at
  );

  -- ── 13. Outbox emits ─────────────────────────────────────────────────
  if v_booking.location_id is distinct from v_new_location_id then
    perform outbox.emit(
      p_tenant_id       => p_tenant_id,
      p_event_type      => 'booking.location_changed',
      p_aggregate_type  => 'booking',
      p_aggregate_id    => p_booking_id,
      p_payload         => jsonb_build_object(
        'tenant_id',         p_tenant_id,
        'booking_id',        p_booking_id,
        'previous_location', v_booking.location_id,
        'new_location',      v_new_location_id,
        'started_at',        v_started_at
      ),
      p_idempotency_key => 'booking.location_changed:' || p_booking_id::text || ':' || p_idempotency_key,
      p_event_version   => 1,
      p_available_at    => null
    );
    v_emitted := v_emitted || to_jsonb('booking.location_changed'::text);
  end if;

  if v_booking.cost_amount_snapshot is distinct from v_new_cost_snapshot then
    perform outbox.emit(
      p_tenant_id       => p_tenant_id,
      p_event_type      => 'booking.cost_changed',
      p_aggregate_type  => 'booking',
      p_aggregate_id    => p_booking_id,
      p_payload         => jsonb_build_object(
        'tenant_id',     p_tenant_id,
        'booking_id',    p_booking_id,
        'previous_cost', v_booking.cost_amount_snapshot,
        'new_cost',      v_new_cost_snapshot,
        'started_at',    v_started_at
      ),
      p_idempotency_key => 'booking.cost_changed:' || p_booking_id::text || ':' || p_idempotency_key,
      p_event_version   => 1,
      p_available_at    => null
    );
    v_emitted := v_emitted || to_jsonb('booking.cost_changed'::text);
  end if;

  -- v4: booking.approval_required emit for rows 2, 7, 8. Payload carries
  -- chain_id + approver_ids[] so a future handler can fan out notifications
  -- without re-reading approvals.
  if v_emit_approval_required then
    perform outbox.emit(
      p_tenant_id       => p_tenant_id,
      p_event_type      => 'booking.approval_required',
      p_aggregate_type  => 'booking',
      p_aggregate_id    => p_booking_id,
      p_payload         => jsonb_build_object(
        'tenant_id',     p_tenant_id,
        'booking_id',    p_booking_id,
        'chain_id',      v_new_chain_id,
        'approver_ids',  to_jsonb(v_approver_ids),
        'started_at',    v_started_at
      ),
      p_idempotency_key => 'booking.approval_required:' || p_booking_id::text || ':' || p_idempotency_key,
      p_event_version   => 1,
      p_available_at    => null
    );
    v_emitted := v_emitted || to_jsonb('booking.approval_required'::text);
  end if;

  -- sla.timer_repointed_required per WO patch that signalled needs_repoint.
  for v_wo in select * from jsonb_array_elements(v_wo_patches) loop
    if coalesce((v_wo->>'needs_repoint')::boolean, false) then
      perform outbox.emit(
        p_tenant_id       => p_tenant_id,
        p_event_type      => 'sla.timer_repointed_required',
        p_aggregate_type  => 'work_order',
        p_aggregate_id    => (v_wo->>'id')::uuid,
        p_payload         => jsonb_build_object(
          'tenant_id',     p_tenant_id,
          'work_order_id', (v_wo->>'id')::uuid,
          'sla_policy_id', nullif(v_wo->>'sla_policy_id', '')::uuid,
          'started_at',    v_started_at,
          'source',        'edit_booking'
        ),
        p_idempotency_key => 'sla.timer_repointed_required:' || (v_wo->>'id')::text || ':' || p_idempotency_key,
        p_event_version   => 1,
        p_available_at    => null
      );
      v_emitted := v_emitted || to_jsonb('sla.timer_repointed_required'::text);
    end if;
  end loop;

  -- ── 14. Assemble result + mark command_operations success ────────────
  v_result := jsonb_build_object(
    'booking',     jsonb_build_object(
      'id',                    p_booking_id,
      'tenant_id',             p_tenant_id,
      'location_id',           v_new_location_id,
      'start_at',              v_new_start_at,
      'end_at',                v_new_end_at,
      'cost_amount_snapshot',  v_new_cost_snapshot,
      'cost_center_id',        v_new_cost_center_id,
      'calendar_etag',         v_new_calendar_etag,
      'applied_rule_ids',      to_jsonb(v_new_applied_rule_ids),
      'policy_snapshot',       v_new_policy_snapshot,
      'host_person_id',        v_new_host_person_id,
      'recurrence_overridden', v_new_recurrence_over,
      'config_release_id',     v_new_config_release_id,
      'status',                v_new_booking_status,
      'updated_at',            v_started_at
    ),
    'follow_ups',  v_emitted,
    'slots_updated',  v_slots_updated,
    'assets_updated', v_assets_updated,
    'orders_updated', v_orders_updated,
    'wo_updated',     v_wo_updated
  );

  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = v_started_at
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

revoke all on function public.edit_booking(uuid, jsonb, uuid, uuid, text) from public;
-- service_role only (canonical lockdown — 00309:361, 00310:260, 00358:389).
grant  execute on function public.edit_booking(uuid, jsonb, uuid, uuid, text) to service_role;

comment on function public.edit_booking(uuid, jsonb, uuid, uuid, text) is
  'B.4.A.4 — edit_booking RPC v4 (supersedes 00363). v4 replaces v3''s deferred raise (`edit_booking.approval_reconciliation_required`) with the §3.6.5 10-row decision table: expires in-flight approvals (Row 3), preserves stable chains (Row 6), inserts fresh chains on outcome flip (Row 2/7/8) — including the DANGEROUS GAP (Row 8: terminal_approved + chain_config_changed → expire + insert + flip back to pending_approval), refuses edits on rejected bookings (Row 5/9 → booking.cancelled_cannot_edit), and refuses deny-on-edit (Row 10 → NEW edit_booking.deny_on_edit). EditPlan contract extended: `approval_outcome_changed` boolean replaced by `approval: { old_outcome, new_outcome, chain_config_changed, new_chain_config }`. Approval INSERTs mirror booking-flow.service.ts:1275-1283 (single chain_id, parallel_group from threshold=all|any, no step_number). Booking.approval_required outbox emit on Row 2/7/8 with chain_id + approver_ids — handler lands in B.4.A.5. All v3 critical fixes (1+2) preserved verbatim. Spec: docs/follow-ups/b4-booking-edit-pipeline.md §3.6.5.';

notify pgrst, 'reload schema';
