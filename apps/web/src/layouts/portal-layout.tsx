import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { NavUser } from '@/components/nav-user';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb';
import {
  Home,
  Ticket,
  CalendarDays,
  UserPlus,
  ShoppingCart,
  Headset,
  BarChart3,
  Settings,
} from 'lucide-react';

const portalNav = [
  { title: 'Home', path: '/portal', icon: Home },
  { title: 'My Requests', path: '/portal/my-requests', icon: Ticket },
  { title: 'Book a Room', path: '/portal/book', icon: CalendarDays },
  { title: 'Invite Visitor', path: '/portal/visitors', icon: UserPlus },
  { title: 'Order', path: '/portal/order', icon: ShoppingCart },
];

// These only show if the user has the right permissions
// TODO: check actual user roles from auth context
const hasAgentPermission = true; // placeholder
const hasAdminPermission = true; // placeholder

const agentNav = [
  { title: 'Service Desk', path: '/desk', icon: Headset },
];

const adminNav = [
  { title: 'Reports', path: '/desk/reports', icon: BarChart3 },
  { title: 'Settings', path: '/desk/settings', icon: Settings },
];

const user = {
  name: 'Jan de Vries',
  email: 'jan.devries@acme.nl',
  avatar: '',
};

const pageTitles: Record<string, string> = {
  '/portal': 'Home',
  '/portal/my-requests': 'My Requests',
  '/portal/book': 'Book a Room',
  '/portal/visitors': 'Invite Visitor',
  '/portal/order': 'Order',
};

export function PortalLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const pageTitle = Object.entries(pageTitles).find(([path]) =>
    path === '/portal' ? location.pathname === '/portal' : location.pathname.startsWith(path)
  )?.[1] ?? 'Portal';

  return (
    <SidebarProvider>
      <Sidebar variant="inset">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                onClick={() => navigate('/portal')}
                className="cursor-pointer"
              >
                <div className="flex aspect-square size-8 items-center justify-center shrink-0">
                  <img src="/assets/prequest-icon-color.svg" alt="Prequest" className="size-7" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">Prequest</span>
                  <span className="truncate text-xs text-muted-foreground">Employee Portal</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          {/* Portal navigation */}
          <SidebarGroup>
            <SidebarGroupLabel>Portal</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {portalNav.map((item) => {
                  const isActive = item.path === '/portal'
                    ? location.pathname === '/portal'
                    : location.pathname.startsWith(item.path);
                  return (
                    <SidebarMenuItem key={item.path}>
                      <SidebarMenuButton
                        isActive={isActive}
                        onClick={() => navigate(item.path)}
                        className="cursor-pointer"
                      >
                        <item.icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {/* Agent navigation — only if has permissions */}
          {hasAgentPermission && (
            <SidebarGroup>
              <SidebarGroupLabel>Workspace</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {agentNav.map((item) => (
                    <SidebarMenuItem key={item.path}>
                      <SidebarMenuButton
                        onClick={() => navigate(item.path)}
                        className="cursor-pointer"
                      >
                        <item.icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}

          {/* Admin navigation — only if has permissions */}
          {hasAdminPermission && (
            <SidebarGroup>
              <SidebarGroupLabel>Admin</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {adminNav.map((item) => (
                    <SidebarMenuItem key={item.path}>
                      <SidebarMenuButton
                        onClick={() => navigate(item.path)}
                        className="cursor-pointer"
                      >
                        <item.icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </SidebarContent>

        <SidebarFooter>
          <NavUser user={user} />
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 px-6">
          <SidebarTrigger className="-ml-2" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>{pageTitle}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        <div className="flex-1 min-h-0 px-6 pb-6 overflow-auto">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
