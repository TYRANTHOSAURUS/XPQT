# Phase 7 — error code registry follow-up

> Tracking Phase 1 error codes that need to land in the AppError catalog in
> Phase 7. Created 2026-05-04 as the /full-review v3 closure I5 fix —
> codex's flag pointed out that the Phase 1 plan referenced this doc but
> it didn't exist.

## Why this doc exists

Phase 1 closes correctness bugs (atomic booking + service create, slot-
first scheduler, compensation boundary) without going through the full
AppError + i18n catalog refactor. That refactor is Phase 7. To prevent
silent drift, every code emitted inline via `BadRequestException`,
`NotFoundException`, `ForbiddenException`, `ConflictException`, or
`InternalServerErrorException` during Phase 1 is registered here so
Phase 7 can:

1. Add each code to `packages/shared/src/error-codes.ts`.
2. Add the English message to `messages.en.ts` (Dutch follows in the
   localisation pass).
3. Replace the inline `throw new <Nest>Exception({code, message})`
   call sites with `throw AppErrors.<class>('<code>', {...})` from the
   factory module.
4. Wire the renderer's class mapping per the error-handling spec
   (`docs/superpowers/specs/2026-05-02-error-handling-system-design.md`
   §3.3-3.4).

Until Phase 7 lands, **do not** refactor these codes inline — leaving
them as raw NestJS exception payloads keeps the wire shape stable and
the migration to AppError mechanical.

## Phase 1 codes registered for Phase 7

Codes are listed in dot-namespace style (`<entity>.<reason>`), which
matches the existing convention in `booking.slot_conflict`,
`booking_slot.not_found`, `booking.partial_failure`. New codes added in
this round (C1, I2) follow the same shape.

| Code                                  | Class       | Source                                                       | Status path |
|---------------------------------------|-------------|--------------------------------------------------------------|-------------|
| `work_order.plan_invalid`             | validation  | `apps/api/src/modules/work-orders/work-order.service.ts`     | 400 |
| `booking.slot_conflict`               | conflict    | `reservation.service.ts editSlot path` (GiST 23P01)          | 409 |
| `booking_slot.not_found`              | not_found   | `reservation.service.ts editSlot, controller`                | 404 |
| `booking_slot.url_mismatch`           | validation  | `reservation.controller.ts editSlot route`                   | 400 |
| `booking.edit_forbidden`              | permission  | `reservation.service.ts editSlot`                            | 403 |
| `booking.partial_failure`             | server      | `InProcessBookingTransactionBoundary`                        | 400 (placeholder; Phase 7 should re-classify as `server`) |
| `booking.compensation_failed`         | server      | `BookingCompensationService.deleteBooking` + boundary catch  | 500 |
| `booking.slot_space_invalid`          | validation  | `reservation.service.ts editSlot (C1 fix)`                   | 400 |
| `booking.slot_update_failed`          | server      | `reservation.service.ts editSlot fallback`                   | 400 |
| `booking.invalid_attendee_count`      | validation  | `reservation.service.ts editOne (I2 preflight)`              | 400 |
| `booking.invalid_attendee_person_ids` | validation  | `reservation.service.ts editOne (I2 preflight)`              | 400 |
| `booking.invalid_window`              | validation  | `reservation.service.ts editOne (I2 preflight)`              | 400 |
| `reference.not_in_tenant`             | validation  | `apps/api/src/common/tenant-validation.ts assertTenantOwned* (Plan A.2)` | 400 |
| `reference.lookup_failed`             | validation  | `apps/api/src/common/tenant-validation.ts assertTenantOwned* (Plan A.2)` | 400 |
| `reference.invalid_uuid`              | validation  | `apps/api/src/common/tenant-validation.ts assertTenantOwned* (Plan A.2)` | 400 |
| `reference.too_many`                  | validation  | `apps/api/src/common/tenant-validation.ts assertTenantOwnedAll (Plan A.2)` | 400 |
| `workflow.update_ticket_field_not_allowed` | validation | `apps/api/src/modules/workflow/workflow-engine.service.ts (Plan A.4 Commit 4 / C3)` | 400 |

## Phase 1 codes still using legacy snake_case (renamed in Phase 7)

These predate the dot-namespace convention. Phase 7 should rename them
to the `<entity>.<reason>` form during the AppError migration. Until
then, they remain stable for callers that have already integrated:

| Legacy code                         | Proposed Phase 7 code           | Source                                                |
|-------------------------------------|---------------------------------|-------------------------------------------------------|
| `insert_failed`                     | `booking.insert_failed`         | `booking-flow.service.ts` create-RPC error path       |
| `reservation_slot_conflict`         | `booking.slot_conflict`         | `booking-flow.service.ts` create GiST 23P01           |
| `rule_deny`                         | `booking.rule_deny`             | `booking-flow.service.ts` rule-engine deny outcome    |
| `override_reason_required`          | `booking.override_reason_required` | reservation create override                        |
| `multi_room_recurrence_unsupported` | `booking.multi_room_recurrence_unsupported` | multi-room recurrence pre-flight           |
| `wrong_endpoint`                    | `booking.wrong_endpoint`        | reservation.service.ts                                |
| `recurrence_unavailable`            | `booking.recurrence_unavailable`| reservation.service.ts                                |
| `edit_scope_failed`                 | `booking.edit_scope_failed`     | reservation.service.ts                                |
| `not_recurring`                     | `booking.not_recurring`         | reservation.service.ts                                |
| `reservation_write_forbidden`       | `booking.write_forbidden`       | reservation.service.ts                                |
| `invalid_input`                     | n/a — split per validation site | reservation.service.ts (multiple call sites)          |
| `space_not_found`                   | `space.not_found`               | reservation.service.ts                                |
| `space_inactive`                    | `space.inactive`                | reservation.service.ts                                |
| `space_not_reservable`              | `space.not_reservable`          | reservation.service.ts                                |

## How to add a code in Phase 1

If a new exception path is introduced before Phase 7 lands:

1. Throw `new <Nest>Exception({ code: '<entity>.<reason>', message: '<short, neutral>' })` — never `new Error(...)`.
2. Pick a class per the error-handling spec §3.3 (validation / not_found / permission / conflict / rate_limit / server).
3. Add the new code to **this file's table** in the same PR.
4. Add a regression test that asserts the code in the response payload.

Skipping step 3 is what this doc exists to prevent — silent drift was
the failure mode codex flagged when this file didn't exist.

## Open questions for Phase 7

1. **`booking.partial_failure` class.** The boundary throws
   `BadRequestException` (400) today, but the spec §3.3 lists this
   class as `server`. Phase 7 should reclassify and adjust the wire
   status code; existing callers that grep on `code:
   'booking.partial_failure'` will still match.
2. **`booking.compensation_failed` traceId surfacing.** Per error-
   handling spec §3.4 — server-class errors must surface a `traceId`
   on the toast for ops to copy into a support ticket. The boundary
   doesn't stamp one today; Phase 7's AppError factory should add it
   in the renderer.
3. **`invalid_input` is a generic anti-pattern.** Multiple call sites
   throw it with different messages; Phase 7 should split per call
   site (`booking.invalid_request_window`, `booking.invalid_geometry`,
   etc.) so error-tracking dashboards can disambiguate.
