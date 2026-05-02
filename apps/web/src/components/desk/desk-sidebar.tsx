"use client"

import * as React from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { NavUser } from "@/components/nav-user"
import { WorkspaceSwitcher } from "@/components/workspace-switcher"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar"
import { Switch } from "@/components/ui/switch"
import {
  InboxIcon,
  TicketIcon,
  CheckSquareIcon,
  BarChart3Icon,
  UserIcon,
  UsersIcon,
  AlertTriangleIcon,
  ClockIcon,
  FilterIcon,
  LayoutGridIcon,
  MenuIcon,
  Columns3Icon,
  LayoutDashboardIcon,
  SettingsIcon,
  GaugeIcon,
  TimerIcon,
  BoxIcon,
  MapPinIcon,
  ListTreeIcon,
  BuildingIcon,
  CalendarRangeIcon,
  CalendarClockIcon,
  HourglassIcon,
  CalendarCheck2Icon,
  ArchiveIcon,
  XCircleIcon,
  GlobeIcon,
  ChefHatIcon,
  UserPlusIcon,
  CalendarDaysIcon,
  CheckCheckIcon,
  KeyRoundIcon,
  AlertCircleIcon,
  type LucideIcon,
} from "lucide-react"
import { useQuery, queryOptions } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api"
import { useAuth } from "@/providers/auth-provider"
import { useReceptionBuilding } from "@/components/desk/desk-building-context"
import { filterNavGroups, type NavGroup } from "@/lib/nav-permissions"
import {
  useInboxUnreadCount,
  useMyPendingApprovalsCount,
  useExpectedVisitorsCount,
} from "@/api/nav"
import { formatCount } from "@/lib/format"
import {
  VIEW_ORDER,
  viewPresets,
  type ViewId,
} from "@/pages/desk/use-ticket-filters"
import {
  VISITOR_VIEW_ORDER,
  visitorViewPresets,
  type VisitorViewId,
} from "@/pages/desk/use-visitor-filters"
import { SchedulerSidebarPanel } from "@/components/desk/scheduler-sidebar-panel"
import { Calendar } from "@/components/ui/calendar"
import { ReceptionBuildingPicker } from "@/components/desk/desk-building-picker"

/**
 * Grouped rail navigation. Per
 * docs/superpowers/specs/2026-05-02-main-menu-redesign-design.md §IA:
 *   • MY QUEUE — things waiting on me (specific label, earns its place)
 *   • unlabeled middle bucket — operational destinations (any label here is
 *     decorative; visual gap suffices)
 *   • INSIGHTS — read-only analysis (different mode, earns a label)
 *
 * `permission` is currently coarse-grained (admin / agent — anyone with
 * desk access sees these). When granular permissions ship, swap this for a
 * permission key per item; the filter helper signature is generic.
 *
 * `countSlot` opts an item into the rail-badge count + urgency dot; nav
 * items without a slot render plain.
 */
type RailItemPermission = "agent" | "admin"
type CountSlot = "inbox" | "approvals" | "visitors"

interface RailNavItem {
  id: string
  title: string
  icon: LucideIcon
  path: string
  permission: RailItemPermission
  countSlot?: CountSlot
}

const railGroups: NavGroup<RailItemPermission, RailNavItem>[] = [
  {
    id: "my-queue",
    label: "My Queue",
    items: [
      { id: "inbox", title: "Inbox", icon: InboxIcon, path: "/desk/inbox", permission: "agent", countSlot: "inbox" },
      { id: "approvals", title: "Approvals", icon: CheckSquareIcon, path: "/desk/approvals", permission: "agent", countSlot: "approvals" },
    ],
  },
  {
    id: "work",
    label: null,
    items: [
      { id: "tickets", title: "Tickets", icon: TicketIcon, path: "/desk/tickets", permission: "agent" },
      { id: "bookings", title: "Bookings", icon: CalendarClockIcon, path: "/desk/bookings", permission: "agent" },
      { id: "scheduler", title: "Scheduler", icon: Columns3Icon, path: "/desk/scheduler", permission: "agent" },
      { id: "visitors", title: "Visitors", icon: UserPlusIcon, path: "/desk/visitors", permission: "agent", countSlot: "visitors" },
    ],
  },
  {
    id: "insights",
    label: "Insights",
    items: [
      { id: "reports", title: "Reports", icon: BarChart3Icon, path: "/desk/reports", permission: "agent" },
    ],
  },
]

// Scopes shown in the Bookings sidebar panel — mirrors the `?scope=` enum
// in `pages/desk/bookings.tsx`. Adding/removing here means doing the same
// in that file's SCOPES array.
type BookingsScope = "pending_approval" | "upcoming" | "past" | "cancelled" | "all"
const bookingsScopes: Array<{
  id: BookingsScope
  label: string
  icon: typeof HourglassIcon
}> = [
  { id: "pending_approval", label: "Pending approval", icon: HourglassIcon },
  { id: "upcoming", label: "Upcoming", icon: CalendarCheck2Icon },
  { id: "past", label: "Past", icon: ArchiveIcon },
  { id: "cancelled", label: "Cancelled", icon: XCircleIcon },
  { id: "all", label: "All bookings", icon: GlobeIcon },
]

// View ids match `useTicketFilters` preset ids. Icons live in the sidebar so
// the hook stays UI-framework-agnostic.
const viewIcons: Record<ViewId, typeof UserIcon> = {
  me: UserIcon,
  all: FilterIcon,
  unassigned: UsersIcon,
  sla_at_risk: AlertTriangleIcon,
  recent: ClockIcon,
}

const viewLabels: Record<ViewId, string> = {
  me: "Assigned to me",
  all: "All tickets",
  unassigned: "Unassigned",
  sla_at_risk: "SLA at risk",
  recent: "Recent",
}

// Visitor view ids — match `useVisitorFilters` preset ids.
const visitorViewIcons: Record<VisitorViewId, typeof UserIcon> = {
  today: CalendarDaysIcon,
  expected: HourglassIcon,
  arrived: CheckCheckIcon,
  pending_approval: AlertCircleIcon,
  loose_ends: KeyRoundIcon,
  all: GlobeIcon,
  recent: ClockIcon,
}

const reportGroups: Array<{
  title: string
  items: Array<{ to: string; label: string; icon: typeof LayoutDashboardIcon }>
}> = [
  {
    title: "Service desk",
    items: [
      { to: "/desk/reports/overview", label: "Overview", icon: LayoutDashboardIcon },
      { to: "/desk/reports/sla", label: "SLA performance", icon: GaugeIcon },
      { to: "/desk/reports/teams", label: "Team workload", icon: UsersIcon },
      { to: "/desk/reports/resolution", label: "Resolution times", icon: TimerIcon },
    ],
  },
  {
    title: "Room booking",
    items: [
      { to: "/desk/reports/bookings",             label: "Overview",            icon: CalendarCheck2Icon },
      { to: "/desk/reports/bookings/utilization", label: "Utilization",         icon: GaugeIcon },
      { to: "/desk/reports/bookings/no-shows",    label: "No-shows & cancels",  icon: AlertTriangleIcon },
      { to: "/desk/reports/bookings/services",    label: "Services & costs",    icon: ChefHatIcon },
      { to: "/desk/reports/bookings/demand",      label: "Demand & contention", icon: HourglassIcon },
    ],
  },
  {
    title: "Operations",
    items: [
      { to: "/desk/reports/assets", label: "Asset analysis", icon: BoxIcon },
      { to: "/desk/reports/locations", label: "Location analysis", icon: MapPinIcon },
      { to: "/desk/reports/request-types", label: "Request types", icon: ListTreeIcon },
    ],
  },
  {
    title: "Financials",
    items: [
      { to: "/desk/reports/vendors", label: "Vendor performance", icon: BuildingIcon },
    ],
  },
]

type InboxReason = "mentioned" | "assigned_to_me" | "my_team" | "watching"

interface InboxAttachment {
  name: string
  size: number
  type: string
}

interface InboxActivity {
  id: string
  created_at: string
  content: string | null
  visibility: string
  attachments: InboxAttachment[]
  author?: { first_name: string; last_name: string } | null
}

interface InboxTicket {
  id: string
  title: string
  status_category: string
  priority: string
  requester?: { first_name: string; last_name: string }
  created_at: string
  inbox_reason: InboxReason
  inbox_reasons: InboxReason[]
  latest_activity?: InboxActivity | null
}

interface InboxResponse {
  items: InboxTicket[]
}

const priorityDot: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-orange-400",
  medium: "bg-blue-400",
  low: "bg-gray-300",
}

const inboxReasonLabel: Record<InboxReason, string> = {
  mentioned: "Mentioned",
  assigned_to_me: "Assigned",
  my_team: "Team",
  watching: "Watching",
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function personLabel(person?: { first_name: string; last_name: string } | null): string | null {
  if (!person) return null

  const fullName = `${person.first_name} ${person.last_name}`.trim()
  return fullName || null
}

function inboxPreview(ticket: InboxTicket): string {
  const content = ticket.latest_activity?.content?.trim()
  if (content) return content.replace(/\s+/g, " ")

  const attachments = ticket.latest_activity?.attachments ?? []
  if (attachments.length === 1) return `Attached ${attachments[0].name}`
  if (attachments.length > 1) return `Attached ${attachments.length} files`

  return "No messages yet"
}

function inboxPoster(ticket: InboxTicket): string {
  return (
    personLabel(ticket.latest_activity?.author ?? null) ??
    personLabel(ticket.requester) ??
    "Unknown"
  )
}

export function DeskSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const location = useLocation()
  const navigate = useNavigate()
  const { setOpen, railExpanded, toggleRailExpanded } = useSidebar()
  const { hasRole } = useAuth()
  const { buildingId: receptionBuildingId } = useReceptionBuilding()

  // Flatten rail items for active-page lookup. Permission filtering is
  // applied per-render below; the flatten here is over the unfiltered set
  // because the URL might match an item the user can't see (defensive — the
  // route guard would 401 first, but we still derive the activeNav).
  const allRailItems = React.useMemo(
    () => railGroups.flatMap((g) => g.items as RailNavItem[]),
    [],
  )
  const activePage = allRailItems.find((item) => location.pathname.startsWith(item.path))
  const [activeNav, setActiveNav] = React.useState<RailNavItem>(activePage ?? allRailItems[0])
  const [inboxSearch, setInboxSearch] = React.useState("")

  // Permission-aware groups for the current user.
  //
  // ⚠ Today the only meaningful gate is on Settings (admin-only, see
  // `canSeeSettings` below). All RAIL items are tagged `permission: 'agent'`,
  // and `hasRole('agent')` returns true for both agent and admin (auth
  // provider line 143) — meaning every desk operator currently sees every
  // rail item. The `filterNavGroups` machinery is in place so that when
  // granular per-feature permission keys land (e.g. `tickets:read_any`,
  // `visitors:read_any`), each item's `permission` swaps to the granular
  // key and the predicate becomes `userPermissions.has(perm)`. Until then,
  // the filter is structural scaffolding, not enforcement.
  const visibleGroups = React.useMemo(
    () =>
      filterNavGroups(railGroups, (perm) => {
        if (perm === "admin") return hasRole("admin")
        return hasRole("agent")
      }),
    [hasRole],
  )

  // Settings (rail footer) is admin-only. Hidden entirely otherwise so
  // non-admin operators don't see a useless icon.
  const canSeeSettings = hasRole("admin")

  // Rail-badge counts. Each hook is independent; failures are swallowed
  // (the badge slot just renders empty) — see error-handling spec, the rail
  // is a peripheral signal not an action surface.
  const inboxCount = useInboxUnreadCount()
  const approvalsCount = useMyPendingApprovalsCount()
  const visitorsCount = useExpectedVisitorsCount(receptionBuildingId)
  const countByItem: Record<CountSlot, { count?: number; hasUrgency?: boolean }> = {
    inbox: { count: inboxCount.data?.count, hasUrgency: inboxCount.data?.hasUrgency },
    approvals: { count: approvalsCount.data?.count, hasUrgency: approvalsCount.data?.hasUrgency },
    visitors: { count: visitorsCount.data?.count, hasUrgency: visitorsCount.data?.hasUrgency },
  }

  React.useEffect(() => {
    if (activePage) setActiveNav(activePage)
  }, [activePage])

  const isInboxPage = location.pathname.startsWith("/desk/inbox")

  const { data: inboxData } = useQuery(queryOptions({
    queryKey: ['tickets', 'inbox', { limit: 20 }] as const,
    queryFn: ({ signal }) => apiFetch<InboxResponse>('/tickets/inbox', { signal, query: { limit: 20 } }),
    staleTime: 30_000,
  }))
  // Stabilise the items reference so the filter memo only re-runs when the
  // server payload actually changes. `inboxData?.items ?? []` would allocate a
  // new array on every render and defeat the memo.
  const inboxTickets = React.useMemo(() => inboxData?.items ?? [], [inboxData])
  const filteredInboxTickets = React.useMemo(() => {
    const query = inboxSearch.trim().toLowerCase()
    if (!query) return inboxTickets
    return inboxTickets.filter((ticket) =>
      [
        ticket.title,
        inboxPreview(ticket),
        inboxPoster(ticket),
        inboxReasonLabel[ticket.inbox_reason],
        personLabel(ticket.requester) ?? "",
      ].some((value) => value.toLowerCase().includes(query))
    )
  }, [inboxTickets, inboxSearch])

  return (
    <Sidebar
      collapsible="icon"
      className="overflow-hidden *:data-[sidebar=sidebar]:flex-row"
      variant="inset"
      {...props}
    >
      {/* First sidebar: icon rail (expandable to show labels). Width is
          driven by --sidebar-rail-width which the SidebarProvider derives
          from `railExpanded`; the outer sidebar's total width grows in
          step so the contextual second pane keeps its width either way. */}
      <Sidebar
        collapsible="none"
        className="w-(--sidebar-rail-width) border-r border-border/60 transition-[width] duration-200 ease-[var(--ease-smooth)]"
      >
        <SidebarHeader>
          <WorkspaceSwitcher current="desk" collapsed={!railExpanded} />
        </SidebarHeader>
        <SidebarContent>
          {visibleGroups.map((group, groupIndex) => (
            <React.Fragment key={group.id}>
              {/* Visual gap between groups; render only when the group has
                  no label so labeled groups use SidebarGroupLabel instead. */}
              {group.label === null && groupIndex > 0 && railExpanded && (
                <SidebarSeparator className="my-1" />
              )}
              <SidebarGroup>
                {group.label !== null && railExpanded && (
                  <SidebarGroupLabel className="px-2 uppercase tracking-wide">
                    {group.label}
                  </SidebarGroupLabel>
                )}
                <SidebarGroupContent className={railExpanded ? "px-1.5" : "px-1.5 md:px-0"}>
                  <SidebarMenu>
                    {(group.items as RailNavItem[]).map((item) => {
                      const slot = item.countSlot ? countByItem[item.countSlot] : undefined
                      const showCount = slot && typeof slot.count === "number" && slot.count > 0 && railExpanded
                      const showUrgency = slot?.hasUrgency === true
                      return (
                        <SidebarMenuItem key={item.id}>
                          <SidebarMenuButton
                            tooltip={{ children: item.title, hidden: railExpanded }}
                            onClick={() => {
                              setActiveNav(item)
                              navigate(item.path)
                              setOpen(true)
                            }}
                            isActive={activeNav?.id === item.id}
                            className={railExpanded ? "px-2" : "px-2.5 md:px-2"}
                          >
                            <item.icon className="shrink-0" />
                            {railExpanded && <span>{item.title}</span>}
                            {showCount && (
                              <span className="ml-auto font-mono tabular-nums text-xs text-muted-foreground">
                                {formatCount(slot.count!)}
                              </span>
                            )}
                            {showUrgency && railExpanded && (
                              <span
                                aria-label="needs attention"
                                className="ml-1 inline-block size-1.5 rounded-full bg-destructive"
                              />
                            )}
                            {showUrgency && !railExpanded && (
                              <span
                                aria-label="needs attention"
                                className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-destructive"
                              />
                            )}
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </React.Fragment>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={{ children: "Employee Portal", hidden: railExpanded }}
                onClick={() => navigate("/portal")}
                className={railExpanded ? "px-2" : "px-2.5 md:px-2"}
              >
                <LayoutDashboardIcon className="shrink-0" />
                {railExpanded && <span>Portal</span>}
              </SidebarMenuButton>
            </SidebarMenuItem>
            {canSeeSettings && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip={{ children: "Platform Settings", hidden: railExpanded }}
                  onClick={() => navigate("/admin")}
                  className={railExpanded ? "px-2" : "px-2.5 md:px-2"}
                >
                  <SettingsIcon className="shrink-0" />
                  {railExpanded && <span>Settings</span>}
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
          <SidebarSeparator className="my-1" />
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={{
                  children: railExpanded ? "Compact view" : "Show labels",
                  hidden: railExpanded,
                }}
                onClick={toggleRailExpanded}
                className={railExpanded ? "px-2" : "px-2.5 md:px-2"}
              >
                {railExpanded ? (
                  <LayoutGridIcon className="shrink-0" />
                ) : (
                  <MenuIcon className="shrink-0" />
                )}
                {railExpanded && <span>Compact view</span>}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <NavUser />
        </SidebarFooter>
      </Sidebar>

      {/* Second sidebar: nested content panel */}
      <Sidebar collapsible="none" className="hidden flex-1 md:flex overflow-hidden">
        {isInboxPage ? (
          <>
            <SidebarHeader className="gap-3.5 border-b p-4">
              <div className="flex w-full items-center justify-between">
                <div className="text-base font-medium text-foreground">Inbox</div>
                <Label className="flex items-center gap-2 text-sm">
                  <span>Unread</span>
                  <Switch className="shadow-none" />
                </Label>
              </div>
              <SidebarInput
                placeholder="Search inbox..."
                value={inboxSearch}
                onChange={(event) => setInboxSearch(event.target.value)}
              />
            </SidebarHeader>
            <SidebarContent>
              <SidebarGroup className="px-0">
                <SidebarGroupContent>
                  {filteredInboxTickets.length === 0 && (
                    <div className="p-6 text-sm text-muted-foreground text-center">
                      {inboxTickets.length === 0 ? "No relevant tickets" : "No matching tickets"}
                    </div>
                  )}
                  <SidebarMenu>
                    {filteredInboxTickets.map((ticket) => {
                      const preview = inboxPreview(ticket)
                      const poster = inboxPoster(ticket)
                      const previewTime = ticket.latest_activity?.created_at ?? ticket.created_at

                      return (
                        <SidebarMenuItem key={ticket.id}>
                          <SidebarMenuButton
                            onClick={() => navigate(`/desk/inbox?ticket=${ticket.id}`)}
                            className="h-auto items-start gap-3 px-4 py-3 text-sm overflow-hidden"
                          >
                            <div className={`mt-1.5 h-2.5 w-2.5 rounded-full shrink-0 ${priorityDot[ticket.priority] ?? "bg-gray-300"}`} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-start gap-2">
                                <span className="line-clamp-2 flex-1 font-medium leading-5">{preview}</span>
                                <span className="ml-auto text-xs text-muted-foreground shrink-0">
                                  {timeAgo(previewTime)}
                                </span>
                              </div>
                              <div className="mt-1 flex items-center justify-between gap-2">
                                <span className="line-clamp-1 text-xs text-muted-foreground">
                                  {poster}
                                </span>
                                <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px] font-medium">
                                  {inboxReasonLabel[ticket.inbox_reason]}
                                </Badge>
                              </div>
                            </div>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </>
        ) : activeNav.path === "/desk/tickets" ? (
          <TicketsSidebarPanel />
        ) : activeNav.path === "/desk/visitors" ? (
          <VisitorsSidebarPanel />
        ) : activeNav.path === "/desk/bookings" ? (
          <BookingsSidebarPanel />
        ) : activeNav.path === "/desk/scheduler" ? (
          <SchedulerSidebarPanel />
        ) : activeNav.path === "/desk/reports" ? (
          <>
            <SidebarHeader className="gap-3.5 border-b p-4">
              <div className="text-base font-medium text-foreground">Reports</div>
            </SidebarHeader>
            <SidebarContent>
              {reportGroups.map((group) => (
                <SidebarGroup key={group.title}>
                  <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {group.items.map((item) => (
                        <SidebarMenuItem key={item.to}>
                          <SidebarMenuButton
                            onClick={() => navigate(item.to)}
                            isActive={location.pathname === item.to}
                            className="text-sm"
                          >
                            <item.icon className="size-4" />
                            <span>{item.label}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              ))}
            </SidebarContent>
          </>
        ) : (
          <SidebarHeader className="gap-3.5 border-b p-4">
            <div className="text-base font-medium text-foreground">
              {activeNav?.title}
            </div>
          </SidebarHeader>
        )}
      </Sidebar>
    </Sidebar>
  )
}

/**
 * Sidebar panel shown when /desk/bookings is active. Mirrors the
 * TicketsSidebarPanel shape — each scope is a sub-route on the same
 * page, driven by the `?scope=` URL param so deep-links highlight
 * correctly.
 */
function BookingsSidebarPanel() {
  const navigate = useNavigate()
  const location = useLocation()

  const activeScope = React.useMemo<BookingsScope>(() => {
    if (!location.pathname.startsWith("/desk/bookings")) return "pending_approval"
    const params = new URLSearchParams(location.search)
    const v = params.get("scope")
    return (v as BookingsScope) ?? "pending_approval"
  }, [location.pathname, location.search])

  // Pane header shows the active scope, not the section name — the rail
  // already says "Bookings". Scope labels are sourced from the in-file
  // bookingsScopes table to avoid duplication.
  const activeScopeLabel =
    bookingsScopes.find((s) => s.id === activeScope)?.label ?? "Bookings"

  return (
    <>
      <SidebarHeader className="gap-3.5 border-b p-4">
        <div className="flex items-center justify-between">
          <div className="text-base font-medium text-foreground">{activeScopeLabel}</div>
          <button
            onClick={() => navigate("/desk/scheduler")}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            type="button"
          >
            <CalendarRangeIcon className="size-3.5" />
            Scheduler
          </button>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Scopes</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {bookingsScopes.map((scope) => (
                <SidebarMenuItem key={scope.id}>
                  <SidebarMenuButton
                    className="text-sm"
                    isActive={activeScope === scope.id}
                    onClick={() => navigate(`/desk/bookings?scope=${scope.id}`)}
                  >
                    <scope.icon className="size-4" />
                    <span>{scope.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </>
  )
}

/**
 * Sidebar panel shown when /desk/tickets is active. Renders the named view
 * presets defined in `useTicketFilters`. Clicking a view navigates to the
 * tickets page with the preset's URL params applied. The active view is
 * derived from the `view` search param so deep-links highlight correctly.
 */
function TicketsSidebarPanel() {
  const navigate = useNavigate()
  const location = useLocation()

  const activeView = React.useMemo(() => {
    if (!location.pathname.startsWith("/desk/tickets")) return null
    const params = new URLSearchParams(location.search)
    return params.get("view")
  }, [location.pathname, location.search])

  // Pane header shows the active sub-context, not the section name —
  // the rail already says "Tickets". Falls back to "Views" when no
  // preset is active so the pane never reads as a duplicate of the rail.
  const headerLabel =
    (activeView && (viewLabels as Record<string, string | undefined>)[activeView]) ?? "Views"

  return (
    <>
      <SidebarHeader className="gap-3.5 border-b p-4">
        <div className="text-base font-medium text-foreground">{headerLabel}</div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Views</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {VIEW_ORDER.map((id) => {
                const Icon = viewIcons[id]
                const preset = viewPresets[id].params()
                const qs = new URLSearchParams(preset).toString()
                const isActive = activeView === id
                return (
                  <SidebarMenuItem key={id}>
                    <SidebarMenuButton
                      className="text-sm"
                      isActive={isActive}
                      onClick={() => navigate(`/desk/tickets?${qs}`)}
                    >
                      <Icon className="size-4" />
                      <span>{viewLabels[id]}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </>
  )
}

/**
 * Sidebar panel shown when /desk/visitors is active. Mirrors the
 * TicketsSidebarPanel: a list of named view presets at the top, plus
 * a small calendar widget that drives the `?date=YYYY-MM-DD` filter
 * for arbitrary days. The active view is derived from the `view`
 * search param so deep-links highlight correctly.
 */
function VisitorsSidebarPanel() {
  const navigate = useNavigate()
  const location = useLocation()

  const activeView = React.useMemo(() => {
    if (!location.pathname.startsWith("/desk/visitors")) return null
    const params = new URLSearchParams(location.search)
    return params.get("view")
  }, [location.pathname, location.search])

  const activeDate = React.useMemo(() => {
    if (!location.pathname.startsWith("/desk/visitors")) return undefined
    const v = new URLSearchParams(location.search).get("date")
    if (!v) return undefined
    if (v === "today") {
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      return d
    }
    if (v === "tomorrow") {
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      d.setDate(d.getDate() + 1)
      return d
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const [yyyy, mm, dd] = v.split("-").map(Number)
      return new Date(yyyy, mm - 1, dd)
    }
    return undefined
  }, [location.pathname, location.search])

  const onPickDate = (d: Date | undefined) => {
    const params = new URLSearchParams(location.search)
    if (!d) {
      params.delete("date")
    } else {
      const yyyy = d.getFullYear()
      const mm = String(d.getMonth() + 1).padStart(2, "0")
      const dd = String(d.getDate()).padStart(2, "0")
      params.set("date", `${yyyy}-${mm}-${dd}`)
    }
    navigate(`/desk/visitors?${params.toString()}`)
  }

  // Pane header shows the active view, not the section name — the rail
  // already says "Visitors". Falls back to "Today" (the default view) when
  // no view query param is present.
  const activeViewLabel =
    (activeView && visitorViewPresets[activeView as VisitorViewId]?.label) ??
    visitorViewPresets.today.label

  return (
    <>
      <SidebarHeader className="gap-3.5 border-b p-4">
        <div className="text-base font-medium text-foreground">{activeViewLabel}</div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Building</SidebarGroupLabel>
          <SidebarGroupContent className="px-2">
            <ReceptionBuildingPicker variant="prominent" />
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Views</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {VISITOR_VIEW_ORDER.map((id) => {
                const Icon = visitorViewIcons[id]
                const preset = visitorViewPresets[id].params()
                const qs = new URLSearchParams(preset).toString()
                const isActive = activeView === id || (!activeView && id === "today")
                return (
                  <SidebarMenuItem key={id}>
                    <SidebarMenuButton
                      className="text-sm"
                      isActive={isActive}
                      onClick={() => navigate(`/desk/visitors?${qs}`)}
                    >
                      <Icon className="size-4" />
                      <span>{visitorViewPresets[id].label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Calendar</SidebarGroupLabel>
          <SidebarGroupContent className="px-2">
            {/*
             * Fill the sidebar width. shadcn's Calendar defaults to
             * `w-fit` on its root + classNames.root, which collapses to
             * the day-grid's natural width and leaves a gap on the
             * right inside the sidebar. Override the root classes to
             * `w-full` so the day cells flex-grow across the available
             * width. The day cells themselves already use
             * `aspect-square w-full` per the upstream classNames, so
             * widening the row hands the extra px to each cell evenly.
             */}
            <Calendar
              mode="single"
              selected={activeDate}
              onSelect={onPickDate}
              className="w-full rounded-md border bg-background"
              classNames={{ root: "rdp-root w-full" }}
            />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </>
  )
}
