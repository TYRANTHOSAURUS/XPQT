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
  PanelLeftOpenIcon,
  PanelLeftCloseIcon,
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
  SearchIcon,
  ChefHatIcon,
} from "lucide-react"
import { useCommandPalette } from "@/components/command-palette/command-palette"
import { useQuery, queryOptions } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api"
import {
  VIEW_ORDER,
  viewPresets,
  type ViewId,
} from "@/pages/desk/use-ticket-filters"
import { SchedulerSidebarPanel } from "@/components/desk/scheduler-sidebar-panel"

const navItems = [
  { title: "Inbox", icon: InboxIcon, path: "/desk/inbox" },
  { title: "Tickets", icon: TicketIcon, path: "/desk/tickets" },
  { title: "Approvals", icon: CheckSquareIcon, path: "/desk/approvals" },
  { title: "Bookings", icon: CalendarClockIcon, path: "/desk/bookings" },
  { title: "Scheduler", icon: CalendarRangeIcon, path: "/desk/scheduler" },
  { title: "Reports", icon: BarChart3Icon, path: "/desk/reports" },
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
  const { setOpen } = useSidebar()
  const { setOpen: setPaletteOpen } = useCommandPalette()
  const paletteOpen = React.useCallback(() => setPaletteOpen(true), [setPaletteOpen])

  const activePage = navItems.find((item) => location.pathname.startsWith(item.path))
  const [activeNav, setActiveNav] = React.useState(activePage ?? navItems[0])
  const [railExpanded, setRailExpanded] = React.useState(false)
  const [inboxSearch, setInboxSearch] = React.useState("")

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
      {/* First sidebar: icon rail (expandable to show labels) */}
      <Sidebar
        collapsible="none"
        className={`${railExpanded ? 'w-[180px]!' : 'w-[calc(var(--sidebar-width-icon)+1px)]!'} border-r transition-[width] duration-200`}
      >
        <SidebarHeader>
          <WorkspaceSwitcher current="desk" collapsed={!railExpanded} />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent className={railExpanded ? "px-2" : "px-1.5 md:px-0"}>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip={{ children: "Search (⌘K)", hidden: railExpanded }}
                    onClick={() => paletteOpen()}
                    className={railExpanded ? "px-3" : "px-2.5 md:px-2"}
                  >
                    <SearchIcon className="shrink-0" />
                    {railExpanded && (
                      <>
                        <span>Search</span>
                        <span className="ml-auto text-xs text-muted-foreground">⌘K</span>
                      </>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      tooltip={{ children: item.title, hidden: railExpanded }}
                      onClick={() => {
                        setActiveNav(item)
                        navigate(item.path)
                        setOpen(true)
                      }}
                      isActive={activeNav?.title === item.title}
                      className={railExpanded ? "px-3" : "px-2.5 md:px-2"}
                    >
                      <item.icon className="shrink-0" />
                      {railExpanded && <span>{item.title}</span>}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={{ children: "Employee Portal", hidden: railExpanded }}
                onClick={() => navigate("/portal")}
                className={railExpanded ? "px-3" : "px-2.5 md:px-2"}
              >
                <LayoutDashboardIcon className="shrink-0" />
                {railExpanded && <span>Portal</span>}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={{ children: "Platform Settings", hidden: railExpanded }}
                onClick={() => navigate("/admin")}
                className={railExpanded ? "px-3" : "px-2.5 md:px-2"}
              >
                <SettingsIcon className="shrink-0" />
                {railExpanded && <span>Settings</span>}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <div className="my-1" />
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={{ children: railExpanded ? "Collapse menu" : "Expand menu", hidden: railExpanded }}
                onClick={() => setRailExpanded(!railExpanded)}
                className={railExpanded ? "px-3" : "px-2.5 md:px-2"}
              >
                {railExpanded ? <PanelLeftCloseIcon className="shrink-0" /> : <PanelLeftOpenIcon className="shrink-0" />}
                {railExpanded && <span>Collapse</span>}
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

  return (
    <>
      <SidebarHeader className="gap-3.5 border-b p-4">
        <div className="flex items-center justify-between">
          <div className="text-base font-medium text-foreground">Bookings</div>
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

  return (
    <>
      <SidebarHeader className="gap-3.5 border-b p-4">
        <div className="text-base font-medium text-foreground">Tickets</div>
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
