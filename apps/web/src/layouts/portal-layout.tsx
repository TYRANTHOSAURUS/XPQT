import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { NavUser } from '@/components/nav-user';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
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
import { useAuth } from '@/providers/auth-provider';
import { PortalProvider, usePortal } from '@/providers/portal-provider';
import { PortalLocationPicker } from '@/components/portal/portal-location-picker';
import { PortalNoScopeBlocker } from '@/components/portal/portal-no-scope-blocker';

const portalNav = [
  { title: 'Home', path: '/portal', icon: Home },
  { title: 'My Requests', path: '/portal/my-requests', icon: Ticket },
  { title: 'Book a Room', path: '/portal/book', icon: CalendarDays },
  { title: 'Invite Visitor', path: '/portal/visitors', icon: UserPlus },
  { title: 'Order', path: '/portal/order', icon: ShoppingCart },
];

const agentNav = [
  { title: 'Service Desk', path: '/desk', icon: Headset },
];

const adminNav = [
  { title: 'Admin', path: '/admin', icon: Settings },
  { title: 'Reports', path: '/desk/reports', icon: BarChart3 },
];

const pageTitles: Record<string, string> = {
  '/portal': 'Home',
  '/portal/my-requests': 'My Requests',
  '/portal/book': 'Book a Room',
  '/portal/visitors': 'Invite Visitor',
  '/portal/order': 'Order',
};

export function PortalLayout() {
  return (
    <PortalProvider>
      <PortalLayoutInner />
    </PortalProvider>
  );
}

function PortalLayoutInner() {
  const navigate = useNavigate();
  const location = useLocation();
  const { hasRole } = useAuth();
  const { data: portal, loading: portalLoading } = usePortal();

  const hasAgentPermission = hasRole('agent');
  const hasAdminPermission = hasRole('admin');

  const pageTitle = Object.entries(pageTitles).find(([path]) =>
    path === '/portal' ? location.pathname === '/portal' : location.pathname.startsWith(path)
  )?.[1] ?? 'Portal';

  return (
    <SidebarProvider>
      <Sidebar variant="inset">
        <SidebarHeader>
          <WorkspaceSwitcher current="portal" />
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
          <NavUser />
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
          <div className="ml-auto">
            <PortalLocationPicker />
          </div>
        </header>
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="mx-auto w-full max-w-6xl px-6 pb-6">
            {!portalLoading && portal && !portal.can_submit
              ? <PortalNoScopeBlocker />
              : <Outlet />}
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
