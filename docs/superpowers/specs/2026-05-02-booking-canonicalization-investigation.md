# Booking-canonicalization blast-radius investigation

**Date:** 2026-05-02
**Status:** Investigation complete — pre-spec; not a design doc
**Purpose:** Measure the cost and risk of moving from lazy-bundle (current) to booking-canonical (target). Drives the Phase 0 design spec written separately.

## Decision being measured

**Locked by user 2026-05-02:** `booking_bundles` becomes the canonical "booking" entity. Every reservation belongs to a booking. Title/description/host/status live on the booking. Reservations become pure resource+time children. Services + visitors + tickets attach to the booking. The lazy-bundle invariant ("bundle created only on first-service-attach") is dead under this model.

**Counts at start:** 275 migration files; 146 distinct `booking_bundle_id` references in SQL; 96 in TS code (excluding tests). Lazy-bundle assumption is encoded in roughly five layers — schema, service-layer branches, the visitor module's dual-link, visibility services, and a half-dozen frontend components that gate UI on bundle-presence.

---

## Section 1 — SQL surfaces affected

**Finding:** Every `booking_bundle_id IS NOT NULL` predicate in views/RPCs/indexes implicitly assumes lazy-bundle absence. **Files/lines:** `supabase/migrations/00199_reservations_with_bundle_index.sql:18`; `00155_room_booking_report_rpc.sql:158, 336, 473`; `00156_room_booking_management_reports.sql:568, 619, 712`; `00148_booking_bundle_status_view.sql:21,28,35`; `00185_booking_bundle_status_view_ticket_aware.sql:29,36,43`; `00210_step1b_booking_bundle_status_v_cutover.sql:28,35,44`. **Impact:** All become "always true" — predicates collapse to no-ops. Status-view JOINs already use LEFT JOIN, so they survive without changes; the `where booking_bundle_id is not null` filters in `00156` recurring-cost reports become dead clauses (safe but should be removed).

**Finding:** Partial indexes filtering on bundle presence become candidates for plain indexes once the column is NOT NULL. **Files/lines:** `00199:18` (`idx_reservations_with_bundle`); `00145:10-11` (`idx_tickets_bundle`, `idx_tickets_kind_bundle`); `00144:12` (`idx_orders_bundle`); `00142:40` (`idx_asset_reservations_bundle`); `00252:142-144` (`idx_visitors_booking_bundle`); `00213:168` (`work_orders.booking_bundle_id`). **Impact:** Six partial indexes need to either become full or be re-evaluated. The `idx_reservations_with_bundle` exists to cover only ~5% of rows; once bundles exist for 100%, it stops being a useful selectivity index.

**Finding:** `parent_kind` CHECK constraint on `work_orders` encodes the dual-root model symbolically. **Files/lines:** `00213_step1c1_work_orders_new_table.sql:39-46`; `00218:144-154`; `00208:33,37`. **Impact:** XOR `(parent_case_id IS NULL OR booking_bundle_id IS NULL)` and the `parent_kind` discriminator (`'case' | 'booking_bundle' | NULL`) are unaffected by canonical bundles — the WO still has at most one parent. But the meaning of `parent_kind='booking_bundle'` shifts: today it implies "service-attached booking"; under canonical every booking has a bundle, so the discriminator no longer carries semantic weight.

**Finding:** Bundle↔reservation FK cycle stays, but cardinality flips. **Files/lines:** `00147_booking_bundles_fk_cycle.sql:10-18` (both FKs `ON DELETE SET NULL`); `00153_booking_bundles_primary_reservation_unique.sql:19-21` (partial unique on `primary_reservation_id WHERE NOT NULL`). **Impact:** Cycle-with-nullable-FKs design exists *because* booking_bundles can be created before reservations (services-only bundles). Under always-create-on-reservation, the reservation→bundle FK can become NOT NULL, but bundle→reservation must stay nullable for services-only bundles unless they are also folded in. The unique-on-primary_reservation_id partial index becomes a full unique constraint.

**Finding:** All bundle FKs cascade `ON DELETE SET NULL` except visitors. **Files/lines:** `00142:22`; `00144:5`; `00145:7`; `00213:35`; `00147:13,18`; `00252:36` (visitors — no `on delete` clause, so default RESTRICT). **Impact:** Cascade semantics don't change under always-create, but `visitors.booking_bundle_id` defaulting to RESTRICT becomes a real constraint — survives today only because most visitors have NULL bundle. Under canonical every visitor has one and you cannot delete a bundle without first detaching visitors.

**Finding:** `booking_bundle_status_v` and `fulfillment_units_v` JOIN reservation/order/ticket onto bundle. **Files/lines:** `00148`, `00185`, `00210`, `00222:280-298`, `00186`, `00190`, `00209`. **Impact:** Functionally fine. The view's "pending" branch (`when nothing linked → 'pending'`) becomes unreachable under canonical — every bundle has at minimum a reservation. View definitions don't need to change but status meaning thins.

**Finding:** `bundle_is_visible_to_user(uuid,uuid,uuid)` SQL helper takes a bundle id. **Files/lines:** `00148:71-103`; `00245_bundle_visibility_parity_with_ts.sql:38-101`. **Impact:** No call sites in SQL today (per `00245`'s own comment). Function signature stays; semantics simplify because every reservation now has a bundle, so reservation-visibility could just delegate to bundle-visibility.

**Finding:** Functions taking either `reservation_id` or `bundle_id`. **Files/lines:** `cancelOrdersForReservation(reservation_id)` (`bundle-cascade.service.ts:479`); `cancelLine`/`cancelBundle` (same file); approvals carry `target_entity_type IN ('reservation', 'booking_bundle', 'visitor_invite', 'order', 'ticket')` (`approval.service.ts:329-347`). **Impact:** ~6 dispatch points distinguish reservation-anchored from bundle-anchored. Under canonical, the natural collapse is "always go through bundle"; the approval `target_entity_type='reservation'` branch becomes dead.

---

## Section 2 — API service layer affected

**Finding:** Three reservation-creation paths funnel through `BookingFlowService.create`. **Files/lines:** `apps/api/src/modules/reservations/booking-flow.service.ts:63`; `multi-room-booking.service.ts:39-146` (loops `bookingFlow.create` per room, services attach to first room only — `:130-131`); `recurrence.service.ts` (materialisation calls back); `order.service.ts:688-720` (services-only / standalone — calls `createServicesOnlyBundle`); calendar-sync `room-mailbox.service.ts:46,261` (TODO Phase C, not wired). **Impact:** "Where would always-create-bundle live" has one answer: `BookingFlowService.create`. Insert lands at line 169 (`booking_bundle_id: input.booking_bundle_id ?? null`). The lazy-attach branch at `:262-316` becomes the unconditional path.

**Finding:** Single `lazyCreateBundle` call site. **Files/lines:** `bundle.service.ts:112` (called from `attachServicesToReservation`); body at `:845-902`. **Impact:** Method gets repurposed to "create-if-missing" with a service-supplied bundle row, or absorbed into `BookingFlowService` and removed.

**Finding:** Five distinct branches on `if (reservation.booking_bundle_id == null)` or equivalent. **Files/lines:** `bundle.service.ts:121, 851`; `reservation.service.ts:402-407, 562`; `bundle-cascade.service.ts:83-88, 493`; `booking-flow.service.ts:262, 273-316`. **Impact:** Each becomes either trivially true or dead-code on cleanup. The visitor-cascade gate at `reservation.service.ts:562` is the most impactful — today, room-only edits never emit visitor events because no bundle exists; under canonical, every room edit fires the lookup (no-op for room-only bookings).

**Finding:** `runPostCreateAutomation` does NOT branch on bundle existence. **Files/lines:** `ticket.service.ts:693-727`. **Impact:** Untouched. Booking-origin work orders use the separate `createBookingOriginWorkOrder` path (`:1732-1830`) which already requires a bundle id and never went through `runPostCreateAutomation`.

**Finding:** `DispatchService` and `createBookingOriginWorkOrder` both assume the bundle exists when called. **Files/lines:** `ticket.service.ts:1732-1830`; `setup-work-order-trigger.service.ts:95`; `bundle.service.ts:330-342`. **Impact:** Setup trigger can fire from any place where a reservation exists once bundle is canonical, not only from "service rules emitted require_internal_setup". No behavior changes in dispatch itself; the gate "this booking has services so it has a bundle" goes away.

**Finding:** Visitors module's dual-link is the largest collapse. **Files/lines:** `invitation.service.ts:135-136`; `visitors.controller.ts:415`; `reception.controller.ts:166,173`; `dto/schemas.ts:41` + `dto/create-invitation.dto.ts:40`; `bundle-cascade.adapter.ts:316-322`; `reservation.service.ts:598-602`; `apps/web/src/components/desk/visitor-detail.tsx:476-501` (the "prefer reservation_id, fall back to booking_bundle_id" lookup). **Impact:** Dual link existed because some invites land before/without a bundle; under canonical, `booking_bundle_id` becomes the only join, `reservation_id` becomes derivable (or kept as denormalised shortcut to the primary reservation).

**Finding:** Approvals attach to BOTH reservation and bundle today. **Files/lines:** `booking-flow.service.ts:567-588` (`target_entity_type: 'reservation'`); `bundle.service.ts:274-283` (`target_entity_type: 'booking_bundle'`); `approval.service.ts:329-347`. **Impact:** Two distinct approval flows depending on whether services were attached before/with the booking. Under canonical, the `reservation` target type can be retired and approvals always anchor on the bundle. Migration must handle in-flight `target_entity_type='reservation'` rows.

**Finding:** Calendar sync (Outlook) does NOT branch on bundle today — it's a TODO. **Files/lines:** `room-mailbox.service.ts:10,46,62,196,261,317,367`; both `booking_bundles.calendar_event_id` (`00140:26`) and `reservations.calendar_event_id` (`00122:50-52`) exist as parallel columns. **Impact:** Two surface candidates exist; the canonical-bundle move makes it uncomplicated to choose `booking_bundles.calendar_event_id` as the canonical path.

---

## Section 3 — Frontend surfaces affected

**Finding:** Three primary TS types model nullable bundle. **Files/lines:** `apps/web/src/api/room-booking/types.ts:85`; `apps/web/src/api/orders/types.ts:12`; `apps/web/src/api/visitors/index.ts:108,154` + `apps/web/src/api/visitors/admin.ts:391`. `apps/web/src/api/booking-bundles/types.ts:71` (`BookingBundle.primary_reservation_id: string | null` — inverse nullability — also flips for reservation-anchored bundles). **Impact:** All become non-null on the reservation side. `BookingBundle.primary_reservation_id` stays nullable for services-only bundles unless those are also folded in.

**Finding:** Components branching on `reservation.booking_bundle_id == null`. **Files/lines:** `booking-detail-content.tsx:394`; `bundle-services-section.tsx:62-148`; `apps/web/src/pages/desk/bookings.tsx:413`; `booking-composer.tsx:528-545`. **Impact:** Every conditional becomes "always true" once the type narrows. Empty-state in `bundle-services-section.tsx:98-148` gets simpler. Composer's two-shape result handling (`reservations[]` vs single bundle) collapses.

**Finding:** Parallel React Query hooks for reservation vs bundle. **Files/lines:** `apps/web/src/api/room-booking/queries.ts:109` (`useReservationDetail`); `apps/web/src/api/booking-bundles/queries.ts:31` (`useBundle`); `visitor-detail.tsx:495,501`; `bundle-services-section.tsx:236`; `bundle-work-orders-section.tsx:42`. **Impact:** Hooks themselves are different and probably stay split — but the visitor-detail fallback pattern collapses to a single canonical lookup. `useReservationDetail` could include `bundle: BookingBundle` inline so most call sites stop double-fetching.

**Finding:** Booking detail surfaces stitch reservation + bundle separately today. **Files/lines:** `booking-detail-content.tsx:18-72`; `bundle-services-section.tsx:62-236`; `bundle-work-orders-section.tsx:42`. **Impact:** Two-step "reservation → maybe bundle" load could collapse to "load booking" once the model is canonical. Doesn't have to — but it halves round-trips on the booking detail page.

**Finding:** Composer's submit conditionally creates a bundle. **Files/lines:** `booking-composer.tsx:528-567` (handles two response shapes); `state.ts:8,91`; `sections/visitors-section.tsx:9`. **Impact:** Composer's submit path simplifies — every booking returns a `booking_bundle_id`, no need to branch on whether services were included.

**Finding:** Multi-room frontend handling. **Files/lines:** `booking-composer.tsx:528-567` handles `reservations[]` array; `multi-room-booking.service.ts:130-131` only attaches services to primary room. **Impact:** Under canonical, "does multi-room create one bundle or N bundles" becomes load-bearing. Today it's one bundle (anchored on primary reservation). Frontend already handles this — no UI change needed if answer stays "one bundle for the group".

---

## Section 4 — Tests that depend on the lazy invariant

**Finding:** Tests that explicitly fixture/assert no-bundle state. **Files/lines:** `multi-room-booking.service.spec.ts:49`; `reservation.service.events.spec.ts:65, 236-240`; `bundle.service.spec.ts:5,9` (`it.todo('creates a bundle on first-service-attach')`). **Impact:** ~3 explicit no-bundle assertions need rewriting; multiple fixtures across reservation specs need their `booking_bundle_id: null` flipped to a real bundle id.

**Finding:** Visitor-cascade test fixtures encode the dual-link. **Files/lines:** `bundle-cascade.adapter.spec.ts:38,104,157+`; `bundle-cascade-integration.spec.ts:53,99,126,176`. **Impact:** Specs keep working — they pass an explicit `bundle_id`. Just check fixtures don't assert "visitor has reservation_id but no booking_bundle_id".

**Finding:** Seed data — only ~8 reservation rows in `00133`, none with bundle. **Files/lines:** `00133_seed_room_booking_examples.sql`; `00172_seed_booking_services_demo.sql` (zero reservation/bundle rows). **Impact:** Seed reservations need bundles backfilled by the migration.

**Finding:** Smoke gate does NOT depend on lazy invariant. **Files/lines:** `apps/api/scripts/smoke-work-orders.mjs`. **Impact:** Untouched.

---

## Section 5 — Migration data scope

**Finding:** Production-row counts can't be measured without DB access from this session. Inferring from seed + spec context: `00133` seeds 8 reservations; `00172` seeds none. The "95% room-only" comment in `00199:4-5,12` is an architectural prediction, not a measurement. **Impact:** Backfill creates one bundle per existing reservation lacking one (~95% of rows). At remote dev DB scale this is small (single-digit ms); at customer-scale (5000-employee tenant) it could be tens of thousands.

**Finding:** Orphan-bundle risk exists by design. **Files/lines:** `00147:13`; `00153`. **Impact:** A reservation deletion sets bundle's `primary_reservation_id = NULL`; bundle survives as orphan. Standalone-orders also have bundles with `primary_reservation_id IS NULL` by design (`order.service.ts:716` `createServicesOnlyBundle`). Backfill must NOT touch services-only bundles. Backfill predicate is `WHERE reservations.booking_bundle_id IS NULL`, not the bundle table.

**Finding:** Cancelled / archived reservations exist. **Files/lines:** `reservation.service.ts:140-178`; `reservations.status IN ('cancelled', 'released')`. **Impact:** Spec must decide — backfill for cancelled too (preserves history symmetry, creates dead bundles), or skip them (cleaner but breaks the invariant for past data). Recommend backfill to keep the invariant absolute.

---

## Section 6 — Risky places where the cutover could silently break

**Finding:** RLS policies do NOT compose `booking_bundle_id IS NULL` conditions today. **Files/lines:** Surveyed `00125`, `00140`, `00142`, `00148`, `00185`, `00210`, `00213`, `00245`, `00252` — all RLS is pure `tenant_isolation`. **Impact:** Low — no RLS predicate breaks under canonical. Visibility lives entirely in TS service layer.

**Finding:** Reservation BEFORE-INSERT trigger does NOT inspect bundle. **Files/lines:** `00122:59-73` (`set_reservations_effective_window` — pure time-math). **Impact:** None.

**Finding:** Visitor status trigger requires session marker. **Files/lines:** `visitor.service.ts:113-119`; `00270_visitor_status_insert_validation_and_service_marker.sql`. **Impact:** Backfilling visitor.booking_bundle_id is fine (status not touched), but if migration also collapses any visitor state, it must run via the same `set_config('visitors.transition_marker', 'true', true)` pattern.

**Finding:** Audit events distinguish reservation vs bundle today. **Files/lines:** `entity_type: 'reservation'` at `reservation.service.ts:359, 389, 454, 540`; `booking-flow.service.ts:602`; `check-in.service.ts:90, 178`. `entity_type: 'booking_bundle'` at `bundle.service.ts:393, 1078, 1187, 1293`; `bundle-cascade.service.ts:353`. **Impact:** Going from two `entity_type` values to one is a design call. Don't auto-collapse — orchestrate per-event.

**Finding:** Realtime channels are scoped per-table. **Files/lines:** `use-realtime-bundle.ts:52-68`; `use-realtime-scheduler.ts:81+`; `00132_reservations_realtime.sql` + `00173_bundle_lines_realtime.sql`. **Impact:** Two channel naming schemes (`bundle-lines:` vs `desk-scheduler:`) overlap conceptually. Under canonical they could consolidate but don't have to.

**Finding:** Calendar event id duplicated on bundle and reservation. **Files/lines:** `00140:26-29`; `00122:50-52`. **Impact:** Outlook integration unwired today; canonical model decides the canonical path. No production calendar integration writing yet — link rot bounded.

**Finding:** No materialized views or denormalised columns depend on bundle absence. **Files/lines:** Surveyed all status views — all regular views. **Impact:** Low.

---

## Section 7 — Time/effort honest estimates

**7.1. Migration + backfill SQL — 1 to 1.5 engineer-days.** One migration file: ALTER TABLE to set `reservations.booking_bundle_id NOT NULL` (after backfill); CTE backfill creating one bundle per orphan reservation; convert four partial indexes to plain (drop+create); drop now-vacuous `WHERE booking_bundle_id IS NOT NULL` in report RPCs. Lines: ~150-200. Risky bit isn't the SQL — it's deciding whether to backfill cancelled/archived rows and what `bundle_type` defaults to.

**7.2. API service layer rewrite — 3 to 5 engineer-days.** `BookingFlowService.create` insert moves to "always create bundle". `lazyCreateBundle` becomes `ensureBundle` or absorbed. Approval dispatcher cleanup: retire `target_entity_type='reservation'` branch. Five branches enumerated in §2 each get touched. Risky part: visitor-cascade emit gate at `reservation.service.ts:562` — under canonical, every room edit triggers a bundle-event subscriber walk; need to verify subscribers no-op cheaply on bundles with no visitors. Files: ~10. Lines: ~600-900.

**7.3. Frontend type cleanup + component updates — 1.5 to 2.5 engineer-days.** Flip nullables in 3 type files. Remove "no bundle yet" branch in `bundle-services-section.tsx` (~50 lines). Simplify `booking-detail-content.tsx:394`. Composer's two-shape result handling collapses (~30 lines). Visitor-detail fallback collapses. The `has_bundle` filter in `room-booking/keys.ts:34-37` and `reservation.service.ts:228, 257` becomes a no-op or the chip disappears from `/desk/bookings`. Files: ~8. Lines: net deletion of ~150-250.

**7.4. Test suite updates + smoke-test additions — 2 to 3 engineer-days.** ~3 explicit no-bundle assertions to rewrite; ~6 fixture files where `booking_bundle_id: null` becomes a real id. Add smoke probe verifying every `POST /reservations` returns non-null `booking_bundle_id`. Risky part: integration spec coverage — `reservation.service.events.spec.ts` and visitor cascade specs need careful re-fixturing to ensure cascade path still gets tested for bookings that genuinely have no visitors (the no-op branch). Lines: ~300-500.

**Total: 7.5 – 12 engineer-days.** Median estimate ~10 days = **2 calendar weeks** with codex reviews + buffer.

## 7.5 Highest-risk unknowns

1. **Real row counts on remote DB.** "95% room-only" is architectural prediction not measurement. If actual ratios are inverted, partial-index branch becomes pointless; if 99/1, every backfilled bundle is dead weight. **Action:** Measure before committing to backfill plan.
2. **Services-only bundles' fate.** `order.service.ts:716` creates bundles with `primary_reservation_id IS NULL`. Under canonical these stay (not reservation-anchored), but the "every reservation has a bundle" invariant is one-directional — bundles can still exist without reservations. **Spec must make this explicit** otherwise frontend may assume bundle ↔ reservation 1:1.
3. **`approvals.target_entity_type='reservation'` retirement.** Couldn't quantify in-flight rows. If production has open `target_entity_type='reservation'` approvals at cutover, dispatcher branch can't be removed in same release; needs deprecation window.
4. **Calendar-sync mapping.** `room-mailbox.service.ts:46-261` is unwired Phase C. Whether canonical bundles change the design depends on whether spec wants Outlook events to map to reservation-or-bundle. Duplicate columns suggest this hasn't been decided.
5. **Visitor-cascade on every room edit.** Once `reservation.service.ts:562` no longer gates on bundle-presence, every `editOne` runs the visitor lookup query (`visitors WHERE booking_bundle_id = X`). For room-only bookings that's guaranteed-empty, but it's still a query per edit; on desk scheduler with drag-resize, this adds ~50ms × N edits/min. Whether it's a problem depends on real edit volume.
