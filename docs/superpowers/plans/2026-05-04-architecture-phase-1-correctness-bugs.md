# Architecture Phase 1: Correctness Bugs (v3 — contract-driven)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. This is a CONTRACT plan, not a code plan: each sub-phase says WHAT to fix and WHICH FILES to read first; subagents read the real code and implement against the contract. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix four correctness bugs in booking + work-order subsystem that produce silent partial failures, identity collisions, or unintended field clears.

**Why v3:** v1 + v2 made implementation prescriptions with unverified code samples (wrong signatures, wrong types, wrong endpoint paths, wrong DI shape). After two adversarial review cycles (full-review + codex), the right format is contracts + read-first lists. Subagents read actual files and implement correctly.

**Sequence:** 1.1 → 1.4 → 1.2 → 1.3. (1.3 last because it depends on a Postgres RPC migration; 1.4 before 1.2 to avoid scheduler regression window.)

**Tech Stack:** TypeScript, NestJS (raw `BadRequestException`/`ConflictException`/etc. — `AppError` is unimplemented; Phase 7), Supabase JS client + Postgres RPCs (the only way to get multi-statement atomicity from this app), React 19 + Vite, jest (ts-jest, no DB), live-API smoke (`pnpm smoke:work-orders`).

---

## Strategic Decisions (locked)

### D1. Atomicity comes from Postgres RPCs, not app-side transactions

Supabase JS does not expose multi-statement client-side transactions. Anywhere this plan claims "atomic," the implementation is a Postgres function called via `supabase.rpc(...)`. Two new RPCs:

- **`edit_booking_slot(p_slot_id uuid, p_patch jsonb) returns jsonb`** — updates one slot + recomputes booking-level mirror columns in one tx.
- **`delete_booking_with_guard(p_booking_id uuid) returns jsonb`** — checks blockers + deletes booking + slots in one tx, returning either `{ kind: 'rolled_back' }` or `{ kind: 'partial_failure', blocked_by: [...] }`.

The existing `create_booking` RPC is the precedent — see `supabase/migrations/00277*.sql` for shape conventions and SECURITY DEFINER patterns.

### D2. Compensation contract — query inside the RPC, not from app

The blocker set must be derived from the live state of the booking inside the RPC's transaction (BEFORE the DELETE), not from app-side selects. App-side guard-then-delete is TOCTOU-prone (codex 2026-05-04). The RPC reports back its decision; the app surfaces it.

Blocker rules — discovered by Investigation Task 1.3.0; the v2 plan's list (visitors / tickets / work_orders / orders / asset_reservations / recurrence_series) is incomplete. Specifically:

- `asset_reservations` rows are soft-cancelled by `BundleService` Cleanup (status='cancelled') but `booking_id` remains. The RPC must decide whether cancelled rows count as blockers (probably not — they're tombstones) or unhook them by setting `booking_id = NULL` before delete.
- `approvals` with `target_entity_type IN ('booking', 'booking_bundle') AND target_entity_id = booking_id` are assembled by `ApprovalRoutingService` and NOT cancelled by Cleanup. The RPC must decide: cancel them, or block on them.

The RPC's contract is "do the safe thing in one tx, return a structured outcome." The Investigation Task pins down "safe thing."

### D3. editSlot mirror invariant

After updating any slot of booking B:
- `bookings.start_at = MIN(booking_slots.start_at WHERE booking_id = B)`
- `bookings.end_at = MAX(booking_slots.end_at WHERE booking_id = B)`
- `bookings.location_id` — the existing `editOne` (reservation.service.ts:635) mirrors `bookings.location_id = patch.space_id` directly (not via a `spaces.location_id` lookup). The new RPC mirrors the same way: when the **primary slot's** `space_id` changes, set `bookings.location_id = new_space_id`. "Primary" is the slot with the lowest `display_order`, ties broken by `created_at` ascending — NOT `display_order = 0`.

### D4. Error handling: NestJS exceptions with `code` field

The `AppError` system (spec 2026-05-02) is **aspirational**. No registry, no factory, no exception filter. Phase 1 emits codes inline in NestJS exception payloads, matching the existing pattern in `book-on-behalf.gate.ts:31-33`. New codes are tracked in `docs/follow-ups/phase-7-error-codes.md` for Phase 7 to register.

### D5. Phase 1 explicitly EXCLUDES

- AppError system implementation (Phase 7)
- Transition layer for case/work-order/booking/service-order (Phase 5)
- Outbox infrastructure (Phase 6 replaces 1.3's compensation RPC with a durable outbox)
- Canonical naming cleanup (Phase 8)
- Booking smoke gate (recommended follow-up)

---

## Phase 1.1 — Bug #3: Work-Order Plan Update Preserves Existing Fields

### Bug

`WorkOrderService.update`, when called with only `{ planned_duration_minutes: N }`, silently nulls the existing `planned_start_at`. Root cause: `last` is null on entry to the plan branch when no SLA patch preceded it; the fallback `(last?.planned_start_at ?? null)` becomes null; `setPlan` then forces `finalDuration = null` because start is null.

### Contract

For `WorkOrderService.update(workOrderId, dto, actor)`:

| Input dto | Existing row | Result |
|---|---|---|
| `{ planned_duration_minutes: 90 }` | `start='X', dur=30` | `start='X', dur=90` |
| `{ planned_start_at: 'Y' }` | `start='X', dur=30` | `start='Y', dur=30` |
| `{ planned_start_at: null }` | `start='X', dur=30` | `start=null, dur=null` (clearing start clears duration; existing setPlan invariant) |
| `{ planned_duration_minutes: 90 }` | `start=null, dur=null` | **400 `work_order.plan_invalid`** ("planned_duration_minutes requires planned_start_at") |
| `{ planned_start_at: null, planned_duration_minutes: 90 }` | any | **400 `work_order.plan_invalid`** |

### Read first

- `apps/api/src/modules/work-orders/work-order.service.ts` — read the full `update` method body and the `setPlan` method. Confirm the constructor's exact arg list (codex 2026-05-04: it's 3 args `(supabase, slaService, visibility)`, not 4).
- `apps/api/src/modules/work-orders/work-order.service.ts` — find `present` helper (around line 174–176) and reuse.
- One existing spec to model: `apps/api/src/modules/work-orders/work-order-set-plan.spec.ts` for fixture shape and `apps/api/src/modules/work-orders/work-order-can-plan.spec.ts` for collaborator-mock pattern.
- `apps/api/src/common/tenant-context.ts` for `TenantContext.current()` shape.

### Implementation contract

1. Before the plan branch runs (or at the head of the plan branch when `last` is null), load `{ planned_start_at, planned_duration_minutes }` for the work order using the SAME tenant-scoped query pattern other methods in the file use.
2. For each plan field, write `presentInDto ? dto.value : current.value`. Both fields are nullable; `undefined` means "not present in dto," `null` means "explicit clear."
3. Validate: if final `duration !== null && start === null`, throw `BadRequestException` with `code: 'work_order.plan_invalid'`.
4. Call `setPlan(workOrderId, finalStart, finalDuration, actorAuthUid)` — preserve its existing semantics.

### Tests (TDD)

Create `apps/api/src/modules/work-orders/work-order-update-plan.spec.ts` BEFORE editing the service. Test cases (one `it` per row of the contract table). Use the constructor signature from the codebase (read first). Mock `setPlan` so tests assert what the merge logic decided to call it with.

### Smoke probes

The smoke script structure (codex 2026-05-04):
- `probe()` is returned by `makeProber()` at `apps/api/scripts/smoke-work-orders.mjs:122`.
- There is no `ADMIN_JWT` global; auth is established differently (read the file).
- Work-order rows are read via `GET /api/tickets/:id`, not `/api/work-orders/:id` (read the existing 'WO: planned_start_at +1d' probe and its surrounding `getRow` for the actual pattern).

Add four probes after the existing plan probe, each using the existing pattern in the file:

1. `WO: plan set start+duration` — patch both, assert 200.
2. `WO: plan patch duration only preserves start` — patch only `planned_duration_minutes: 90`; re-read; assert `planned_start_at` unchanged AND `planned_duration_minutes === 90`.
3. `WO: plan patch start only preserves duration` — patch only `planned_start_at: <new>`; re-read; assert `planned_duration_minutes` unchanged.
4. `WO: plan patch null start clears both` — patch `planned_start_at: null`; re-read; assert both null.
5. `WO: duration without start rejected` — on a fresh WO with no plan, patch `planned_duration_minutes: 90`; assert 400 with `code: 'work_order.plan_invalid'`.

If `probe()` doesn't already support a post-200 assertion hook, extend `makeProber` minimally — but read its actual structure first; don't invent.

### Done when

- 5/5 jest specs pass; 4 new smoke probes pass with `pnpm dev` running.
- One commit: `fix(work-orders): preserve plan fields on partial update; reject duration without start`.

---

## Phase 1.4 — Bug #2: Slot-First Scheduler

### Bug

The scheduler PATCHes `/api/reservations/:id` with `id = booking.id`. The backend `editOne` only edits the primary slot of a multi-room booking. Dragging row B (non-primary) silently moves the primary instead. Frontend uses `reservation.id` (booking id) as the React key, drag-source identity, and several other comparisons — not just `key=` props.

### Contract

**Backend:**
- New endpoint `PATCH /api/reservations/:bookingId/slots/:slotId` accepting `{ space_id?, start_at?, end_at? }`.
- The handler asserts `slot.booking_id === bookingId` (URL contract honesty; codex 2026-05-04 #16). On mismatch: 400 `booking_slot.url_mismatch`.
- Auth via the existing pattern from `editOne`: `loadContextByUserId(actor.user_id, tenantId)` → `findByIdOrThrow(bookingId, tenantId)` → `assertVisible(reservation, ctx)` → `if (!canEdit(reservation, ctx)) throw ForbiddenException`. (Codex 2026-05-04: `findByIdOrThrow` takes 2 args, not 1.)
- Slot update + booking-mirror recompute happen in ONE Postgres transaction via the new RPC `edit_booking_slot`.
- Returns the projected `Reservation` for the edited slot (use existing projection helpers — read `reservation-projection.ts` to find the right export name; codex 2026-05-04: `slotWithBookingToReservation` takes ONE joined row, not two).

**RPC `edit_booking_slot(p_slot_id uuid, p_patch jsonb) returns jsonb`:**
- SECURITY DEFINER, tenant_id checked from session via `current_setting('app.tenant_id')` or whatever convention `create_booking` uses (read 00277).
- Validates the slot exists in the caller's tenant; raises a structured exception (matching the project's existing RPC error pattern) on missing.
- Updates `booking_slots` for the given slot id with the columns present in `p_patch`. Preserves existing `effective_start_at`/`effective_end_at` trigger behavior.
- After the slot update, recomputes for the parent booking:
  - `bookings.start_at = MIN(start_at)` across all slots of that booking
  - `bookings.end_at = MAX(end_at)` across all slots of that booking
  - `bookings.location_id` only when the edited slot is **primary** (lowest `display_order` then `created_at`) AND the patch included `space_id`. Set `bookings.location_id = (p_patch->>'space_id')::uuid`.
- On GiST exclusion conflict, raise the existing structured error the codebase recognises (`23P01` SQLSTATE) so the controller can map it to `ConflictException` with `code: 'booking.slot_conflict'`.
- Returns `{ slot_id, booking_id, ... }` enough for the controller to project and respond.

**Frontend:**
- Drag/resize/move now send `slotId` (and `bookingId` for the URL) to a new `useEditBookingSlot` mutation.
- Row keys, drag-source comparisons, optimistic update keys, cache invalidation: ALL switch from `reservation.id` to `slot_id`. Codex flagged that JSX keys are only one of several places — `findSpaceForReservation` and others compare `reservation.id`.
- Existing `PATCH /reservations/:id` (`useEditBooking`) remains for booking-level edits only (host_person_id, attendee_count, etc. — anything that's not slot geometry). Document this in code comments at both call sites so the line stays clean.

### Read first

- `apps/api/src/modules/reservations/reservation.service.ts` — read `editOne` (around 604–699). Note exact: visibility pattern, mirror behavior, return type (`Reservation`).
- `apps/api/src/modules/reservations/reservation-projection.ts` — exported helpers; current `slot_id` emission.
- `apps/api/src/modules/reservations/reservation-visibility.service.ts` — `loadContextByUserId`, `assertVisible`, `canEdit` signatures.
- `apps/api/src/modules/reservations/reservation.controller.ts` — `actorFromRequest` and the `editOne` route shape.
- `apps/api/src/modules/reservations/reservations.module.ts` — providers.
- `supabase/migrations/00277_create_canonical_booking_schema.sql` — booking_slots table + `create_booking` RPC for the SECURITY DEFINER pattern.
- `apps/web/src/lib/api.ts` — `apiFetch` already prepends `/api` (codex 2026-05-04). Use relative paths.
- `apps/web/src/api/room-booking/keys.ts` — query keys: `schedulerWindow(input)`, `schedulerData(input)` (NOT `scheduler()`).
- `apps/web/src/api/room-booking/types.ts` — `Reservation` type. Has `id` and `slot_id` but NO `booking_id` (codex 2026-05-04). If 1.2's plan needs a `booking_id` field, add it to the projection AND the type in 1.4 to avoid frontend compile errors later.
- `apps/web/src/api/room-booking/mutations.ts` — pattern of existing `useEditBooking` (uses `JSON.stringify(body)` per codex). No `withErrorHandling` exists in `apps/web/src` (codex 2026-05-04) — use the existing toast helpers from `apps/web/src/lib/toast.ts` per CLAUDE.md.
- `apps/web/src/pages/desk/scheduler/hooks/use-drag-move.ts` — `MoveState` lives here.
- `apps/web/src/pages/desk/scheduler/hooks/use-drag-resize.ts` — `ResizeState` lives here.
- `apps/web/src/pages/desk/scheduler/components/scheduler-grid-row.tsx` — find every `reservation.id` reference (line 415 et al per codex).
- `apps/web/src/pages/desk/scheduler/index.tsx` — `findSpaceForReservation` (line 835 per codex), drag/resize handlers, `persistEdit`.

### Migration

Add `supabase/migrations/00284_edit_booking_slot_rpc.sql` (or next sequential number — verify against `ls supabase/migrations/`):
- Defines `public.edit_booking_slot(p_slot_id uuid, p_patch jsonb) returns jsonb`.
- Mirrors the SECURITY DEFINER + tenant-check pattern of `create_booking` in 00277.
- Apply via psql (fallback path documented in `.claude/CLAUDE.md`); user has standing DB-push authorization for booking-modal-redesign workstream and this is contiguous (use that authorization).

### Tests (TDD)

- `apps/api/src/modules/reservations/reservation-edit-slot.spec.ts` — mock `supabase.rpc` to return success/conflict/not-found. Three scenarios: happy path (assert RPC called with correct args), conflict (23P01 → `ConflictException` with `code: 'booking.slot_conflict'`), not-found (RPC returns no row → `NotFoundException` with `code: 'booking_slot.not_found'`). Add a fourth: `bookingId` in URL doesn't match `slot.booking_id` → 400 `booking_slot.url_mismatch`.
- Frontend: at minimum, `pnpm tsc --noEmit` must pass after the rewire. Manual smoke (with `pnpm dev`): drag a non-primary slot of a multi-room booking; confirm via Network tab the PATCH hits `/api/reservations/<bookingId>/slots/<slotId>` and only that slot moves.

### Done when

- RPC migration applied to remote (verified by querying `select 1 from pg_proc where proname = 'edit_booking_slot'`).
- All jest specs pass.
- `pnpm tsc --noEmit` clean for both apps.
- Manual scheduler smoke confirms non-primary slot edit works.
- `docs/assignments-routing-fulfillment.md` updated with the slot-first identity rule + mirror invariant.
- `docs/visibility.md` updated with the slot-vs-booking-visibility note.
- One or two commits (RPC migration + service+controller+frontend can be one; docs another).

---

## Phase 1.2 — Bug #4: Pagination Identity Fix

### Bug

`listMine` orders by `start_at, booking_slots.id` but the projection sets `id = booking.id`. Cursor encodes `start_at__booking.id`. Filter `id.gt.<booking.id>` runs against `booking_slots.id`. Type/domain mismatch → multi-room bookings can be skipped or duplicated.

### Contract

- Cursor encodes `start_at__slot.id`. Filter compares against `booking_slots.id` (matches the ORDER BY column).
- The projection emits BOTH `id` (booking id; existing) AND `slot_id` (slot id; existing per `reservation-projection.ts:78`).
- The frontend `Reservation` type ALSO carries `booking_id` from now on (currently has only `id` and `slot_id` per codex). Add it to both the API projection and the TS type so list consumers can dedup.
- `listMine` returns `{ items, next_cursor }` (NOT `{ rows }` per codex). Tests must use the real shape.
- `listMine` signature is `listMine(authUid, opts)` — first arg is the auth uid (codex), not just `opts`. Tests must use the real call.

### Read first

- `apps/api/src/modules/reservations/reservation.service.ts` lines 170–260 — actual `listMine` shape.
- `apps/api/src/modules/reservations/reservation-projection.ts` — full file. Add `booking_id` to the projected row alongside the existing `id` (= booking.id) and `slot_id`.
- `apps/web/src/api/room-booking/types.ts` — current `Reservation` type. Add `booking_id` field.
- Any consumer of the list endpoint — find them via `grep -rn "useBookingsList\|listMine" apps/web/src` then inspect each.

### Implementation

1. Add `booking_id` to projection + type.
2. Switch cursor encoding to `start_at__slot.id`. Filter `id.gt.<cursorSlotId>` (the `id` column in the SQL refers to `booking_slots.id` because `listMine` queries that table).
3. For each frontend list consumer, decide:
   - **Per-slot rows (scheduler etc.)**: React key = `slot_id`. No dedup.
   - **Per-booking cards (`/desk/bookings`, command palette, reports)**: dedup by `booking_id`. React key after dedup = `booking_id`.
4. Document each consumer's decision in the commit message body (1 line each).

### Tests (TDD)

`apps/api/src/modules/reservations/reservation-list-pagination.spec.ts`:
- Multi-room booking with 3 slots A/B/C, all sharing one `booking_id`. Slots have distinct ids and identical `start_at` to exercise tie-breaking.
- `listMine(authUid, { limit: 2 })` returns 2 items + `next_cursor`.
- `listMine(authUid, { limit: 2, cursor })` returns 1 item, no `next_cursor`.
- The 3 slot ids across both pages form a deduplicated set of size 3 (no duplicates, no skips).

Use the actual return shape `{ items, next_cursor }`.

### Done when

- jest specs pass.
- `pnpm tsc --noEmit` clean (after frontend type update).
- Commit message lists each consumer's dedup decision.

---

## Phase 1.3 — Bug #1: Atomic Booking + Service via RPC + Boundary

### Bug

`BookingFlowService.create` runs `create_booking` RPC (atomic for booking+slots), then calls `BundleService.attachServicesToBooking` (sequential app-side calls). On service-attach failure, services roll back via Cleanup but the booking persists. User sees an error response while the room is silently reserved.

### Investigation Task 1.3.0 (BLOCKING — must run before 1.3.1)

Dispatch a subagent (Explore-type) to map the post-`create_booking`-RPC state when `attachServicesToBooking` fails. Specifically:

1. Read `apps/api/src/modules/booking-bundles/bundle.service.ts:160-1900` (full).
2. List every row that `attachServicesToBooking` writes that references `booking_id = <new booking>`. For each: write path, what Cleanup does on rollback (delete? soft-cancel? leave?), and the FK ON DELETE clause from migration 00278.
3. Specifically pin down:
   - `asset_reservations`: Cleanup soft-cancels (status='cancelled') but leaves `booking_id`. Should the compensation RPC delete these tombstones, set `booking_id = NULL`, or treat them as blockers?
   - `approvals` against booking: assembled by `ApprovalRoutingService` (cited in bundle.service.ts:340). Cleanup does NOT cancel them (cited in bundle.service.ts:1940). What does the compensation do — cancel them in the same tx, or block?
   - `audit_events` / `audit_outbox` rows referencing the booking: append-only; do they need cleanup or are they fine as orphans?
   - `setup_work_order_trigger` side effects: only fire AFTER `cleanup.commit()` (bundle.service.ts:375-456); confirm none can land before the failure point.
4. Return a digest in this format: `{ table, written_when, references_booking_via, cleanup_behavior, fk_on_delete, compensation_decision: 'delete' | 'unhook' | 'block' | 'leave' }` for each.

The compensation RPC is then designed against this digest. Do not skip 1.3.0 — guessing the blocker set is what made v2 wrong.

### Contract

After 1.3.0 returns:

**RPC `delete_booking_with_guard(p_booking_id uuid) returns jsonb`:**
- SECURITY DEFINER, tenant-scoped.
- Inside one transaction:
  1. SELECT FOR UPDATE the booking row (so concurrent inserts that reference this booking are serialized against it).
  2. For each blocker class from 1.3.0's `block` decisions: count rows. If any > 0, abort with structured `partial_failure` outcome.
  3. For each `unhook` class: `UPDATE table SET booking_id = NULL WHERE booking_id = p_booking_id`.
  4. For each `delete` class: `DELETE FROM table WHERE booking_id = p_booking_id`.
  5. `DELETE FROM bookings WHERE id = p_booking_id` (cascades to `booking_slots` per 00277:119).
- Returns `jsonb`: `{ kind: 'rolled_back' }` or `{ kind: 'partial_failure', blocked_by: ['table1', 'table2', ...] }`.

**`BookingTransactionBoundary` interface (TS):**
- One method: `runWithCompensation<T>(bookingId, operation, compensate): Promise<T>`.
- In-process impl: try operation; on throw, call compensate(bookingId); if outcome is `rolled_back`, re-throw original; if `partial_failure`, throw `BadRequestException({ code: 'booking.partial_failure', booking_id, blocked_by, original_error })`.

**`BookingCompensationService`:**
- One method: `deleteBooking(bookingId): Promise<CompensationOutcome>` — calls the RPC, surfaces the structured outcome.
- Constructor param: inject `SupabaseService` directly (codex 2026-05-04: `{ admin: SupabaseClient }` won't be DI-resolvable).

**Wiring:**
- `BookingFlowService.create`: wrap the `attachServicesToBooking` call in `txBoundary.runWithCompensation(booking.id, op, compensate)` ONLY when `input.services?.length > 0`.
- `MultiRoomBookingService`: same.
- `attachServicesToBooking` arg shape (codex / verification 2026-05-04): `{ booking_id, requester_person_id, bundle?, services }`. Use exactly that.

### Read first

- Output of Investigation Task 1.3.0.
- `apps/api/src/modules/reservations/booking-flow.service.ts:357-400` — current service-attach call site.
- `apps/api/src/modules/reservations/multi-room-booking.service.ts:262-300` — the multi-room variant.
- `apps/api/src/modules/booking-bundles/bundle.service.ts:58` — `AttachServicesArgs` interface.
- `apps/api/src/modules/reservations/reservations.module.ts` — provider list.
- `apps/api/src/common/supabase/supabase.service.ts` (or wherever the `SupabaseService` lives — find it; the existing services inject this for Nest DI).
- `supabase/migrations/00277*.sql` — RPC convention.
- Migration 00278 — FK ON DELETE clauses on `bookings.id`-referencing tables (already verified: visitors CASCADE; tickets/work_orders/orders/asset_reservations SET NULL; recurrence_series NO ACTION).

### Migration

Add `supabase/migrations/0028N_delete_booking_with_guard_rpc.sql` (next sequential — verify with `ls`). Apply via psql per `.claude/CLAUDE.md` fallback. Verify with `select 1 from pg_proc where proname = 'delete_booking_with_guard';`.

### Tests (TDD)

- `apps/api/src/modules/reservations/booking-compensation.service.spec.ts` — mock `supabase.rpc` to return each outcome shape; assert the service forwards it correctly.
- `apps/api/src/modules/reservations/booking-flow-atomicity.spec.ts` — three scenarios:
  1. Service-attach fails, RPC returns `rolled_back` → original error re-thrown, no `partial_failure`.
  2. Service-attach fails, RPC returns `partial_failure` → `BadRequestException` with `code: 'booking.partial_failure'`, includes `booking_id` and `blocked_by`.
  3. Empty services array → neither `attachServicesToBooking` nor compensation invoked.

Mock-level integration. The actual cascade behavior of the RPC is verified by a manual smoke probe, NOT a jest spec (jest can't simulate FK semantics).

### Manual smoke

Add to `docs/follow-ups/phase-1-booking-smoke.md` (created in Task 1.W.3):

```
1. With dev server up, POST /api/reservations with services: [{ ...invalid asset id }].
2. Expect 4xx response.
3. psql: select id from bookings where created_at > now() - interval '1 minute' order by created_at desc limit 1;
4. Expect: 0 rows (RPC rolled back).
5. Repeat with valid services payload (success) — booking should exist.
```

### Done when

- 1.3.0 digest doc committed at `docs/follow-ups/phase-1-3-blocker-map.md`.
- RPC migration applied to remote.
- jest specs pass.
- Manual smoke confirms cascade.
- Commit messages cite 1.3.0 digest for the compensation-decision rationale.

---

## Phase 1 wrap-up

### Task 1.W.1: Smoke gate

- Start `pnpm dev`.
- Run `pnpm smoke:work-orders` — exit 0, all probes pass.
- Run the manual booking-compensation smoke from 1.3.

### Task 1.W.2: Full test sweep

- `cd apps/api && pnpm jest` — all green.
- `cd apps/web && pnpm tsc --noEmit` — no errors.
- `cd apps/web && pnpm test` — all green. Do NOT mask exit codes (`2>/dev/null || true` is forbidden).

### Task 1.W.3: Phase-7 follow-up doc

Create `docs/follow-ups/phase-7-error-codes.md` with the codes Phase 1 introduced, the throw site, and the recommended `class` for the future registry:

| Code | Class | Source |
|---|---|---|
| `work_order.plan_invalid` | validation | `work-order.service.ts` |
| `booking.slot_conflict` | conflict | `reservation.service.ts editSlot path` |
| `booking_slot.not_found` | not_found | `reservation.service.ts editSlot, controller` |
| `booking_slot.url_mismatch` | validation | `reservation.controller.ts editSlot route` |
| `booking.edit_forbidden` | permission | `reservation.service.ts editSlot` |
| `booking.partial_failure` | server | `InProcessBookingTransactionBoundary` |

### Task 1.W.4: Documentation pass

- `docs/assignments-routing-fulfillment.md` — slot-first identity rule, mirror invariant, plan-merge invariant for work_orders, compensation RPC contract.
- `docs/visibility.md` — slot-vs-booking-visibility note.
- `AGENTS.md` — note that booking-compensation manual smoke is part of Phase 1.3 done-criteria; not a new gate.

### Task 1.W.5: Self-review

Re-read the plan. Confirm:
- No literal code snippets that weren't verified against the codebase by an Explore subagent.
- Function names consistent across tasks.
- No claim of atomicity that isn't backed by an RPC.
- All file paths used as `Read first` confirmed via codex/Explore findings.

### Task 1.W.6: Open review gates

After all sub-phases committed:
- Run `/full-review` on the branch.
- Run codex on plan + diffs.
- Fold mandatory findings; defer optional findings to a follow-up doc.

---

## What's NOT in Phase 1 (re-stated)

- **Phase 5:** Transition layer (case/work-order/booking/service-order). Pattern: model after `VisitorService.transitionStatus`. Separate spec.
- **Phase 6:** Durable side-effect outbox for booking lifecycle. Replaces `InProcessBookingTransactionBoundary` impl with an outbox-driven runner; the interface stays so call sites don't change.
- **Phase 7:** Implement the `AppError` system per `docs/superpowers/specs/2026-05-02-error-handling-system-design.md`. Migrate ~374 raw NestJS throws across touched modules. Register Phase 1's codes from `docs/follow-ups/phase-7-error-codes.md`.
- **Phase 8:** Canonical naming cleanup (`reservation` → `booking_slot` in API contracts and frontend). Mostly renames + audit-event consistency.
