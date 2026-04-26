import { Link, Outlet, useLocation, useMatch } from 'react-router-dom';
import {
  SidebarProvider,
  SidebarInset,
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
import { DeskSidebar } from '@/components/desk/desk-sidebar';
import { ShellSwitcher } from '@/components/shell-switcher';
import { SearchTrigger } from '@/components/command-palette/search-trigger';

const pageTitles: Record<string, string> = {
  '/desk/inbox': 'Inbox',
  '/desk/tickets': 'Tickets',
  '/desk/approvals': 'Approvals',
  '/desk/reports': 'Reports',
  '/desk/settings': 'Settings',
};

export function DeskLayout() {
  const location = useLocation();
  const ticketDetailMatch = useMatch('/desk/tickets/:id');
  const pageTitle =
    pageTitles[location.pathname] ??
    (location.pathname.startsWith('/desk/reports') ? 'Reports' : 'Service Desk');

  return (
    <SidebarProvider>
      <DeskSidebar />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 px-6">
          <SidebarTrigger className="-ml-2" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                Service Desk
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              {ticketDetailMatch ? (
                <>
                  <BreadcrumbItem>
                    <BreadcrumbLink render={<Link to="/desk/tickets" />}>Tickets</BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>Ticket</BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              ) : (
                <BreadcrumbItem>
                  <BreadcrumbPage>{pageTitle}</BreadcrumbPage>
                </BreadcrumbItem>
              )}
            </BreadcrumbList>
          </Breadcrumb>
          <div className="ml-auto flex items-center gap-3">
            <SearchTrigger variant="bar" className="w-[260px]" />
            <ShellSwitcher />
          </div>
        </header>
        <div className="flex-1 min-h-0 min-w-0">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
