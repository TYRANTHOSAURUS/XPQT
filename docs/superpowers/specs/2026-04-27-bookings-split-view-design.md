# Bookings split view — design

**Date:** 2026-04-27
**Owner:** desk / room-booking
**Status:** approved, pending implementation plan

## Problem

`/desk/bookings` is the operator triage queue for every reservation in the tenant. Today, clicking a row opens `BookingDetailDrawer` — a `Sheet` overlay that covers part of the list. This is the right shape for the portal (`/me-bookings`, where a requester opens one of their own bookings at a time) but wrong for desk operators, who triage queues ("approve all eight pending requests in this building", "scan today's confirmed list before the 9am stand-up"). Each open/close round-trip costs context.

The desk tickets page already solved this. `/desk/tickets` uses a 55/45 split-pane layout (`react-resizable-panels`) where clicking a row mounts the detail beside the list, and an expand button on the panel routes to the full detail page at `/desk/tickets/:id`. We want the same shape on `/desk/bookings`.

A second gap: the global command palette (`Ctrl-K`) indexes tickets, people, spaces, locations, assets, vendors, teams, and request types — but not reservations. There's no way to jump straight to a known booking from search.

## Goals

1. Operator-side `/desk/bookings` becomes a split-pane: list on the left, booking detail on the right when a row is selected.
2. New full-page route `/desk/bookings/:id` rendering the same detail content, reachable from the panel's expand button and from any external link.
3. Global search returns reservations, with hits routing to `/desk/bookings/:id`.
4. Portal `/me-bookings` keeps the existing Sheet/drawer — requesters benefit from the modal-style focus, not split-pane.

## Non-goals

- **Table view toggle** on `/desk/bookings`. Tickets has table + list views; bookings stays list-only for this slice. Defer until operators ask.
- **Vendor visibility differentiation** between portal and desk. Today the booking detail surfaces zero vendor data on either side (`Reservation` DTO has no vendor field; `BundleServicesSection` deliberately doesn't render `assigned_vendor_id`). When we later add vendor display to bundle services for operators, gate it then — premature now.
- Server-side cross-scope search on the bookings page itself. The local `search` input remains a client-side filter on the already-fetched scope. The new global-search reservation kind covers cross-tenant lookup.

## Architecture

### Component split

Today, `BookingDetailDrawer` (`apps/web/src/pages/portal/me-bookings/components/booking-detail-drawer.tsx`) fuses the Sheet wrapper with the detail body. The body is ~150 lines of header + status pill + meta rows + bundle services section + action buttons + audit footer.

Extract that body into a shared component:

```
apps/web/src/components/booking-detail/
├── booking-detail-content.tsx     ← extracted body (the rows, edit form, actions)
├── booking-detail-drawer.tsx      ← portal Sheet wrapper (moves here from /me-bookings/components/)
├── booking-detail-panel.tsx       ← NEW desk split-pane right-side wrapper
└── booking-detail-page.tsx        ← NEW full-route wrapper
```

Move all four into `apps/web/src/components/booking-detail/` so they sit alongside each other. Update imports at:

- `apps/web/src/pages/portal/me-bookings/index.tsx` (the requester landing page) — re-imports `BookingDetailDrawer`.
- `apps/web/src/pages/desk/bookings.tsx` — switches from `BookingDetailDrawer` to `BookingDetailPanel`.
- `apps/web/src/pages/desk/scheduler/components/scheduler-event-popover.tsx` (and any other caller) — keeps using `BookingDetailDrawer` if that's its current shape.

Other portal-only siblings (`booking-edit-form.tsx`, `bundle-services-section.tsx`, `cancel-with-scope-dialog.tsx`, `booking-status-pill.tsx`) move with `booking-detail-content.tsx` since they're part of the same surface. The `me-bookings/components/` directory keeps only what's actually requester-specific (e.g. `bookings-list.tsx`, the day-grouping logic).

### `BookingDetailContent` shape

```ts
interface BookingDetailContentProps {
  reservationId: string | null;          // null → loading / unselected
  spaceName?: string | null;             // optional joined display, like today
  onExpand?: () => void;                 // shows expand button when provided (panel only)
  onClose?: () => void;                  // close affordance — Sheet uses this; page passes back-link instead
  /** Pass-through close callback for nested cancel dialogs. */
  onCancelled?: () => void;
}
```

No `context: 'requester' | 'operator'` prop. Everything the component renders today is safe for both audiences.

### Wrappers

**`BookingDetailDrawer`** — thin Sheet around `BookingDetailContent`:

```tsx
<Sheet open={Boolean(reservationId)} onOpenChange={(o) => !o && onClose()}>
  <SheetContent side="right" className="...">
    <BookingDetailContent
      reservationId={reservationId}
      spaceName={spaceName}
      onClose={onClose}
      onCancelled={onClose}
    />
  </SheetContent>
</Sheet>
```

**`BookingDetailPanel`** — fills the right `Panel` of the desk split:

```tsx
<div className="absolute inset-0 overflow-auto overscroll-contain border-l">
  <BookingDetailContent
    reservationId={reservationId}
    spaceName={spaceName}
    onClose={onClose}
    onExpand={() => navigate(`/desk/bookings/${reservationId}`)}
    onCancelled={onClose}
  />
</div>
```

**`BookingDetailPage`** — full-route component for `/desk/bookings/:id`:

- Uses `SettingsPageShell` with `width="default"` (640px column — booking detail doesn't need a wider canvas; that's the whole reason the panel works at 45% of a wide screen).
- Reads `:id` from the URL.
- Renders `BookingDetailContent` with no `onExpand` (already on the full page) and no `onClose` (back-link is the close affordance).
- Header: `SettingsPageHeader` with `backTo="/desk/bookings"`, title is the space name, description is the booking ref + `formatRelativeTime(created_at)`.

The page reuses the same content in a slightly different chrome — drawer header → settings shell header. The interior (status strip, meta rows, services, actions, audit footer) is byte-for-byte identical.

### Header chrome inside `BookingDetailContent`

Today the drawer renders its own header (`SheetHeader` with chip ref + title + description). The Sheet `SheetTitle` is required for accessibility. To keep `BookingDetailContent` portable across Sheet, panel, and page, restructure:

- The Sheet wrapper provides its own `SheetHeader` / `SheetTitle` (a11y requirement).
- The page wrapper provides `SettingsPageHeader` (different chrome).
- The panel wrapper renders an inline header bar with title + close + expand buttons.
- `BookingDetailContent` itself starts at the **status strip** (the row below the existing header). It doesn't render the title/ref/description block — that's a wrapper concern.

This pushes the `spaceName` + `module_number` + `formatRelativeTime(created_at)` rendering into each wrapper. Acceptable: each wrapper has its own header conventions, and the bottom 90% of the content (rows + services + actions + audit) is what's shared.

### `/desk/bookings` page changes

Currently `apps/web/src/pages/desk/bookings.tsx` returns a single column with the Sheet drawer mounted at the bottom. Changes:

1. Wrap return in `<Group orientation="horizontal" style={{ height: '100%' }}>` like tickets.
2. Conditional render based on `selectedId`:
   - No selection → single `<Panel>` with the existing list.
   - Selection → `<Panel id="list" defaultSize="55%">` + `<Separator />` + `<Panel id="detail" defaultSize="45%">` containing `<BookingDetailPanel />`.
3. Remove the bottom-of-tree `<BookingDetailDrawer />` mount.
4. The list itself is unchanged. The day-group sections, scope toggle, search input — all stay as-is.

URL state stays the same: `?scope=` and `?id=` continue to drive layout. `?id=` opening the panel mirrors today's drawer behavior.

### Full route `/desk/bookings/:id`

Add to the desk router (find via `apps/web/src/App.tsx` for the desk route group):

```tsx
<Route path="bookings/:id" element={<BookingDetailPage />} />
```

`BookingDetailPage` reads `useParams<{ id: string }>()`, calls `useReservationDetail(id)`, and renders the shell + content.

Page handles two edge cases:

- **Loading** — shell + header with title "Loading…", body is a thin skeleton.
- **Not found / no permission** — shell + header with title "Booking not found", body is a one-paragraph explanation. (The API already returns 404 if the reservation isn't visible to the caller via `reservation-visibility.service`.)

### Global search — add `reservation` kind

The current search stack:

- **Backend:** `apps/api/src/modules/search/search.service.ts` calls Postgres RPC `search_global(p_user_id, p_tenant_id, p_q, p_types, p_per_type_limit)`. Returns rows shaped `{ kind, id, title, subtitle, breadcrumb, score, extra }`.
- **Type enum:** `SearchKind = 'ticket' | 'person' | 'space' | 'room' | 'location' | 'asset' | 'vendor' | 'team' | 'request_type'`.
- **Frontend:** `apps/web/src/components/command-palette/command-palette-body.tsx` renders grouped hits and routes by kind.

Three changes:

1. **Migration** — extend `search_global` to query reservations. Filter via the existing `ticket_visibility_ids`-equivalent for bookings (confirm during implementation: there is a per-user reservation visibility predicate; if it's not exposed as an RPC yet, add `reservation_visibility_ids(user_id, tenant_id)` as part of this work). Search fields: `space.name`, requester name, ref number (`module_number`), and start-date proximity. Title = space name. Subtitle = `<requester name> · <relative start time>`. Breadcrumb = `<building> · <floor>`. Extra = `{ start_at, end_at, status }`.
2. **Backend enum** — add `'reservation'` to `SearchKind`. No code change to `search.service.ts` itself; the RPC handles the new kind.
3. **Command palette** — add a `'reservation'` group with an icon (calendar) and a route handler that pushes `/desk/bookings/:id`. Reservations only show up for users with desk-side visibility (operator / requester-of-the-booking) — the RPC's visibility predicate enforces this.

Backend visibility correctness is the load-bearing piece: the RPC must NOT return a reservation row for a user who can't view that reservation. Mirror the model used for ticket search.

## Data flow

No new API endpoints for the split-view side. `useReservationDetail(id)` is already the canonical fetcher and works identically for the panel, the page, and the drawer. React Query cache is shared — clicking a row in the list, expanding to the page, and navigating back doesn't refetch.

For global search, one new RPC field family but no new backend route — `/search/global` already exists and just gets new kinds in its response.

## Testing

- **Unit:** `BookingDetailContent` renders the same row set regardless of wrapper. Smoke tests: loading state, loaded state, edit mode, cancel-confirm dialog opening.
- **Integration:** existing `/me-bookings` flow tests stay green (drawer still mounts content the same way). New tests:
  - `/desk/bookings` with `?id=:id` mounts the right panel.
  - Clicking a row pushes `?id=:id`. Closing pushes back to no-id.
  - `/desk/bookings/:id` direct visit renders the page; back-link returns to `/desk/bookings`.
  - 404 visit renders the not-found state.
- **Backend:** RPC tests for `search_global` returning reservations only for visible users; ref-number search; building filter via breadcrumb.

## Migration / rollout

Single PR. No feature flag — both halves of the change (split-pane + full route + search kind) are additive and don't alter existing portal behavior.

Pre-PR checklist:
- [ ] No file in `apps/web/src/pages/portal/me-bookings/components/` is referenced by anything other than `me-bookings/index.tsx` after the move.
- [ ] No file under `apps/web/src/pages/desk/scheduler/` regresses (scheduler uses the drawer too — confirm via grep).
- [ ] `pnpm db:reset` applies the new migration cleanly.
- [ ] Migration pushed to remote (per CLAUDE.md remote-vs-local protocol) before reporting search done.

## Open questions

1. **Reservation visibility RPC.** Confirm whether a `reservation_visibility_ids(user_id, tenant_id)` predicate already exists in SQL. If not, this design adds it. The pattern is already established for tickets.
2. **Search ranking.** Reservations should rank below tickets and people on equal-quality matches (those are higher-frequency targets). The RPC's existing `score` weighting per kind should be tuned in implementation.

## Out of scope / future work

- Table view toggle on `/desk/bookings` (tickets-style).
- Vendor visibility on bundle services for operators (gated `BundleServicesSection`).
- Bulk actions on the desk bookings list (multi-select, bulk approve/cancel).
- Cross-scope server-side search inside `/desk/bookings` (today's local-filter is sufficient).
