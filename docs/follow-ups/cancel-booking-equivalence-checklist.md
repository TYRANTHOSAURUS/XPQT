# cancel_booking_with_cascade — equivalence checklist (audit 03 P0-1 / P1-5, Slice 2)

Mandated by codex plan-gate. Every observable side effect of the current
non-atomic user-cancel chain (cancelOne + cancelForward + cancelBundleImpl +
the visitor adapter + booking notifications) is enumerated and assigned a
destination so NONE is silently dropped when reproduced atomically.

Destinations:
- **TX** — inside the new `cancel_booking_with_cascade` PL/pgSQL RPC, one
  transaction (pure DB writes that do not violate a single-write-path invariant).
- **OBX** — new durable outbox handler `BookingCancelledCascadeHandler`,
  consumes the `booking.cancelled` outbox event the RPC emits in-tx. Replaces the
  in-process BundleEventBus path for the *user-cancel* route only.
- **P1-4** — belongs to per-line cancel (`cancelLine`/`cancelBundle`), a later
  slice; NOT on the user-cancel path; stays TS for now.
- **REPLACED** — the in-process emission is removed for the user-cancel path and
  superseded by the durable OBX path (strictly better: at-least-once vs swallowed).

| # | Current side effect (file:line) | table/col old→new OR event/payload | Destination | Notes / justification |
|---|---|---|---|---|
| 1.1 | cancelOne booking_slots (reservation.service.ts:484-489) | booking_slots.status non-terminal→cancelled; cancellation_grace_until→now+grace_minutes | **TX** | RPC takes p_grace_minutes; replicate grace formula exactly. **C-1 fix:** the RPC cancels ALL non-terminal slots (status NOT IN cancelled/completed/released), matching legacy cancelOne which filtered NOTHING (a7570f14:reservation.service.ts:484-487). An earlier draft narrowed this to a confirmed/checked_in/pending_approval whitelist — that baked a permanent booking/slot status divergence for any 'draft' slot (booking goes cancelled unconditionally at 1.2/7.f). Now corrected. |
| 1.2 | cancelOne bookings (:495-499) | bookings.status→cancelled | **TX** | |
| 1.3 | cancelOne notify onCancelled (:502 / :460) | NotificationService reservation_cancelled | **OBX** | requester notification; durable handler sends + writes notif audit (replaces in-process call) |
| 1.4 | cancelOne audit (:504-510 / :462-471) | audit_events booking.cancelled | **TX** | now in-tx, no longer swallowed |
| 1.5 | cancelOne→bundleCascade (:517-520) | delegates | decomposed below | |
| 2.1 | cancelForward bookings forward-set (recurrence.service.ts:906-920) | bookings.status non-terminal→cancelled, scope predicate | **TX** | lock booking set in id order. **C-2 fix:** the sibling-set predicate is broadened from legacy's confirmed/checked_in/pending_approval whitelist (a7570f14:recurrence.service.ts:911-912) to ALL non-terminal (status NOT IN cancelled/completed/released). Rationale: a forward occurrence in a non-whitelisted live state (e.g. 'draft') was SKIPPED — no cascade, no booking.cancelled emit, no audit — yet step 8 still caps recurrence_series.series_end_at at the pivot, leaving a permanently-live orphan occurrence on a "cancelled series". This is a deliberate strengthening OVER legacy (legacy had the same latent orphan bug); same lock-then-aggregate / `order by id` deadlock-safety preserved. |
| 2.2 | cancelForward booking_slots (:926-933) | booking_slots.status active→cancelled | **TX** | |
| 2.3 | cancelForward per-occurrence cascade (:943-950) | per booking → Path 3 | **TX** + **OBX** | cascade in-tx per booking; one booking.cancelled emit per cancelled booking |
| 2.4 | cancelForward series cap (:954-958) | recurrence_series.series_end_at→pivot.start_at | **TX** | codex confirmed: cap + soft-cancel = sufficient vs materialize() (:385/:406/:424) + rollover (:719) |
| 2.5 | cancelForward audit (:962-973) | audit_events booking.recurrence_cancel_forward | **TX** | |
| 3.1 | cancelBundleImpl partition OLIs (bundle-cascade.service.ts:243-256) | read-only partition fulfilled/kept/cancellable | **TX** | logic inside RPC |
| 3.2 | asset_reservations (:284-289) | asset_reservations.status→cancelled (cancellable only) | **TX** | |
| 3.3 | work_orders (:300-309) | work_orders non-terminal status_category→closed, closed_at→now | **TX** | preserve NON_TERMINAL whitelist incl in_progress; do NOT re-stamp terminal |
| 3.4 | order_line_items (:311-323) | OLI.fulfillment_status→cancelled, pending_setup_trigger_args→null (cancellable only) | **TX** | fulfilled lines protected (not touched). **orders→cancelled enhancement (RPC-only, legacy TS never did this) — I-3 tightened predicate:** an order flips to 'cancelled' ONLY when it BOTH (a) had ≥1 line cancelled BY THIS RPC iteration's 7.c (order_id ∈ the 7.c RETURNING set) AND (b) now has no non-cancelled line left. The (a) clause is the I-3 fix: without it, an order whose sole remaining line was cancelled by a PRIOR unrelated op — and which this booking-scoped cancel never touched — could be collaterally flipped. |
| 3.5 | booking/slots cancel gate (:335-348) | bookings/slots→cancelled when everythingCancelled | **TX** | USER-CANCEL SEMANTIC: user cancelled the booking → 1.1/1.2 already cancel it unconditionally (matches today's cancelOne). Fulfilled-line *protection* preserved at OLI level (3.4); the booking still goes cancelled per explicit user intent. Documented deliberate behavior. |
| 3.6 | approvals (:355-368) | full cancel: all pending approvals status→expired, responded_at→now, comments | **TX** | whole-booking user cancel → cancelPendingApprovalsForBundle semantics (:592-608). Per-line rescope (:527-590) is **P1-4**, not user-cancel. |
| 3.7 | cancelBundleImpl audit (:370-380) | audit_events bundle.cancelled | **TX** | keep for continuity, in-tx |
| 3.8 | BundleEventBus bundle.cancelled (:393-399) | in-process event | **REPLACED** | user-cancel path emits `booking.cancelled` OUTBOX in-tx instead; in-process bus stays for cancelLine/cancelBundle (**P1-4**). RPC must NOT emit the in-process event. |
| 4.0/4.1 | adapter expected/pending visitors (bundle-cascade.adapter.ts:255-275) | VisitorService.transitionStatus→cancelled (marker-safe, FOR UPDATE) | **OBX** | handler calls VisitorService.transitionStatus — preserves 00270 single-write-path marker + visitor audit (visitor.service.ts:198) + visitor.cancelled emit (:244). RPC must NOT write `visitors` directly (00270:83 trigger rejects). |
| 4.2 | adapter visitor.cascade.cancelled (:276-285) | domain_events visitor.cascade.cancelled (email intent, target visitor) | **OBX** | emitted by handler after successful transition |
| 4.3 | adapter arrived/in_meeting host alert (:290-304) | domain_events visitor.cascade.host_alert (target host, no status change) | **OBX** | |
| 4.4/4.5 | adapter handleLineMoved (:137-173) | line-move, not cancel | **N/A** | not a cancel path; out of scope |
| 5.1 | BookingNotifications onCancelled (booking-notifications.service.ts:72-81) | reservation_cancelled notification | **OBX** | same as 1.3 (single requester notification via handler) |
| 5.2 | notification audit (:89) | audit_events reservation.notification_sent | **OBX** | handler writes after send |
| 6.2 | POST /reservations/:id/cancel guard (reservation.controller.ts:382-393) | no RequireClientRequestIdGuard today | **TS** | ADD the guard — command_operations idempotency needs a client request id |
| 6.3-6.5 | DTO + return shape | CancelReservationDto {scope,reason,grace_minutes}; Reservation or {scope,cancelled,pivot} | **TS** | wrapper preserves caller signature + response shape |
| 7 | jest specs cancelOne/cancelForward/cascade | — | **TS** | update for one-call wrapper; keep green; smoke covers DB equivalence |

## Net behavioral changes (intentional, documented)
- Cancel becomes a **command_operations**-idempotent producer route (gains
  RequireClientRequestIdGuard + an idempotency key). Replays return cached success.
- Already-cancelled short-circuit: RPC checks booking.status; if already cancelled
  it returns a success-shaped result WITHOUT re-cascading or re-emitting (CAS).
- Visitor cascade + requester notification become **durable** (outbox, at-least-once)
  instead of best-effort-swallowed in-process. Strictly stronger guarantee.
- `booking.cancelled` is now emitted on EVERY user-cancel (single + series, one per
  cancelled booking) — closes P1-5 (was: only `delete_booking_with_guard`/compensation).
- No legacy side effect is dropped, and the user-cancel path is now STRICTLY
  STRONGER than legacy in two ways the original "strictly additive" claim
  understated (precise post-fix behavior):
  - **C-1**: legacy cancelOne cancelled every slot with no status filter; the
    RPC cancels every NON-TERMINAL slot (excludes only cancelled/completed/
    released). Equivalent breadth for live slots; terminal slots correctly
    untouched (legacy would have re-stamped a 'completed'/'released' slot to
    'cancelled' — the RPC's exclusion is a *correctness* improvement, not a
    drop).
  - **C-2**: the recurrence sibling-set is broadened from legacy's
    confirmed/checked_in/pending_approval whitelist to all non-terminal —
    legacy SKIPPED forward occurrences in other live states (e.g. 'draft')
    while still capping the series, leaving live orphans. The RPC cancels +
    cascades + emits for every live forward occurrence. This is a deliberate
    strengthening over legacy, not parity.
  - The only removed emission (in-process BundleEventBus for the user-cancel
    path) is superseded by the durable booking.cancel_cascade_required→handler
    path (at-least-once vs swallowed).
  - **I-3**: the orders→cancelled flip is RPC-only (legacy never did it) and
    is scoped to orders THIS op cancelled a line on — it cannot collaterally
    flip an unrelated order. Net new, precisely bounded.
- F-CRIT-1: RPC takes p_actor_user_id=auth_uid (Slice-1 D-1 lesson); wrapper passes
  actor.auth_uid.

## Deferred residual (I-1) — durable cascade dead-letter backstop

If `booking.cancel_cascade_required` permanently dead-letters (outbox retry
budget exhausted → row moved to `outbox.events_dead_letter`), the consequences
on a *cancelled* booking are: linked visitors stay `'expected'` (never
transitioned to `'cancelled'`), and the requester is never sent the
`reservation_cancelled` notification. The booking + slots + orders + OLIs +
asset_reservations + work_orders + approvals are still atomically correct (all
in the RPC's TX); only the OBX-column side effects are lost.

There is **no booking-specific backstop sweeper** for this. The generic
`outbox.events_dead_letter` table provides *visibility* (an operator/alert can
see the stuck event), but nothing automatically replays it. A cross-cutting
dead-letter backstop / replay job is **outbox/infra-workstream territory, not
booking Slice 2** — it would apply to every durable handler, not just this one.

- **Owner:** outbox/infra workstream.
- **Risk:** bounded by the outbox retry budget (§4.4 of the outbox design
  spec); after exhaustion it is unbounded until a manual dead-letter replay.
- This is an **explicit documented deferral, NOT a silent gap.** Surfacing it
  here is the deliberate choice per the no-silent-deferral rule.

## Smoke (smoke-cancel-booking.mjs) must assert every TX + OBX row above
per scope (this / this_and_following / series), plus: booking.cancelled outbox per
booking; idempotency replay (no double cascade); payload mismatch; cross-tenant
booking id; missing X-CRID; already-cancelled re-cancel short-circuit; visitor
expected→cancelled + visitor.cancelled + visitor.cascade.cancelled present;
requester reservation_cancelled notification + notification audit present;
**C-1/C-2**: a 'draft' (live-but-not-old-whitelisted) slot on every cancelled
booking transitions to cancelled; **C-2 non-pivot**: a non-pivot cancelled
series occurrence gets its own booking.cancelled emit + visitor cascade.
