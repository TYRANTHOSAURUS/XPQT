-- Booking-audit remediation Slice 6 — atomic order-line / bundle-services
-- cancel cascade RPC (audit 03 P1-4 :179).
--
-- Closes audit `docs/follow-ups/audits/03-booking-reservation.md`:
--   - P1-4 `BundleCascadeService.cancelLine` / `cancelBundle` are
--     TS-orchestrated multi-write choreographies with no transaction
--     (partial-failure ⇒ wrong total cost / orphan asset_reservation /
--     mismatched daglijst) PLUS a lossy in-process BundleEventBus emit
--     (same data-loss class P0-1 eliminated for booking-cancel).
--
-- Replaces BOTH non-atomic TS entry points with ONE PL/pgSQL transaction
-- (decision doc: docs/follow-ups/slice6-cancel-order-line-plan.md +
-- its `## Plan-review remediation — 2026-05-17` section, which OVERRIDES
-- any earlier contradicting text). `p_line_ids` non-null → explicit lines
-- (cancelLine = single-element). NULL → all cancellable lines under the
-- booking honouring `p_keep_line_ids` (cancelBundle).
--
-- ── Mirror template ──────────────────────────────────────────────────────
-- supabase/migrations/00408_cancel_booking_with_cascade.sql (the cancel-
-- family canonical RPC) is mirrored clause-for-clause. Each step below
-- cites the 00408 clause it reproduces.
--
-- ── Citation discipline (every named symbol below was Read this session) ─
--   - 00408_cancel_booking_with_cascade.sql — the mirror template:
--       :155-178 arg-shape guards (step 0);
--       :180-194 F-CRIT-1 actor resolve (`where u.auth_uid =
--         p_actor_user_id and u.tenant_id = p_tenant_id`; raise
--         `<rpc>.actor_not_found`);
--       :196-203 advisory xact lock (hashtextextended);
--       :205-239 command_operations idempotency gate (deterministic md5
--         payload hash; found/cache-hit/payload-mismatch P0001/in_progress);
--       :241-252 booking SELECT FOR UPDATE tenant-scoped → not_found raise;
--       :348-361 asset_reservations→cancelled (status='confirmed' only);
--       :363-386 work_orders non-terminal close, whitelist
--         array['new','assigned','in_progress','waiting','pending_approval']
--         + closed_at;
--       :388-408 order_line_items→cancelled + pending_setup_trigger_args
--         null + capture distinct order_ids;
--       :410-446 orders→cancelled I-3 collateral-flip guard
--         (o.id = any(captured) AND zero non-cancelled lines AND order has
--          ≥1 line AND not already terminal);
--       :491-508 cancelPendingApprovalsForBundle (all pending → expired +
--         responded_at + comments) — the `p_line_ids IS NULL` branch;
--       :543-561 outbox.emit(...) keyword-arg signature;
--       :618-646 finalize command_operations success + revoke/grant/comment
--         trailer + `notify pgrst`.
--   - 00299_outbox_foundation.sql:132-140 — outbox.emit signature
--     (p_tenant_id,p_event_type,p_aggregate_type,p_aggregate_id,p_payload,
--      p_idempotency_key,p_event_version default 1,p_available_at default
--      null) + :154-155 raises p_idempotency_key required.
--   - apps/api/src/modules/booking-bundles/bundle-cascade.service.ts —
--     the EXACT TS semantics reproduced:
--       :680 FULFILLED_STATUSES = Set(['confirmed','preparing','delivered'])
--         (used :98 cancelLine + :271 cancelBundleImpl) — the protected set
--         is this 3-literal verbatim; `ordered` + `en_route` ARE cancellable;
--       :82-90 cancelLine: line_not_found if line absent;
--         bundle.line_not_in_bundle if line.bundle_id is null;
--       :98-100 cancelLine: line_already_fulfilled if fulfilled;
--       :114-121 cancelLine asset_reservations cancel (status='cancelled'
--         on linked_asset_reservation_id);
--       :136-151 cancelLine work_orders close — NON_TERMINAL_STATUSES =
--         ['new','assigned','in_progress','waiting','pending_approval'] via
--         work_orders.linked_order_line_item_id, set status_category=
--         'closed', closed_at;
--       :158-165 cancelLine OLI cancel + pending_setup_trigger_args=null;
--       :527-590 rescopeApprovalsAfterLineCancel — scope_breakdown shrink
--         of {order_line_item_ids,ticket_ids,asset_reservation_ids}; if all
--         ENTITY_KEYS empty → status='expired',responded_at=now,
--         comments='Auto-closed after scope drop'; else UPDATE
--         scope_breakdown (:566 ENTITY_KEYS = reservation_ids/order_ids/
--         order_line_item_ids/ticket_ids/asset_reservation_ids :681-687);
--       :592-609 cancelPendingApprovalsForBundle — all pending on the
--         booking → status='expired',responded_at=now,comments=
--         'Bundle cancelled; voiding approval';
--       :334-336 cancelBundleImpl weak booking-close condition
--         `everythingCancelled = fulfilledLineIds.length===0 &&
--          keep.size===0` then `if (everythingCancelled &&
--          !args.reservation_id)` (the && !reservation_id conjunct is
--          dead/always-true — reservation_id retired, see :44-55);
--       :337-348 cancelBundleImpl booking_slots → cancelled WHERE status in
--         ('confirmed','checked_in','pending_approval') + bookings →
--         cancelled;
--       :178-185 cancelLine audit order.line_cancelled shape;
--       :370-380 cancelBundleImpl audit bundle.cancelled shape.
--   - 00144_orders_bundle_columns.sql:17,25 — order_line_items.
--     linked_ticket_id + linked_asset_reservation_id; 00197:19 —
--     order_line_items.pending_setup_trigger_args.
--   - 00012_approvals.sql:3-20 — approvals (target_entity_type/_id, status,
--     responded_at, comments, scope_breakdown jsonb).
--   - 00019_events_audit.sql:4-46 — domain_events + audit_events schema.
--   - 00316_command_operations_table.sql:32-42 — command_operations.
--
-- ── Net behavioral changes (documented, intentional) ─────────────────────
--   - cancelLine + cancelBundle become ONE atomic command_operations-
--     idempotent RPC (the wrappers add RequireClientRequestIdGuard + a
--     deterministic key). Replays return cached success, no re-cascade.
--   - The per-line (`p_line_ids` non-null) in-process bundle.line.cancelled
--     emit is a VERIFIED visitor no-op (bundle-cascade.adapter.ts:235
--     `if (event.line_kind !== 'visitor') return;`; lineKindForOli ALWAYS
--     returns 'other' for OLI lines — bundle-cascade.service.ts:652-655) →
--     it is DROPPED, NO outbox event on the per-line path (plan
--     remediation C2).
--   - The bundle (`p_line_ids` NULL) path emits a NEW durable
--     `bundle.services_cancelled` outbox event in-tx (replaces the lossy
--     in-process bundle.cancelled emit). A new durable handler runs the
--     EXISTING BundleCascadeAdapter.handleBundleCancelled cascade.
--   - F-CRIT-1: p_actor_user_id is auth_uid (Slice-1 D-1 lesson). Fix-cycle
--     (Fix C): the controller threads its in-scope authUid (req.user.id =
--     JWT subject = auth_uid) through the cancelLine/cancelBundle wrappers
--     to p_actor_user_id — cancel-family-consistent with
--     ReservationService.cancelOne → cancel_booking_with_cascade
--     (reservation.service.ts:505). NULL only for internal/system callers
--     with no actor (F-CRIT-1 at step 1 skips resolution on null and
--     records a system-attributed audit row).

-- ── cancel_order_lines_with_cascade ──────────────────────────────────────

drop function if exists public.cancel_order_lines_with_cascade(uuid, uuid[], uuid[], uuid, uuid, text, text);

create or replace function public.cancel_order_lines_with_cascade(
  p_booking_id      uuid,
  p_line_ids        uuid[],
  p_keep_line_ids   uuid[],
  p_tenant_id       uuid,
  p_actor_user_id   uuid,
  p_reason          text,
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
  v_reason           text;

  v_booking          record;

  -- The line ids the caller explicitly named (p_line_ids), sorted for the
  -- deterministic hash + a stable sentinel '__ALL__' when NULL (I-2 —
  -- hash the INTENT, not the resolved set).
  v_line_ids_sorted_txt text;
  v_keep_ids_sorted_txt text;

  -- Resolved-under-lock cancellable set (the partition).
  v_cancellable_ids  uuid[] := '{}'::uuid[];
  v_keep_set         uuid[] := coalesce(p_keep_line_ids, '{}'::uuid[]);

  v_oli_cancelled_order_ids uuid[];
  v_cascaded_ticket_ids     uuid[] := '{}'::uuid[];
  v_cascaded_ar_ids         uuid[] := '{}'::uuid[];
  v_fulfilled_line_ids      uuid[] := '{}'::uuid[];

  -- Approval-rescope accumulators.
  v_rescoped_approval_ids uuid[] := '{}'::uuid[];
  v_expired_approval_ids  uuid[] := '{}'::uuid[];
  v_appr             record;
  v_new_lines        uuid[];
  v_new_tickets      uuid[];
  v_new_assets       uuid[];
  v_new_scope        jsonb;
  v_still_covers     boolean;

  v_booking_cancelled boolean := false;
  v_row_count        int;
  v_result           jsonb;
begin
  -- ── 0. Argument shape checks (mirrors 00408:155-178) ─────────────────
  if p_tenant_id is null then
    raise exception 'cancel_order_lines_with_cascade: p_tenant_id required';
  end if;
  if p_booking_id is null then
    raise exception 'cancel_order_lines_with_cascade: p_booking_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'cancel_order_lines_with_cascade: p_idempotency_key required';
  end if;
  -- An explicitly-empty p_line_ids array (NOT null) is meaningless — the
  -- caller asked to cancel "these lines" but named none. NULL is the
  -- distinct "cancel-all" intent (cancelBundle). 422-class.
  if p_line_ids is not null and array_length(p_line_ids, 1) is null then
    raise exception 'cancel_order_lines_with_cascade.invalid_args: p_line_ids is an empty array (use NULL for cancel-all)'
      using errcode = 'P0001';
  end if;

  v_reason := coalesce(p_reason, 'user_cancel');

  -- ── 1. F-CRIT-1: auth_uid → users.id ONCE (mirrors 00408:180-194) ────
  -- The RPC writes audit_events.actor_user_id = the resolved users.id; the
  -- TS wrapper passes actor.auth_uid (NOT users.id) per the Slice-1 D-1
  -- lesson, so the resolution is required.
  if p_actor_user_id is not null then
    select u.id
      into v_actor_users_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;

    if v_actor_users_id is null then
      raise exception 'cancel_order_lines_with_cascade.actor_not_found: auth_uid=% not registered as a user in tenant=%',
        p_actor_user_id, p_tenant_id
        using errcode = 'P0001';
    end if;
  end if;

  -- ── 2. Advisory lock keyed on (tenant, oli-cancel, booking) ──────────
  -- Mirrors 00408:196-203 (the cancel family serialises on the booking,
  -- not the request, so a concurrent retry of a DIFFERENT key for the
  -- same booking still serialises correctly).
  v_lock_key := hashtextextended(
    p_tenant_id::text || ':oli-cancel:' || p_booking_id::text, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 3. command_operations idempotency gate (mirrors 00408:205-239) ───
  -- I-2: hash the INTENT tuple, NOT the resolved cancellable set. The set
  -- is recomputed under FOR UPDATE each attempt; a successful cache-hit
  -- short-circuits (correct idempotent intent even if the live set
  -- shifted). Arrays sorted before hashing (D-5/D-6 nondeterminism-class
  -- avoidance — NO Date.now/random/unsorted). A fixed sentinel '__ALL__'
  -- distinguishes the cancel-all intent (p_line_ids NULL) from an
  -- (impossible — guarded above) empty list.
  if p_line_ids is null then
    v_line_ids_sorted_txt := '__ALL__';
  else
    select coalesce(string_agg(x::text, ','), '')
      into v_line_ids_sorted_txt
      from (select unnest(p_line_ids) as x order by 1) s;
  end if;
  select coalesce(string_agg(x::text, ','), '')
    into v_keep_ids_sorted_txt
    from (select unnest(coalesce(p_keep_line_ids, '{}'::uuid[])) as x order by 1) s;

  v_payload_hash := md5(
    coalesce(p_booking_id::text, '') || '|' ||
    v_line_ids_sorted_txt            || '|' ||
    v_keep_ids_sorted_txt            || '|' ||
    coalesce(p_tenant_id::text, '')  || '|' ||
    coalesce(v_actor_users_id::text, '') || '|' ||
    coalesce(p_reason, '') );

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

  -- ── 4. Lock the booking + tenant validation (mirrors 00408:241-252) ──
  select id, tenant_id, status
    into v_booking
    from public.bookings
   where id = p_booking_id
     and tenant_id = p_tenant_id
   for update;

  if not found then
    raise exception 'cancel_order_lines_with_cascade.booking_not_found: booking=% tenant=%', p_booking_id, p_tenant_id
      using errcode = 'P0001';
  end if;

  -- ── 5. Resolve the cancellable OLI set UNDER THE LOCK ────────────────
  -- Lines whose order_id ∈ (orders WHERE booking_id=p_booking_id AND
  -- tenant). When p_line_ids is non-null, restrict to those ids AND
  -- reproduce the live cancelLine validation order
  -- (bundle-cascade.service.ts:82-99):
  --   - line absent in this booking's orders → line_not_found (404);
  --   - line present but its parent order has no booking link
  --     (line.bundle_id null in TS) → line_not_in_bundle (422);
  --   - line fulfilled (fulfillment_status ∈ the 3-literal protected set)
  --     → line_already_fulfilled (422).
  -- Then exclude fulfilled (the protected set) + exclude p_keep_line_ids.
  -- p_line_ids NULL = every cancellable line (cancelBundle).
  if p_line_ids is not null then
    -- Per-line validation: each named line must (a) exist in this tenant,
    -- (b) hang off an order linked to THIS booking, (c) not be fulfilled.
    -- The order of these raises mirrors cancelLine :82-99 exactly.
    declare
      v_lid uuid;
      v_oli record;
    begin
      foreach v_lid in array p_line_ids loop
        select oli.id, oli.order_id, oli.fulfillment_status, o.booking_id
          into v_oli
          from public.order_line_items oli
          left join public.orders o
            on o.id = oli.order_id and o.tenant_id = p_tenant_id
         where oli.id = v_lid
           and oli.tenant_id = p_tenant_id
         limit 1;

        if not found then
          raise exception 'cancel_order_lines_with_cascade.line_not_found: line=% not found', v_lid
            using errcode = 'P0001';
        end if;
        -- TS cancelLine walks orders.booking_id; a null booking_id (no
        -- order link to a booking) is the `!line.bundle_id` branch
        -- (bundle-cascade.service.ts:88) → line_not_in_bundle.
        if v_oli.booking_id is null or v_oli.booking_id <> p_booking_id then
          raise exception 'cancel_order_lines_with_cascade.line_not_in_bundle: line=% is not part of booking=%', v_lid, p_booking_id
            using errcode = 'P0001';
        end if;
        -- Protected/fulfilled set = EXACTLY the live FULFILLED_STATUSES
        -- 3-literal (bundle-cascade.service.ts:680 + 00408:375,:403).
        if v_oli.fulfillment_status = any (array['confirmed','preparing','delivered']) then
          raise exception 'cancel_order_lines_with_cascade.line_already_fulfilled: line=% has been fulfilled', v_lid
            using errcode = 'P0001';
        end if;
      end loop;
    end;

    -- All named lines validated. The cancellable set = the named lines
    -- minus p_keep_line_ids (a named line that is also kept is a no-op;
    -- mirrors cancelBundleImpl's keep-set exclusion :275).
    select coalesce(array_agg(distinct oli.id), '{}'::uuid[])
      into v_cancellable_ids
      from public.order_line_items oli
      join public.orders o on o.id = oli.order_id
     where o.tenant_id = p_tenant_id
       and o.booking_id = p_booking_id
       and oli.tenant_id = p_tenant_id
       and oli.id = any (p_line_ids)
       and not (oli.fulfillment_status = any (array['confirmed','preparing','delivered']))
       and not (oli.id = any (v_keep_set));
  else
    -- cancelBundle: every cancellable line under the booking, honouring
    -- p_keep_line_ids (cancelBundleImpl :271-277). Also collect the
    -- fulfilled (protected) line ids for the result + the weak-close
    -- condition (cancelBundleImpl :259/271-274 fulfilledLineIds).
    select coalesce(array_agg(oli.id) filter (
             where not (oli.fulfillment_status = any (array['confirmed','preparing','delivered']))
               and not (oli.id = any (v_keep_set))), '{}'::uuid[]),
           coalesce(array_agg(oli.id) filter (
             where oli.fulfillment_status = any (array['confirmed','preparing','delivered'])), '{}'::uuid[])
      into v_cancellable_ids, v_fulfilled_line_ids
      from public.order_line_items oli
      join public.orders o on o.id = oli.order_id
     where o.tenant_id = p_tenant_id
       and o.booking_id = p_booking_id
       and oli.tenant_id = p_tenant_id;
  end if;

  -- ── 6/7.a — asset_reservations linked to cancelled OLIs → cancelled ──
  -- (reproduces cancelLine :114-121 / 00408:348-361 — only status=
  -- 'confirmed' is cancellable). Capture the cascaded ar ids for the
  -- result envelope.
  if array_length(v_cancellable_ids, 1) is not null then
    with cancelled_ar as (
      update public.asset_reservations ar
         set status = 'cancelled'
       where ar.tenant_id = p_tenant_id
         and ar.status = 'confirmed'
         and ar.id in (
           select oli.linked_asset_reservation_id
             from public.order_line_items oli
            where oli.tenant_id = p_tenant_id
              and oli.id = any (v_cancellable_ids)
              and oli.linked_asset_reservation_id is not null
         )
      returning ar.id
    )
    select coalesce(array_agg(id), '{}'::uuid[]) into v_cascaded_ar_ids from cancelled_ar;
  end if;

  -- ── 7.b — work_orders linked to cancelled OLIs → closed ──────────────
  -- via work_orders.linked_order_line_item_id; non-terminal whitelist
  -- reproduced VERBATIM from cancelLine :136 / cancelBundleImpl :298 /
  -- 00408:382 — array['new','assigned','in_progress','waiting',
  -- 'pending_approval']. Do NOT re-stamp terminal rows (closed_at only
  -- when we close).
  if array_length(v_cancellable_ids, 1) is not null then
    with closed_wo as (
      update public.work_orders w
         set status_category = 'closed', closed_at = v_started_at
       where w.tenant_id = p_tenant_id
         and w.linked_order_line_item_id = any (v_cancellable_ids)
         and w.status_category = any (array['new','assigned','in_progress','waiting','pending_approval'])
      returning w.id
    )
    select coalesce(array_agg(id), '{}'::uuid[]) into v_cascaded_ticket_ids from closed_wo;
  end if;

  -- ── 7.c — order_line_items → cancelled + pending_setup_trigger_args ──
  -- null (reproduces cancelLine :158-165 / cancelBundleImpl :315-322 /
  -- 00408:388-408). Capture the distinct order_ids THIS op touched (I-3).
  if array_length(v_cancellable_ids, 1) is not null then
    with cancelled_oli as (
      update public.order_line_items oli
         set fulfillment_status = 'cancelled', pending_setup_trigger_args = null
       where oli.tenant_id = p_tenant_id
         and oli.id = any (v_cancellable_ids)
      returning oli.order_id
    )
    select coalesce(array_agg(distinct order_id), '{}'::uuid[])
      into v_oli_cancelled_order_ids
      from cancelled_oli;
  else
    v_oli_cancelled_order_ids := '{}'::uuid[];
  end if;

  -- ── 7.d — orders → cancelled ONLY when an order BOTH (a) had ≥1 line
  -- cancelled by THIS op (o.id ∈ v_oli_cancelled_order_ids — I-3
  -- collateral-flip guard) AND (b) now has NO non-cancelled line left.
  -- Reproduces 00408:410-446 exactly (the legacy TS cancelLine/
  -- cancelBundle never flipped orders.status; this is the same
  -- documented enhancement 00408 ships, scoped identically).
  if array_length(v_oli_cancelled_order_ids, 1) is not null then
    with fully_cancelled_orders as (
      select o.id
        from public.orders o
       where o.tenant_id = p_tenant_id
         and o.booking_id = p_booking_id
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
    )
    update public.orders o
       set status = 'cancelled'
     where o.id in (select id from fully_cancelled_orders)
       and o.tenant_id = p_tenant_id;
  end if;

  -- ── 8. Approvals — branch on p_line_ids IS NULL (plan I1) ────────────
  if p_line_ids is not null then
    -- Per-line RESCOPE — reproduce rescopeApprovalsAfterLineCancel
    -- (bundle-cascade.service.ts:527-590) EXACTLY. For each pending
    -- approval targeting the booking: drop the cancelled {oli, ticket,
    -- asset_reservation} ids from scope_breakdown. If the ENTIRE scope
    -- (across ALL ENTITY_KEYS reservation_ids/order_ids/
    -- order_line_item_ids/ticket_ids/asset_reservation_ids :681-687) is
    -- empty → expire (status='expired', responded_at=now, comments=
    -- 'Auto-closed after scope drop'); else UPDATE scope_breakdown.
    -- The TS iterates per-line; doing the full cancelled-set at once is
    -- equivalent (set-subtraction is order-independent) and matches
    -- 00408's set-based reproduction posture.
    for v_appr in
      select a.id, coalesce(a.scope_breakdown, '{}'::jsonb) as scope_breakdown
        from public.approvals a
       where a.tenant_id = p_tenant_id
         and a.target_entity_id = p_booking_id
         and a.status = 'pending'
       for update
    loop
      select coalesce(array_agg(x), '{}'::uuid[]) into v_new_lines
        from (
          select (jsonb_array_elements_text(v_appr.scope_breakdown -> 'order_line_item_ids'))::uuid as x
        ) s
       where x <> all (v_cancellable_ids);
      select coalesce(array_agg(x), '{}'::uuid[]) into v_new_tickets
        from (
          select (jsonb_array_elements_text(v_appr.scope_breakdown -> 'ticket_ids'))::uuid as x
        ) s
       where x <> all (v_cascaded_ticket_ids);
      select coalesce(array_agg(x), '{}'::uuid[]) into v_new_assets
        from (
          select (jsonb_array_elements_text(v_appr.scope_breakdown -> 'asset_reservation_ids'))::uuid as x
        ) s
       where x <> all (v_cascaded_ar_ids);

      v_new_scope := v_appr.scope_breakdown
        || jsonb_build_object(
             'order_line_item_ids', to_jsonb(v_new_lines),
             'ticket_ids',          to_jsonb(v_new_tickets),
             'asset_reservation_ids', to_jsonb(v_new_assets));

      -- stillCovers = ANY of the 5 ENTITY_KEYS has a non-empty array
      -- (bundle-cascade.service.ts:566 + :681-687). reservation_ids /
      -- order_ids are untouched here (we only shrink the 3 cancelled-
      -- entity arrays) but still count toward "still covers".
      v_still_covers :=
        coalesce(jsonb_array_length(v_new_scope -> 'reservation_ids'), 0) > 0
        or coalesce(jsonb_array_length(v_new_scope -> 'order_ids'), 0) > 0
        or array_length(v_new_lines, 1) is not null
        or array_length(v_new_tickets, 1) is not null
        or array_length(v_new_assets, 1) is not null;

      if not v_still_covers then
        update public.approvals
           set status = 'expired',
               responded_at = v_started_at,
               comments = 'Auto-closed after scope drop'
         where id = v_appr.id
           and tenant_id = p_tenant_id;
        v_expired_approval_ids := array_append(v_expired_approval_ids, v_appr.id);
      else
        update public.approvals
           set scope_breakdown = v_new_scope
         where id = v_appr.id
           and tenant_id = p_tenant_id;
        v_rescoped_approval_ids := array_append(v_rescoped_approval_ids, v_appr.id);
      end if;
    end loop;
  else
    -- cancelBundle: expire ALL pending approvals on the booking
    -- (reproduce cancelPendingApprovalsForBundle
    -- bundle-cascade.service.ts:592-609; mirrors 00408:491-508 step 7.g).
    with expired_appr as (
      update public.approvals a
         set status = 'expired',
             responded_at = v_started_at,
             comments = 'Bundle cancelled; voiding approval'
       where a.tenant_id = p_tenant_id
         and a.target_entity_id = p_booking_id
         and a.status = 'pending'
      returning a.id
    )
    select coalesce(array_agg(id), '{}'::uuid[]) into v_expired_approval_ids from expired_appr;
  end if;

  -- ── 9. Conditional booking/slot close (plan I3) ──────────────────────
  -- Reproduces cancelBundleImpl's live condition VERBATIM
  -- (bundle-cascade.service.ts:335-336):
  --   everythingCancelled = fulfilledLineIds.length===0 && keep.size===0
  --   if (everythingCancelled && !args.reservation_id) { ...close... }
  -- The `&& !args.reservation_id` conjunct is DEAD/always-true
  -- (reservation_id retired — bundle-cascade.service.ts:44-55) → dropped
  -- as faithful reproduction. ONLY runs on the bundle path (p_line_ids
  -- NULL): the per-line path never closed the booking (cancelLine has no
  -- such branch). Do NOT strengthen/weaken.
  if p_line_ids is null
     and array_length(v_fulfilled_line_ids, 1) is null
     and array_length(v_keep_set, 1) is null then
    -- reproduces bundle-cascade.service.ts:335-336;
    -- !reservation_id dropped (reservation_id retired, always-true)
    update public.booking_slots
       set status = 'cancelled'
     where tenant_id = p_tenant_id
       and booking_id = p_booking_id
       and status in ('confirmed', 'checked_in', 'pending_approval');
    update public.bookings
       set status = 'cancelled'
     where tenant_id = p_tenant_id
       and id = p_booking_id;
    v_booking_cancelled := true;
  end if;

  -- ── 10. In-tx audit_events (NOT swallowed; mirrors 00408:510-528) ────
  -- Per-line path → order.line_cancelled per cancelled line (continuity
  -- with the legacy cancelLine audit shape bundle-cascade.service.ts:
  -- 178-185). Bundle path → one bundle.cancelled row (continuity with
  -- cancelBundleImpl :370-380).
  if p_line_ids is not null then
    insert into public.audit_events
      (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
    select
      p_tenant_id, 'order.line_cancelled', 'order_line_item', lid, v_actor_users_id,
      jsonb_build_object(
        'line_id',                 lid,
        'bundle_id',               p_booking_id,
        'ticket_ids',              to_jsonb(v_cascaded_ticket_ids),
        'asset_reservation_ids',   to_jsonb(v_cascaded_ar_ids),
        'closed_approval_ids',     to_jsonb(v_expired_approval_ids),
        'reason',                  v_reason)
    from unnest(v_cancellable_ids) as lid;
  else
    insert into public.audit_events
      (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
    values
      (p_tenant_id, 'bundle.cancelled', 'booking', p_booking_id, v_actor_users_id,
       jsonb_build_object(
         'bundle_id',                       p_booking_id,
         'cancelled_line_ids',              to_jsonb(v_cancellable_ids),
         'cancelled_ticket_ids',            to_jsonb(v_cascaded_ticket_ids),
         'cancelled_asset_reservation_ids', to_jsonb(v_cascaded_ar_ids),
         'closed_approval_ids',             to_jsonb(v_expired_approval_ids),
         'fulfilled_line_ids',              to_jsonb(v_fulfilled_line_ids),
         'booking_cancelled',               v_booking_cancelled,
         'reason',                          v_reason));
  end if;

  -- ── 11. In-tx domain_events intent log (mirrors 00408:530-541) ───────
  insert into public.domain_events
    (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id)
  values
    (p_tenant_id,
     case when p_line_ids is not null then 'order.line_cancelled' else 'bundle.services_cancelled' end,
     'booking', p_booking_id,
     jsonb_build_object(
       'booking_id',          p_booking_id,
       'cancelled_line_ids',  to_jsonb(v_cancellable_ids),
       'booking_cancelled',   v_booking_cancelled,
       'reason',              v_reason),
     v_actor_users_id);

  -- ── 12. In-tx outbox.emit — BUNDLE PATH ONLY (plan remediation C2) ───
  -- The per-line (p_line_ids non-null) path emits NOTHING: its in-process
  -- bundle.line.cancelled was a VERIFIED visitor no-op
  -- (bundle-cascade.adapter.ts:235 line_kind guard; lineKindForOli never
  -- returns 'visitor' for OLI lines — bundle-cascade.service.ts:652-655),
  -- so a new event + handler for a no-op is scope creep.
  -- The bundle path emits a NEW durable bundle.services_cancelled (the
  -- durable replacement for the lossy in-process bundle.cancelled →
  -- BundleCascadeAdapter.handleBundleCancelled). outbox.emit signature
  -- mirrored from 00408:543-561 / 00299:132-140.
  if p_line_ids is null then
    perform outbox.emit(
      p_tenant_id       => p_tenant_id,
      p_event_type      => 'bundle.services_cancelled',
      p_aggregate_type  => 'booking',
      p_aggregate_id    => p_booking_id,
      p_payload         => jsonb_build_object(
        'tenant_id',          p_tenant_id,
        'booking_id',         p_booking_id,
        'cancelled_line_ids', to_jsonb(v_cancellable_ids),
        'booking_cancelled',  v_booking_cancelled
      ),
      p_idempotency_key => 'bundle.services_cancelled:' || p_booking_id::text || ':' || p_idempotency_key,
      p_event_version   => 1,
      p_available_at    => null
    );
  end if;

  -- ── 13. Finalize command_operations + return (mirrors 00408:618-637) ─
  v_result := jsonb_build_object(
    'cancelled_line_ids',    to_jsonb(v_cancellable_ids),
    'cascaded',              jsonb_build_object(
       'ticket_ids',            to_jsonb(v_cascaded_ticket_ids),
       'asset_reservation_ids', to_jsonb(v_cascaded_ar_ids)),
    'rescoped_approval_ids', to_jsonb(v_rescoped_approval_ids),
    'expired_approval_ids',  to_jsonb(v_expired_approval_ids),
    'booking_cancelled',     v_booking_cancelled,
    'fulfilled_line_ids',    to_jsonb(v_fulfilled_line_ids),
    'kept_line_ids',         to_jsonb(v_keep_set)
  );

  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = v_started_at
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

-- Trailer — mirrors 00408:641-646 revoke/grant/comment posture.
revoke all on function public.cancel_order_lines_with_cascade(uuid, uuid[], uuid[], uuid, uuid, text, text) from public;
grant  execute on function public.cancel_order_lines_with_cascade(uuid, uuid[], uuid[], uuid, uuid, text, text) to service_role;

comment on function public.cancel_order_lines_with_cascade(uuid, uuid[], uuid[], uuid, uuid, text, text) is
  'Booking-audit remediation Slice 6 (audit 03 P1-4). Atomic order-line / bundle-services cancel: ONE tx replaces both BundleCascadeService.cancelLine (p_line_ids = explicit lines) and cancelBundle (p_line_ids NULL = all cancellable under p_keep_line_ids). Cascades to asset_reservations / work_orders / order_line_items / orders, branches approvals on p_line_ids IS NULL (per-line rescope vs expire-all), conditionally closes the booking + slots on the bundle path (reproduces the live weak-close condition verbatim), writes audit_events + domain_events, and emits the durable bundle.services_cancelled outbox event on the bundle path ONLY (the per-line in-process bundle.line.cancelled emit was a verified visitor no-op — dropped). command_operations idempotency-gated (00408 pattern; INTENT-hashed, recompute-under-lock); F-CRIT-1 actor resolved via auth_uid; advisory lock on (tenant,oli-cancel,booking). Mirror template: supabase/migrations/00408_cancel_booking_with_cascade.sql. Decision doc: docs/follow-ups/slice6-cancel-order-line-plan.md.';

notify pgrst, 'reload schema';
