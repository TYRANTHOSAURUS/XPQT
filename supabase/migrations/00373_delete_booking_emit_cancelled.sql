-- Universal Workflow Architecture — Phase 1.A commit 2: emit
-- `booking.cancelled` lifecycle outbox event from
-- `delete_booking_with_guard`.
--
-- Spec: docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md
--       §3.5 (Resume mechanism — Tier 2 outbox-driven wake from day 1, LOCKED)
--       §1.4 (Booking lifecycle today — `booking.cancelled` is currently only
--             a TS-side `audit_events` row from reservation.service.ts:464,506;
--             NOT an outbox event)
--       §3.6 (Cancellation propagation — wake handler dispatches the
--             cancel_child cascade for any parent workflow_instance_link
--             waiting on this booking)
--       §7  (Producer-before-consumer for Phase 1)
--
-- ── Why supersede 00292 ──────────────────────────────────────────────────
--
-- Same pattern as 00372: `CREATE OR REPLACE FUNCTION` re-states the entire
-- body. The diff in version control isolates the new emit at the bottom of
-- the rolled-back path. `ALTER FUNCTION` cannot replace a function body.
--
-- ── What changed vs. 00292 ───────────────────────────────────────────────
--
-- ONE addition between the `delete from public.bookings` and the success
-- return: `perform outbox.emit('booking.cancelled', ...)` BEFORE the final
-- `return jsonb_build_object('kind', 'rolled_back')`.
--
-- The emit is INSIDE the rolled_back branch — NOT inside the partial_failure
-- branch and NOT before the `if v_has_series then return ...` early-exit.
-- This is structurally important per the spec §1.4 / §3.6 contract:
-- `booking.cancelled` is the wake signal that the booking actually went
-- away. Emitting it on the partial_failure path (where the booking row
-- still exists, blocked by recurrence_series) would mis-fire the wake
-- handler — parent workflows would resume on their `cancelled` branch
-- thinking the child entity was gone, when in fact it's still alive +
-- referenced by a series. Emitting only after the DELETE succeeds is the
-- correct contract.
--
-- The `booking.not_found` raise path also doesn't emit (the booking never
-- existed in this tenant; nothing to cancel).
--
-- ── Payload shape ────────────────────────────────────────────────────────
--
-- Mirrors the booking.created shape from 00372 for handler symmetry:
--   - tenant_id              (#0 invariant)
--   - booking_id             (the aggregate)
--   - reason                 (text — fixed `'guard_rollback'` in this RPC's
--                              one caller path; future supersessions can
--                              parameterize from a p_reason argument)
--   - started_at             (now() at the cancel — wall-clock of the emit)
--
-- The wake handler (workflow-spawn-wake.handler.ts) keys off booking_id +
-- spawn_mode='wait' + resolved_at IS NULL; reason is included for audit
-- payloads downstream (notification handlers can render "cancelled because
-- ..." text without re-querying audit_events).
--
-- ── Idempotency ──────────────────────────────────────────────────────────
--
-- The booking row is uniquely keyed by (tenant_id, booking_id). On retry
-- the booking is gone, the SELECT FOR UPDATE finds nothing, and the RPC
-- raises `booking.not_found` (P0002) — the emit never fires. So replay
-- safety follows from "booking exists at most once". Defense-in-depth:
-- the idempotency key includes booking_id::text so even a hypothetical
-- second-emit would be ON CONFLICT no-op'd at outbox.emit
-- (00299:171-178). No per-call idempotency_key parameter is taken because
-- this RPC is a compensation primitive (not request-keyed), so we mint
-- a deterministic key from booking_id alone.

create or replace function public.delete_booking_with_guard(
  p_booking_id uuid,
  p_tenant_id  uuid default null
) returns jsonb
language plpgsql
security invoker
set search_path = public, outbox
as $$
declare
  v_tenant_id     uuid;
  v_booking_row   public.bookings;
  v_has_series    boolean;
  v_cancelled_at  timestamptz;
begin
  -- Tenant resolution mirrors create_booking (00277:271-275) and
  -- edit_booking_slot (00291:70-73). Service-role callers pass it explicitly;
  -- user-token callers fall back to JWT claim.
  v_tenant_id := coalesce(p_tenant_id, public.current_tenant_id());
  if v_tenant_id is null then
    raise exception 'delete_booking_with_guard: tenant_id required (none in JWT, none passed)';
  end if;

  -- Lock the booking row FOR UPDATE (per blocker-map RPC pseudocode line 91)
  -- so any concurrent inserts referencing this booking_id (e.g. a parallel
  -- attachServicesToBooking) serialize against this transaction.
  --
  -- Capture the full row so we can mint a deterministic `started_at` for
  -- the outbox emit further down — `now()` in the payload would change on
  -- a hypothetical replay and break payload_hash dedup.
  select *
    into v_booking_row
    from public.bookings
   where id = p_booking_id
     and tenant_id = v_tenant_id
   for update;

  if not found then
    raise exception 'booking.not_found' using errcode = 'P0002';
  end if;

  -- Deterministic timestamp for the outbox payload. We use the booking's
  -- own `created_at` (a stable DB-state value) rather than `now()` /
  -- `clock_timestamp()`. Why determinism matters: outbox.emit computes
  -- `payload_hash` from the serialised payload. A retry of this RPC (e.g.
  -- after a worker restart) would re-execute the body, hit
  -- booking.not_found on the second pass (booking already deleted), and
  -- never reach the emit — so in practice replay isn't possible. But if
  -- the dedup gate ever has a hole, a `now()`-derived payload would
  -- differ on retry and outbox.emit would raise 23505 on the (tenant_id,
  -- idempotency_key) ON CONFLICT path because the payload_hash wouldn't
  -- match the existing row. `created_at` from the booking row is
  -- guaranteed-stable across any hypothetical retry.
  v_cancelled_at := v_booking_row.created_at;

  -- Check the only true blocker: recurrence_series with NO ACTION FK
  -- (00278:184). Per blocker-map §"recurrence series" (lines 70-82): if a
  -- child series exists, deleting the parent would orphan materialised
  -- occurrences; we must surface this so the caller can handle the series
  -- (cancel it, or call us only when no series exists).
  select exists (
    select 1
      from public.recurrence_series
     where parent_booking_id = p_booking_id
       and tenant_id = v_tenant_id
  )
  into v_has_series;

  if v_has_series then
    -- partial_failure path: booking row remains. NO booking.cancelled emit
    -- here — the wake handler must not resume parent workflows for a
    -- booking that's still alive. See header comment.
    return jsonb_build_object(
      'kind', 'partial_failure',
      'blocked_by', jsonb_build_array('recurrence_series')
    );
  end if;

  -- No explicit unhook/delete needed for the remaining tables (all decisions
  -- per blocker-map lines 14-26):
  --   - asset_reservations: status='cancelled' tombstones from Cleanup
  --     (bundle.service.ts:1920-1925); FK SET NULL (00278:140) is safe; do
  --     not delete (audit + GiST history).
  --   - approvals (booking target): not cancelled by Cleanup
  --     (bundle.service.ts:1940-1945); leave as historical record.
  --   - approvals (order/oli targets): already cancelled by Cleanup
  --     (bundle.service.ts:1952-1964); no FK to bookings.
  --   - audit_events / audit_outbox: append-only, no FK.
  --   - work_orders: created only after cleanup.commit() succeeds
  --     (bundle.service.ts:375-456); never present at compensation time.
  --   - visitors: CASCADE handles them (00278:45) — see blocker-map line 26.
  --   - booking_slots: CASCADE handles them (00277:119).
  --   - orders / order_line_items: Cleanup deletes them on attach failure
  --     (bundle.service.ts:1907-1938); compensation only runs after
  --     attach failed, so Cleanup has already run.

  -- Delete the booking. Cascades to:
  --   - booking_slots         (00277:119, CASCADE)
  --   - visitors              (00278:45,  CASCADE)
  -- Sets NULL on:
  --   - tickets.booking_id    (00278:65)
  --   - work_orders.booking_id(00278:91)   — none should exist
  --   - orders.booking_id     (00278:116)  — Cleanup already deleted these
  --   - asset_reservations.booking_id (00278:140)
  delete from public.bookings
   where id = p_booking_id
     and tenant_id = v_tenant_id;

  -- ── Emit booking.cancelled outbox event (Spec 2026-05-12 §3.5 / §3.6) ──
  --
  -- NEW in 00373. Universal Workflow Architecture Phase 1.A — Tier 2 wake
  -- mechanism subscribes to this event in WorkflowSpawnWakeHandler. Per
  -- spec §3.6 cancellation propagation: any parent workflow_instance_link
  -- waiting on this booking (spawn_mode='wait', resolved_at IS NULL,
  -- child_entity_id = this booking_id) gets atomically claimed and
  -- resumed on the `cancelled` branch.
  --
  -- Emitted ONLY on the rolled_back path. The partial_failure return above
  -- does NOT emit (booking row still exists; resuming parents on a
  -- cancelled branch would be a lie). The booking.not_found raise above
  -- doesn't reach here.
  --
  -- Idempotency: deterministic key from booking_id alone (this RPC takes no
  -- p_idempotency_key parameter). Same-booking second-call would raise
  -- booking.not_found above (booking already deleted), so the emit can
  -- only fire once per booking lifecycle. Defense-in-depth: outbox.emit's
  -- (tenant_id, idempotency_key) ON CONFLICT (00299:171-178) makes any
  -- hypothetical replay a silent no-op.
  perform outbox.emit(
    p_tenant_id       => v_tenant_id,
    p_event_type      => 'booking.cancelled',
    p_aggregate_type  => 'booking',
    p_aggregate_id    => p_booking_id,
    p_payload         => jsonb_build_object(
      'tenant_id',  v_tenant_id,
      'booking_id', p_booking_id,
      'reason',     'guard_rollback',
      'started_at', v_cancelled_at
    ),
    p_idempotency_key => 'booking.cancelled:' || p_booking_id::text || ':guard_rollback',
    p_event_version   => 1,
    p_available_at    => null
  );

  return jsonb_build_object('kind', 'rolled_back');
end;
$$;

comment on function public.delete_booking_with_guard(uuid, uuid) is
  'Compensation primitive for booking + services creation. Atomic rollback of a booking that was inserted but whose subsequent services-attach failed. Returns rolled_back / partial_failure / raises booking.not_found. Phase 1.A (00373): emits booking.cancelled outbox event on the rolled_back path for the universal-workflow Tier 2 wake mechanism (spec 2026-05-12 §3.5 / §3.6).';

notify pgrst, 'reload schema';
