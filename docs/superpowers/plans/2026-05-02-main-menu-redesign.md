# Main menu redesign — implementation plan

> Companion to `docs/superpowers/specs/2026-05-02-main-menu-redesign-design.md`. Executed autonomously 2026-05-02 in one session per user instruction. Each phase = one focused commit.

## Phases

- [ ] **P1 — Foundation: width math + railExpanded persistence** (`sidebar.tsx`)
  - Lift `railExpanded` boolean from `DeskSidebar` into `SidebarProvider` context
  - Persist to `localStorage['prequest:rail-expanded']` (default `true` for new users)
  - Replace `SIDEBAR_WIDTH = "24rem"` with derived total = `--sidebar-rail-w` + `--sidebar-pane-w`
  - Add `--sidebar-rail-w-compact = 48px` + `--sidebar-rail-w-expanded = 180px`
  - Pane min-width 280px (CSS); default 320px
  - Width transition `200ms var(--ease-smooth)`
  - Harmonize active-state styling on `SidebarMenuButton` (`bg-sidebar-accent` + 2px left rule in `--primary`)
  - Add `data-second-pane-present` attribute on outer Sidebar for seam logic

- [ ] **P2 — Permission filter helper** (`lib/nav-permissions.ts` new)
  - Pure function `filterNavGroups(groups, hasPerm)` — hide empty groups, preserve order, keep label on single-item
  - Permission keys map per spec
  - Wire to `useAuth().appUser.roles` (project uses role types, not granular permissions yet — admin/agent/employee gates)

- [ ] **P3 — Backend count endpoints**
  - `GET /tickets/inbox?count=true` — extend `getInbox` to return `{count, hasUrgency}` when count flag set
  - `GET /approvals/pending/me/count` — new route (no `:personId`, derives from auth)
  - `GET /reception/today/count` — visitor expected-today count + urgency

- [ ] **P4 — Frontend count hooks** (`api/nav/` new module)
  - `keys.ts`, `queries.ts`, `types.ts`, `index.ts` per existing api/ pattern
  - `useInboxUnreadCount`, `useMyPendingApprovalsCount`, `useExpectedVisitorsCount`
  - staleTime 30s, refetchOnWindowFocus

- [ ] **P5 — DeskSidebar refactor** (`desk-sidebar.tsx`)
  - Delete Search row
  - Group structure: MY QUEUE → unlabeled middle → INSIGHTS via `SidebarGroup` + `SidebarSeparator`
  - Apply `filterNavGroups`
  - Wire counts + urgency dot to Inbox/Approvals/Visitors
  - Disambiguate Scheduler icon: `CalendarRangeIcon` → `Columns3Icon`
  - Replace bottom toggle icon: `PanelLeftOpen/Close` → `MenuIcon`/`LayoutGridIcon`; tooltip "Show labels" / "Compact view"
  - Wire toggle to context (no local state)
  - Permission-gate Settings rail item

- [ ] **P6 — Pane seam** (sidebar.tsx + desk-sidebar.tsx)
  - Add `border-r border-border/60` on rail when second pane present

- [ ] **P7 — Header dedup**
  - Tickets pane → `{view label} · {count}`
  - Bookings pane → `{scope label} · {count}` (scope from URL)
  - Visitors pane → `{view label} · {count}`
  - Inbox/Reports unchanged

- [ ] **P8 — NavUser cleanup** (`user-menu-content.tsx`)
  - Remove disabled "Settings" item (Platform Settings stays in rail)
  - Add disabled "Keyboard shortcuts" placeholder (will activate when shortcuts ship)

- [ ] **P9 — Manual smoke** with dev server

- [ ] **P10 — `/full-review`**

## Notes
- Frontend has no test framework today; rely on TypeScript + lint + manual smoke. Backend count endpoints get Jest specs.
- Bookings/Scheduler stay separate per user call.
- All 11 redirected decisions from the brainstorm are in the spec.
