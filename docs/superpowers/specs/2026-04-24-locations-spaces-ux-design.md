# Locations & Spaces — UX redesign

**Date:** 2026-04-24
**Scope:** `/admin/locations` page — visual and interaction redesign.
**Out of scope:** floor plans, desk booking, occupancy, CSV import (phase 2).

## Problem

The current page is a flat table. A tenant's space graph is a tree — `Site → Building → (Wing) → Floor → Room / Desk / Common Area` — typically 1–100 buildings with many floors, wings, and rooms each, which puts real-world tenants at hundreds to low thousands of nodes. The flat view shows no hierarchy, no parent-child relationships, and no practical way to answer "what's inside Building A?" or "which rooms on Floor 3 are reservable?". Admins can't navigate, can't reason about structure, and creating a space forces them to remember and pick the right `parent_id` from a dropdown of every site/building/floor.

## Goals

1. Hierarchy is the first thing you see.
2. The UI scales to thousands of nodes without choking the browser or the reader.
3. Creating a child under a parent is one click, with type options pre-constrained.
4. Finding any space — by name, code, or attribute — takes one search box, not scrolling.
5. Bulk editing across a parent's children is a first-class action, not a loop of single edits.
6. Every space is deep-linkable.

## Non-goals (phase 1)

- Floor plan upload or map view.
- Reservation calendar / occupancy heatmap.
- CSV import/export.
- Cross-tenant views.
- Role-scoped editing (handled by existing permissions).

## User jobs (ordered by frequency)

1. **Browse** — open a building, see what's inside.
2. **Find** — jump to a known room by code or name.
3. **Edit one space** — rename, change capacity, toggle reservable.
4. **Add a child** — new floor under a building; new room under a floor.
5. **Bulk edit** — mark all rooms on Floor 3 reservable; add an amenity to every meeting room in Building A.
6. **Move / reparent** — rare but critical when floors get renumbered or wings get reorganised.
7. **Audit** — "show all storage rooms without a code"; "all reservable rooms with capacity ≥ 10".

## Design

### Layout: two-pane explorer

```
┌─────────────────────────┬─────────────────────────────────────────┐
│  Search + filter chips  │  Breadcrumb · Name · Type · actions     │
│  ─────────────────────  │  ─────────────────────────────────────  │
│  ▸ Amsterdam HQ         │  Metadata strip                         │
│    ▾ Building A    · 42 │    Code · Capacity · Reservable · Amen. │
│      ▸ Ground           │                                         │
│      ▾ Floor 3    · 24  │  Tabs: Overview │ Children │ Activity   │
│        ● Room 302       │                                         │
│        · Room 303       │  Children table (direct descendants)    │
│        · Meeting A      │  [ select ] Name  Type  Code  Cap  Res  │
│    ▸ Building B         │  ☐ Room 302 …                           │
│  ▸ London Site          │  ☐ Room 303 …                           │
│                         │  Bulk bar appears when rows selected    │
└─────────────────────────┴─────────────────────────────────────────┘
```

**Left rail (~300 px, resizable, persistent):**

- Sticky header: search box (`⌘K` focus) + compact filter chips (Type, Reservable, Capacity range, Amenity).
- Two result modes, toggled in the rail header:
  - **Tree mode (default):** collapsed below Site by default; matches are highlighted, ancestors auto-expand to show the path.
  - **Flat mode:** match list with full breadcrumb per row. Used when the tree is too dense or the admin wants to scan across buildings.
- Tree row layout: `chevron · type icon · name · [code pill]`. Parent nodes show a child count (`Floor 3 · 24`). Active row gets accent background.
- Hover reveals a `+` button on any row → adds a child (type picker constrained by the parent's type).
- Keyboard: `↑/↓` move, `→` expand, `←` collapse, `Enter` open edit, `⌘K` focus search, `⌘/` toggle tree/flat mode.
- Virtualised rendering via `@tanstack/react-virtual`. No "expand all".

**Right pane — detail view:**

- Header: clickable breadcrumb (`Ams > … > Floor 3 > Room 302`, middle truncated when >4 deep; hover shows full path), name, type badge, action buttons (Edit, Move, Delete).
- Metadata strip directly under the header: capacity, reservable toggle (inline editable), amenity chips. Low-commitment edits happen here without opening a dialog.
- Tabs: **Overview · Children · Activity**. Activity is a stub in phase 1 (shows `updated_at` and created-by) but the tab is reserved.
- **Children tab** is the current table, scoped to this node's direct descendants. Columns: Name · Type · Code · Capacity · Reservable · Amenities. Sort + filter per column.
- Multi-select on the children table surfaces a bulk action bar: `Set reservable`, `Add amenity`, `Move to…`, `Delete`. Bulk ops confirm with a single dialog summarising affected rows.
- Empty state per type: "No rooms on this floor yet — [+ Add room]".

**Root-level (nothing selected):**
- Shows tenant-wide summary cards: total sites, buildings, floors, rooms, reservable rooms. One click on a card filters the tree to that type in flat mode.

### Create & move flow

- **Create from parent:** `+` on any tree row, or "Add child" button in the detail header. Opens the space dialog with `parent_id` pre-filled and the `type` select pre-filtered to children-valid-for-parent (see taxonomy table below).
- **Create at root:** "Add site" button at the top of the rail. Only `site` is allowed at root.
- **Move:** `Move…` button in the detail header opens a tree picker. Drag-and-drop in the tree is phase 2 — the picker is deliberate and less error-prone for deep trees.
- **Rename:** double-click name in tree row (inline). `Esc` cancels.

### Type taxonomy & parent rules

Type hierarchy (after adding `wing`):

| Parent type          | Allowed child types                                                      |
| -------------------- | ------------------------------------------------------------------------ |
| *(root)*             | `site`                                                                   |
| `site`               | `building`, `common_area`, `parking_space`                               |
| `building`           | `wing`, `floor`, `common_area`                                           |
| `wing`               | `floor`                                                                  |
| `floor`              | `room`, `meeting_room`, `common_area`, `storage_room`, `technical_room`  |
| `room`               | `desk`                                                                   |
| `meeting_room`       | *(leaf)*                                                                 |
| `desk` / `common_area` / `storage_room` / `technical_room` / `parking_space` | *(leaf)*                                 |

The frontend enforces this in the type picker. The backend adds a validation check in `SpaceService.create` / `update` that the proposed `(parent.type, this.type)` pair is allowed. This prevents "Site under Room" bugs that the current dropdown allows.

### Data model changes

1. Add `wing` to the `spaces.type` check constraint (migration 00107).
2. Add `wing` to the `location_granularity` allowlist in `00049_request_type_location_granularity.sql` — this is mandatory per the comment in that migration (otherwise request types can't target wings).
3. Add a `public.is_valid_space_parent(parent_type text, child_type text) returns boolean` SQL function codifying the table above. Called from a `before insert/update` trigger on `spaces`. This makes the constraint enforceable even outside the app.
4. Grep for other consumers of `spaces.type` and update:
   - `apps/api/src/modules/space/**` — DTO enums / type guards.
   - `apps/web/src/pages/admin/locations.tsx` + any picker components that hard-code the list.
   - Seed migrations (`00102_…`) — no schema change needed if they don't create wings, but verify.

### API contract

Additions to `apps/api/src/modules/space/space.controller.ts`:

- `GET /spaces/tree` — returns the full tenant tree in a single call. Payload shape: `TreeNode { id, name, code, type, capacity, reservable, amenities, parent_id, child_count, children: TreeNode[] }`. Used to hydrate the rail in one round trip. For tenants > 5 000 nodes, fall back to lazy loading: first call returns nodes up to `building` depth with `child_count` hints; rail expands a node → `GET /spaces/:id/children`.
- `GET /spaces/:id` — already exists; frontend keeps using for detail pane.
- Lazy-load children for an expanded node: reuse the existing `GET /spaces?parent_id=<id>` rather than add a new endpoint. Avoids API surface duplication.
- `PATCH /spaces/bulk` — accepts `{ ids: string[], patch: UpdateSpaceDto }`. Enforces tenant + type-parent rules per id. Returns per-id success/error.
- `POST /spaces/:id/move` — `{ parent_id: string | null }`. Validates parent rule; prevents cycles.

### Frontend architecture

**New files** (under `apps/web/src/`):

- `api/spaces/keys.ts` — React Query key factory per `docs/react-query-guidelines.md`.
- `api/spaces/queries.ts` — `spaceTreeQueryOptions`, `spaceDetailQueryOptions(id)`, `spaceChildrenQueryOptions(id)`.
- `api/spaces/mutations.ts` — `useCreateSpace`, `useUpdateSpace`, `useMoveSpace`, `useBulkUpdateSpaces`, `useDeleteSpace`. Optimistic updates where safe; invalidate `keys.tree()` + `keys.detail(parent_id)` on settle.
- `components/admin/space-tree/` — the rail:
  - `space-tree.tsx` — orchestrator, owns selection state + mode toggle.
  - `space-tree-row.tsx` — one row (virtualised item).
  - `space-tree-search.tsx` — search + filter chips.
  - `space-tree-flat-list.tsx` — flat-mode result list.
  - `space-type-icon.tsx` — lucide icon per type.
  - `use-space-tree-state.ts` — expanded set, selection, search query, URL sync.
- `components/admin/space-detail/` — the right pane:
  - `space-detail.tsx` — header + tabs container.
  - `space-detail-header.tsx` — breadcrumb + actions.
  - `space-metadata-strip.tsx` — inline-editable fields.
  - `space-children-table.tsx` — table + bulk bar.
  - `space-activity-tab.tsx` — stub.
- `components/admin/space-form/` — shared form used by Create, Edit, and bulk-edit dialogs:
  - `space-form.tsx` — uses shadcn `Field` primitives (FieldGroup / Field / FieldLabel / FieldSet / FieldLegend / FieldSeparator / FieldDescription per CLAUDE.md §"Form composition").
  - `space-type-picker.tsx` — enforces taxonomy.
  - `space-parent-picker.tsx` — tree picker used by Move and Create.

**Modified:**

- `apps/web/src/pages/admin/locations.tsx` — rewritten as a two-pane layout. Uses `SettingsPageShell` only for the page chrome; the tree + detail live inside a `ResizablePanelGroup` (shadcn `resizable`). Drops the current flat-table rendering entirely. Migrates off `useApi` to React Query.
- `apps/web/src/App.tsx` — route becomes `/admin/locations/:spaceId?`. Missing or invalid `spaceId` shows the root summary state.

**Component boundaries:**

- The tree never imports from detail, and vice versa — they only share state through the URL (`spaceId`) and React Query cache. This keeps them independently testable and lets either be embedded elsewhere (e.g. a future "Select a space" picker reuses `space-tree` alone).
- `space-form` is consumed by Create, Edit, and bulk-edit. A single source of truth for validation and layout.

### Scale & performance

- Initial page load: one `GET /spaces/tree` call; expected payload ~200 KB for a 5 000-node tenant. Compressed, cached by React Query with `staleTime: 30s`.
- Rail rendering is virtualised; only visible rows hit the DOM.
- Search debounced at 150 ms; runs client-side against the in-memory tree (no extra API call). Filter chips also client-side.
- For tenants > 10 000 nodes, switch to lazy mode: tree query returns up to `floor` depth; rooms/desks load on demand when a floor is expanded. Threshold behind a config constant, not per-tenant flag (YAGNI for now).
- Bulk updates: hit `PATCH /spaces/bulk`, show a progress toast with success/failure counts.

### Accessibility

- Full keyboard navigation in the rail (see keybindings above). `aria-tree` / `aria-treeitem` roles. Expand/collapse announced.
- Every action button has an accessible label. Inline toggles use `aria-pressed`.
- Focus ring on every interactive element. Selection is visible with more than just colour (accent bg + left border).
- The children table uses the existing shadcn `Table` with sort buttons that are real `<button>`s.

### States & errors

- **Loading:** rail shows skeleton rows; detail pane shows a centred spinner.
- **Empty tenant:** rail shows a single-button empty state ("Add your first site"). Detail pane shows onboarding copy.
- **No node selected:** detail pane shows the tenant summary cards described above.
- **Selected node not found** (stale URL): detail pane shows "This space no longer exists" + "Back to root" button. Rail keeps working.
- **Move/create violates parent rule:** inline error in the form, toast on API-side rejection. Backend is the source of truth.
- **Bulk partial failure:** results dialog lists the failed ids with reason, success count highlighted.

## Deferred (phase 2+)

- Floor-plan image per floor with desk pin placement.
- Realtime co-editing (multiple admins on the same building).
- Utilisation / occupancy heatmap (needs reservations data).
- CSV import + export.
- Drag-and-drop reparenting in the tree.
- Space templates ("apply standard floor layout").
- Archive view (today, inactive spaces just disappear — a filter to show them would help audits).

## Rollout

Single PR replaces the current `locations.tsx`. Schema changes are additive (new `wing` value on the type check constraint + new validation trigger); no data migration required. Old URL `/admin/locations` keeps working and lands on the root summary; `/admin/locations/:spaceId` deep-links work the moment the PR ships. No feature flag — the current page is strictly worse and there's no cohort to roll out to.

## Risks / open questions

1. **Wing adoption.** If some tenants already model wings as floors ("Floor 3 - East"), introducing `wing` may tempt over-migration. Resolution: `wing` is purely additive; nothing forces existing data to change.
2. **Tree payload at the top end.** 50 000-node tenants (rare but possible for hospital/campus customers) may need server-side filtering. Flagged as phase 2 lazy mode; monitor p95 payload size.
3. **URL sync vs selection state.** If multiple admins open the same tenant, one clicking a node shouldn't navigate the other. Confirmed not an issue — `spaceId` is per-browser URL, not realtime state.
4. **Inline-edit save semantics.** Metadata-strip toggles (reservable, capacity) save on blur. Needs explicit loading/error state on each control — not a toast-only pattern — so the admin sees which field failed.
