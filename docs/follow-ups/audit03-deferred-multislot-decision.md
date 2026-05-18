# audit-03 Slice 3 — P0-2 multi-slot linked-row residual (DECISION: Path B; Path A → D-11)

Date: 2026-05-18
Slice: audit-03 Slice 3 (deferred-finding closeout)
Status: **CLOSED for the residual *as a silent gap*** (durable skip signal + fail-closed safety smoke). The propagation gap itself (Path A) is **deferred-with-owner as discovered finding D-11** — it is not closeout-scope.

---

## 1. Finding (the Slice-1 deferred residual)

Slice 1 (2026-05-16) closed P0-2 (`AssembleEditPlanService` always emitted
empty linked-row patches) for SINGLE-slot bookings via the new
`buildLinkedRowPatches`, and explicitly **deferred** the multi-slot case:
for a booking with >1 `booking_slots`, `buildLinkedRowPatches` returns
empty patch arrays + `skippedMultiSlot:true` and logs `this.log.warn`
(`[I-1]`), because the children (`orders` / `asset_reservations` /
`work_orders`) key ONLY off `booking_id` with no slot/space attribution
column (`00278:108-144`) — a booking-level child cannot be safely
attributed to one moved slot.

The Slice-1 ledger row recorded the candidate fix as *"uniform-delta
propagation for whole-booking moves (pending codex direction)"*.

## 2. Premise falsification (the SHARPER truth — verified against code)

The Slice-1 candidate fix's premise — *"just propagate uniformly for a
whole-booking move"* — is **false today**, and the reason is deeper than
"children key per-booking":

- `editOne` is itself **under-defined for a multi-slot booking**. It
  resolves and patches only the **PRIMARY slot**
  (`reservation.service.ts` — primary-slot resolution + `assembleEditPlan
  kind:'one'` on that one slot). The other slots are untouched.
- The `edit_booking` v5 RPC writes `bookings.start_at` / `bookings.end_at`
  **straight from the booking patch** (`00394:634-635, :718-721`) — there
  is **NO MIN/MAX over `booking_slots`**.
- The assembler defers the multi-slot booking-envelope MIN/MAX to a
  **non-existent "Step 2F"** (`assemble-edit-plan.service.ts` ~:776-783 /
  :839-840 comments: *"For multi-slot bookings, Step 2F will compute
  MIN/MAX"* — Step 2F is unbuilt).
- `editSlot` moves exactly one slot. `editScope` **cannot time-shift**
  (gate A rejects `start_at`/`end_at` → 422).

⇒ **No edit kind today produces a uniform whole-booking move of a
multi-slot booking.** An `editOne` of a 2-slot booking *half-moves* it:
the primary slot + the booking envelope move; the non-primary slot stays;
the booking envelope is now **inconsistent with its own slots BEFORE
linked rows even enter the picture**. Generalizing linked-row
propagation now would shift the caterer/setup children to a window the
*other* slots never moved to — **strictly worse than the documented
skip** (it would manufacture a false consistency the booking itself does
not have).

This is recorded as discovered finding **D-11** (§5).

## 3. Why Path B, not Path A

**Path A** = generalize linked-row propagation for multi-slot bookings.
That requires FIRST redefining multi-room `editOne` semantics (block the
edit? true whole-booking move with envelope MIN/MAX over all slots?) AND
resolving an unresolved sub-decision: with N slots that can match
different rules, **which slot drives `newOutcome` / approval / cost /
`recurrence_overridden`?** That is an **unspecced redesign of a CLOSED,
smoke-gated core path** (the `edit_booking` family, P0-1/P0-2/P0-3
closed + gated). It is squarely **out of deferred-finding closeout
scope** — the audit's own norm for exactly this situation is
*defer-with-owner* (cf. P2-3 deferred-with-rationale, D-5/D-6
bundled-owner, D-10 deferred-with-owner).

**Path B** (this slice) = make the skip **NON-SILENT and provably
non-corrupting**, and hand Path A to a future owner with the prerequisite
written down. This is the honest best-in-class end state for a closeout
slice: the gap is bounded, observable, queryable, and proven to not
silently corrupt data — without unilaterally redesigning a closed core
path on an unverified premise (the exact class of error the D-5
misdiagnosis burned this audit on).

## 4. Chosen mechanism — (a) durable tenant-scoped `audit_events` row

Two candidates were on the table:

- **(a) PREFERRED — a durable best-effort tenant-scoped `audit_events`
  row** emitted from the TS edit path on the multi-slot-skip branch.
- (b) fallback — keep/strengthen the structured `this.log.warn` and let
  the live smoke + ledger be the only non-silent record.

**Chosen: (a).** Rationale:

- A no-migration `audit_events` write path **already exists and is the
  codebase canon**. The exact in-service post-commit best-effort pattern
  was mirrored from `ReservationService` (the `booking.restored` insert
  on the `restoreOccurrence` path): `await this.supabase.admin.from(
  'audit_events').insert({ tenant_id, event_type, entity_type,
  entity_id, details })` wrapped in `try/catch` that swallows on failure.
  (Same shape used by `booking-flow.service.ts`'s private `audit(...)`
  and ~20 other in-service writers; table exists since `00019`.)
- It is **durable + queryable** (`SELECT … WHERE event_type =
  'booking.linked_rows_not_propagated'`) — a real triage surface for
  *"which multi-room-with-services bookings had a time edit whose caterer
  daglijst / setup WO is now diverged"*. The `log.warn` is retained as
  defense-in-depth (and a fallback if the insert itself fails).
- **`tenant_id` is the #0 rule** — every write is tenant-scoped. The
  actor is recorded in the jsonb `details.actor_user_id` (NOT the uuid
  `actor_user_id` column) because synthetic actors carry a non-uuid
  `system:*` sentinel (the D-8 class) and `details` is jsonb with no uuid
  constraint — the `restored_by` precedent.
- **Best-effort + post-commit + awaited**: the row is emitted AFTER the
  `edit_booking` RPC commits and AFTER the visitor-cascade block.
  `recordMultiSlotLinkedRowSkip` swallows its own failures and never
  throws — it can never block or roll back the already-committed edit. It
  is `await`ed (not fire-and-forget) ONLY so the live smoke can read the
  row deterministically.

Mechanism (b) was rejected: a no-migration `audit_events` path exists, so
the brief mandates (a). (b) would have left the durable record as
deferred Path-A work — unnecessary here.

### Why NOT `warnings[]` / a success-path error code

A response `warnings[]` field or a success-path `error-codes.ts` entry is
**SPEC-ILLEGAL** per `docs/superpowers/specs/2026-05-02-error-handling-
system-design.md`: it specifies a CLOSED RFC-9457 wire shape, a CLOSED
surface enum, and an exhaustive 11-class taxonomy, and explicitly forbids
inventing a new surface or a success-path error. The durable
`audit_events` row is the codebase's canonical *"this happened, it's
queryable, it never blocks the operation"* mechanism — it touches
neither the wire shape nor the error taxonomy.

### Why NO migration / NO RPC change / NO wire change

- The v5 RPC child loops are slot-agnostic (id/tenant/booking-keyed) — a
  producer/service-side fix needs **no migration** and **no RPC change**.
- The skip flag is threaded as a **SERVER-INTERNAL** `_`-prefixed marker
  (`EditPlan._skipped_multi_slot_linked_rows`, set by `buildSingleSlotPlan`
  — pre-fix the flag was DROPPED there; only the 3 patch arrays were
  destructured). It is **STRIPPED by the service at the producer→RPC
  boundary** (`ReservationService.stripInternalMarkers`, applied at every
  `edit_booking` / `edit_booking_scope` call site) so it **never reaches
  the wire, the RPC, or the `command_operations` idempotency md5**. This
  is load-bearing: the hash strip helper (`booking_edit_strip_hash_
  server_fields`, 00407/00430) removes ONLY the 3 enumerated names
  (`_resolution_at`, `old_outcome`, `chain_config_changed`) — it would
  **NOT** remove this marker, so leaving it on the payload would corrupt
  the idempotency hash. Stripping at the service boundary closes that
  risk by construction. `assemble-edit-plan.idempotency.spec.ts` GUARD-2
  was annotated with an explicit EXEMPTION note explaining why this
  `_`-prefixed field is correctly absent from the SQL strip set.

## 5. Discovered finding D-11 (deferred-with-owner)

**D-11 — `editOne` half-moves a multi-room booking (primary slot only),
leaving the other slots + the booking envelope inconsistent.**
Pre-existing; **NOT introduced here** (it is the unbuilt-"Step 2F"
reality verified in §2). `editOne` on a >1-slot booking moves the primary
slot + writes `bookings.start_at/end_at` from the booking patch (no
MIN/MAX over slots), leaving non-primary slots at the old window and the
booking envelope inconsistent with its own slots — *before* linked rows
matter.

- **Owner:** a future booking-audit multi-slot-edit-semantics slice.
- **Prerequisite:** define multi-room `editOne` semantics (block the edit
  vs. a true whole-booking move with envelope MIN/MAX over all slots),
  AND resolve which slot drives `newOutcome` / approval / cost /
  `recurrence_overridden` when slots match different rules. Only after
  that is Path A (generalized linked-row propagation) well-defined.
- **Risk:** multi-room-with-services time edits leave the caterer
  daglijst / setup work_orders diverged from the moved primary slot until
  the semantics slice ships — **now MITIGATED**: the divergence is no
  longer silent (a queryable `booking.linked_rows_not_propagated`
  audit_events row per occurrence) and the safety smoke proves there is
  **no silent corruption** (children are left exactly at seed, not
  shifted to a phantom window).

## 6. What shipped

**Code**

- `apps/api/src/modules/reservations/edit-plan.types.ts` — added
  SERVER-INTERNAL `EditPlan._skipped_multi_slot_linked_rows?: boolean`
  (documented: never sent to the RPC).
- `apps/api/src/modules/reservations/assemble-edit-plan.service.ts` —
  `buildSingleSlotPlan` now propagates `linked.skippedMultiSlot` onto the
  plan (set ONLY when true; pre-fix it was DROPPED at this call site).
- `apps/api/src/modules/reservations/reservation.service.ts` — new
  `recordMultiSlotLinkedRowSkip` (durable best-effort tenant-scoped
  `audit_events` insert, mirroring the in-service `booking.restored`
  pattern) + `stripInternalMarkers` (wire-strip); wired into `editOne`
  (post-commit emit + strip), `editSlot` (post-commit emit + strip), and
  `editScope` (strip only — scope cannot time-shift, so no daglijst
  divergence ⇒ no audit row on that path; the strip is the load-bearing
  part: keep the marker off the scope RPC wire/hash).

**Tests**

- `apps/api/src/modules/reservations/assemble-edit-plan.linked-rows.spec.ts`
  — NEW describe block: drives the REAL `buildSingleSlotPlan` end-to-end
  for a >1-slot booking and asserts the marker is set + 3 patch arrays
  empty (caller no longer drops the flag); single-slot ⇒ marker absent.
  The existing direct-`buildLinkedRowPatches` multi-slot test is
  UNCHANGED (not weakened).
- `apps/api/src/modules/reservations/reservation-edit-slot.spec.ts` — NEW
  tests: (a) multi-slot skip ⇒ marker STRIPPED off the RPC payload AND a
  durable tenant-scoped `audit_events` row emitted with
  `{reason, edit_kind, slot_count, actor_user_id}`; (b) negative — no
  such row on a normal single-slot edit. Existing tests unchanged.
- `apps/api/src/modules/reservations/assemble-edit-plan.idempotency.spec.ts`
  — GUARD-2 annotated with the EXEMPTION note (no assertion change; all
  guards still pass).

**Live smoke** (`apps/api/scripts/smoke-edit-booking.mjs`)

- Fixture D (existing single-slot linked-row propagation) UNCHANGED —
  regression preserved, not weakened.
- NEW **Fixture E** (2-slot booking + 1 catering order + 1 boundary-
  aligned asset_reservation + 1 custom-window asset_reservation + 1 setup
  work_order; `session_replication_role='replica'`; +135d future;
  multi-session-safe keyed to the seeded booking_id) + `runFixtureEProbe`.
  editOne window-shift it, then assert (post-edit DB reads, epoch
  compare, NOT http-200-only): (i) ALL children + the non-primary slot
  UNCHANGED vs seed (no silent corruption); (ii) exactly one durable
  tenant-scoped `booking.linked_rows_not_propagated` audit row with the
  expected details; (iii) clean 2xx + NO invented wire field. Cleanup
  mirrors Fixture D (generic booking_id-keyed `deleteFixtures` sweep).
  `docs/smoke-gates.md` updated.

**Validation** (orchestrator runs the live smoke in the batch pass)

- `pnpm -s --filter @prequest/api exec tsc --noEmit` → exit 0.
- `pnpm -s --filter @prequest/api exec jest src/modules/reservations` →
  4 failed / 268 passed; all 4 failures are the pre-existing
  `reservation-edit-scope.spec.ts` (B.4 Step 2F.3 splitSeries/editScope)
  defect, provably on pristine origin/main (this branch does not modify
  that spec; origin/main already contains the failing assertion with 0
  conflict markers). Every new/edited spec in this slice passes.
- `pnpm -s errors:check-app-errors` → exit 0 (0 raw throws / 35 modules).
