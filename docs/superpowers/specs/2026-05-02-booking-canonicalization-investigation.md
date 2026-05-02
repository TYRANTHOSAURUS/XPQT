# Booking-canonicalization blast-radius investigation

**Date:** 2026-05-02
**Status:** Investigation complete — pre-spec; not a design doc
**Purpose:** Measure the cost and risk of moving from lazy-bundle (current) to booking-canonical (target). Drives the Phase 0 design spec written separately.
**Revision history:**
- 2026-05-02 (v1): Initial investigation.
- 2026-05-02 (v2): Folded corrections from two adversarial reviewers (completeness + accuracy). Replaced unsourced row-count predictions with measurements from remote DB. Added §2.5 "Critical structural findings". Revised §7 estimates upward. Removed fabricated quantitative claim. Marked v1 conclusions that survived vs. were corrected.

## Decision being measured

**Locked by user 2026-05-02:** `booking_bundles` becomes the canonical "booking" entity. Every reservation belongs to a booking. Title/description/host/status live on the booking. Reservations become pure resource+time children. Services + visitors + tickets attach to the booking. The lazy-bundle invariant ("bundle created only on first-service-attach") is dead under this model.

**Counts at start (v1):** 275 migration files; 146 distinct `booking_bundle_id` references in SQL; 96 in TS code (excluding tests).

---

## Section 1 — SQL surfaces affected

**Finding:** Every `booking_bundle_id IS NOT NULL` predicate in views/RPCs/indexes implicitly assumes lazy-bundle absence. **Files/lines:** `supabase/migrations/00199_reservations_with_bundle_index.sql:18`; `00155_room_booking_report_rpc.sql:158, 336, 473`; `00156_room_booking_management_reports.sql:568, 619, 712`; `00148_booking_bundle_status_view.sql:21,28,35`; `00185_booking_bundle_status_view_ticket_aware.sql:29,36,43`; `00210_step1b_booking_bundle_status_v_cutover.sql:28,35,44`. **Impact:** All become "always true" — predicates collapse to no-ops. Status-view JOINs already use LEFT JOIN, so they survive without changes; the `where booking_bundle_id is not null` filters in `00156` recurring-cost reports become dead clauses (safe but should be removed).

**Finding:** Partial indexes filtering on bundle presence become candidates for plain indexes once the column is NOT NULL. **Files/lines:** `00199:18` (`idx_reservations_with_bundle`); `00145:10-11` (`idx_tickets_bundle`, `idx_tickets_kind_bundle`); `00144:12` (`idx_orders_bundle`); `00142:40` (`idx_asset_reservations_bundle`); `00252:142-144` (`idx_visitors_booking_bundle`); `00213:168` (`work_orders.booking_bundle_id`). **Impact:** Six partial indexes need to either become full or be re-evaluated. The `idx_reservations_with_bundle` exists to cover ~5% of rows per the partial-index migration's own architectural prediction; **measurement (see §5) shows the actual ratio on the dev DB is 19% with-bundle, not 5%** — the partial-index selectivity assumption is already wrong before canonicalization.

**Finding:** `parent_kind` CHECK constraint on `work_orders` encodes the dual-root model symbolically. **Files/lines:** `00213_step1c1_work_orders_new_table.sql:39-46`; `00218:144-154`; `00208:33,37`. **Impact:** XOR `(parent_case_id IS NULL OR booking_bundle_id IS NULL)` and the `parent_kind` discriminator (`'case' | 'booking_bundle' | NULL`) are unaffected by canonical bundles — the WO still has at most one parent. But the meaning of `parent_kind='booking_bundle'` shifts: today it implies "service-attached booking"; under canonical every booking has a bundle, so the discriminator no longer carries semantic weight.

**Finding:** Bundle↔reservation FK cycle stays, but cardinality flips. **Files/lines:** `00147_booking_bundles_fk_cycle.sql:10-18` (both FKs `ON DELETE SET NULL`); `00153_booking_bundles_primary_reservation_unique.sql:19-21` (partial unique on `primary_reservation_id WHERE NOT NULL`). **Impact:** Cycle-with-nullable-FKs design exists *because* booking_bundles can be created before reservations (services-only bundles). Under always-create-on-reservation, the reservation→bundle FK can become NOT NULL, but bundle→reservation must stay nullable for services-only bundles unless they are also folded in. The unique-on-primary_reservation_id partial index becomes a full unique constraint **for reservation-anchored bundles only** — the spec must explicitly carve out services-only bundles.

**Finding:** All bundle FKs cascade `ON DELETE SET NULL` except visitors. **Files/lines:** `00142:22`; `00144:5`; `00145:7`; `00213:35`; `00147:13,18`; `00252:36` (visitors — no `on delete` clause, so default RESTRICT). **Impact:** Cascade semantics don't change under always-create, but `visitors.booking_bundle_id` defaulting to RESTRICT becomes a real constraint — survives today only because most visitors have NULL bundle. Under canonical every visitor has one and you cannot delete a bundle without first detaching visitors.

**Finding:** `booking_bundle_status_v` and `fulfillment_units_v` JOIN reservation/order/ticket onto bundle. **Files/lines:** `00148`, `00185`, `00210`, `00222:280-298`, `00186`, `00190`, `00209`. **Impact:** Functionally fine. The view's "pending" branch (`when nothing linked → 'pending'`) becomes unreachable under canonical — every bundle has at minimum a reservation. View definitions don't need to change but status meaning thins.

**Finding:** `bundle_is_visible_to_user(uuid,uuid,uuid)` SQL helper takes a bundle id. **Files/lines:** `00148:71-103`; `00245_bundle_visibility_parity_with_ts.sql:38-101`. **Impact:** No call sites in SQL today (per `00245`'s own comment). Function signature stays; semantics simplify because every reservation now has a bundle, so reservation-visibility could just delegate to bundle-visibility.

**Finding (added v2 — completeness reviewer):** Other SQL functions touched indirectly. **Files/lines:** `reservation_merge_policy_snapshot` (00138) and `reservation_visibility_ids` (00157) — both encode the reservation-as-root assumption without taking bundle ids. Under canonical, `reservation_visibility_ids` becomes a wrapper around `bundle_visibility` (with the bundle→reservation join). `search_global` (00158:305) has its own `reservations` branch producing hits without bundle awareness. **Impact:** Add ~0.5d to §7.1 for these adjustments.

**Finding:** Functions taking either `reservation_id` or `bundle_id`. **Files/lines:** `cancelOrdersForReservation(reservation_id)` (`bundle-cascade.service.ts:479`); `cancelLine`/`cancelBundle` (same file); approvals carry `target_entity_type IN ('reservation', 'booking_bundle', 'visitor_invite', 'order', 'ticket')` (`approval.service.ts:329-347`). **Impact:** ~6 dispatch points distinguish reservation-anchored from bundle-anchored. Under canonical, the natural collapse is "always go through bundle"; the approval `target_entity_type='reservation'` branch becomes dead. **See §2.5 finding #3 for the cutover risk on in-flight approvals.**

---

## Section 2 — API service layer affected

**Finding (corrected v2 — accuracy reviewer):** **At least four** reservation-creation paths funnel through `BookingFlowService.create`. **Files/lines:** `apps/api/src/modules/reservations/booking-flow.service.ts:63` (the canonical pipeline); `reservation.controller.ts:117` (HTTP entry); `multi-room-booking.service.ts:39-146` (loops `bookingFlow.create` per room — see §2.5 #2 for the bundle-fan-out write loop that lives OUTSIDE this method); `recurrence.service.ts:413-426` (per-occurrence — see §2.5 #1 for the structural mess); `reservations.module.ts:186` (calendar-sync TickleService stub for Phase C); `room-mailbox.service.ts:46,261` (TODO Phase C, not wired today); `order.service.ts:688-720` (services-only / standalone — calls `createServicesOnlyBundle`, NOT a reservation-creation path but still inserts a bundle). v1 said "three"; this is wrong — recurrence is a fan-out multiplier, not a peer.

**Finding:** Single `lazyCreateBundle` call site. **Files/lines:** `bundle.service.ts:112` (called from `attachServicesToReservation`); body at `:845-902`. **Impact:** Method gets repurposed to "create-if-missing" with a service-supplied bundle row, or absorbed into `BookingFlowService` and removed.

**Finding:** Five distinct branches on `if (reservation.booking_bundle_id == null)` or equivalent. **Files/lines:** `bundle.service.ts:121, 851`; `reservation.service.ts:402-407, 562`; `bundle-cascade.service.ts:83-88, 493`; `booking-flow.service.ts:262, 273-316`. **Impact:** Each becomes either trivially true or dead-code on cleanup. The visitor-cascade gate at `reservation.service.ts:562` is the most impactful — today, room-only edits never emit visitor events because no bundle exists; under canonical, every room edit fires the lookup (no-op for room-only bookings, but a query per edit).

**Finding:** `runPostCreateAutomation` does NOT branch on bundle existence. **Files/lines:** `ticket.service.ts:693-727`. **Impact:** Untouched. Booking-origin work orders use the separate `createBookingOriginWorkOrder` path (`:1732-1830`) which already requires a bundle id and never went through `runPostCreateAutomation`.

**Finding:** `DispatchService` and `createBookingOriginWorkOrder` both assume the bundle exists when called. **Files/lines:** `ticket.service.ts:1732-1830`; `setup-work-order-trigger.service.ts:95`; `bundle.service.ts:330-342`. **Impact:** Setup trigger can fire from any place where a reservation exists once bundle is canonical. No behavior changes in dispatch itself; the gate "this booking has services so it has a bundle" goes away.

**Finding:** Visitors module's dual-link is the largest collapse. **Files/lines:** `invitation.service.ts:135-136`; `visitors.controller.ts:415`; `reception.controller.ts:166,173`; `dto/schemas.ts:41` + `dto/create-invitation.dto.ts:40`; `bundle-cascade.adapter.ts:316-322`; `reservation.service.ts:598-602`; `apps/web/src/components/desk/visitor-detail.tsx:476-501` (the "prefer reservation_id, fall back to booking_bundle_id" lookup). **Impact:** Dual link existed because some invites land before/without a bundle; under canonical, `booking_bundle_id` becomes the only join, `reservation_id` becomes derivable (or kept as denormalised shortcut to the primary reservation).

**Finding (corrected v2 — completeness reviewer):** Approvals attach to BOTH reservation and bundle today, AND filter sites are non-trivial. **Files/lines:** `booking-flow.service.ts:567-588` (writes `target_entity_type: 'reservation'`); `bundle.service.ts:274-283` (writes `target_entity_type: 'booking_bundle'`); `approval.service.ts:329-347` (dispatcher); `multi-room-booking.service.ts:221` (filters by `target_entity_type='reservation'`); `bundle-visibility.service.ts:127, 143` (filters by `'booking_bundle'`); `orders/approval-routing.service.ts:37` (typed as `'booking_bundle' | 'order'`). **Impact:** Two distinct approval flows depending on whether services were attached before/with the booking. Under canonical, the `reservation` target type retires and approvals always anchor on the bundle. **The cutover risk is concrete — see §2.5 #3 + §5 measurement: 13 in-flight pending reservation-typed approvals exist on the dev DB.**

**Finding:** Calendar sync (Outlook) does NOT branch on bundle today — it's a TODO. **Files/lines:** `room-mailbox.service.ts:10,46,62,196,261,317,367`; both `booking_bundles.calendar_event_id` (`00140:26`) and `reservations.calendar_event_id` (`00122:50-52`) exist as parallel columns. **Impact:** Two surface candidates exist; the canonical-bundle move makes it uncomplicated to choose `booking_bundles.calendar_event_id` as the canonical path.

---

## Section 2.5 — Critical structural findings (NEW in v2)

These three findings, surfaced by the completeness review, are the load-bearing structural issues the spec must explicitly resolve. They were buried or missed in v1.

### #1 — Recurrence is a fan-out multiplier, not a peer

**Files/lines:** `recurrence.service.ts:413-426` (per-occurrence calls `bookingFlow.create` WITHOUT passing `booking_bundle_id`); `cloneBundleOrdersToOccurrence:467-505` (writes orders against `master.booking_bundle_id` — the master's bundle, not the occurrence's).

**Today's reality (broken-by-design):** When a recurring series has services, each occurrence's `reservations.booking_bundle_id` stays NULL, but the orders attached to the occurrence point at the master's bundle id. There are two bundles per occurrence in the loosest sense — the absent one (NULL on the reservation) and the master's that orders join to.

**Under canonical:** Every occurrence gets its own bundle from `BookingFlowService.create`. The `cloneBundleOrdersToOccurrence` SQL `eq('booking_bundle_id', args.bundleId)` continues to use the master bundle. **You now have two bundles in play per occurrence — the new one from `create`, and the master's that orders are joined to.**

**Volume risk:** A 90-day-window daily series can produce ~90 occurrences. Under canonical, materialisation triggers ~90 bundle inserts + ~90 visitor cascade emits. Power-user creates one series; production sees the load spike Monday morning.

**Spec must answer:** One bundle per series-occurrence (clean but high-volume) OR one bundle per series with reservations as children (matches today's intent but contradicts "every reservation has a bundle")? Today's hybrid is neither — pick one explicitly.

### #2 — Multi-room writes bundle_id OUTSIDE `BookingFlowService`

**Files/lines:** `multi-room-booking.service.ts:165, 201` (the `from('reservations')` writes that retrofit the bundle id onto sibling rooms after the primary's first-service-attach).

**Today's reality:** v1's claim "where would always-create-bundle live: one answer, BookingFlowService.create" is wrong. Multi-room has a second insertion point — a bundle-fan-out write loop to siblings — that lives outside that method entirely.

**Under canonical:** Either lift bundle creation up to BEFORE the per-room loop in `MultiRoomBookingService.startGroupBooking` (clean: one bundle, N reservations all stamped at insert), OR keep the fan-out loop and just remove the lazy gate. The first is the right answer; the second is technical debt.

**Spec must answer:** One bundle per multi-room group (today's behavior, preserved) OR one bundle per room within a group (contradicts user vocabulary)? Today: one per group. Lift the bundle insert upward and stop the fan-out write.

### #3 — In-flight `target_entity_type='reservation'` approvals = 13 pending

**Files/lines:** `approval.service.ts:329-347` (dispatcher branches on `target_entity_type`); `bundle-visibility.service.ts:127, 143` (filters by `'booking_bundle'` only — becomes the only surface granting approver visibility under canonical); `multi-room-booking.service.ts:221` (filters by `'reservation'` — under canonical this branch becomes dead and the multi-room approval lookup must be re-pointed at `'booking_bundle'`).

**Today's reality:** 13 in-flight pending `target_entity_type='reservation'` approvals exist on the remote dev DB (measured §5). The 13 approvers see these in their queue today via the dispatcher's reservation branch.

**Under canonical:** If the dispatcher branch for `target_entity_type='reservation'` is removed in the same release as the schema change, those 13 approvers lose visibility into approvals they own — the bundle-visibility filter at `:143` won't match because the `target_entity_id` points at a reservation, not a bundle.

**Spec must answer:** (a) Deprecation window — keep the dispatcher branch live for one release while new approvals are bundle-typed, OR (b) data migration — re-target the 13 pending rows to `target_entity_type='booking_bundle', target_entity_id=<their bundle id>` in the migration. (b) is cleaner if the bundles are guaranteed to exist post-backfill (which they are).

---

## Section 3 — Frontend surfaces affected

**Finding:** Three primary TS types model nullable bundle. **Files/lines:** `apps/web/src/api/room-booking/types.ts:85`; `apps/web/src/api/orders/types.ts:12`; `apps/web/src/api/visitors/index.ts:108,154` + `apps/web/src/api/visitors/admin.ts:391`. `apps/web/src/api/booking-bundles/types.ts:71` (`BookingBundle.primary_reservation_id: string | null` — inverse nullability — also flips for reservation-anchored bundles). **Impact:** All become non-null on the reservation side. `BookingBundle.primary_reservation_id` stays nullable for services-only bundles unless those are also folded in.

**Finding (file paths corrected v2):** Components branching on `reservation.booking_bundle_id == null`. **Files/lines:** `apps/web/src/components/booking-detail/booking-detail-content.tsx:394`; `apps/web/src/components/booking-detail/bundle-services-section.tsx:62-148`; `apps/web/src/pages/desk/bookings.tsx:413`; `apps/web/src/components/booking-composer/booking-composer.tsx:528-545`. **Impact:** Every conditional becomes "always true" once the type narrows. Empty-state in `bundle-services-section.tsx:98-148` gets simpler. Composer's two-shape result handling collapses.

**Finding:** Parallel React Query hooks for reservation vs bundle. **Files/lines:** `apps/web/src/api/room-booking/queries.ts:109` (`useReservationDetail`); `apps/web/src/api/booking-bundles/queries.ts:31` (`useBundle`); `apps/web/src/components/desk/visitor-detail.tsx:495,501`; `apps/web/src/components/booking-detail/bundle-services-section.tsx:236`; `apps/web/src/components/booking-detail/bundle-work-orders-section.tsx:42`. **Impact:** Hooks themselves are different and probably stay split — but the visitor-detail fallback pattern collapses to a single canonical lookup. `useReservationDetail` could include `bundle: BookingBundle` inline so most call sites stop double-fetching.

**Finding:** Booking detail surfaces stitch reservation + bundle separately today. **Files/lines:** `apps/web/src/components/booking-detail/booking-detail-content.tsx:18-72`; `apps/web/src/components/booking-detail/bundle-services-section.tsx:62-236`; `apps/web/src/components/booking-detail/bundle-work-orders-section.tsx:42`. **Impact:** Two-step "reservation → maybe bundle" load could collapse to "load booking" once the model is canonical. Doesn't have to — but it halves round-trips on the booking detail page.

**Finding:** Composer's submit conditionally creates a bundle. **Files/lines:** `apps/web/src/components/booking-composer/booking-composer.tsx:528-567` (handles two response shapes); `state.ts:8,91`; `sections/visitors-section.tsx:9`. **Impact:** Composer's submit path simplifies — every booking returns a `booking_bundle_id`, no need to branch on whether services were included.

**Finding:** Multi-room frontend handling. **Files/lines:** `booking-composer.tsx:528-567` handles `reservations[]` array; `multi-room-booking.service.ts:130-131` only attaches services to primary room. **Impact:** Under canonical, "does multi-room create one bundle or N bundles" becomes load-bearing. Today it's one bundle (anchored on primary reservation). Frontend already handles this — no UI change needed if answer stays "one bundle for the group".

**Finding (added v2 — completeness reviewer):** Frontend deeplink in approvals breaks for services-only bundles. **Files/lines:** `apps/web/src/pages/desk/approvals.tsx:276` (links to `/desk/bookings?scope=bundles&id=${bundle.primary_reservation_id ?? ''}`). **Impact:** Already broken today when `primary_reservation_id` is null. Canonical doesn't fix it; spec should call out and either fix in this slice or track as a follow-up.

---

## Section 4 — Tests that depend on the lazy invariant

**Finding (corrected v2 — accuracy reviewer found 9 not 5):** Spec files explicitly fixturing or asserting no-bundle state. **Files/lines:** `multi-room-booking.service.spec.ts:49`; `reservation.service.events.spec.ts:65, 236-240`; `bundle.service.spec.ts:5,9` (`it.todo('creates a bundle on first-service-attach')`); `recurrence-materialize.service.spec.ts`; `bundle.service.edit-line.events.spec.ts`; `bundle-cascade.service.events.spec.ts`; `bundle-visibility.service.spec.ts`; `booking-origin-work-order.spec.ts`; `bundle-cascade-integration.spec.ts:53,99,126,176`. **Impact:** ~3 explicit no-bundle assertions + 6 fixture files where `booking_bundle_id: null` becomes a real bundle id. **FK ordering forces every reservation-creating fixture to also create a bundle row first** — this multiplies edits across many test files even where the assertion shape stays the same.

**Finding:** Visitor-cascade test fixtures encode the dual-link. **Files/lines:** `bundle-cascade.adapter.spec.ts:38,104,157+`; `bundle-cascade-integration.spec.ts:53,99,126,176`. **Impact:** Specs keep working — they pass an explicit `bundle_id`. Just check fixtures don't assert "visitor has reservation_id but no booking_bundle_id".

**Finding:** Seed data — only ~8 reservation rows in `00133`, none with bundle. **Files/lines:** `00133_seed_room_booking_examples.sql`; `00172_seed_booking_services_demo.sql` (zero reservation/bundle rows). **Impact:** Seed reservations need bundles backfilled by the migration.

**Finding:** Smoke gate does NOT depend on lazy invariant. **Files/lines:** `apps/api/scripts/smoke-work-orders.mjs`. **Impact:** Untouched.

---

## Section 5 — Migration data scope (MEASURED in v2)

**v1 claim:** "Production-row counts can't be measured without DB access." — **WRONG.** Credentials are in `.claude/CLAUDE.md`. Measured 2026-05-02 against remote dev DB:

| Metric | Value |
|---|---|
| reservations total | 32 |
| no-bundle reservations | **26 (81%)** — not the v1 "95%" prediction |
| with-bundle reservations | 6 (19%) |
| booking_bundles total | 7 |
| bundle_type histogram | meeting: 6, hospitality: 1 |
| services-only bundles (`primary_reservation_id IS NULL`) | 1 |
| in-flight `target_entity_type='reservation'` approvals (status=pending) | **13** |
| recurring series total | 2 |
| occurrences in series | 5 |
| reservation status mix | confirmed:14, pending_approval:11, released:5, cancelled:1, checked_in:1 |

**Observations from measurement:**
- Dev DB scale is small — production tenants will be 10-1000× larger; numbers above are useful for migration safety scaffolding (table locks, batched backfill thresholds), not for "is the architecture worth it" judgement.
- The 81% no-bundle ratio is high enough that the partial-index assumption (`00199`) was approximately right *directionally* but the specific 95% prediction was unsupported.
- 13 in-flight reservation-typed approvals on a 32-row dev DB is significant — at customer scale this is the dominant migration risk (see §2.5 #3).
- Services-only bundles are real but rare (1 row). Spec must explicitly carve them out of the backfill predicate (`WHERE reservations.booking_bundle_id IS NULL`).

**Cancelled / archived reservations:** 5 released + 1 cancelled = 6 rows (19% of total). Spec must decide — backfill for cancelled too (preserves invariant absolutely, creates dead bundles), or skip them (cleaner but breaks invariant for past data). At dev-DB scale either choice is cheap; recommend backfill for the absolute invariant.

**Orphan-bundle risk** stays as v1 described — no measurement changes this. The 1 services-only bundle is a real instance; backfill must NOT touch it.

---

## Section 6 — Risky places where the cutover could silently break

**Finding (caveat added v2):** RLS policies surveyed do NOT compose `booking_bundle_id IS NULL` conditions. **Files/lines surveyed:** `00125`, `00140`, `00142`, `00148`, `00185`, `00210`, `00213`, `00245`, `00252` — all RLS is pure `tenant_isolation`. **v2 caveat:** Completeness reviewer noted this is a sample, not exhaustive. Re-grepped all 275 migrations: zero policies compose bundle-presence conditions. Notable cross-references — `reservation_visitors` (00159–00160) and `calendar_sync_events` (00126) both gate by reservation visibility (not bundle), so canonical doesn't change RLS semantics. **Impact:** Low — confirmed exhaustive. Visibility lives entirely in TS service layer.

**Finding:** Reservation BEFORE-INSERT trigger does NOT inspect bundle. **Files/lines:** `00122:59-73` (`set_reservations_effective_window` — pure time-math). **Impact:** None.

**Finding:** Visitor status trigger requires session marker. **Files/lines:** `visitor.service.ts:113-119`; `00270_visitor_status_insert_validation_and_service_marker.sql`. **Impact:** Backfilling visitor.booking_bundle_id is fine (status not touched), but if migration also collapses any visitor state, it must run via the same `set_config('visitors.transition_marker', 'true', true)` pattern.

**Finding (revised v2 — compliance-touching):** Audit events distinguish reservation vs bundle today across **7+ call sites**. **Files/lines:** `entity_type: 'reservation'` at `reservation.service.ts:359, 389, 454, 540`; `booking-flow.service.ts:602`; `check-in.service.ts:90, 178`. `entity_type: 'booking_bundle'` at `bundle.service.ts:393, 1078, 1187, 1293`; `bundle-cascade.service.ts:353`. **Impact:** Audit-events have **7-year legal-hold retention** (`adapters/audit-events.adapter.ts:13` — NL compliance). Reporting that filters `entity_type='reservation'` will under-count under canonical (events that "should" have been bundle-anchored will land somewhere). v1 said "design call, orchestrate per-event" — that's not concrete enough. **The spec must include an explicit per-call-site mapping table** with a decision on whether old `entity_type='reservation'` rows get rewritten in `audit_events` or stay as historical artifacts. **Adds ~0.5 day to §7.2.**

**Finding:** Realtime channels are scoped per-table. **Files/lines:** `use-realtime-bundle.ts:52-68`; `use-realtime-scheduler.ts:81+`; `00132_reservations_realtime.sql` + `00173_bundle_lines_realtime.sql`. **Impact:** Two channel naming schemes (`bundle-lines:` vs `desk-scheduler:`) overlap conceptually. Under canonical they could consolidate but don't have to.

**Finding:** Calendar event id duplicated on bundle and reservation. **Files/lines:** `00140:26-29`; `00122:50-52`. **Impact:** Outlook integration unwired today; canonical model decides the canonical path. No production calendar integration writing yet — link rot bounded.

**Finding:** No materialized views or denormalised columns depend on bundle absence. **Files/lines:** Re-verified v2: zero `create materialized view` across all 275 migrations. All status views (`booking_bundle_status_v`, `fulfillment_units_v`) are regular views. **Impact:** Low.

---

## Section 7 — Time/effort estimates (REVISED in v2)

v1 estimates were too optimistic. Both adversarial reviewers independently landed on roughly the same revised numbers. v2 estimates incorporate: §2.5 structural findings, §6 audit-event mapping, accuracy-reviewer's production-scale ALTER TABLE NOT NULL semantics, completeness-reviewer's test fixture FK ordering.

**7.1. Migration + backfill SQL — 2 to 3 engineer-days** (v1: 1–1.5; revised up).
- ALTER TABLE NOT NULL on `reservations.booking_bundle_id` — at customer scale, AccessExclusiveLock is non-trivial. Use `NOT VALID` + `VALIDATE CONSTRAINT` two-pass to avoid full table scan under lock.
- Batched CTE backfill (otherwise transaction bloat at 10K+ row tenants).
- Convert ~6 partial indexes to plain indexes via `CREATE INDEX CONCURRENTLY` + `DROP INDEX CONCURRENTLY` — choreographed to avoid app downtime.
- Drop now-vacuous `WHERE booking_bundle_id IS NOT NULL` clauses in report RPCs.
- Re-target 13 pending `target_entity_type='reservation'` approvals OR keep dispatcher branch live for deprecation window (see §2.5 #3).
- Decide bundle_type default per `reservation_type` (today: `'meeting'` blanket vs introduce `'minimal'`).
- Re-spec `reservation_visibility_ids` (00157), `reservation_merge_policy_snapshot` (00138), `search_global` (00158) for bundle awareness.
- Lines: ~200–300.

**7.2. API service layer rewrite — 5 to 8 engineer-days** (v1: 3–5; revised up).
- `BookingFlowService.create` insert path moves to "always create bundle" — straightforward.
- `lazyCreateBundle` becomes `ensureBundle` or absorbed.
- **Resolve §2.5 #1 (recurrence fan-out):** decide one-bundle-per-occurrence or one-bundle-per-series, then implement. Likely +1–1.5 days alone.
- **Resolve §2.5 #2 (multi-room insertion point):** lift bundle creation above the per-room loop in `MultiRoomBookingService.startGroupBooking`, remove the fan-out write at `:165, 201`. Likely +0.5 day.
- **Resolve §2.5 #3 (approval cutover):** dispatcher cleanup + multi-room approval filter re-point + in-flight row migration. +0.5–1 day.
- **Audit-event entity_type mapping (§6 revised):** explicit per-call-site decisions. +0.5 day.
- Visitor-cascade emit gate at `reservation.service.ts:562` — verify subscribers no-op cheaply on bundles with no visitors. +0.5 day if subscribers need adjustment.
- Files touched: ~12. Lines: ~700–1,100.

**7.3. Frontend type cleanup + component updates — 1.5 to 2.5 engineer-days** (unchanged).
- Flip nullables in 3 type files. Remove "no bundle yet" branch in `bundle-services-section.tsx` (~50 lines). Simplify `booking-detail-content.tsx:394`. Composer's two-shape result handling collapses (~30 lines). Visitor-detail fallback collapses. The `has_bundle` filter in `room-booking/keys.ts:34-37` and `reservation.service.ts:228, 257` becomes a no-op or the chip disappears from `/desk/bookings`. Address `approvals.tsx:276` deeplink (track or fix).
- Files: ~9. Lines: net deletion of ~150–250.

**7.4. Test suite updates + smoke-test additions — 3 to 4 engineer-days** (v1: 2–3; revised up).
- 9 spec files (not 5) explicitly depend on the lazy invariant (per accuracy-reviewer recount).
- Every reservation-creating fixture across the test suite now needs a bundle row first (FK ordering). Fixture-helper consolidation prevents per-spec edits.
- Add smoke probe verifying every `POST /reservations` returns non-null `booking_bundle_id`.
- Recurrence series materialization needs new fixtures asserting whichever rule the spec picks (per-occurrence vs per-series).
- Lines: ~400–600.

**Total revised: 11.5–17.5 engineer-days**, median ~14.5 days, **~3 calendar weeks** with codex reviews per slice and back-track buffer (the project mandates per-slice codex review per `.claude/CLAUDE.md`).

## 7.5 Highest-risk unknowns (revised v2)

1. **~~Real row counts~~ — MEASURED.** See §5. Not an unknown anymore.
2. **Services-only bundles' fate.** `order.service.ts:716` `createServicesOnlyBundle` creates bundles with `primary_reservation_id IS NULL`. Under canonical these stay (not reservation-anchored), but the "every reservation has a bundle" invariant is one-directional — bundles can still exist without reservations. **Spec must make this explicit** otherwise frontend may assume bundle ↔ reservation 1:1.
3. **Recurrence semantics decision (§2.5 #1).** One bundle per occurrence vs one per series? Today's hybrid is broken. Spec must resolve before any code changes.
4. **Multi-room insertion-point refactor (§2.5 #2).** Lift above the loop or keep the fan-out write? Lift is cleaner but touches more.
5. **Approval migration strategy (§2.5 #3).** Deprecation window (safe but slow) vs in-place re-target (fast but irreversible). Spec must pick.
6. **Audit-event entity_type mapping (§6 revised).** Compliance-touching; needs explicit per-call-site table in spec.
7. **~~Visitor-cascade per edit "~50ms × N edits/min"~~ — FABRICATED in v1.** The cascade is an indexed point-lookup, sub-ms. The structural concern (visitor-cascade running per room edit under canonical, even for room-only bookings) is real; the quantitative claim was invented. Revised: monitor edit-handler latency in production once shipped; alert if median >5ms.
8. **Calendar-sync mapping.** `room-mailbox.service.ts:46-261` is unwired Phase C. Whether canonical bundles change the design depends on whether the spec wants Outlook events to map to reservation-or-bundle. The duplicate columns suggest this hasn't been decided.

---

## Reviewer-flagged corrections summary (v2)

For audit trail. Each was confirmed against the code.

| Source | Severity | Change applied |
|---|---|---|
| Completeness reviewer C1 | Critical | Recurrence fan-out — added §2.5 #1 |
| Completeness reviewer C2 | Critical | Multi-room raw-write outside `BookingFlowService` — added §2.5 #2 |
| Completeness reviewer C3 | Critical | Approval cutover risk to in-flight rows — added §2.5 #3 |
| Completeness reviewer C4 | Critical | RLS sample → re-verified exhaustive in §6; reservation_visitors / calendar_sync_events flagged |
| Completeness reviewer C5 | Critical | Additional SQL functions surveyed in §1 (reservation_merge_policy_snapshot, reservation_visibility_ids, search_global) |
| Completeness reviewer I8 | Important | DB credentials available — measurements added in §5 |
| Completeness reviewer I9 | Important | In-flight approval count measured = 13 |
| Completeness reviewer I10 | Important | Audit-event mapping is compliance-touching — §6 revised, +0.5d in §7.2 |
| Completeness reviewer I11 | Important | `approvals.tsx:276` deeplink finding added in §3 |
| Accuracy reviewer #1 | Critical | "Three creation paths" → at least four, recurrence is fan-out — §2 corrected |
| Accuracy reviewer #2 | Critical | Row counts measured — §5 replaced |
| Accuracy reviewer #3 | Important | Frontend file paths fixed with full folders — §3 corrected |
| Accuracy reviewer #4 | Important | Migration estimate 1–1.5d → 2–3d — §7.1 revised |
| Accuracy reviewer #5 | Important | "50ms × N edits/min" → fabricated, removed; structural concern preserved — §7.5 revised |
| Accuracy reviewer #8 | Important | Test estimate 2–3d → 3–4d, 9 spec files not 5 — §7.4 revised |
| Both reviewers | Critical | Total estimate 7.5–12d → 11.5–17.5d, ~2wk → ~3wk — §7 revised |
