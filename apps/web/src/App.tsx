import { Routes, Route, Navigate } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DeskLayout } from '@/layouts/desk-layout';
import { InboxPage } from '@/pages/desk/inbox';
import { TicketsPage } from '@/pages/desk/tickets';

function DeskIndex() {
  return <Navigate to="/desk/inbox" replace />;
}

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="flex h-screen items-center justify-center text-muted-foreground">
      <p>{title} — coming soon</p>
    </div>
  );
}

export function App() {
  return (
    <TooltipProvider>
      <Routes>
        <Route path="/" element={<Navigate to="/desk" replace />} />

        {/* Service Desk */}
        <Route path="/desk" element={<DeskLayout />}>
          <Route index element={<DeskIndex />} />
          <Route path="inbox" element={<InboxPage />} />
          <Route path="tickets" element={<TicketsPage />} />
          <Route path="approvals" element={<PlaceholderPage title="Approvals" />} />
          <Route path="reports" element={<PlaceholderPage title="Reports" />} />
          <Route path="settings" element={<PlaceholderPage title="Settings" />} />
        </Route>

        {/* Employee Portal (Phase 1) */}
        {/* <Route path="/portal" element={<PortalLayout />}> */}
        {/*   ... */}
        {/* </Route> */}

        {/* Admin (Phase 1) */}
        {/* <Route path="/admin" element={<AdminLayout />}> */}
        {/*   ... */}
        {/* </Route> */}
      </Routes>
    </TooltipProvider>
  );
}
