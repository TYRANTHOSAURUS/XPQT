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
  FormInput,
  UserCog,
  PersonStanding,
  Package,
  GitBranch,
  Webhook,
  HandCoins,
  ListTree,
  Store,
  BookOpen,
} from 'lucide-react';

const configNav = [
  { title: 'Catalog Hierarchy', path: '/admin/catalog-hierarchy', icon: ListTree },
  { title: 'Request Types', path: '/admin/request-types', icon: FileText },
  { title: 'Form Schemas', path: '/admin/form-schemas', icon: FormInput },
  { title: 'SLA Policies', path: '/admin/sla-policies', icon: Clock },
  { title: 'Routing Rules', path: '/admin/routing-rules', icon: Route },
  { title: 'Business Hours', path: '/admin/business-hours', icon: Calendar },
  { title: 'Notifications', path: '/admin/notifications', icon: Bell },
  { title: 'Workflows', path: '/admin/workflow-templates', icon: GitBranch },
  { title: 'Webhooks', path: '/admin/webhooks', icon: Webhook },
];

const peopleNav = [
  { title: 'Teams', path: '/admin/teams', icon: Users },
  { title: 'Users & Roles', path: '/admin/users', icon: UserCog },
  { title: 'Persons', path: '/admin/persons', icon: PersonStanding },
  { title: 'Delegations', path: '/admin/delegations', icon: HandCoins },
];

const operationsNav = [
  { title: 'Locations', path: '/admin/locations', icon: MapPin },
  { title: 'Assets', path: '/admin/assets', icon: Package },
  { title: 'Vendors', path: '/admin/vendors', icon: Store },
  { title: 'Vendor Menus', path: '/admin/vendor-menus', icon: BookOpen },
];

const quickNav = [
  { title: 'Portal', path: '/portal', icon: LayoutDashboard },
  { title: 'Service Desk', path: '/desk', icon: Headset },
];

const pageTitles: Record<string, string> = {
  '/admin/catalog-hierarchy': 'Catalog Hierarchy',
  '/admin/request-types': 'Request Types',
  '/admin/form-schemas': 'Form Schemas',
  '/admin/teams': 'Teams',
  '/admin/locations': 'Locations',
  '/admin/sla-policies': 'SLA Policies',
  '/admin/routing-rules': 'Routing Rules',
  '/admin/business-hours': 'Business Hours',
  '/admin/notifications': 'Notifications',
  '/admin/workflow-templates': 'Workflow Templates',
  '/admin/webhooks': 'Webhooks',
  '/admin/users': 'Users & Roles',
  '/admin/persons': 'Persons',
  '/admin/delegations': 'Delegations',
  '/admin/assets': 'Assets',
  '/admin/vendors': 'Vendors',
  '/admin/vendor-menus': 'Vendor Menus',
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
          <WorkspaceSwitcher current="admin" />
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
            <SidebarGroupLabel>People</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {peopleNav.map((item) => (
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
            <SidebarGroupLabel>Operations</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {operationsNav.map((item) => (
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
          <NavUser />
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
