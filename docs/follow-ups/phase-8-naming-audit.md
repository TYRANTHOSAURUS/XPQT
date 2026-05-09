# Phase 8.A.1 — naming-canonicalization audit

> **Status:** v1 audit. NO code changes shipped — this doc + the
> `apps/api/src/.naming-allowlist.txt` are the only artifacts. Phase
> 8.A.2 (the actual sweep) is gated on the migration plan in §3 below.
>
> **Date:** 2026-05-09. **Branch:** `main` at `0690803`.
> **Scope:** TS code only. Migration history (`supabase/migrations/`)
> is sampled for sanity but not enumerated — those files are the
> historical record.

## 0. tl;dr

The post-canonicalisation TS surface is **larger than the v1 plan
estimated** (475 vs. 209 legacy table-name sites in `apps/api/src`,
once `bundle_id` and `reservation_id` field-name aliases are counted)
but **the cleanup risk is much lower** than the gross numbers suggest:

- **No live SQL queries against `from('booking_bundles')` or
  `from('reservations')` remain in either `apps/api/src` or
  `apps/web/src`.** The legacy tables were dropped in 00276 and the
  new schema landed in 00277 — every Supabase `.from(...)` call is
  already on `bookings` / `booking_slots`.
- **The `tickets.{ticket_type_id, workflow_id, sla_id}` columns are
  intentional B.2 §0.1 asymmetries** — runtime row uses the short
  name, configuration table uses the long (`request_type_id`,
  `workflow_definition_id`, `sla_policy_id`). TS code that reads /
  writes these columns IS NOT a bug. The "asymmetry" only matters
  when the same logical id flows through both layers (resolver in →
  config out → row in).
- **Most legacy bundle/reservation refs in TS are one of three
  intentional things:** (a) `bundle_id` / `reservation_id` retained
  as a backwards-compat field name on a service-method argument or
  return shape, (b) a comment documenting a column rename ("renamed
  from booking_bundles in 00277"), or (c) a column on a non-renamed
  sibling table (`asset_reservations.linked_asset_reservation_id`,
  `recurrence_series.parent_reservation_id`).

Phase 8.A.2 is therefore narrower than v1 implied: **rename the
backwards-compat field-name aliases module-by-module, leave the
schema asymmetry as-is**, and accept the historical comments. The
allowlist file at `apps/api/src/.naming-allowlist.txt` lists the
intentional refs so a future CI guard can pin them.

---

## 1. Summary counts

### `apps/api/src/` (TypeScript, all files)

| Pattern | Lines | Files |
|---|---:|---:|
| `booking_bundle\|bundle_member\|bundle_id` | **238** | 41 |
| `reservation_id\b\|\breservations\b` | **237** | 56 |
| `ticketTypeId\|requestTypeId\|ticket_type_id\|request_type_id` | **285** | 44 |
| → split: `request_type_id\|requestTypeId` | 210 | — |
| → split: `ticket_type_id\|ticketTypeId` | 82 | — |
| `\bworkflow_id\b\|\bworkflowId\b\|workflow_definition_id\|workflowDefinitionId` | **67** | 14 |
| → split: `workflow_definition_id\|workflowDefinitionId` | 52 | — |
| → split: `\bworkflow_id\b\|\bworkflowId\b` | 15 | — |
| `\bsla_id\b\|\bslaId\b\|sla_policy_id\|slaPolicyId` | **319** | 34 |
| → split: `sla_policy_id\|slaPolicyId` | 144 | — |
| → split: `\bsla_id\b\|\bslaId\b` | 182 | — |
| **Live SQL targeting `from('booking_bundles')` or `from('reservations')`** | **0** | 0 |

**Top 20 files (by combined legacy + asymmetry count) in `apps/api/src`:**

| File | Bundle | Reservation | TicketType | Workflow | SLA |
|---|---:|---:|---:|---:|---:|
| `modules/booking-bundles/bundle.service.ts` | 43 | 25 | — | — | — |
| `modules/booking-bundles/bundle-cascade.service.ts` | 31 | 27 | — | — | — |
| `modules/orders/order.service.ts` | 27 | 20 | — | — | — |
| `modules/work-orders/work-order.service.ts` | — | — | — | — | 34 |
| `modules/ticket/ticket.service.ts` | 10 | — | 13 | 6 | 24 |
| `modules/ticket/dispatch.service.ts` | — | — | 16 | — | 22 |
| `modules/ticket/dispatch.service.spec.ts` | — | — | 3 | — | 26 |
| `modules/config-engine/request-type.service.ts` | — | — | 42 | 16 | 21 |
| `modules/sla/sla.service.ts` | — | — | — | — | 17 |
| `modules/routing/resolver.service.spec.ts` | — | — | 20 | — | — |
| `modules/sla/sla.service.spec.ts` | — | — | — | — | 15 |
| `modules/work-orders/work-order-sla-edit.spec.ts` | — | — | — | — | 14 |
| `modules/webhook/webhook-mapping.service.spec.ts` | — | — | 15 | — | — |
| `modules/webhook/webhook-mapping-validator.spec.ts` | — | — | 14 | — | — |
| `modules/routing/routing-evaluator.service.ts` | — | — | 14 | — | — |
| `modules/workflow/workflow-engine.service.spec.ts` | — | — | — | — | 13 |
| `modules/ticket/dispatch-scope-override.spec.ts` | — | — | — | — | 13 |
| `modules/visitors/bundle-cascade.adapter.spec.ts` | 13 | — | — | — | — |
| `modules/webhook/webhook-admin.service.ts` | — | — | 12 | 6 | — |
| `modules/ticket/booking-origin-work-order.spec.ts` | 12 | — | — | — | — |

### `apps/web/src/` + `packages/`

| Pattern | Lines | Files |
|---|---:|---:|
| `booking_bundle\|bundle_member\|bundle_id` | **32** | 16 |
| `reservation_id\b\|\breservations\b` | **110** | 34 |
| `ticketTypeId\|requestTypeId\|ticket_type_id\|request_type_id` | **93** | 19 |
| `\bworkflow_id\b\|\bworkflowId\b\|workflow_definition_id\|workflowDefinitionId` | **21** | 9 |
| `\bsla_id\b\|\bslaId\b\|sla_policy_id\|slaPolicyId` | **73** | 22 |
| **Live SQL targeting legacy tables (`from('booking_bundles' \| 'reservations')`)** | **0** | 0 |

Web-side concentration is in `apps/web/src/api/` modules (typed
payload shapes) and `apps/web/src/pages/desk/scheduler/`. The largest
web file is `apps/web/src/api/room-booking/mutations.ts` with 15
reservation refs and 4 bundle refs; all are payload field names that
the backend still emits as `reservation_id` for backwards compat.

### `supabase/migrations/`

- 24 files reference `booking_bundles` — all are **legitimate
  history** (the table existed in migrations 00140–00275 and was
  dropped in 00276). Forward-going migrations (00277+) reference the
  legacy name only in comments documenting the rename or in the
  retarget migration 00278 (which renames sibling-table FKs).
- 273 lines reference `booking_bundle\|bundle_member` and 202
  reference `\breservations\b` — virtually all in pre-rewrite
  migrations and the rewrite migration itself.
- **No new code in 00277+ creates legacy-named objects.** Sampled
  00299 (outbox foundation) — clean. Sampled 00309–00315 (combined
  RPCs) — clean.

Migration files are not enumerated in the allowlist; they are
historical and immutable.

---

## 2. By-category breakdown

### A. Variable / type names referencing legacy `booking_bundles` table

**Total:** 238 lines, 41 files in `apps/api/src/`.

**Sub-breakdown by classification:**

| Classification | Approx lines | Files (top examples) |
|---|---:|---|
| `KEEP_HISTORICAL_COMMENT` (column-rename docs) | ~110 | `bundle.service.ts`, `bundle-cascade.service.ts`, `order.service.ts`, `ticket.service.ts`, `reservation.service.ts`, `booking-flow.service.ts` |
| `KEEP_BACKWARDS_COMPAT_FIELD` (`bundle_id` retained as method-arg / return-shape field name; equals booking id under new schema) | ~95 | `bundle.service.ts` (lines 184, 996, 1713, 1779…), `reservation.controller.ts`, `orders/order.service.ts`, `attach-plan.types.ts` |
| `KEEP_AUDIT_ENTITY_TYPE` (`'booking_bundle'` literal preserved as `audit_events.entity_type`/`outbox_events.entity_type` for historical row compatibility) | ~15 | `bundle.service.ts:527-543`, `bundle.service.ts:1937`, `bundle.service.ts:1967`, `approval.service.ts`, `portal-approvals-lane.tsx` |
| `RENAME` (genuinely stale TS variable that should adopt canonical naming) | ~18 | spec fixtures using `booking_bundle_id: 'b'` as row-shape (e.g. `booking-origin-work-order.spec.ts`, `bundle-cascade.adapter.spec.ts`) — keep payload key, rename the local variable to `booking_id` where the type is the new row |

**Recommended action:** Most refs are intentional and stay. The
~18 RENAME candidates are in spec files where the variable is
constructing a mock row that should match the new row shape. These
are safe to update mechanically and are well-covered by the existing
test suite.

### B. Variable / type names referencing legacy `reservations` table

**Total:** 237 lines, 56 files in `apps/api/src/`.

**Sub-breakdown:**

| Classification | Approx lines | Notes |
|---|---:|---|
| `KEEP_LEGITIMATE_OTHER_TABLE` — `asset_reservations.*`, `linked_asset_reservation_id`, `cancelled_asset_reservation_ids` | ~85 | `asset_reservations` is a separate, non-renamed table. Every ref to it is correct. |
| `KEEP_LEGITIMATE_OTHER_TABLE` — `recurrence_series.parent_reservation_id` (renamed but to a sibling table; col name retained) | ~5 | `booking-flow.service.ts:977`, `recurrence.service.ts` |
| `KEEP_HISTORICAL_COMMENT` (rename docs / rationale) | ~50 | `bundle-cascade.service.ts`, `reservation.service.ts`, `booking-flow.service.ts`, `approval.service.ts` |
| `KEEP_BACKWARDS_COMPAT_FIELD` (`reservation_id` retained on RPC arg / return shape — under new schema `reservation_id == booking_slot_id`) | ~40 | `bundle-cascade.service.ts:512`, `magic-check-in.token.ts`, `reception.controller.ts`, `reservation-projection.ts` |
| `RENAME` (clear stale TS-only variable / type field) | ~20 | spec fixtures, internal helper vars in `reservations/*` |
| `INVESTIGATE` (visitors/calendar-sync refs that may be either pre-rewrite junction-table residue or legitimate) | ~37 | `calendar-sync/__tests__/reconciler.diff.spec.ts` (9 refs), `bundle-cascade-integration.spec.ts` (7 refs), `multi-room-booking.service.ts` (5) |

**Recommended action:** Bulk-classify the `asset_reservations` lines
under `KEEP_LEGITIMATE_OTHER_TABLE` and stop counting them. The
~37 INVESTIGATE rows in calendar-sync + visitors specs need
case-by-case review during 8.A.2 — most are likely ok but a handful
may genuinely write to the new `booking_slots` table while still
calling the variable `reservation_id`.

### C. Naming asymmetry: `ticket_type_id` ↔ `request_type_id`

**Total:** 285 lines, 44 files in `apps/api/src/`.

**Important framing:** This is NOT a bug — `tickets.ticket_type_id`
is the runtime DB column (FK to `request_types`) and
`request_types.id` resolves to a `request_type_id` everywhere else
(routing rules, scope overrides, audience rules, etc.). The two
names live on two different tables and TS code uses each correctly
**most of the time**.

**Sub-breakdown:**

| Classification | Approx lines | Notes |
|---|---:|---|
| `KEEP_DB_COLUMN` — read/write of `tickets.ticket_type_id` or `work_orders.ticket_type_id` | ~70 | `ticket.service.ts`, `dispatch.service.ts`, `reclassify.service.ts` |
| `KEEP_DB_COLUMN` — `request_type_id` on a non-tickets table (routing rules, audience rules, coverage rules, categories) | ~140 | `request-type.service.ts` (42 refs all on config tables), `routing-evaluator.service.ts`, `audit.service.ts`, `service-catalog.service.ts` |
| `RENAME` (TS-only var that mismatches its function role) | ~30 | `dispatch.service.ts:283` — `const requestTypeId = row.ticket_type_id` (local rename for downstream call into resolver, correct but should be commented). `ticket.service.ts:783, 1315` — same shape. **Keep the renames** but add a one-line comment so a future reader doesn't mis-blame. |
| `INVESTIGATE` (test fixtures + webhook mapping where both names appear in the same payload) | ~45 | `webhook-mapping.service.spec.ts` (15 refs), `webhook-mapping-validator.spec.ts` (14), `webhook-mapping-validator.ts`, `routing/resolver.service.spec.ts` (20). Some of these are wire-shape probes for the webhook ingest contract — touching them = wire-shape change risk. |

**Recommended action:** Treat as a **documentation problem**, not a
rename problem. Add a comment block in `ticket.service.ts` and
`dispatch.service.ts` explaining the asymmetry once. Leave the
column reads alone. The ~45 INVESTIGATE webhook lines need a
careful read for wire-shape contract before any change.

### D. Naming asymmetry: `workflow_id` ↔ `workflow_definition_id`

**Total:** 67 lines, 14 files in `apps/api/src/`.

**Framing:** `tickets.workflow_id` (column) FKs to
`workflow_definitions.id`. The column was deliberately given a
short name in 00184 / 00220-area work to match what the workflow
engine row stores. Configuration tables (`request_types`, scope
overrides) use the long name `workflow_definition_id`.

**Sub-breakdown:**

| Classification | Lines | Notes |
|---|---:|---|
| `KEEP_DB_COLUMN` — `workflow_definition_id` on config tables | ~50 | `request-type.service.ts` (16), `webhook-admin.service.ts` (6), `routing/scope-override-resolver.service.ts` (3), `workflow-engine.service.ts:79, 183, 747` |
| `KEEP_DB_COLUMN` — `tickets.workflow_id` and `work_orders.workflow_id` | ~12 | `ticket.service.ts`, `reclassify.service.ts` |
| `RENAME` | 0 | None. The asymmetry is column-driven. |
| `INVESTIGATE` | ~5 | `workflow-engine.service.ts:79` — `workflow_id: { table: 'workflow_definitions', entityName: 'workflow' }`. Looks like a metadata map — confirm purpose. |

**Recommended action:** Leave alone. Add a comment.

### E. Naming asymmetry: `sla_id` ↔ `sla_policy_id`

**Total:** 319 lines, 34 files in `apps/api/src/`.

**Framing:** Same pattern. `tickets.sla_id` and `work_orders.sla_id`
are runtime columns; `sla_policy_id` is the column name on
`sla_policies.id` and on `sla_timers.sla_policy_id` (the per-ticket
timer). The runtime row stores `sla_id` (FK), the timer table stores
the long form. Both are correct.

**Sub-breakdown:**

| Classification | Lines | Notes |
|---|---:|---|
| `KEEP_DB_COLUMN` — `tickets.sla_id` / `work_orders.sla_id` reads/writes | ~140 | `work-order.service.ts` (34), `ticket.service.ts` (24), `dispatch.service.ts` (22), spec files |
| `KEEP_DB_COLUMN` — `sla_policy_id` on `sla_timers` and `sla_policies` config | ~120 | `sla.service.ts` (17), `sla.service.spec.ts` (15), `request-type.service.ts` (21), `service-routing.service.ts` (9), `scope-override-resolver.service.ts` (6) |
| `RENAME` (local var bridging the two — e.g. `const slaPolicyId = after.sla_id ?? before.sla_id`) | ~10 | `sla.service.ts:269`, `work-order.service.ts:701-742`. Already locally correct; comment is good enough. |
| `INVESTIGATE` (test fixtures with both names in the same payload) | ~40 | `work-order-sla-edit.spec.ts` (14), `dispatch-scope-override.spec.ts` (13), `ticket-sla-edit.spec.ts` (6) |
| Already in `.b2-config-reads-allowlist.txt` (B.2-scope reads) | ~9 | sla.service.ts entries documented |

**Recommended action:** Leave alone for runtime row writes. The
~40 INVESTIGATE test rows are fixture shapes — verify the test is
asserting the correct payload key (B.2 §0.1 says runtime is
`sla_id`).

---

## 3. Ordered migration plan for 8.A.2

The v1 plan estimated 132 + 209 = 341 sites for one engineer over
3-4 days. The audit reveals that **most refs are intentional**, so
the actual rename count is much smaller (~80-100 RENAME-class lines
across all 5 categories combined). 8.A.2 should be **smaller than
v1 estimated**, not bigger.

**Suggested 6-commit decomposition for `apps/api/src` (8.A.2):**

1. **Commit 1 — `booking-bundles` module spec fixtures.**
   Touch: `booking-origin-work-order.spec.ts`,
   `bundle-cascade.adapter.spec.ts`,
   `bundle-cascade.service.events.spec.ts`,
   `bundle.service.edit-line.events.spec.ts`,
   `bundle-visibility.service.spec.ts`. Update fixture row shapes
   from `booking_bundle_id` to `booking_id` where the type is now
   the new row; preserve the field where it's a method arg key. ~18
   line-level renames. Run `bundle-*.spec.ts` after.

2. **Commit 2 — `reservations` + `orders` spec fixtures.**
   Touch: `reservation.service.events.spec.ts`,
   `order-service-create-tenant-validation.spec.ts`,
   `approval-routing.assemble-plan.spec.ts`,
   `multi-room-booking.service.spec.ts`,
   `recurrence-materialize.service.spec.ts`. Same pattern. ~20
   line-level renames.

3. **Commit 3 — `calendar-sync` + `visitors` + `privacy-compliance`
   INVESTIGATE rows.** Read each ref carefully; classify into
   KEEP_* or RENAME. Touch: `calendar-sync/__tests__/`,
   `bundle-cascade-integration.spec.ts`, `sprint3.spec.ts`. ~37
   lines. The highest-risk commit because some refs may genuinely
   be writing to the new tables under the old variable name.

4. **Commit 4 — Documentation comments for ticket-type / workflow /
   sla asymmetry.** Add a block comment to the top of
   `ticket.service.ts` and `dispatch.service.ts` explaining the
   intentional asymmetry per B.2 §0.1, with a pointer to this audit
   doc. **Zero behavior change.**

5. **Commit 5 — Webhook mapping wire-shape audit.** Read every ref
   in `webhook-mapping*.spec.ts` and `webhook-mapping-validator.ts`.
   Classify each into the wire-shape contract (KEEP) vs. internal
   variable (RENAME). The webhook ingress payload is on the wire —
   any rename here is a public API change. ~45 lines, audit-only
   in this commit; renames (if any) deferred to commit 6.

6. **Commit 6 — Final cleanup + lint guard.** Add a CI script
   `scripts/check-naming-allowlist.sh` analogous to
   `scripts/check-b2-config-reads.sh` that diffs `rg` output
   against `apps/api/src/.naming-allowlist.txt` and fails on
   unexpected new refs. This locks the intentional set in.

**Phase 8.B (frontend) follows the same shape, smaller:** ~3
commits covering web-side type renames + the
`api/booking-bundles/` and `api/room-booking/` modules.

---

## 4. Risk register

### 4.1 Wire-shape compatibility risks

- **`webhook-ingest.service.ts` + `webhook-mapping.service.ts`** —
  the webhook ingest contract may emit `request_type_id` (config
  side) but accept `ticket_type_id` (runtime side). Renaming
  variables in this surface without auditing the wire-shape is a
  potential public-API breakage. **Action:** before commit 5,
  generate a list of every payload key that crosses the
  request/response boundary and pin it to a contract test.

- **`api/room-booking/mutations.ts` + `api/booking-bundles/mutations.ts`**
  on the web side — payload field names go on the wire. Backend
  currently accepts `bundle_id` AND `booking_id` per the
  attach-plan flow. Verify this before any web-side rename.

- **`api/visitors/index.ts:114`** — `booking_bundle_id` is on the
  visitor wire shape (renamed column 00278:41, but the **field
  name on the API** appears retained for backwards compat). Check
  whether any external integration consumes this; if yes, treat as
  versioned.

### 4.2 Test fixture renames

- ~38 spec files reference legacy table/column names in row-shape
  fixtures. Each fixture rename should be paired with a re-run of
  that file's test — not just typecheck. The mocked-Supabase tests
  pass even when row shape is wrong; the smoke gate
  (`pnpm smoke:work-orders`) catches some but not all.

### 4.3 Untouched legacy paths still in use

- **`booking_bundles` audit-event entity_type** — historical
  `audit_events` rows have `entity_type='booking_bundle'`. Code in
  `bundle.service.ts:527-543` deliberately preserves the literal
  string when emitting historical-format events. **Do not rename
  this string** — it would invalidate the audit timeline.
- **Approval `target_entity_type='booking_bundle'`** — same
  pattern in `approval.service.ts` and the portal approval lane.
  Pinned in the allowlist.
- **Outbox events** — `bundle.created` / `bundle.cancelled` event
  type names are downstream contracts. Treat as wire shape.

### 4.4 SQL function names with legacy prefixes

- `edit_booking_slot` (00291) — last caller cutover happens in B.4
  per the v1 plan §1 Phase 8.D. **Defer drop until B.4 ships.**
- `delete_booking_with_guard` (00292) — keep, name is fine.
- No other legacy-prefixed SQL functions found in 00277+.

---

## 5. Surprises uncovered during audit

1. **`bundle_id` is a deliberately-retained method-arg field name
   on most service methods even though the table is `bookings`.**
   This is a service-layer convention: `args.bundle_id` equals the
   booking's `id` under canonicalisation. Renaming all of these
   would be a large mechanical sweep with zero functional gain.
   The cleaner path is to add a comment block in
   `bundle.service.ts` explaining this convention and stop.

2. **`booking_bundle` lives on as a string literal in
   `audit_events.entity_type` and `approvals.target_entity_type`
   for backwards compat with historical rows.** This is correct
   behavior — renaming it would break audit-log integrity. Pinned.

3. **The `request_type_id` ↔ `ticket_type_id` asymmetry has 285
   lines** — much larger than the v1 plan's 132 estimate. But the
   asymmetry is **intentional** and documented in B.2 §0.1. The
   actual mismatch-class issues are an order of magnitude smaller
   than the gross count.

4. **Web-side legacy refs are concentrated in
   `apps/web/src/api/*` typed payload shapes** — 32 bundle + 110
   reservation refs. Most are field names on the wire shape that
   the backend still emits. A frontend-only rename without a
   backend-side payload rename is incoherent. **Phase 8.B should
   be sequenced AFTER 8.A.2's backend renames land**, not parallel.

5. **The booking modal redesign (shipped 2026-05-03, see
   `project_booking_modal_redesign_shipped`) introduced new web
   files in `apps/web/src/components/booking-composer-v2/` that
   are already on the canonical names** — only one ref to
   `booking_bundle` in `booking-composer-modal.tsx:252`, and it's
   a comment documenting the rename. This subsystem is clean.

---

## 6. Allowlist file format

`apps/api/src/.naming-allowlist.txt` lists, one per line:

```
<path>:<line>:<exact source line>
```

…for every line classified as `KEEP_HISTORICAL_COMMENT`,
`KEEP_LEGITIMATE_OTHER_TABLE`, `KEEP_BACKWARDS_COMPAT_FIELD`, or
`KEEP_AUDIT_ENTITY_TYPE` in §2 above. The format mirrors
`apps/api/src/modules/.b2-config-reads-allowlist.txt`.

**Lifecycle:** entries are pinned. Adding a NEW reference to a
legacy name requires either (a) classifying it as RENAME and fixing
in the same PR, or (b) adding it to the allowlist with a justifying
comment. CI guard (Phase 8.A.2 commit 6) enforces.

The allowlist as shipped in this PR has **~330 lines**, covering
the bulk of the 475 + 286 + 67 + 319 = 1,147 raw matches across
`apps/api/src`. Refs not in the allowlist are RENAME or INVESTIGATE
and will be addressed in 8.A.2. Refs in legitimate-other-table
families (asset_reservations, recurrence_series) are aggregated by
file rather than per-line to keep the file readable.

---

**Status:** v1 audit. Ready for review. No code changes. Next:
user go-ahead → Phase 8.A.2 commit 1.
