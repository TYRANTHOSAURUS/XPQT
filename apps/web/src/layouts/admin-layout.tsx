import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { NavUser } from '@/components/nav-user';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
import { useAuth } from '@/providers/auth-provider';
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
  Users,
  MapPin,
  Clock,
  Route,
  Bell,
  Calendar,
  FormInput,
  UserCog,
  PersonStanding,
  Package,
  GitBranch,
  Webhook,
  HandCoins,
  ListTree,
  Filter,
  Store,
  BookOpen,
  Network,
  Layers,
  Compass,
  ArrowLeft,
  Building2,
  Palette,
} from 'lucide-react';
import { features } from '@/lib/features';

const legacyRoutingNav = [
  { title: 'Routing Rules', path: '/admin/routing-rules', icon: Route },
  { title: 'Location Teams', path: '/admin/location-teams', icon: MapPin },
  { title: 'Space Groups', path: '/admin/space-groups', icon: Layers },
  { title: 'Domain Hierarchy', path: '/admin/domain-parents', icon: Network },
];

const configNav = [
  { title: 'Service Catalog', path: '/admin/catalog-hierarchy', icon: ListTree },
  { title: 'Form Schemas', path: '/admin/form-schemas', icon: FormInput },
  { title: 'Criteria Sets', path: '/admin/criteria-sets', icon: Filter },
  { title: 'SLA Policies', path: '/admin/sla-policies', icon: Clock },
  ...(features.routingStudio
    ? [{ title: 'Routing Studio', path: '/admin/routing-studio', icon: Compass }]
    : legacyRoutingNav),
  { title: 'Business Hours', path: '/admin/business-hours', icon: Calendar },
  { title: 'Notifications', path: '/admin/notifications', icon: Bell },
  { title: 'Workflows', path: '/admin/workflow-templates', icon: GitBranch },
  { title: 'Webhooks', path: '/admin/webhooks', icon: Webhook },
  { title: 'Branding', path: '/admin/branding', icon: Palette },
];

const peopleNav = [
  { title: 'Organisations', path: '/admin/organisations', icon: Building2 },
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


const pageTitles: Record<string, string> = {
  '/admin/catalog-hierarchy': 'Catalog Hierarchy',
  '/admin/request-types': 'Request Types',
  '/admin/form-schemas': 'Form Schemas',
  '/admin/criteria-sets': 'Criteria Sets',
  '/admin/teams': 'Teams',
  '/admin/locations': 'Locations',
  '/admin/sla-policies': 'SLA Policies',
  '/admin/routing-studio': 'Routing Studio',
  '/admin/routing-rules': 'Routing Rules',
  '/admin/location-teams': 'Location Teams',
  '/admin/space-groups': 'Space Groups',
  '/admin/domain-parents': 'Domain Hierarchy',
  '/admin/business-hours': 'Business Hours',
  '/admin/notifications': 'Notifications',
  '/admin/workflow-templates': 'Workflow Templates',
  '/admin/webhooks': 'Webhooks',
  '/admin/users': 'Users & Roles',
  '/admin/persons': 'Persons',
  '/admin/organisations': 'Organisations',
  '/admin/delegations': 'Delegations',
  '/admin/assets': 'Assets',
  '/admin/vendors': 'Vendors',
  '/admin/vendor-menus': 'Vendor Menus',
  '/admin/branding': 'Branding',
};

export function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { hasRole } = useAuth();
  const pageTitle = Object.entries(pageTitles).find(([path]) =>
    location.pathname.startsWith(path)
  )?.[1] ?? 'Admin';

  const backTarget = hasRole('agent')
    ? { title: 'Back to Service Desk', path: '/desk' }
    : { title: 'Back to Portal', path: '/portal' };

  return (
    <SidebarProvider>
      <Sidebar variant="inset">
        <SidebarHeader>
          <WorkspaceSwitcher current="admin" />
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => navigate(backTarget.path)}
                    className="cursor-pointer"
                  >
                    <ArrowLeft />
                    <span>{backTarget.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

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
