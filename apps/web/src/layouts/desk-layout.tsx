import { Outlet, useLocation } from 'react-router-dom';
import {
  SidebarProvider,
  SidebarInset,
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
import { DeskSidebar } from '@/components/desk/desk-sidebar';

const pageTitles: Record<string, string> = {
  '/desk/inbox': 'Inbox',
  '/desk/tickets': 'Tickets',
  '/desk/approvals': 'Approvals',
  '/desk/reports': 'Reports',
  '/desk/settings': 'Settings',
};

export function DeskLayout() {
  const location = useLocation();
  const pageTitle = pageTitles[location.pathname] ?? 'Service Desk';

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
              <BreadcrumbItem>
                <BreadcrumbPage>{pageTitle}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        <div className="flex-1 overflow-hidden">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
