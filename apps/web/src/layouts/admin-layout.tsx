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
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import {
  FileText,
  Users,
  MapPin,
  Clock,
  Route,
  Bell,
  Calendar,
  Headset,
  LayoutDashboard,
} from 'lucide-react';

const configNav = [
  { title: 'Request Types', path: '/admin/request-types', icon: FileText },
  { title: 'Teams', path: '/admin/teams', icon: Users },
  { title: 'Locations', path: '/admin/locations', icon: MapPin },
  { title: 'SLA Policies', path: '/admin/sla-policies', icon: Clock },
  { title: 'Routing Rules', path: '/admin/routing-rules', icon: Route },
  { title: 'Business Hours', path: '/admin/business-hours', icon: Calendar },
  { title: 'Notifications', path: '/admin/notifications', icon: Bell },
];

const quickNav = [
  { title: 'Portal', path: '/portal', icon: LayoutDashboard },
  { title: 'Service Desk', path: '/desk', icon: Headset },
];

const user = {
  name: 'Service Agent',
  email: 'agent@prequest.io',
  avatar: '',
};

const pageTitles: Record<string, string> = {
  '/admin/request-types': 'Request Types',
  '/admin/teams': 'Teams',
  '/admin/locations': 'Locations',
  '/admin/sla-policies': 'SLA Policies',
  '/admin/routing-rules': 'Routing Rules',
  '/admin/business-hours': 'Business Hours',
  '/admin/notifications': 'Notifications',
};

export function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const pageTitle = Object.entries(pageTitles).find(([path]) =>
    location.pathname.startsWith(path)
  )?.[1] ?? 'Admin';

  return (
    <SidebarProvider>
      <Sidebar variant="inset">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                onClick={() => navigate('/admin/request-types')}
                className="cursor-pointer"
              >
                <div className="flex aspect-square size-8 items-center justify-center shrink-0">
                  <img src="/assets/prequest-icon-color.svg" alt="Prequest" className="size-7" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">Prequest</span>
                  <span className="truncate text-xs text-muted-foreground">Admin</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Configuration</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {configNav.map((item) => (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton
                      isActive={location.pathname.startsWith(item.path)}
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

          <SidebarGroup>
            <SidebarGroupLabel>Navigate</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {quickNav.map((item) => (
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
              <BreadcrumbItem>Admin</BreadcrumbItem>
              <BreadcrumbSeparator />
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
