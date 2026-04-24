import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
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
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { ArrowLeft } from 'lucide-react';
import { adminNavGroups } from '@/lib/admin-nav';

const pageTitles: Record<string, string> = Object.fromEntries(
  adminNavGroups.flatMap((group) => group.items.map((item) => [item.path, item.title])),
);
pageTitles['/admin/request-types'] = 'Request Types';

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

          {adminNavGroups.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
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
          ))}

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
                <BreadcrumbLink render={<Link to="/admin" />}>Admin</BreadcrumbLink>
              </BreadcrumbItem>
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
