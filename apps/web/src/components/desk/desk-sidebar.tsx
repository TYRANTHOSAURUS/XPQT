"use client"

import * as React from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { NavUser } from "@/components/nav-user"
import { WorkspaceSwitcher } from "@/components/workspace-switcher"
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
} from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { useApi } from "@/hooks/use-api"

const navItems = [
  { title: "Inbox", icon: InboxIcon, path: "/desk/inbox" },
  { title: "Tickets", icon: TicketIcon, path: "/desk/tickets" },
  { title: "Approvals", icon: CheckSquareIcon, path: "/desk/approvals" },
  { title: "Reports", icon: BarChart3Icon, path: "/desk/reports" },
]

const ticketViews = [
  { id: "assigned-to-me", label: "Assigned to me", icon: UserIcon },
  { id: "all", label: "All tickets", icon: FilterIcon },
  { id: "unassigned", label: "Unassigned", icon: UsersIcon },
  { id: "sla-at-risk", label: "SLA at risk", icon: AlertTriangleIcon },
  { id: "my-team", label: "My team", icon: UsersIcon },
  { id: "recent", label: "Recent", icon: ClockIcon },
]


interface Ticket {
  id: string
  title: string
  status_category: string
  priority: string
  requester?: { first_name: string; last_name: string }
  created_at: string
  sla_at_risk: boolean
}

interface TicketListResponse {
  items: Ticket[]
  next_cursor: string | null
}

const priorityDot: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-orange-400",
  medium: "bg-blue-400",
  low: "bg-gray-300",
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

export function DeskSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const location = useLocation()
  const navigate = useNavigate()
  const { setOpen } = useSidebar()

  const activePage = navItems.find((item) => location.pathname.startsWith(item.path))
  const [activeNav, setActiveNav] = React.useState(activePage ?? navItems[0])
  const [railExpanded, setRailExpanded] = React.useState(false)

  const isInboxPage = activeNav.path === "/desk/inbox"

  const { data: ticketData } = useApi<TicketListResponse>(
    "/tickets?parent_ticket_id=null&limit=20",
    [],
  )
  const tickets = ticketData?.items ?? []

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
              <SidebarInput placeholder="Search tickets..." />
            </SidebarHeader>
            <SidebarContent>
              <SidebarGroup className="px-0">
                <SidebarGroupContent>
                  {tickets.length === 0 && (
                    <div className="p-6 text-sm text-muted-foreground text-center">
                      No tickets yet
                    </div>
                  )}
                  <SidebarMenu>
                    {tickets.map((ticket) => (
                      <SidebarMenuItem key={ticket.id}>
                        <SidebarMenuButton
                          onClick={() => navigate(`/desk/inbox?ticket=${ticket.id}`)}
                          className="h-auto items-start gap-3 px-4 py-3 text-sm overflow-hidden"
                        >
                          <div className={`mt-1.5 h-2.5 w-2.5 rounded-full shrink-0 ${priorityDot[ticket.priority] ?? "bg-gray-300"}`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate">{ticket.title}</span>
                              <span className="ml-auto text-xs text-muted-foreground shrink-0">
                                {timeAgo(ticket.created_at)}
                              </span>
                            </div>
                            <span className="text-xs text-muted-foreground truncate block mt-0.5">
                              {ticket.requester
                                ? `${ticket.requester.first_name} ${ticket.requester.last_name}`
                                : "Unknown"}
                              {" · "}
                              {ticket.status_category.replace("_", " ")}
                            </span>
                          </div>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </>
        ) : activeNav.path === "/desk/tickets" ? (
          <>
            <SidebarHeader className="gap-3.5 border-b p-4">
              <div className="text-base font-medium text-foreground">Tickets</div>
              <SidebarInput placeholder="Search..." />
            </SidebarHeader>
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupLabel>Views</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {ticketViews.map((view) => (
                      <SidebarMenuItem key={view.id}>
                        <SidebarMenuButton className="text-sm">
                          <view.icon className="size-4" />
                          <span>{view.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>

              <SidebarGroup>
                <SidebarGroupLabel>Filters</SidebarGroupLabel>
                <SidebarGroupContent className="px-4 space-y-4">
                  <div>
                    <p className="text-xs font-medium mb-2">Status</p>
                    {["new", "assigned", "in_progress", "waiting", "resolved"].map((s) => (
                      <div key={s} className="flex items-center gap-2.5 py-1.5">
                        <Checkbox id={`status-${s}`} />
                        <Label htmlFor={`status-${s}`} className="text-sm capitalize font-normal cursor-pointer">
                          {s.replace("_", " ")}
                        </Label>
                      </div>
                    ))}
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-2">Priority</p>
                    {["critical", "high", "medium", "low"].map((p) => (
                      <div key={p} className="flex items-center gap-2.5 py-1.5">
                        <Checkbox id={`priority-${p}`} />
                        <Label htmlFor={`priority-${p}`} className="text-sm capitalize font-normal cursor-pointer">
                          {p}
                        </Label>
                      </div>
                    ))}
                  </div>
                </SidebarGroupContent>
              </SidebarGroup>
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
