# Slice 5 — `attach_services_to_existing_booking` (audit 03 P1-3) — decision + HONEST partial-close

Status: **PARTIAL — code-complete + verified; live smoke gate + 2-agent full-review PENDING.**
This is the one booking-audit slice that ships at commit time WITHOUT its live smoke
gate. That is stated plainly here and in the audit ledgers — it is a tracked,
risk-disclosed deferral, NOT a silent gap and NOT a faked/constructed-to-pass gate
(the dishonest-fixture anti-pattern this audit exists to kill).

## What shipped (verified directly by the orchestrator, 2026-05-17)

- `supabase/migrations/00412_attach_services_to_existing_booking_rpc.sql` on remote
  (`pg_get_functiondef` confirmed). The RPC = the LIVE `create_booking_with_attach_plan`
  attach-half (INSERT orders / asset_reservations / order_line_items / approvals +
  `setup_work_order.create_required` outbox emit guarded by `NOT any_pending_approval`)
  WITHOUT the booking/booking_slots INSERTs (the booking already exists). Idempotent via
  the `attach_operations` table (attach-family, like create) + advisory lock; atomic
  (single PL/pgSQL tx); `security definer`; revoke-public / grant-service_role.
- `bundle.service.ts` `attachServicesToBooking` → thin RPC wrapper (builds the plan via
  the existing pure `buildAttachPlan`, mints `buildAttachServicesIdempotencyKey`, calls
  the RPC, maps `attach_services_to_existing_booking.*` errors). The legacy non-atomic
  N-write path + the TS `Cleanup` undo-queue class are **deleted** (repo-verified no
  other caller; `StandaloneCleanup` in `order.service.ts` is a DIFFERENT, unrelated
  class — untouched). Dead post-cutover private helpers `createOrder` / `createLineItem`
  / `createAssetReservation` and the now-unused `setupTrigger` injection removed.
- `reservation.controller.ts` `@Post(':id/services')` threads `clientRequestId`
  (RequireClientRequestIdGuard already gated the route) into the attach idempotency key.
- `packages/shared/src/idempotency.ts` — `ATTACH_SERVICES_IDEMPOTENCY_KEY_PREFIX`
  (`booking:attach`) + `buildAttachServicesIdempotencyKey`. (`@prequest/shared` is a
  built package — `dist` is gitignored; CI/consumers run `pnpm --filter @prequest/shared
  build`, as for every prior shared change.)

## Validator-input correctness (the key correctness risk — VERIFIED, not assumed)

`validate_attach_plan_tenant_fks` (00303) dereferences from `p_booking_input`:
`requester_person_id` (required → persons), `host_person_id` (optional → persons),
`booked_by_user_id` (optional → users), `location_id` (required → spaces). It does NOT
check booking existence. `validate_attach_plan_internal_refs` (LIVE, post-00410)
dereferences `booking_id` (required; raises 22023 if null) + `applied_rule_ids[]`
(→ room_booking_rules — D-4 fix; absent on a post-create attach ⇒ §7a vacuous, correct).
00412 does NOT pass a bare `{booking_id}` stub: it SELECTs the existing booking row
(`where id = p_booking_id and tenant_id = p_tenant_id`) and builds a faithful
`booking_input` (booking_id + requester_person_id + host_person_id + booked_by_user_id
+ location_id) from it, so BOTH validators validate correctly for the existing-booking
case. Confirmed against 00303's body + the live internal-refs definition.

## Verified gates (what the orchestrator ran directly)

- `tsc --noEmit` (apps/api): clean.
- `jest src/modules/booking-bundles src/modules/reservations`: 32 suites / 333 passed
  / 5 todo (incl. the constructor-arity spec fix for the removed `setupTrigger`).
- `errors:check-app-errors`: clean (0 raw throws / 35 modules).
- 00412 on remote, `pg_get_functiondef` shape-confirmed.

## PENDING (deferred, tracked — owner: this workstream; task #15)

- **Live smoke gate `smoke:attach-services`** (atomic attach / idempotency-no-dup /
  payload-mismatch 409 / atomic-rollback-proves-Cleanup-removal-safe / cross-tenant /
  missing-CRID / require_approval setup-emit suppression). Not authored: two
  closure subagents were killed mid-run by API infrastructure failures (rate-limit;
  stream-idle-timeout) on 2026-05-17. **Risk:** no live-DB proof of the attach RPC
  end-to-end + the idempotency/rollback invariants; unit + tsc + migration-shape are
  necessary-but-not-sufficient (the exact lesson the smoke-gate mandate exists for).
  Mitigation until done: the RPC mirrors the already-smoke-gated, shipped
  `create_booking_with_attach_plan` attach-half; validator-input verified; jest green.
- **2-agent full-review** of the cutover + 00412 (every prior slice had one; it caught
  real defects each time incl. an orchestrator misdiagnosis). Same API-instability cause.

## Residuals (explicit, not silent)

- Deprecated `attachServicesToReservation` shim retained (intentional caller-stability;
  already forwards `client_request_id`).
- 00412 forward-only on shared remote (no clean DB-only rollback; the old TS path is
  deleted — revert = git-revert + drop function, re-exposing the non-atomic bug).
- P2-1 boundary respected: the recurrence-clone `cloneOrderForOccurrence` path is
  orthogonal and untouched (P2-1 retires `BookingTransactionBoundary` in a later slice).
