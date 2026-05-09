# Phase 8.B.1 — frontend rename triage

> **Status:** v1 audit, ZERO code changes shipped. The 8.A.1 audit
> predicted that the frontend would mirror the backend pattern (mostly
> wire-shape pinned, with intentional backwards-compat field-name
> aliases); this triage confirms it.
>
> **Date:** 2026-05-09. **Branch:** `main` at `91284b5`.
> **Scope:** TypeScript code in `apps/web/src/` and
> `packages/shared/src/`. Migration history is not in scope.

## 0. tl;dr

**The frontend has 142 legacy-name refs and exactly ZERO of them are
safe to mechanically rename.**

- 32 `booking_bundle*` / `bundle_member` / `bundle_id` refs.
- 110 `reservation_id\b` / bare `reservations` refs.
- Of those: ~50 are inline comments documenting column renames, ~50
  are TypeScript type fields whose name matches what the backend emits
  on the wire, ~25 are URL path strings (`/reservations/...`) that ARE
  the wire contract, ~10 are React Query cache key segments
  (`['booking-bundles', ...]`) that double as backwards-compat
  identifiers across hooks, and ~7 are audit/approval entity_type
  literals (`'booking_bundle'` as a string value the backend still
  emits).
- The `Reservation` TypeScript type itself is a deliberate flat
  projection that the backend's `slotWithBookingToReservation`
  (`apps/api/src/modules/reservations/reservation-projection.ts:55`)
  still emits — renaming it on the client requires a coordinated
  backend payload rename that is explicitly out of scope per the
  prompt's "Don't change wire-shape field names" constraint.

**The v1 plan estimated 142 sites for renaming.** Actual rename
count: **0**. The estimate was right about the ref volume but wrong
about classification — every single ref is intentional and stays.

This commit ships the triage doc plus an extension to the existing
naming-allowlist guard so the frontend gets the same drift protection
as the backend (lock the intentional set in; new unblessed refs fail
CI).

---

## 1. Summary counts

### `apps/web/src/` + `packages/shared/src/`

| Pattern | Lines | Files |
|---|---:|---:|
| `booking_bundle\|bundle_member\|bundle_id` | **32** | 16 |
| `reservation_id\b\|\breservations\b` | **110** | 34 |
| **Live SQL targeting legacy tables** | **0** | 0 |

Top 10 files by combined ref count:

| File | Bundle | Reservation |
|---|---:|---:|
| `apps/web/src/api/room-booking/mutations.ts` | 4 | 15 |
| `apps/web/src/api/room-booking/types.ts` | 3 | 11 |
| `apps/web/src/api/room-booking/queries.ts` | — | 10 |
| `apps/web/src/api/booking-bundles/mutations.ts` | 2 | 10 |
| `apps/web/src/components/portal/portal-approvals-lane.tsx` | 5 | — |
| `apps/web/src/pages/desk/scheduler/index.tsx` | — | 6 |
| `apps/web/src/pages/desk/scheduler/hooks/use-scheduler-data.ts` | — | 6 |
| `apps/web/src/pages/desk/scheduler/components/scheduler-grid-row.tsx` | — | 5 |
| `apps/web/src/api/booking-bundles/queries.ts` | 1 | 4 |
| `apps/web/src/components/desk/visitor-detail.tsx` | 2 | 3 |

The `apps/web/src/api/room-booking/` and
`apps/web/src/api/booking-bundles/` modules together hold ~50 refs
(35% of total). All are either wire-shape pins or query-key /
backwards-compat identifiers.

---

## 2. Per-category breakdown

### A. `booking_bundle*` / `bundle_id` refs (32 total)

| Classification | Lines | Top examples |
|---|---:|---|
| `KEEP_WIRE_SHAPE` (response field, request payload field, audit literal `'booking_bundle'`, query key segment `'booking-bundles'`) | 14 | `portal-approvals-lane.tsx:23,27,35,43,50` (entity_type literal); `desk/approvals.tsx:224` (switch case for in-flight `'booking_bundle'` approvals); `api/orders/mutations.ts:17` (`bundle_id` in `/orders/standalone` response); `api/orders/keys.ts:3` (orders list query param); `api/booking-bundles/mutations.ts:34,79` (`bundle_id` in `/reservations/:id/bundle` and `/reservations/:id/services` response shapes); `api/visitors/index.ts:114` (`booking_bundle_id` retained as request payload field in `CreateInvitationPayload` because backend `dto/schemas.ts:46` still accepts it); `api/room-booking/mutations.ts:249,274` (`bundle_id` in attach-services response + cache invalidation key) |
| `KEEP_HISTORICAL_COMMENT` (rationale comment for column/field rename, no code identifier) | 18 | `desk/visitor-detail.tsx:324,509`; `portal/visitor-invite-form.tsx:85`; `booking-composer-v2/booking-composer-modal.tsx:252`; `api/orders/types.ts:12`; `api/booking-bundles/types.ts:69`; `api/booking-bundles/queries.ts:8`; `api/visitors/index.ts:108,144`; `api/visitors/admin.ts:391`; `api/room-booking/types.ts:4,16,223`; `api/room-booking/mutations.ts:236,267`; `pages/desk/bookings.tsx:400`; `pages/desk/approvals.tsx:221,252` |
| `RENAME_INTERNAL` | **0** | — |

**Why every ref stays:**
- The audit-event entity_type literal `'booking_bundle'` is preserved
  in approvals payloads for in-flight pending approvals at rollout
  time (already documented in `desk/approvals.tsx:220-224`).
- The query key segment `['booking-bundles', 'detail', data.bundle_id]`
  in `room-booking/mutations.ts:274` doubles as a cache invalidation
  bridge between hooks that hold the bundle id alias and hooks that
  hold the booking id; renaming would break cross-hook cache hits.
- `bundle_id` as a TS-side response field name matches what the
  backend emits per `apps/api/src/modules/orders/order.service.ts:97,
  360, 776, 952, 1119, 1250` and the `/reservations/:id/services`
  attach-plan response. Backend Phase 8.A.2 audit classified it as
  `KEEP_BACKWARDS_COMPAT_FIELD`.
- `booking_bundle_id` on `CreateInvitationPayload` is still accepted
  by the backend (`apps/api/src/modules/visitors/dto/schemas.ts:46`)
  for callers mid-migration; dropping it from the TS type would force
  every visitor-invite caller to switch in lockstep, which is a
  cross-cutting change beyond Phase 8.B's scope.

### B. `reservation_id` / bare `reservations` refs (110 total)

| Classification | Lines | Top examples |
|---|---:|---|
| `KEEP_WIRE_SHAPE` — URL path string `/reservations/...` (a wire contract) | ~25 | All `apiFetch('/reservations', ...)` and `apiFetch(\`/reservations/${id}/...\`, ...)` callers across `api/room-booking/queries.ts`, `mutations.ts`, `api/booking-bundles/mutations.ts`, comments referencing the URL |
| `KEEP_WIRE_SHAPE` — TS type field name that mirrors backend response (`Reservation`, `Reservation[]`, `reservations: Reservation[]`, `reservation_id` on report rows) | ~50 | `api/room-booking/types.ts:23-245` (the `Reservation` projection itself); `api/room-booking/queries.ts:46-49,196,237` (`ReservationListResponse.items`, `SchedulerWindowResponse.items`, `SchedulerDataResponse.reservations` + `reservations_total/truncated/next_cursor`); `api/booking-reports/types.ts:60,183` (`NoShowWatchlistRow.reservation_id` — backend `00289_bookings_overview_reports_rebuild.sql:431,1011` emits this field); `api/room-booking-rules/types.ts:171` (`sample_affected_bookings[].reservation_id` — backend `apps/api/src/modules/room-booking-rules/impact-preview.service.ts:38,148` emits this); `api/orders/types.ts:60-61` |
| `KEEP_WIRE_SHAPE` — Local variable / prop named to match the wire field | ~20 | `pages/desk/scheduler/components/scheduler-grid.tsx:189,232` (`const reservations = ...; <SchedulerGridRow reservations={reservations} />`); `pages/desk/scheduler/components/scheduler-grid-row.tsx:62,138,170` (`reservations: Reservation[]` prop type + body uses); `pages/desk/scheduler/hooks/use-scheduler-data.ts:126,129,150,152,162` (`reservationsBySpaceId`, `reservationsTotal`, `reservationsTruncated`, `reservationsNextCursor` — all mirror `SchedulerDataResponse.reservations*`) |
| `KEEP_BACKWARDS_COMPAT_FIELD` — query key segment / palette alias / cache key | ~5 | `pages/portal/me-bookings/components/bookings-list.tsx:44` ("dedup by booking_id" comment but variable is `reservations`); `lib/command-palette/routes.ts:76` (`aliases: ['reservations']` for user-facing search — operators still type "reservations") |
| `KEEP_HISTORICAL_COMMENT` (rationale comment, label string, doc) | ~10 | `pages/admin/room-booking-rules/components/rule-impact-preview-card.tsx:110,115` (rendering the wire field in chips); `pages/admin/room-booking-reports/no-shows.tsx:240,260` + `components/no-show-watchlist.tsx:33` (rendering `reservation_id` from the wire response in a table); `api/room-booking-rules/types.ts:171`; `api/gdpr/index.ts:250` (English label "Historical reservations"); `pages/desk/scheduler/hooks/use-realtime-scheduler.ts:9` (Supabase realtime channel name); `pages/portal/book-room/hooks/use-realtime-availability.ts:9,14` (channel name); `packages/shared/src/error-codes.ts:192` (section heading comment); various other comments |
| `RENAME_INTERNAL` | **0** | — |

**Why every ref stays:**
- The `Reservation` flat projection type is the wire shape the API
  emits from every `/reservations/*` endpoint (the projector at
  `apps/api/src/modules/reservations/reservation-projection.ts:55`).
  Renaming the TS type without renaming the wire is incoherent.
- `reservation_id` on report row types is what the backend SQL
  functions emit (`00289_bookings_overview_reports_rebuild.sql:431,
  1011, 1088, 1140` and `impact-preview.service.ts:38, 148`).
  Renaming on the client without changing the SQL function returns is
  a contract break.
- Local variables like `const reservations = ...` mirror the prop /
  type names; renaming locally while the prop / type stays
  `reservations` creates a readability mismatch that hurts more than
  helps. The right time to rename is when the wire shape itself
  flips.
- The Supabase realtime channel pattern
  `reservations:tenant_<id>:space_<id>` is published by the backend's
  realtime emitter; the client just subscribes. Channel names are
  on the wire.
- The command palette user-facing alias `'reservations'` is preserved
  intentionally — operators who learned the legacy term still type it
  to find bookings.

---

## 3. Recommendation

**Apply zero renames in Phase 8.B.2.** Every legacy ref is one of:

1. A TypeScript type whose field name mirrors the backend wire shape
   (renaming requires a backend payload rename, out of scope).
2. A URL path string in `apiFetch()` calls (the URL is the wire
   contract).
3. A React Query cache key segment that doubles as a cross-hook
   bridge (renaming would break cache invalidation across hooks
   holding the bundle/booking id alias).
4. An audit-event / approval-payload entity_type literal that
   matches what the backend emits for in-flight rows.
5. A backwards-compat request-payload field name still accepted by
   the backend.
6. A comment documenting a column rename or carrying rationale.

**Phase 8.B.3 — extend the naming allowlist guard to cover the web
side.** This is the structural defense: pin the 142 intentional refs
as the baseline, fail CI on any new unblessed ref. Same pattern as
the backend allowlist (commit 8.A.2.6 / `91284b5`) at
`apps/api/src/.naming-allowlist.txt` + `scripts/check-naming-allowlist.sh`.

---

## 4. Risk register

### 4.1 Wire-shape risks (frontend types that DO need renaming if we want canonical naming)

If at some future date we want full canonical naming on the wire,
these are the renames that need a coordinated backend + frontend +
migration sequence:

- **`Reservation` → `Booking` + `BookingSlot` flat projection.** The
  flat projection type lives in `apps/web/src/api/room-booking/types.ts`
  and is emitted by every `/reservations/*` endpoint. Renaming
  requires changing the backend projector
  (`apps/api/src/modules/reservations/reservation-projection.ts:55`),
  the Nest controller paths, and ~25 frontend caller files. Estimated
  3–5 commits, deferred to a future "rename `/reservations` to
  `/bookings` route" workstream.
- **`SchedulerDataResponse.reservations` → `.bookings`.** Same
  shape — the field name on the wire matches `Reservation[]`. Coupled
  to the rename above.
- **`NoShowWatchlistRow.reservation_id` → `.slot_id` (or
  `.booking_id`).** The SQL function `00289_bookings_overview_reports`
  emits `reservation_id` as the slot id (per its comment at line 404).
  A rename is a SQL function rewrite + frontend change.
- **`ImpactPreviewResult.sample_affected_bookings[].reservation_id`.**
  Same pattern — backend
  `apps/api/src/modules/room-booking-rules/impact-preview.service.ts:38,
  148` emits this field name.

None of these are required for Phase 8.B; they belong in a future
dedicated wire-rename workstream that Phase 8.B does NOT preempt.

### 4.2 Cross-hook cache invalidation

`apps/web/src/api/room-booking/mutations.ts:274`:

```ts
queryClient.invalidateQueries({
  queryKey: ['booking-bundles', 'detail', data.bundle_id] as const
});
```

This invalidates the `useBundle` query cache that keys on
`bundleKeys.detail(id)` from `api/booking-bundles/keys.ts`. The
literal cache key prefix `'booking-bundles'` is shared across
multiple hooks; renaming it without renaming every consumer in
lockstep would silently miss invalidations.

### 4.3 Visitor invite payload backwards compat

`api/visitors/index.ts:114` keeps `booking_bundle_id?: string` on
`CreateInvitationPayload` because the backend
(`apps/api/src/modules/visitors/dto/schemas.ts:45-46`) still accepts
both `booking_id` (preferred) and `booking_bundle_id` (legacy alias).
Dropping the alias from the TS type forces every caller to switch in
lockstep, which is a separate sweep with no functional gain since
the legacy field name is harmless.

---

## 5. Surprises uncovered during audit

1. **The `Reservation` TS type is the largest single contributor.**
   ~30% of the 110 reservation refs come from one file
   (`api/room-booking/types.ts` — 11 refs in the type itself plus
   another 6 across the `Booking` and `BookingSlot` co-located types,
   most being comments documenting the `bookings`/`booking_slots`
   replacements). Renaming the type requires renaming every consumer.
2. **The booking-composer-v2 surface is already on canonical names.**
   Only 1 ref (`booking-composer-modal.tsx:252`) and it's a comment
   referencing the dropped `booking_bundle_id` field. The new
   composer reads `result.id` directly. Mirrors the backend audit
   finding (point 5 in `phase-8-naming-audit.md` §5).
3. **The portal approvals lane preserves the audit literal.**
   `portal-approvals-lane.tsx` has 5 refs to `'booking_bundle'` and
   they're all branches in the `EntityKind` switch — same defensive
   handling as `desk/approvals.tsx:224` for in-flight pending
   approvals. Both surfaces correctly accept the literal even though
   the canonical value is now `'booking'`.
4. **No `.from('booking_bundles')` or `.from('reservations')` calls
   exist in `apps/web/src`.** The frontend doesn't touch Supabase
   directly except via the API; same as the backend audit finding.
   Confirms the destructive-default booking-canonicalisation rewrite
   landed cleanly through the wire layer.
5. **The `booking-reports/types.ts` file has 3 refs but the user-
   facing rendering picks them up from the SQL output verbatim**
   (`pages/admin/room-booking-reports/no-shows.tsx:240,260`,
   `components/no-show-watchlist.tsx:33`). A rename on the TS type
   without changing the SQL function output flips the UI to render
   `undefined`. Confirmed contract pin.

---

## 6. Allowlist file format (web extension)

`apps/web/src/.naming-allowlist.txt` mirrors the backend file format:

```
<path>:<line>:<exact source line>
```

…for every line classified as `KEEP_WIRE_SHAPE`,
`KEEP_HISTORICAL_COMMENT`, or `KEEP_BACKWARDS_COMPAT_FIELD` in §2
above. CI script (`scripts/check-naming-allowlist.sh`) is extended in
Phase 8.B.3 to scan both `apps/api/src` and `apps/web/src` against
their respective allowlists.

The allowlist captures all 142 refs as the baseline.

---

**Status:** v1 audit. Honest assessment: **the v1 plan estimated
142 sites for renaming and the actual rename count is 0.** The
estimate was right about ref volume but wrong about classification.
Every legacy ref in the frontend is intentional (wire-shape pinned,
backwards-compat alias, audit literal, or historical comment) and
none can be renamed without a coordinated wire-shape change.

The right Phase 8.B output is therefore:

- Commit 1 (this doc) — triage doc only.
- Commit 2 — SKIPPED. No internal renames found.
- Commit 3 — extend the existing allowlist + CI to lock the
  intentional set in on the frontend.
