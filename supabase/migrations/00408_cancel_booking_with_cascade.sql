-- Booking-audit remediation Slice 2 — atomic user-cancel cascade RPC.
--
-- Closes audit `docs/follow-ups/audits/03-booking-reservation.md`:
--   - P0-1 `cancelOne` is not atomic and loses outbox lineage (:67).
--   - P1-5 `booking.cancelled` outbox event has only one producer (:187).
--
-- Replaces the non-atomic TS choreography (reservation.service.ts:438-524
-- cancelOne + recurrence.service.ts:881-977 cancelForward + the swallowed
-- bundle-cascade.service.ts:230-411 cancelBundleImpl) with ONE PL/pgSQL
-- transaction. Every observable side effect was enumerated and assigned a
-- destination in `docs/follow-ups/cancel-booking-equivalence-checklist.md`
-- (converged through 3 codex plan-gate rounds). This migration implements
-- the TX-column rows; the OBX-column rows live in the new durable handler
-- `apps/api/src/modules/outbox/handlers/booking-cancelled-cascade.handler.ts`.
--
-- ── Citation discipline ──────────────────────────────────────────────────
-- Every pattern reproduced below was Read in this session:
--   - 00407_booking_edit_idempotency_intent_hash.sql:87-333 — the LIVE
--     edit_booking body: command_operations idempotency gate (payload-hash
--     compute → found/cache-hit/payload-mismatch/in_progress branches),
--     F-CRIT-1 actor resolution (`where u.auth_uid = p_actor_user_id and
--     u.tenant_id = p_tenant_id`; raise `*.actor_not_found` if null),
--     advisory-lock pattern, tenant validation, revoke/grant trailer,
--     security/search_path trailer. The cancel payload has NO
--     nondeterministic field, so the hash is a plain md5 over the
--     deterministic arg tuple (NOT the strip helper).
--   - 00373_delete_booking_emit_cancelled.sql:195-209 — the EXACT
--     outbox.emit(...) argument signature + `booking.cancelled` payload
--     shape {tenant_id,booking_id,reason,started_at}. Reused verbatim;
--     key = 'booking.cancelled:'||booking_id::text||':user_cancel'
--     (deterministic, per cancelled booking, distinct from the
--     ':guard_rollback' key 00373 uses).
--   - 00299_outbox_foundation.sql:132-196 — outbox.emit signature.
--   - 00270_visitor_status_insert_validation_and_service_marker.sql:83-89 —
--     the visitors single-write-path trigger. This RPC MUST NOT write the
--     `visitors` table (the trigger rejects any write without the session
--     marker set by VisitorService.transitionStatus). Visitor cascade is
--     OBX-only.
--   - bundle-cascade.service.ts:230-411 — partition (FULFILLED_STATUSES =
--     {confirmed,preparing,delivered} :680), asset_reservations cancel
--     (:284-289), work_orders non-terminal close (:298-309, whitelist
--     {new,assigned,in_progress,waiting,pending_approval}), OLI cancel +
--     pending_setup_trigger_args=null (:311-323), cancelPendingApprovals
--     ForBundle (:592-609). orders→cancelled when all lines cancelled is
--     a documented enhancement (checklist row 3.4 note); the legacy TS
--     path never flipped `orders.status` — this RPC does, gated on "all
--     lines for that order are now cancelled".
--   - recurrence.service.ts:881-977 — cancelForward scope predicate
--     (status in confirmed/checked_in/pending_approval; start_at >= pivot
--     for this_and_following; series_end_at := pivot.start_at cap).
--   - 00277_create_canonical_booking_schema.sql:27-160 — bookings /
--     booking_slots schema + status enums.
--   - 00013_orders_catalog.sql:44-99 — orders/order_line_items schema.
--     00144_orders_bundle_columns.sql:4-25 — requested_for_* +
--     linked_asset_reservation_id + linked_ticket_id; 00197:19 —
--     order_line_items.pending_setup_trigger_args.
--   - 00142_asset_reservations.sql:7-30 — asset_reservations schema.
--     00278_retarget_sibling_tables.sql:41-144 — booking_bundle_id →
--     booking_id renames on orders/asset_reservations/work_orders.
--   - 00213_step1c1_work_orders_new_table.sql:52-53,105,125 —
--     status_category enum + linked_order_line_item_id + closed_at.
--   - 00012_approvals.sql:3-20 — approvals schema.
--   - 00019_events_audit.sql:4-46 — domain_events + audit_events schema.
--   - 00316_command_operations_table.sql:32-42 — command_operations.
--   - 00124_recurrence_series.sql:5-17 — recurrence_series.
--
-- ── Net behavioral changes (documented, intentional) ─────────────────────
--   - Cancel becomes command_operations-idempotent (the wrapper adds
--     RequireClientRequestIdGuard + a deterministic key). Replays return
--     cached success without re-cascading or re-emitting.
--   - Already-cancelled short-circuit: SELECT booking FOR UPDATE; if
--     status='cancelled' finalize command_operations success with a
--     success-shaped cached_result and RETURN — no cascade, no emit (CAS).
--   - `booking.cancelled` is now emitted on EVERY user-cancel (single +
--     series, one per cancelled booking) — closes P1-5.
--   - The in-process BundleEventBus emission is removed for the user-cancel
--     path (REPLACED): the durable booking.cancel_cascade_required event +
--     handler supersede it. The per-line cancelLine/cancelBundle path keeps
--     the in-process bus (P1-4, a later slice). The RPC emits NEITHER the
--     in-process bus event (it can't — PL/pgSQL) NOR writes `visitors`.
--   - F-CRIT-1: p_actor_user_id is auth_uid (Slice-1 D-1 lesson); the
--     wrapper passes actor.auth_uid.
--
-- ── Two outbox events, by design ─────────────────────────────────────────
-- Per cancelled booking the RPC emits TWO distinct outbox events:
--   1. `booking.cancelled` (00373 signature) — consumed by the EXISTING
--      sole registrant WorkflowSpawnWakeOnBookingCancelledHandler. Closes
--      P1-5 (workflow Tier 2 wake on user-cancel).
--   2. `booking.cancel_cascade_required` (NEW event type) — consumed by
--      the NEW BookingCancelledCascadeHandler (visitor cascade + requester
--      notification).
-- Rationale: the OutboxHandlerRegistry (outbox-handler.registry.ts:62-78)
-- THROWS at Nest boot on a duplicate (event_type, version). A second
-- @OutboxHandler('booking.cancelled', {version:1}) would crash the app.
-- The contract's "multiple handlers per event_type is supported" assumption
-- is false for this dispatch model; a distinct event type is the correct,
-- scope-clean resolution (the equivalence checklist OBX destination only
-- requires the cascade be DURABLE, not that it ride the booking.cancelled
-- event name).

-- ── cancel_booking_with_cascade ──────────────────────────────────────────

drop function if exists public.cancel_booking_with_cascade(uuid, uuid, uuid, text, text, int, text);

create or replace function public.cancel_booking_with_cascade(
  p_booking_id      uuid,
  p_tenant_id       uuid,
  p_actor_user_id   uuid,
  p_scope           text,
  p_reason          text,
  p_grace_minutes   int,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, outbox
as $$
declare
  v_started_at       constant timestamptz := now();

  v_existing         public.command_operations;
  v_payload_hash     text;
  v_lock_key         bigint;

  v_actor_users_id   uuid;

  v_pivot            record;
  v_scope            text;
  v_grace            int;
  v_reason           text;
  v_grace_until      timestamptz;

  v_booking_ids      uuid[] := '{}'::uuid[];
  v_bid              uuid;

  -- Per-booking cascade accumulators (totals across the scope set).
  v_slots_transitioned          int := 0;
  v_orders_cancelled            int := 0;
  v_asset_reservations_cancelled int := 0;
  v_work_orders_closed          int := 0;
  v_approvals_expired           int := 0;
  v_emitted                     int := 0;

  v_row_count        int;
  -- I-3: order ids whose lines THIS RPC iteration just cancelled in 7.c.
  -- 7.d only flips an order to 'cancelled' if it appears here — so an
  -- order whose sole remaining line was cancelled by a PRIOR unrelated
  -- op (and which this booking-scoped cancel did NOT touch) is never
  -- collaterally flipped.
  v_oli_cancelled_order_ids uuid[];
  v_already_cancelled boolean := false;

  v_result           jsonb;
begin
  -- ── 0. Argument shape checks ─────────────────────────────────────────
  -- Mirrors 00407:184-209 (edit_booking arg-shape preflight).
  if p_tenant_id is null then
    raise exception 'cancel_booking_with_cascade: p_tenant_id required';
  end if;
  if p_booking_id is null then
    raise exception 'cancel_booking_with_cascade: p_booking_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'cancel_booking_with_cascade: p_idempotency_key required';
  end if;

  v_scope := coalesce(p_scope, 'this');
  if v_scope not in ('this', 'this_and_following', 'series') then
    raise exception 'cancel_booking_with_cascade.invalid_scope: p_scope must be this|this_and_following|series (got %)', v_scope
      using errcode = 'P0001';
  end if;

  v_reason := coalesce(p_reason, 'user_cancel');
  -- grace formula: replicate cancelOne (reservation.service.ts:476-477) —
  -- coalesce(grace, 5) minutes. p_grace_minutes is the wire value (NULL =
  -- default 5).
  v_grace       := coalesce(p_grace_minutes, 5);
  v_grace_until := v_started_at + make_interval(mins => v_grace);

  -- ── 1. F-CRIT-1: auth_uid → users.id ONCE (00407:289-303). ───────────
  if p_actor_user_id is not null then
    select u.id
      into v_actor_users_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;

    if v_actor_users_id is null then
      raise exception 'cancel_booking_with_cascade.actor_not_found: auth_uid=% not registered as a user in tenant=%',
        p_actor_user_id, p_tenant_id
        using errcode = 'P0001';
    end if;
  end if;

  -- ── 2. Advisory lock keyed on (tenant, booking, cancel) ──────────────
  -- The brief mandates this exact key shape (deadlock-safe vs. the
  -- per-idempotency-key lock the edit RPC uses; cancel serializes on the
  -- booking, not the request, so a concurrent retry of a DIFFERENT key for
  -- the same booking still serializes correctly).
  v_lock_key := hashtextextended(
    p_tenant_id::text || ':booking:cancel:' || p_booking_id::text, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 3. command_operations idempotency gate (00407:309-333) ───────────
  -- The cancel payload tuple is fully deterministic (no server-stamped
  -- field), so a plain md5 over the canonical arg string is the hash —
  -- the booking-edit strip helper is NOT needed (and would be wrong: it
  -- targets EditPlan jsonb, not this tuple).
  v_payload_hash := md5(
    coalesce(p_booking_id::text, '') || '|' ||
    coalesce(p_tenant_id::text, '')  || '|' ||
    coalesce(p_actor_user_id::text, '') || '|' ||
    v_scope || '|' ||
    v_reason || '|' ||
    coalesce(p_grace_minutes::text, '') );

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

  -- ── 4. Lock the pivot booking + tenant validation ────────────────────
  select id, tenant_id, status, start_at, recurrence_series_id
    into v_pivot
    from public.bookings
   where id = p_booking_id
     and tenant_id = p_tenant_id
   for update;

  if not found then
    raise exception 'cancel_booking_with_cascade.not_found: booking=% tenant=%', p_booking_id, p_tenant_id
      using errcode = 'P0001';
  end if;

  -- ── 5. Already-cancelled short-circuit (CAS) ─────────────────────────
  -- Matches today's cancelOne early-return (reservation.service.ts:448
  -- `if (r.status === 'cancelled') return r;`). No cascade, no emit.
  -- Finalize command_operations with a success-shaped cached_result so a
  -- later same-key replay also short-circuits at step 3.
  if v_pivot.status = 'cancelled' then
    v_already_cancelled := true;
    v_result := jsonb_build_object(
      'kind',                          'cancelled',
      'scope',                         v_scope,
      'booking_ids',                   to_jsonb(array[p_booking_id]),
      'slots_transitioned',            0,
      'orders_cancelled',              0,
      'asset_reservations_cancelled',  0,
      'work_orders_closed',            0,
      'approvals_expired',             0,
      'emitted',                       0,
      'pivot',                         p_booking_id,
      'already_cancelled',             true
    );
    update public.command_operations
       set outcome = 'success', cached_result = v_result, completed_at = v_started_at
     where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    return v_result;
  end if;

  -- ── 6. Resolve the booking set by scope ──────────────────────────────
  -- 'this' → [p_booking_id]. Recurrence scopes → forward/series set,
  -- LOCKED FOR UPDATE ordered by id (deadlock-safe — same ordering as
  -- edit_booking_scope 00399 + recurrence.service.ts:919).
  if v_scope = 'this' then
    v_booking_ids := array[p_booking_id];
  else
    if v_pivot.recurrence_series_id is null then
      raise exception 'cancel_booking_with_cascade.not_recurring: booking=% is not part of a recurring series', p_booking_id
        using errcode = 'P0001';
    end if;
    -- Postgres forbids FOR UPDATE in the same query as an aggregate
    -- (array_agg) — "FOR UPDATE is not allowed with aggregate functions".
    -- Canonical lock-then-aggregate: (1) acquire the row locks in a
    -- deterministic id order via a locking SELECT in a CTE, (2) aggregate
    -- the locked ids in a separate (non-locking) outer query. The CTE's
    -- ORDER BY id makes the lock-acquisition order deadlock-safe (same
    -- ordering rationale as edit_booking_scope 00399 +
    -- recurrence.service.ts:919). The pivot row was already FOR UPDATE'd
    -- at step 4.
    -- C-2 (audit 03 P0-1 orphan-occurrence class): the sibling-set
    -- predicate must be ALL NON-TERMINAL, NOT the legacy
    -- (confirmed,checked_in,pending_approval) whitelist
    -- (a7570f14:recurrence.service.ts:911-912). With the whitelist, a
    -- forward occurrence in 'draft' (a live state — 00277:49-51 bookings
    -- enum) was SKIPPED — no cascade, no booking.cancelled emit, no
    -- audit — yet step 8 still caps recurrence_series.series_end_at at
    -- the pivot, so the rollover job (recurrence.service.ts) will never
    -- re-materialise it: a permanently live orphan occurrence on a
    -- "cancelled series". FIX: broaden to every booking NOT already
    -- terminal — terminal = ('cancelled','completed','released'),
    -- consistent with the C-1 slot fix (same enum, same terminal set).
    -- Every live forward occurrence is now actually cancelled +
    -- cascaded (7.a-7.k) + emitted. Lock-then-aggregate is preserved:
    -- the locking SELECT's `order by b.id` keeps lock acquisition
    -- deadlock-safe; the non-locking aggregate uses the SAME predicate
    -- so the locked set == the aggregated set.
    perform b.id
       from public.bookings b
      where b.tenant_id = p_tenant_id
        and b.recurrence_series_id = v_pivot.recurrence_series_id
        and b.status not in ('cancelled', 'completed', 'released')
        and (v_scope <> 'this_and_following' or b.start_at >= v_pivot.start_at)
      order by b.id
      for update;
    select coalesce(array_agg(b.id order by b.id), '{}'::uuid[])
      into v_booking_ids
      from public.bookings b
     where b.tenant_id = p_tenant_id
       and b.recurrence_series_id = v_pivot.recurrence_series_id
       and b.status not in ('cancelled', 'completed', 'released')
       and (v_scope <> 'this_and_following' or b.start_at >= v_pivot.start_at);

    -- The pivot may be excluded by the broadened predicate only if it is
    -- 'completed' or 'released' (the 'cancelled' case already
    -- short-circuited at step 5). The user explicitly asked to cancel
    -- THIS booking, so force the pivot into the set regardless — its
    -- cascade is then a near-no-op for terminal linked rows (the 7.x
    -- whitelists skip already-terminal rows) but the booking goes
    -- 'cancelled' per explicit user intent (7.f unconditional, mirroring
    -- legacy cancelOne). Idempotent — array_append only if absent.
    if not (p_booking_id = any (v_booking_ids)) then
      v_booking_ids := array_append(v_booking_ids, p_booking_id);
    end if;
  end if;

  -- ── 7. Per-booking cascade — checklist rows 3.1-3.7 + 1.1/1.2/1.4 + 2.x
  foreach v_bid in array v_booking_ids loop
    -- 7.a — asset_reservations linked to this booking, cancellable only.
    --       (bundle-cascade.service.ts:284-289 — status→'cancelled';
    --        00142:14-15 status literals confirmed/cancelled/released —
    --        only 'confirmed' is cancellable.)
    with cancelled_ar as (
      update public.asset_reservations
         set status = 'cancelled'
       where tenant_id = p_tenant_id
         and booking_id = v_bid
         and status = 'confirmed'
      returning 1
    )
    select count(*) into v_row_count from cancelled_ar;
    v_asset_reservations_cancelled := v_asset_reservations_cancelled + v_row_count;

    -- 7.b — work_orders linked to cancellable OLIs of this booking, via
    --       order_line_items.linked_order_line_item_id (00145:8) →
    --       work_orders.linked_order_line_item_id (00213:105). Non-terminal
    --       whitelist preserved verbatim (bundle-cascade.service.ts:298);
    --       do NOT re-stamp terminal rows (closed_at only when we close).
    with cancellable_oli as (
      select oli.id
        from public.order_line_items oli
        join public.orders o on o.id = oli.order_id
       where o.tenant_id = p_tenant_id
         and o.booking_id = v_bid
         and oli.tenant_id = p_tenant_id
         and not (oli.fulfillment_status = any (array['confirmed','preparing','delivered']))
    ),
    closed_wo as (
      update public.work_orders w
         set status_category = 'closed', closed_at = v_started_at
       where w.tenant_id = p_tenant_id
         and w.linked_order_line_item_id in (select id from cancellable_oli)
         and w.status_category = any (array['new','assigned','in_progress','waiting','pending_approval'])
      returning 1
    )
    select count(*) into v_row_count from closed_wo;
    v_work_orders_closed := v_work_orders_closed + v_row_count;

    -- 7.c — order_line_items cancellable → fulfillment_status='cancelled',
    --        pending_setup_trigger_args=null (bundle-cascade.service.ts:
    --        311-323 + 00197:19). Fulfilled lines (confirmed/preparing/
    --        delivered) are PROTECTED (not touched) — checklist row 3.4.
    --        I-3: capture the DISTINCT order_ids whose lines THIS
    --        iteration just cancelled so 7.d can scope its order flip to
    --        orders this op actually touched.
    with cancelled_oli as (
      update public.order_line_items oli
         set fulfillment_status = 'cancelled', pending_setup_trigger_args = null
        from public.orders o
       where oli.order_id = o.id
         and o.tenant_id = p_tenant_id
         and o.booking_id = v_bid
         and oli.tenant_id = p_tenant_id
         and not (oli.fulfillment_status = any (array['confirmed','preparing','delivered']))
      returning oli.order_id
    )
    select coalesce(array_agg(distinct order_id), '{}'::uuid[])
      into v_oli_cancelled_order_ids
      from cancelled_oli;

    -- 7.d — orders → 'cancelled' ONLY when an order BOTH (a) had ≥1 line
    --        cancelled BY THIS operation in 7.c (o.id ∈
    --        v_oli_cancelled_order_ids — I-3: prevents collaterally
    --        flipping an order whose sole remaining line was cancelled by
    --        a prior unrelated op and which this booking-scoped cancel
    --        never touched) AND (b) now has NO non-cancelled line left.
    --        Documented enhancement (checklist row 3.4 note — legacy TS
    --        never flipped orders.status). 00013:55 status literals; only
    --        orders not already terminal. C2 / tenant-on-write rule: the
    --        UPDATE itself carries `o.tenant_id = p_tenant_id` (every
    --        sibling cascade UPDATE in 7.x does — defense-in-depth even
    --        though the id set is already tenant-derived).
    with fully_cancelled_orders as (
      select o.id
        from public.orders o
       where o.tenant_id = p_tenant_id
         and o.booking_id = v_bid
         and o.id = any (v_oli_cancelled_order_ids)
         and o.status not in ('cancelled', 'fulfilled')
         and exists (select 1 from public.order_line_items l
                      where l.order_id = o.id and l.tenant_id = p_tenant_id)
         and not exists (
           select 1 from public.order_line_items l
            where l.order_id = o.id
              and l.tenant_id = p_tenant_id
              and l.fulfillment_status <> 'cancelled'
         )
    ),
    cancelled_orders as (
      update public.orders o
         set status = 'cancelled'
       where o.id in (select id from fully_cancelled_orders)
         and o.tenant_id = p_tenant_id
      returning 1
    )
    select count(*) into v_row_count from cancelled_orders;
    v_orders_cancelled := v_orders_cancelled + v_row_count;

    -- 7.e — booking_slots of THIS booking, ALL NON-TERMINAL → 'cancelled'
    --        + cancellation_grace_until (checklist rows 1.1 / 2.2).
    --        C-1 (audit 03 P0-1:76 class): legacy cancelOne cancelled
    --        EVERY slot of the booking with NO status filter
    --        (a7570f14:reservation.service.ts:484-487 —
    --        `.eq('tenant_id',t).eq('booking_id',id)` only) while the
    --        bookings row goes 'cancelled' unconditionally (7.f). The
    --        pre-fix `status in (confirmed,checked_in,pending_approval)`
    --        whitelist baked a permanent booking/slot status divergence
    --        for any slot in 'draft' (a real live state — 00277:142-144
    --        enum: draft|pending_approval|confirmed|checked_in|released|
    --        cancelled|completed). FIX: cancel every slot NOT already
    --        terminal. Terminal slot statuses = ('cancelled','completed',
    --        'released'): 'cancelled' is the no-op target; 'completed' is
    --        a finished slot (the wrapper rejects a completed PIVOT at
    --        reservation.service.ts:475 — a completed sibling/slot must
    --        not be re-stamped); 'released' is the no-show/auto-release
    --        end-state (check-in.service.ts:172,191 — same terminal class
    --        the codebase uses for asset_reservations at
    --        assemble-edit-plan.service.ts:1044/1051). Everything else
    --        (draft|pending_approval|confirmed|checked_in) is live →
    --        cancelled, restoring legacy breadth.
    with cancelled_slots as (
      update public.booking_slots
         set status = 'cancelled', cancellation_grace_until = v_grace_until
       where tenant_id = p_tenant_id
         and booking_id = v_bid
         and status not in ('cancelled', 'completed', 'released')
      returning 1
    )
    select count(*) into v_row_count from cancelled_slots;
    v_slots_transitioned := v_slots_transitioned + v_row_count;

    -- 7.f — bookings → 'cancelled' UNCONDITIONALLY (checklist rows 1.2 /
    --        2.1 + the row 3.5 note: user cancelled the booking → it goes
    --        cancelled per explicit intent; fulfilled-line protection is
    --        at the OLI level only, 7.c above). Mirrors today's cancelOne
    --        (reservation.service.ts:495-499) which is unconditional.
    update public.bookings
       set status = 'cancelled'
     where tenant_id = p_tenant_id
       and id = v_bid;

    -- 7.g — all pending approvals for this booking → 'expired'
    --        (bundle-cascade.service.ts:592-609
    --        cancelPendingApprovalsForBundle semantics; checklist row 3.6.
    --        Whole-booking user-cancel = cancel ALL pending, NOT the
    --        per-line rescope which is P1-4).
    with expired_appr as (
      update public.approvals
         set status = 'expired',
             responded_at = v_started_at,
             comments = 'Booking cancelled; voiding approval'
       where tenant_id = p_tenant_id
         and target_entity_type = 'booking'
         and target_entity_id = v_bid
         and status = 'pending'
      returning 1
    )
    select count(*) into v_row_count from expired_appr;
    v_approvals_expired := v_approvals_expired + v_row_count;

    -- 7.h — audit_events booking.cancelled (checklist rows 1.4 / 3.7).
    --        Now in-tx, no longer swallowed. Mirrors the TS shape at
    --        reservation.service.ts:504-510 + the bundle.cancelled
    --        continuity row (bundle-cascade.service.ts:370-380).
    insert into public.audit_events
      (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
    values
      (p_tenant_id, 'booking.cancelled', 'booking', v_bid, v_actor_users_id,
       jsonb_build_object(
         'booking_id', v_bid,
         'scope',      v_scope,
         'reason',     v_reason,
         'started_at', v_started_at)),
      (p_tenant_id, 'bundle.cancelled', 'booking', v_bid, v_actor_users_id,
       jsonb_build_object(
         'bundle_id',  v_bid,
         'reason',     v_reason,
         'started_at', v_started_at,
         'continuity', true));

    -- 7.i — domain_events row (parity with the visitor cascade's
    --        domain_events intent log; bundle-cascade.adapter.ts:434-439).
    insert into public.domain_events
      (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id)
    values
      (p_tenant_id, 'booking.cancelled', 'booking', v_bid,
       jsonb_build_object(
         'booking_id', v_bid,
         'scope',      v_scope,
         'reason',     v_reason,
         'started_at', v_started_at),
       v_actor_users_id);

    -- 7.j — outbox.emit booking.cancelled PER cancelled booking
    --        (00373:195-209 signature verbatim; closes P1-5). Key is
    --        deterministic + per-booking + ':user_cancel' so it never
    --        collides with delete_booking_with_guard's ':guard_rollback'.
    perform outbox.emit(
      p_tenant_id       => p_tenant_id,
      p_event_type      => 'booking.cancelled',
      p_aggregate_type  => 'booking',
      p_aggregate_id    => v_bid,
      p_payload         => jsonb_build_object(
        'tenant_id',  p_tenant_id,
        'booking_id', v_bid,
        'reason',     v_reason,
        'started_at', v_started_at
      ),
      p_idempotency_key => 'booking.cancelled:' || v_bid::text || ':user_cancel',
      p_event_version   => 1,
      p_available_at    => null
    );
    v_emitted := v_emitted + 1;

    -- 7.k — outbox.emit booking.cancel_cascade_required PER cancelled
    --        booking — the DURABLE replacement for the in-process
    --        BundleEventBus bundle.cancelled (checklist rows 3.8 /
    --        4.x / 5.x). Consumed by BookingCancelledCascadeHandler
    --        (visitor cascade + requester reservation_cancelled notif).
    --        Distinct event type so it coexists with the workflow wake
    --        handler (registry one-handler-per-(type,version) rule).
    perform outbox.emit(
      p_tenant_id       => p_tenant_id,
      p_event_type      => 'booking.cancel_cascade_required',
      p_aggregate_type  => 'booking',
      p_aggregate_id    => v_bid,
      p_payload         => jsonb_build_object(
        'tenant_id',  p_tenant_id,
        'booking_id', v_bid,
        'reason',     v_reason,
        'started_at', v_started_at
      ),
      p_idempotency_key => 'booking.cancel_cascade_required:' || v_bid::text || ':user_cancel',
      p_event_version   => 1,
      p_available_at    => null
    );
    v_emitted := v_emitted + 1;
  end loop;

  -- ── 8. Series cap (checklist row 2.4) ────────────────────────────────
  -- For this_and_following / series: cap the series so the rollover job
  -- won't re-materialise the dropped occurrences
  -- (recurrence.service.ts:954-958). For this_and_following the cap is
  -- the pivot's start_at (forward set); for full series cap there too
  -- (everything <= pivot already cancelled; capping at pivot.start_at
  -- prevents any future re-materialisation past it — matches the legacy
  -- behaviour which set series_end_at := pivot.start_at for BOTH scopes).
  if v_scope in ('this_and_following', 'series') then
    update public.recurrence_series
       set series_end_at = v_pivot.start_at
     where tenant_id = p_tenant_id
       and id = v_pivot.recurrence_series_id;

    -- Series-level continuity audit row (checklist row 2.5 —
    -- booking.recurrence_cancel_forward; recurrence.service.ts:962-973).
    insert into public.audit_events
      (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
    values
      (p_tenant_id, 'booking.recurrence_cancel_forward', 'recurrence_series',
       v_pivot.recurrence_series_id, v_actor_users_id,
       jsonb_build_object(
         'scope',           v_scope,
         'pivot_booking_id', p_booking_id,
         'pivot_start_at',  v_pivot.start_at,
         'cancelled_count', coalesce(array_length(v_booking_ids, 1), 0),
         'reason',          v_reason));
  end if;

  -- ── 9. Finalize command_operations + return ──────────────────────────
  v_result := jsonb_build_object(
    'kind',                          'cancelled',
    'scope',                         v_scope,
    'booking_ids',                   to_jsonb(v_booking_ids),
    'slots_transitioned',            v_slots_transitioned,
    'orders_cancelled',              v_orders_cancelled,
    'asset_reservations_cancelled',  v_asset_reservations_cancelled,
    'work_orders_closed',            v_work_orders_closed,
    'approvals_expired',             v_approvals_expired,
    'emitted',                       v_emitted,
    'pivot',                         p_booking_id,
    'already_cancelled',             false
  );

  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = v_started_at
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

-- Trailer — mirrors 00407:1067-1068 (edit_booking) revoke/grant posture.
revoke all on function public.cancel_booking_with_cascade(uuid, uuid, uuid, text, text, int, text) from public;
grant  execute on function public.cancel_booking_with_cascade(uuid, uuid, uuid, text, text, int, text) to service_role;

comment on function public.cancel_booking_with_cascade(uuid, uuid, uuid, text, text, int, text) is
  'Booking-audit remediation Slice 2 (audit 03 P0-1 + P1-5). Atomic user-cancel: single tx cancels the booking set resolved by p_scope (this | this_and_following | series), cascades to booking_slots / orders / order_line_items / asset_reservations / work_orders / approvals, caps recurrence_series for forward/series scopes, writes audit_events + domain_events, and emits booking.cancelled (closes P1-5; consumed by WorkflowSpawnWakeOnBookingCancelledHandler) + booking.cancel_cascade_required (consumed by BookingCancelledCascadeHandler for the durable visitor cascade + requester notification — replaces the swallowed in-process BundleEventBus path). command_operations idempotency-gated (00407 pattern); F-CRIT-1 actor resolved via auth_uid; advisory lock on (tenant,booking,cancel). MUST NOT write visitors (00270 single-write-path) — visitor cascade is OBX-only. Equivalence contract: docs/follow-ups/cancel-booking-equivalence-checklist.md.';

notify pgrst, 'reload schema';
