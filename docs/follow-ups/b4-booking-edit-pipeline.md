# Plan B.4 — Booking edit pipeline

> **Status:** v1 spec, planning. NO code, NO migrations.
>
> **Reading order before implementation:**
> 1. CLAUDE.md "Multi-step writes are PL/pgSQL RPCs"
> 2. `docs/superpowers/specs/2026-05-04-domain-outbox-design.md` §1, §3.1, §7.6 (canonical RPC pattern)
> 3. `docs/follow-ups/b2-survey-and-design.md` §0.2 (source-of-truth invariant table — adapt for bookings)
> 4. This doc §1 + §3
>
> **Why this exists:** booking edits today silently skip every recompute that booking creates run through. The edit path writes new geometry but keeps stale cost, stale buffers, stale rule evaluation, stale approval status, and stale catering/asset/work-order linkages. This produces a class of bugs that range from cosmetic (display lies) to financial (catering routed to old room) to operational (work-orders fire for the wrong time/place).

## 0. Scope contract

**What B.4 covers.** The booking-edit pipeline. Specifically:
- `PATCH /reservations/:id` (`reservation.service.ts:editOne`)
- `PATCH /reservations/:bookingId/slots/:slotId` (`reservation.service.ts:editSlot`)
- `POST /reservations/:id/edit-scope` (`booking-flow.service.ts:editScope`)
- The atomic primitive `public.edit_booking_slot(...)` (00291) gets replaced by a richer `edit_booking(...)` RPC.

**What B.4 does NOT cover.**
- Booking creation — already shipped via `create_booking_with_attach_plan` (00309).
- Booking cancellation — Phase 6 hardening backlog.
- Visitor edits — visitor cascade trigger (existing) handles those independently.
- Recurrence series materialisation (cron job) — orthogonal.

**Architectural rule applied throughout (CLAUDE.md):**
> If a feature has to write to ≥2 tables and any partial-write state is corrupting (cross-table invariants, FK chains, audit-trail integrity), the writes go inside one PL/pgSQL function called from TypeScript — NOT a sequence of supabase-js HTTP calls in TS.

**TS keeps:** input validation, permission checks, plan assembly (load space, run rule resolver, run buffer collapse, compute cost — all read-only).
**PG owns:** advisory lock → tenant validation of every FK → state-machine check → atomic writes (slot + booking mirror + asset_reservations + orders + OLIs + work_orders + approvals reconciliation) → outbox emit → return outcome.

## 0.1 Source-of-truth contract (mirrors B.2 §0.2)

The runtime row is the source of truth post-edit. Specifically:
- `bookings.location_id` is committed at edit time and sticky. Edits to `request_type_scope_overrides` or to room config do NOT retroactively change committed booking config.
- `bookings.cost_amount_snapshot` is the price as quoted at edit time.
- `bookings.policy_snapshot` is the rule evaluation at edit time.
- `bookings.applied_rule_ids` is the set of rules in effect at edit time.

Same discipline as B.2: re-derivation in PG happens only at edit-RPC entry to validate the TS plan. After commit, all reads use the committed booking row.

## 1. Survey — what an edit changes today vs. should change

| Mutable field | Where it lives | What edits today | What B.4 should additionally update |
|---|---|---|---|
| `space_id` (slot) | `booking_slots.space_id` | Direct write in `edit_booking_slot` (00291:131-139); `bookings.location_id` mirrored only on primary-slot edit | rule re-eval, buffer recompute (new room's `setup_buffer_minutes`/`teardown_buffer_minutes`), cost recompute (new room's `cost_per_hour`), `asset_reservations` (linked window invalidates), `orders.delivery_location_id`, OLI `requested_for_start_at` (if attached_at_create_time was for this slot's window), `work_orders.planned_start_at` for setup tickets, approvals row reconciliation, calendar_etag bump |
| `start_at`/`end_at` (slot) | `booking_slots.start_at/end_at` → `bookings.start_at = MIN(slots)`, `bookings.end_at = MAX(slots)` | Direct write; mirrored | conflict-guard tstzrange re-check, `asset_reservations.start_at/end_at`, OLI `requested_for_start_at`, SLA timers on setup WOs, recurrence-series anchor |
| `attendee_count` (slot) | `booking_slots.attendee_count` | Direct write | catering pricing recompute (`computeLineTotal`), capacity rule re-check |
| `attendee_person_ids` (slot) | `booking_slots.attendee_person_ids` | Direct write | multi-attendee conflict guard, visitor cascade (already fires) |
| `host_person_id` (booking) | `bookings.host_person_id` | Direct write | notifications |
| `recurrence_overridden` | `bookings.recurrence_overridden` | Direct write in scope-edit | series projection |

**Citation:** every "What edits today" line is verified at the cited file:line in the digest above.

## 2. Bug inventory (10 — all closed by B.4)

1. **Stale cost on moved booking** — `cost_amount_snapshot` not recomputed; reports lie.
2. **Buffer leak/overlap** — old room's setup/teardown carried into new room. Conflict-guard runs against wrong window.
3. **Rule violation slips through** — capacity overflow on smaller new room; allowed-roles violated; deny rules ignored.
4. **Approval bypass** — moving from no-approval room to approval-required room leaves status=`confirmed` with no `pending_approval` row.
5. **Catering routes to old room** — `orders.delivery_location_id` stale; daglijst shows wrong drop-off; vendor delivers wrong place.
6. **Asset reservations stuck on old window** — asset double-booked or freed prematurely.
7. **Setup work-orders anchored on old time** — `planned_start_at` and SLA timers measure against old start.
8. **Recurrence-series scope edit** is bare-UPDATE across N occurrences with zero validation. One tenant can shift a 52-week series into a smaller room and break every occurrence's capacity invariant.
9. **Calendar sync drift** — `calendar_etag` not bumped; Outlook view diverges from system of record.
10. **Visibility regression on non-primary slot moves** — operators with location-scope may lose/gain access without audit trail.

## 3. Architectural shape — combined RPC `edit_booking`

**TS plan-build (read-only):**
1. Load current booking + slots + linked orders/OLIs/asset_reservations/work_orders.
2. Apply patch to compute target state.
3. Load target space (`loadSpace`).
4. Run `RuleResolverService.resolve` on target state.
5. Run `ConflictGuardService.snapshotBuffersForBooking` on target slot set.
6. Compute new cost (room hours × cost_per_hour + service-bundle re-sum via `CostService.computeBundleCost` if linked orders exist).
7. Determine new approval requirement from rule outcome.
8. Build `EditPlan` jsonb with everything needed for the atomic write.

**RPC `edit_booking(p_booking_id uuid, p_plan jsonb, p_tenant_id uuid, p_actor_user_id uuid, p_idempotency_key text)`:**

```
returns jsonb     -- { booking: row, follow_ups: [...event types emitted] }
```

**Body sketch:**
1. Advisory xact lock on `(tenant_id, booking_id)`.
2. `command_operations` idempotency gate (mirrors B.2 §3.7 — same table, sibling to `attach_operations`).
3. SELECT current booking + slots + linked rows FOR UPDATE.
4. **Tenant-validate every FK in `p_plan`** via `validate_entity_in_tenant` (B.2 §3.8). Rooms, asset ids, line items, work orders.
5. **Semantic re-derivation gate** (mirrors B.2 §3.10 step 5a) — re-run rule resolver with current data + `request_type_effective_scope_override` and assert TS plan matches; concurrent-edit handling (PG wins on `request_type_scope_overrides.updated_at > p_plan._resolution_at`).
6. **Atomic write block:**
   - UPDATE `booking_slots` (space_id, start_at, end_at, setup_buffer_minutes, teardown_buffer_minutes, attendee_count, attendee_person_ids).
   - UPDATE `bookings` (location_id mirror, start_at = MIN, end_at = MAX, cost_amount_snapshot, policy_snapshot, applied_rule_ids, status if transitioning to `pending_approval`, calendar_etag bump).
   - UPDATE `asset_reservations` (start_at, end_at) for any reservation tied to a moved/resized slot.
   - UPDATE `orders.delivery_location_id` if primary slot location changed.
   - UPDATE `order_line_items.requested_for_start_at` for lines whose anchor moved.
   - UPDATE `work_orders.planned_start_at`, `sla_due_at` for any linked setup WOs.
   - **If new approval required and no active pending row:** INSERT `approvals` row + UPDATE `bookings.status='pending_approval'`.
   - **If old approval row exists and new state doesn't require approval:** UPDATE old approval to `cancelled` with reason.
7. INSERT `audit_events` (`booking.edited`, payload includes diff).
8. INSERT `domain_events` (`booking_edited`).
9. Emit outbox events atomically:
   - `booking.location_changed` if `space_id` changed (drives notification + cache invalidation).
   - `booking.cost_changed` if cost delta non-zero.
   - `booking.approval_required` if status went to `pending_approval`.
10. UPDATE `command_operations` to outcome='success'.
11. Return `{ booking: row, follow_ups: [...] }`.

**Why one RPC, not three.** Same reasoning as B.0's `create_booking_with_attach_plan`: the partial-write hazard is real (booking row commits with new room but asset reservation still on old window → asset double-booked). All-or-nothing is the architectural rule.

## 3.1 Source-of-truth invariant table

| Reader path | Source of truth | Allowed columns | Why |
|---|---|---|---|
| §3 `edit_booking` RPC | TS-built `EditPlan` + PG re-derivation | All fields in §1 table | Single legitimate raw-config read site (semantic-mismatch gate) |
| Daglijst / catering renderer | `orders` row (committed delivery_location_id) | `delivery_location_id` | Sticky after edit |
| Calendar sync | `bookings.calendar_etag` | etag bumped on every edit | Forces Outlook re-sync |
| WO setup planner | `work_orders.planned_start_at` / `sla_due_at` | sticky after edit | Setup team gets the new time, not the old |

## 4. Migration plan

| # | File | Purpose |
|---|---|---|
| 00339 | `edit_booking_rpc.sql` | The combined RPC. Replaces 00291 `edit_booking_slot` (kept as deprecated wrapper for one cycle). |
| 00340 | `edit_booking_runbook.sql` | Cleanup runbook for any in-flight `edit_booking_slot` callers (transition window). |
| (00341 optional) | `bookings_calendar_etag_index.sql` | Performance index if queries on `calendar_etag` show up on the slow log. |

3 migrations. Deprecation of 00291's RPC is gradual: keep the function as a thin wrapper that calls `edit_booking` for one release cycle, then drop in a follow-up.

## 5. Test plan

**Mocked-jest specs** (mirror B.0.B's pattern):
- One `*.spec.ts` per RPC code path (geometry-only edit, location change, attendee resize, approval gate flip, recurrence scope, idempotency replay).
- 50-80 specs.

**Live-API smoke probe:**
- New script `pnpm smoke:edit-booking` — sibling of `smoke-work-orders.mjs`. Drives:
  - Plain time edit (no recompute beyond mirror).
  - Location change to bigger room (rules still allow).
  - Location change to smaller room (capacity rule denies → 422).
  - Location change to room with approval rule → status flips to pending_approval, approval row inserted.
  - Time change with linked catering → OLI `requested_for_start_at` updates, `delivery_location_id` updates if room changed.
  - Idempotency replay: same key → cached_result.

**Real-DB concurrency probe** (extends `apps/api/test/concurrency/`):
- Two concurrent edits on the same booking → second blocks via advisory lock, then commits or returns `cached_result` if same idempotency_key.

## 6. Estimated scope

- 1 RPC migration + tests: ~3-5 days
- TS plan-build refactor (extract reusable `assembleEditPlan` from create-flow): ~2-3 days
- Cutover of `editOne` / `editSlot` / `editScope` controllers: ~2 days
- Recurrence-scope edit (hardest case — fan-out validation): ~3-5 days
- Smoke probes + concurrency tests: ~1-2 days

**Total: 11-17 days = 2-3 weeks** for one engineer.

## 7. Sequencing

1. **B.4.A foundation.** Migration 00339 (the RPC), TS `assembleEditPlan` helper, mocked-jest specs. Cutover `editSlot` (the simplest path) only.
2. **B.4.B `editOne` cutover.** All booking-level patches now route through the combined RPC.
3. **B.4.C `editScope` cutover.** The hardest one — recurrence-series fan-out becomes a per-occurrence loop calling the RPC, with explicit failure aggregation (don't silently partial-succeed across 52 weeks).
4. **B.4.D smoke + concurrency probes.**

## 8. Dependencies on other workstreams

- **B.0 (shipped):** `create_booking_with_attach_plan` is the structural template. B.4 mirrors it.
- **B.2 (planned):** §0.2 invariant table + §3.10 semantic re-derivation gate are the pattern B.4 should follow. **B.4 should NOT start until B.2.A foundation lands** so the patterns are consistent.
- **B.0.A.0 allowlist (shipped):** new B.4 reads of `request_types.workflow_definition_id` / `sla_policy_id` (via the rule resolver chain) need triage in `apps/api/src/modules/.b2-config-reads-allowlist.txt`.

## 9. Open questions

1. **Deny on edit** — the rule resolver returns `final='deny'` for an attempted edit. Reject with 403 (no override)? Allow with `actor.has_override_rules`? Or downgrade to `draft`? Recommend mirroring CREATE: deny → 403 unless override.
2. **Approval-required on edit** — status was `confirmed`, edit puts it back to `pending_approval`. Fair to the requester? Or should we keep `confirmed` and surface a "pending re-approval" badge? Decision needed before implementation.
3. **Recurrence-scope edit failure mode** — partial success across N occurrences. Stop at first failure? Continue and aggregate? Recommend continue + aggregate; surface failures in response payload.
4. **Calendar sync** — Outlook may have cached the original event. Should the edit RPC trigger a sync push immediately, or rely on the next renew cycle? Latency impact on user.

## 10. Out of scope (deferred)

- Booking-cancellation cascade. Phase 6 hardening — bigger surface than just the cancel write.
- Multi-room booking + service attach edits. Edge case; can be Phase 6.
- Visitor pass assignment edits. Separate codebase.

---

**Status:** Spec v1 — ready for codex review. After codex pass, /full-review, then implementation per §7 sequencing.
