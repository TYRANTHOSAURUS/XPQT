import { Outlet } from 'react-router-dom';
import {
  SidebarProvider,
  SidebarInset,
} from '@/components/ui/sidebar';
import { DeskSidebar } from '@/components/desk/desk-sidebar';

export function DeskLayout() {
  return (
    <SidebarProvider>
      <DeskSidebar />
      <SidebarInset>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
