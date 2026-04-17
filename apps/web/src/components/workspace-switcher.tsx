import { useNavigate } from "react-router-dom"
import {
  ChevronsUpDownIcon,
  CheckIcon,
  LayoutDashboardIcon,
  HeadsetIcon,
  SettingsIcon,
  type LucideIcon,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useAuth, type RoleType } from "@/providers/auth-provider"

export type WorkspaceId = "portal" | "desk" | "admin"

interface Workspace {
  id: WorkspaceId
  label: string
  icon: LucideIcon
  path: string
  requiresRole?: RoleType
}

const WORKSPACES: Workspace[] = [
  { id: "portal", label: "Employee Portal", icon: LayoutDashboardIcon, path: "/portal" },
  { id: "desk", label: "Service Desk", icon: HeadsetIcon, path: "/desk", requiresRole: "agent" },
  { id: "admin", label: "Platform Settings", icon: SettingsIcon, path: "/admin", requiresRole: "admin" },
]

interface WorkspaceSwitcherProps {
  current: WorkspaceId
  collapsed?: boolean
}

export function WorkspaceSwitcher({ current, collapsed = false }: WorkspaceSwitcherProps) {
  const navigate = useNavigate()
  const { hasRole } = useAuth()
  const { isMobile } = useSidebar()

  const available = WORKSPACES.filter((w) => !w.requiresRole || hasRole(w.requiresRole))
  const currentWorkspace = WORKSPACES.find((w) => w.id === current) ?? WORKSPACES[0]

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className={
                  collapsed
                    ? "md:h-8 md:p-0 data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
                    : "data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
                }
              />
            }
          >
            <div className="flex aspect-square size-8 items-center justify-center shrink-0">
              <img src="/assets/prequest-icon-color.svg" alt="Prequest" className="size-7" />
            </div>
            {!collapsed && (
              <>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">Prequest</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {currentWorkspace.label}
                  </span>
                </div>
                <ChevronsUpDownIcon className="ml-auto size-4 opacity-60" />
              </>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="start"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
              {available.map((w) => {
                const Icon = w.icon
                const isActive = w.id === current
                return (
                  <DropdownMenuItem key={w.id} onClick={() => navigate(w.path)}>
                    <Icon />
                    <span>{w.label}</span>
                    {isActive && <CheckIcon className="ml-auto size-4" />}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
