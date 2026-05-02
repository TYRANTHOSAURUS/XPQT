# Main menu (desk shell) redesign — design

**Date:** 2026-05-02
**Status:** Shipped (commits c93886a → e020ee5 + adversarial-review fixes)
**Owner:** Frontend
**Touches:** `apps/web/src/components/desk/desk-sidebar.tsx`, `apps/web/src/components/ui/sidebar.tsx`, `apps/web/src/components/nav-user.tsx`, `apps/web/src/layouts/desk-layout.tsx`, plus a small new helper for permission-aware nav filtering.

> **Spec ↔ shipped reconciliation (post-`/full-review`):** the sections below have been edited to reflect what actually shipped where the implementation diverged. Original drift points: (a) count endpoints are dedicated `/.../count` routes rather than `?count=true` query params, (b) permission gating is role-based today, not granular, (c) localStorage hydration is now backed by a cookie mirror to prevent the 180→48 width flash, (d) realtime invalidation is NOT wired (counts refresh on focus + 30s staleTime only). See "Open follow-ups" at the bottom for the deferred work.

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

### Permission-aware filtering (as shipped)

The nav array is filtered before render via `filterNavGroups(groups, canShow)` (`apps/web/src/lib/nav-permissions.ts`). The helper is a pure function with the structural rules below; the predicate is supplied per call site.

Structural rules:
- **An item is hidden** when the predicate returns false for its `permission` value.
- **A group is hidden entirely** when all its items are hidden after filtering.
- **A single-item group still shows its group label** (the label is the orientation cue, not visual decoration).
- **The unlabeled middle bucket renders even with one item** — the gap above/below is the separator.
- **Groups always render in fixed order** (`MY QUEUE` → middle → `INSIGHTS`); never reordered based on what's visible.

⚠ **Today the gating is role-based, not granular.** The auth provider currently exposes only `hasRole('admin' | 'agent' | 'employee')` — there's no per-feature permission key surface for the rail to consume. The shipped predicate maps every rail item to `'agent'` (which `hasRole` resolves true for both agent and admin), so every desk operator currently sees every rail item except Settings (admin-only). The promised "reception only sees Visitors" UX requires a granular permission catalog that hasn't shipped yet — captured under "Open follow-ups."

| Nav item | Gate today | Granular gate (when permission catalog supports it) |
|---|---|---|
| Inbox | `agent` (i.e. all desk operators) | `tickets:inbox` |
| Approvals | `agent` | `approvals:read_any` OR `approvals:read_assigned` |
| Tickets | `agent` | `tickets:read_any` OR `tickets:read_assigned` |
| Bookings | `agent` | `bookings:read_any` OR `bookings:read_assigned` |
| Scheduler | `agent` | same as Bookings |
| Visitors | `agent` | `visitors:read_any` OR `visitors:read_assigned` |
| Reports | `agent` | `reports:read` |
| Settings (footer) | `admin` (real gate) | any `*:admin` permission |
| Portal (footer) | always visible | always visible |

### Counts

Items that get counts: **Inbox, Approvals, Visitors.** Others stay numeric-silent.

| Item | What's counted | Source |
|---|---|---|
| Inbox | Unread items in your inbox (tickets where you're @-mentioned, assigned, watching, or your team owns) | `GET /tickets/inbox?unread=true&count=true` (extend existing endpoint to support `count=true` returning just `{count}` without payload) |
| Approvals | Pending approvals where YOU are the approver | `GET /approvals/pending?owner=me&count=true` (new endpoint or extend existing) |
| Visitors | Visitors expected today at the operator's reception's building | `GET /visitors?date=today&building=$reception_building&count=true` |

**Display:** count appears right-aligned in the row, `font-mono tabular-nums text-xs text-muted-foreground`. Uses the `tabular-nums` token already in `index.css` so digit width changes don't jitter.

**Update cadence (as shipped):**
- On mount: fresh fetch.
- On focus return (tab visibility change): `refetchOnWindowFocus: true`.
- React Query staleTime: 30s.
- **Realtime invalidation is NOT wired in v1.** The spec previously claimed counts refreshed on realtime push via `RealtimeStatusStore` — that store only carries connection status (`open | reconnecting | broken`), not entity-change events. Adding a true realtime path requires (a) a channel subscription per counted module, (b) targeted `queryClient.invalidateQueries(navKeys.inboxCount())` calls on relevant events. Captured under "Open follow-ups" below.

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

### State persistence (as shipped)

The rail's expanded state is persisted per-device with **dual storage**:

- **Cookie** `prequest_rail_expanded` (path=/, max-age=7d) — read SYNCHRONOUSLY on first render so the initial paint width is correct. Without this, the previous "default expanded → hydrate from localStorage on mount" approach caused a 180→48 width flash on every page load for compact-mode users (and full layout reflow with the rail's `transition-[width]`).
- **localStorage** `prequest:rail-expanded` — canonical, written on every toggle alongside the cookie. Also read in a one-shot effect to backfill the cookie if a user's preference predates the cookie write being added.

**Defaults:**
- **First-time users (no cookie or localStorage):** rail starts **expanded**.
- **Returning users:** read from cookie synchronously, no flicker.
- **Toggle writes both cookie + localStorage.**

Per-device, not per-user-via-backend, for v1. Per-user backend persistence would address the "I use it expanded on my desk monitor and compact on the laptop" comment from review (the inverse — the cookie/localStorage IS per-device, which is what the screenshot use-case actually wants); a backend persistence would only help if a user wants the same setting across devices. Captured under "Open follow-ups."

The header `SidebarTrigger` (full sidebar offcanvas/icon toggle) keeps its existing persistence behavior in the `sidebar_state` cookie — unchanged.

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

## Open follow-ups (deferred from v1, surfaced by the post-ship `/full-review`)

1. **Granular permission catalog for nav items.** Today the rail is gated on role types (`agent` / `admin`) so all desk operators see every rail item. Building the persona-specific UX promised in §IA ("reception only sees Visitors") requires per-feature permission keys (`tickets:read_any`, `visitors:read_any`, etc.) and an auth-provider extension to expose them. Filter scaffolding is in place — the predicate body becomes `userPermissions.has(perm)` once the catalog ships.
2. **Realtime invalidation of counts.** v1 refreshes on focus + 30s staleTime. To make the badges "feel alive" during sustained activity, wire a per-module realtime channel that calls `queryClient.invalidateQueries(navKeys.inboxCount())` (and the analogous keys) on relevant events. Coordinate with the existing `RealtimeStatusStore` for per-tenant subscription.
3. **Inbox count perf.** `getInboxCount` currently wraps `getInbox` and counts items — same query cost as opening the Inbox page. Refactor to a fast-path that runs the candidate-id composition without activity hydration; the urgency check needs only `priority` + `inbox_reason` columns.
4. **Per-user backend persistence of rail expanded.** Today is per-device (cookie + localStorage). A backend persistence would let a user keep the same setting across devices. Low priority — most users do work the same way on the same hardware.
5. **A11y polish.** Add `aria-label="Inbox, 7 unread"` on counted items, `aria-current="page"` on active rows, ensure the urgency dot has a screen-reader-friendly description (already shipped: `aria-label="needs attention"` on the dot).
6. **Mobile manual-smoke regression.** v1 smoke covered desktop only. The mobile sheet uses the same `--sidebar-width` CSS var; the dual-pane width math is gated behind `dualPane` on `SidebarProvider` and the desk shell's mobile sheet should pick up the existing `SIDEBAR_WIDTH_MOBILE` (20rem). Verify on a phone/tablet before claiming mobile parity.
7. **Bookings/Scheduler icons.** `Columns3Icon` reads as a kanban/columns view rather than a timeline scheduler. Pick a more timeline-native icon (`GanttChartIcon`?) when one of the lucide releases ships an obvious match.
8. **`INSIGHTS` group label** is currently shown for a single item ("Reports"). Defensible per the spec rule "single-item groups still labeled," but reads tautological. Reconsider when a second insights item arrives or if the user wants the label hidden in the meantime.
9. **Frontend test coverage.** No frontend test framework is configured today (no vitest/RTL). The shipped work was validated via `tsc --noEmit`, `eslint`, `vite build`, and manual smoke. Backend gets full Jest coverage for the modified services. Bootstrapping vitest+RTL is a separate sweep.
10. **Inbox panel "Unread" Switch** is decorative — pre-existing dead UI carried forward unchanged. Wire it or delete it as part of the next inbox-pass.
