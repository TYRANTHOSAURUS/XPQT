# Main menu (desk shell) redesign — design

**Date:** 2026-05-02
**Status:** Approved (brainstorm — design lock)
**Owner:** Frontend
**Touches:** `apps/web/src/components/desk/desk-sidebar.tsx`, `apps/web/src/components/ui/sidebar.tsx`, `apps/web/src/components/nav-user.tsx`, `apps/web/src/layouts/desk-layout.tsx`, plus a small new helper for permission-aware nav filtering.

## Problem

The desk shell (`DeskSidebar`, used by `/desk/*`) has three concrete failures, listed in increasing order of severity:

1. **Width-collision bug.** Today the outer `<Sidebar>` has a fixed total width (`SIDEBAR_WIDTH = 24rem = 384px`, see `apps/web/src/components/ui/sidebar.tsx:28`). The inner icon-rail expands from 48px → 180px when the user clicks the bottom collapse-toggle (`desk-sidebar.tsx:374`), and the contextual second pane is `flex-1` — so the second pane shrinks by exactly the 132px the rail just gained. Both panes literally cannot be at max width simultaneously. The user described this as the immediate trigger for the redesign.
2. **Discoverability collapses with role-permissioned navs.** Different roles see different items (service desk often sees all 7; reception only sees Visitors). With a flat, label-less, ungrouped icon list, a role-permissioned operator can't build positional muscle memory ("Bookings is the 4th icon") because the position drifts based on which items are visible. Tooltip-on-hover is serial discovery (one label at a time, ~700ms per hover) — exactly the worst-case interaction for "I need to make a reservation, where do I go?"
3. **Polish gaps that compound.** No counts (the nav reads as inert), redundant Search row that duplicates the topbar SearchTrigger and ⌘K, two near-identical calendar icons (Bookings + Scheduler), inconsistent active-state treatments between the two panes, no visual seam between the two panes (they read as one slab), and three "Tickets" labels visible at once on the tickets page (rail + pane header + breadcrumb).

## Goals

1. Both panes (icon-rail + contextual second pane) usable at their max width *simultaneously* — fix the width math, no more either/or.
2. Permission-aware grouped IA: section labels where they earn their existence, hidden groups when permissions remove all items in a section, single-item groups still labeled (so a reception-only user sees `MY QUEUE → ...` rather than a flat orphan).
3. Live-feeling nav: counts on the items where a count is actionable; binary urgency dot when something inside breaches.
4. Quieter chrome, louder destinations: redundant Search row removed; bottom toggle re-affordanced; avatar gains a popover for user-scoped actions (theme, sign-out, etc.). Platform Settings stays as a rail footer destination — it's frequent admin work, not rare configuration.
5. Visual consistency between rail and second-pane (active state, seam, header dedup).
6. No regressions on mobile (sheet/offcanvas behavior unchanged).

## Non-goals (deferred to follow-up specs)

- **Triage section** (cross-domain "needs me" aggregation across @-mentions / approvals / SLA-breach / expected visitors). Real product feature with its own brainstorm.
- **Two-key shortcuts** (G + letter, GitHub/Linear style) shown as inline hints in the expanded rail.
- **Recent + Favorites** auto-populated section at the top.
- **Hover-reveal "+ New X"** secondary action on each row.
- **Drag-resize** sidebar boundary.
- **Bookings + Scheduler merge.** User explicitly chose not to merge for v1; spec keeps them as separate top-level items but with disambiguated icons.
- **Count-update spring animation** and other micro-polish — small enough to fold in later without spec changes.

## Architecture

### Width math (the fix for the original bug)

The outer sidebar's width becomes a function of the rail's expanded state, with per-pane min-widths so neither pane crushes the other.

| State | Rail width | Second-pane width | Total `--sidebar-width` | When |
|---|---|---|---|---|
| Sidebar fully collapsed (header `SidebarTrigger`) | 48px | hidden | 48px (icon-only mode) | "Max work area, no contextual nav at all." |
| Sidebar open + rail compact (default for returning users who chose compact) | 48px | 320px | 368px | "I know where I'm going; max content area." |
| Sidebar open + rail expanded (default for new users) | 180px | 320px | 500px | "I'm scanning the nav / I forgot what's where." |

- **Second-pane min-width: 280px.** Hard floor — never crushes below this.
- **Total sidebar grows on rail expand, shrinks on rail collapse.** Page content reflows once per intentional toggle.
- **Animation:** `transition: width 200ms var(--ease-smooth)` on both the rail and the outer sidebar. The token is already in `:root` (`apps/web/src/index.css`) — do not invent a new cubic-bezier.

**Implementation:** in `apps/web/src/components/ui/sidebar.tsx`, replace the constant `SIDEBAR_WIDTH = "24rem"` with a derived value computed from the rail's `expanded` state lifted into context. Two new CSS custom properties: `--sidebar-rail-w` and `--sidebar-pane-w`. The outer `<Sidebar>` width = `var(--sidebar-rail-w) + var(--sidebar-pane-w)` (CSS `calc`).

The rail-expanded boolean lives in `SidebarProvider` context, persisted to `localStorage` under key `prequest:rail-expanded` (see Persistence below).

### IA — grouped nav with semantic labels

Final structure (B2 from brainstorm):

```
MY QUEUE
  Inbox          (count + optional red dot)
  Approvals      (count + optional red dot)

  ── visual gap, no label ──
  Tickets
  Bookings
  Scheduler
  Visitors       (count + optional red dot)

INSIGHTS
  Reports
```

**Why these labels, why no middle label.** `MY QUEUE` and `INSIGHTS` say something specific (waiting-for-you · read-only-analysis). The middle bucket has no label because every candidate name (`WORK`, `WORKSPACE`, `OPERATIONS`) was decorative — the items themselves (Tickets, Bookings, Scheduler, Visitors) already communicate "operational work." Visual gap separates the groups; labels appear only where they earn their existence.

**Visual gap implementation:** a `SidebarSeparator` (semantic, respects sidebar tokens) — not invisible padding.

**Group order is fixed** regardless of which items are permission-visible. Reception with only Visitors visible sees:
```
  ── visual gap (top, since MY QUEUE has nothing) ──
  Visitors      (12)
```
The unlabeled middle bucket is fine to display alone — the items themselves provide the context.

### Permission-aware filtering

The nav array is filtered before render based on the current user's effective permissions. A new helper, `filterNavForUser(navItems, perms)`, returns only the items the user can access.

Rules:
- **An item is hidden** if the user has no permission to view its destination route. (e.g. no `tickets:read_any` and no `tickets:read_assigned` → Tickets hidden.)
- **A group is hidden entirely** if all its items are hidden after filtering.
- **A single-item group still shows its group label** (the label is the orientation cue, not visual decoration).
- **The unlabeled middle bucket renders even with one item** — the gap above/below is the separator.
- **Groups always render in fixed order** (`MY QUEUE` → middle → `INSIGHTS`); never reordered based on what's visible.

This keeps every operator's nav coherent, predictable, and immediately understood by their role.

Permission keys used (already in the catalog per `project_permission_catalog_enforcement_shipped`):

| Nav item | Permission gate |
|---|---|
| Inbox | `tickets:inbox` (always — every operator gets an inbox) |
| Approvals | `approvals:read_any` OR `approvals:read_assigned` |
| Tickets | `tickets:read_any` OR `tickets:read_assigned` |
| Bookings | `bookings:read_any` OR `bookings:read_assigned` |
| Scheduler | same as Bookings |
| Visitors | `visitors:read_any` OR `visitors:read_assigned` |
| Reports | `reports:read` |
| Settings (footer) | any `*:admin` permission (hidden for non-admin users) |
| Portal (footer) | always visible (every operator can drop into the employee portal) |

### Counts

Items that get counts: **Inbox, Approvals, Visitors.** Others stay numeric-silent.

| Item | What's counted | Source |
|---|---|---|
| Inbox | Unread items in your inbox (tickets where you're @-mentioned, assigned, watching, or your team owns) | `GET /tickets/inbox?unread=true&count=true` (extend existing endpoint to support `count=true` returning just `{count}` without payload) |
| Approvals | Pending approvals where YOU are the approver | `GET /approvals/pending?owner=me&count=true` (new endpoint or extend existing) |
| Visitors | Visitors expected today at the operator's reception's building | `GET /visitors?date=today&building=$reception_building&count=true` |

**Display:** count appears right-aligned in the row, `font-mono tabular-nums text-xs text-muted-foreground`. Uses the `tabular-nums` token already in `index.css` so digit width changes don't jitter.

**Update cadence:**
- On mount: fresh fetch.
- On realtime push: count refresh (already wired via `RealtimeStatusStore` for these three modules).
- On focus return (tab visibility change): refresh (cheap, ~1 RTT).
- React Query staleTime: 30s.

**Urgency signal (the dot):** binary red dot rendered to the *right* of the count when something inside the queue is in a "needs attention" state:

| Item | Dot appears when |
|---|---|
| Inbox | Any unread item is an @-mention OR is a `priority = 'critical'` ticket |
| Approvals | Any pending approval owned by the user is older than 24h |
| Visitors | Any expected visitor is past their `expected_at` time + 15min grace window without check-in |

The dot is **binary** — present or absent, no count. It uses `bg-destructive` and is `4×4px`. When state transitions from no-dot → dot, single-pulse animation (one cycle, 240ms `var(--ease-out)`, no loop).

**Hidden when collapsed-rail.** The dot still appears in collapsed (icon-only) state — small enough to fit at the top-right of the icon. Counts disappear in collapsed state (no room).

### Bottom toggle re-affordance

The bottom rail toggle keeps its job (toggle rail expanded/compact) but its icon and tooltip are clarified to communicate the actual semantic.

| Before | After |
|---|---|
| Icon: `PanelLeftOpenIcon` ↔ `PanelLeftCloseIcon` | Icon: `MenuIcon` ↔ `LayoutGridIcon` |
| Tooltip: "Expand menu" / "Collapse menu" | Tooltip: "Show labels" / "Compact view" |

Removes the misleading "open/close panel" affordance — nothing opens or closes; the labels appear or hide.

### Search row removed

The `SearchIcon` row at the top of the rail (currently `desk-sidebar.tsx:313-327`) is **deleted**. It calls the same `paletteOpen()` as ⌘K, and the topbar `SearchTrigger` (in `desk-layout.tsx:78`) is always visible. Three entrypoints to one modal — drop the loudest one inside the rail.

### Avatar menu (user-scoped only — Platform Settings stays in the rail)

**Platform Settings is NOT demoted.** The current rail footer item navigates to `/admin` — the admin shell with users, roles, request types, organizations, webhooks, etc. For admins and admin-permissioned service-desk operators this is a frequent operational destination, not rare configuration. Treat it the same as `Portal`: a top-level cross-shell jump.

Both `Portal` and `Settings` stay as rail footer items. `Settings` is permission-gated — hidden for users without any `*:admin` permission so reception/non-admin operators don't see a useless icon. (Current code shows it to everyone; clicking 401s. The fix is to hide it when not authorized, consistent with the new permission-aware filtering rule for the main nav.)

The `NavUser` component at the bottom of the rail still becomes a popover trigger — but only for **user-scoped** items, not for Platform Settings:

```
[avatar + name + email at top]
─────────────
Profile
Theme              [Light · Dark · System]
Keyboard shortcuts
─────────────
Sign out
```

Note: no "Preferences" / "Settings" label inside the popover — every item is specific. That avoids any visual collision with the rail's `Settings` (Platform) item.

### Active state harmonization

Both rail and second pane use the same active-state treatment:
- `bg-sidebar-accent` background fill
- `2px` left accent rule in `--primary` color
- Text color `text-sidebar-accent-foreground`

Implementation: extend `SidebarMenuButton`'s `data-[active=true]` styles in `apps/web/src/components/ui/sidebar.tsx` so both panes inherit the same treatment.

### Pane seam

When the second pane is present, add `border-r border-border/60` to the rail. When the rail is alone (sidebar fully collapsed to icon-only mode), no seam. Conditional via the same `data-[collapsible]` attribute the sidebar primitive already exposes.

### Header dedup

The second pane's header today shows the section name ("Tickets", "Bookings"). Change it to show the **active sub-context**:

| Pane | Old header | New header |
|---|---|---|
| Tickets | `Tickets` | `Unassigned · 23` (active view + count) |
| Bookings | `Bookings` | `Pending approval · 7` |
| Visitors | `Visitors` | `Today · 12` |
| Inbox | `Inbox` | `Inbox` (unchanged — Inbox IS the active context) |
| Reports | `Reports` | `Reports` (unchanged — no active sub-context) |

The rail already says you're in `Tickets` (active item). The pane should tell you *which* Tickets view. Removes the "Tickets · Tickets · Tickets" triple.

The active sub-context is computed from the URL params (`view=`, `scope=`, `date=`).

### State persistence

The rail's expanded state is persisted per-device in `localStorage` under key `prequest:rail-expanded` (boolean).

- **First-time users (no key set):** rail starts **expanded**. Label-discovery wins over compactness for first-runs.
- **Returning users:** load saved value.
- **Persist on every toggle.**

Per-device, not per-user-via-backend, because (a) avoids a backend round-trip on every toggle, (b) respects the legitimate "I use the rail expanded on my desk monitor and compact on the laptop" pattern.

The header `SidebarTrigger` (full sidebar offcanvas/icon toggle) keeps its existing persistence behavior in cookie storage — that's unchanged.

## Component changes — file-by-file

### `apps/web/src/components/ui/sidebar.tsx`

- Replace `SIDEBAR_WIDTH = "24rem"` constant with two derived custom properties: `--sidebar-rail-w` and `--sidebar-pane-w`.
- Lift `railExpanded` from `DeskSidebar` into `SidebarProvider` context, persist to `localStorage`.
- Update `data-[active=true]` styles on `SidebarMenuButton` to match the harmonized active treatment.
- Add `data-second-pane-present` data attribute on the outer `<Sidebar>` so the rail can conditionally render its right-border.

### `apps/web/src/components/desk/desk-sidebar.tsx`

- Remove the Search row (lines 313–327).
- Keep the standalone Settings nav item in the footer (lines 361–370) — but wrap it in the new permission gate so it's hidden for users with zero `*:admin` permissions.
- Remove the bottom rail-toggle wrapper/state (lines 372–384) — toggle moves into the SidebarProvider context (still rendered by `DeskSidebar` near the bottom but pulls state from context).
- Replace `PanelLeftOpen/Close` icons with `MenuIcon`/`LayoutGridIcon`; update tooltip strings.
- Replace flat `navItems.map` with grouped `<SidebarGroup>`s wrapping the four sections (`MY QUEUE`, unlabeled middle, `INSIGHTS`).
- Wrap the entire group rendering in `filterNavForUser(...)` (new helper).
- Add count-render slot to Inbox, Approvals, Visitors items (count + optional dot).
- Disambiguate icons: Bookings keeps `CalendarClockIcon`; Scheduler changes from `CalendarRangeIcon` to `Columns3Icon` (visually distinct from both Bookings' calendar+clock and the bottom-toggle's `LayoutGridIcon`).
- Update each second-pane's `<SidebarHeader>` content to show active sub-context (`Unassigned · 23`, `Pending approval · 7`, etc.).

### `apps/web/src/components/nav-user.tsx`

- Convert from a passive nav row into a `Popover` trigger.
- Build out the popover content per spec (Profile · Theme triad · Keyboard shortcuts · Sign out). **No Platform Settings entry** — that stays in the rail footer.
- The Theme triad is a small inline 3-button segment using the existing `useTheme` hook.

### `apps/web/src/lib/nav-permissions.ts` (new)

- Export `filterNavForUser(navGroups: NavGroup[], userPerms: PermissionSet): NavGroup[]`.
- Iterates groups, filters items per permission, drops empty groups, preserves order.
- Pure function. Unit-tested with permission fixtures.

### `apps/web/src/api/nav/counts.ts` (new)

- One React Query hook per counted item: `useInboxUnreadCount()`, `useMyPendingApprovalsCount()`, `useExpectedVisitorsCount()`.
- Each follows the `apps/web/src/api/<module>/` pattern (per `docs/react-query-guidelines.md`).
- Each returns `{ count: number, hasUrgency: boolean }`.
- staleTime: 30s. Refetch on focus + on realtime push.

### Backend signal additions

Three lightweight count endpoints (or extensions to existing):

- `GET /tickets/inbox?count=true` → `{ count, hasUrgency }`
- `GET /approvals/pending?owner=me&count=true` → `{ count, hasUrgency }`
- `GET /visitors?date=today&building=$id&count=true` → `{ count, hasUrgency }`

`hasUrgency` is computed server-side per the rules in the Counts section.

## Visual specs (consolidated)

| Token / measure | Value |
|---|---|
| Rail width — compact | `48px` |
| Rail width — expanded | `180px` |
| Second pane width — default | `320px` |
| Second pane width — minimum | `280px` |
| Total `--sidebar-width` — collapsed (icon-only) | `48px` |
| Total `--sidebar-width` — open + rail compact | `368px` |
| Total `--sidebar-width` — open + rail expanded | `500px` |
| Width transition | `200ms var(--ease-smooth)` |
| Active row treatment | `bg-sidebar-accent` + `2px` left rule in `--primary` |
| Pane seam | `border-r border-border/60` on rail (only when second pane present) |
| Group label | `text-[11px] uppercase tracking-wide text-muted-foreground font-medium` (existing `SidebarGroupLabel` styling) |
| Group separator | `<SidebarSeparator>` between groups |
| Count text | `font-mono tabular-nums text-xs text-muted-foreground ml-auto` |
| Urgency dot | `4×4px bg-destructive` rounded-full, right of count |
| Urgency dot transition | single pulse on appear: `200ms var(--ease-out)`, no loop |
| Bottom toggle icon | `MenuIcon` (compact) ↔ `LayoutGridIcon` (expanded) |
| Bottom toggle tooltip | "Show labels" / "Compact view" |

## Behavioral edge cases

| Case | Behavior |
|---|---|
| User toggles rail rapidly | Width transition is interruptible (CSS transition, not keyframes). The page-content reflow is also interruptible — uses the same easing, no jank. |
| All groups empty (zero permissions — pathological) | Render an empty rail with just the avatar. Should not happen in practice. |
| Counts endpoint fails | Item still renders, count slot is empty (no `?` placeholder, no error indicator in the rail). Toast nothing — this is a peripheral signal, not an action. Failure is logged. |
| Realtime is broken (`RealtimeStatusStore` reports 'broken') | Counts stop auto-refreshing; the realtime status dot in page-headers communicates the broken state per existing error-handling spec. Rail counts don't grow stale-stamped icons — they just stop updating until reconnect. |
| User is on mobile (`isMobile` from `useSidebar`) | Sidebar uses sheet/offcanvas (existing behavior). Rail-expanded toggle is hidden on mobile (full sheet always shows labels). Spec changes don't touch mobile layout. |
| User has multiple buildings as reception scope | Visitor count uses the *currently selected* building from `ReceptionBuildingProvider`. If no building selected, count is hidden (not zero). |
| First load / SSR / no localStorage | Rail defaults to expanded; rendered server-side as expanded; client hydrates from localStorage on mount. Prevents the "expanded → compact flash" by gating on a hydration boolean if needed. |

## Out of scope (explicit non-goals, restated)

- Triage section (separate brainstorm)
- Two-key keyboard shortcuts (`G T`, `G I`, etc.) — polish wave 2
- Recent + Favorites auto-populated section
- Hover-reveal "+ New X" actions
- Drag-resize sidebar boundary
- Sub-pane keyboard navigation (j/k between rows)
- Per-user backend-persisted rail preference (localStorage is sufficient for v1)
- Animated number-scrub on count changes (cheap polish to fold in later, no spec needed)
- Bookings + Scheduler merge

## Testing

| Layer | What to test |
|---|---|
| Unit | `filterNavForUser` — fixtures for: full-perms, reception-only, no-perms, partial-perms across each group. Assert hidden groups, kept groups, single-item groups still labeled. |
| Unit | Each count hook — happy path, error path (count slot empty), realtime push triggers refetch. |
| Component (RTL) | `DeskSidebar` renders correct grouped structure given each persona's perms. Active state matches between rail and second pane. Header dedup shows active sub-context. |
| Component (RTL) | `NavUser` popover opens, contains expected items, theme switcher works, Sign out fires logout mutation. |
| E2E (Playwright if available; manual otherwise) | Toggle rail expanded/compact → total sidebar width changes per spec, second pane never crushes below 280px. State persists across reload. |
| E2E | Reception user (Visitors-only perms) sees a clean rail with one labeled-context group. |
| E2E | Service-desk user (full perms) sees all four groups, labels in correct positions, counts populate. |
| Accessibility | Rail toggle is keyboard-reachable; active state is announced via `aria-current="page"`; counts are exposed via `aria-label="Inbox, 7 unread"` not just visual. Reduced motion: width transition collapses to 0ms (already handled globally per `index.css`). |

## Smoke gate

This spec touches no backend services that the existing `pnpm smoke:work-orders` gate covers. The new count endpoints should each have their own service-level test. No new mandatory smoke target needed.

## Open questions

None. All twelve consolidated decisions in the brainstorm were resolved before write-up.
