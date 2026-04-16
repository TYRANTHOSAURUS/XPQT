import { Routes, Route, Navigate } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DeskLayout } from '@/layouts/desk-layout';
import { PortalLayout } from '@/layouts/portal-layout';
import { InboxPage } from '@/pages/desk/inbox';
import { TicketsPage } from '@/pages/desk/tickets';
import { PortalHome } from '@/pages/portal/home';
import { MyRequestsPage } from '@/pages/portal/my-requests';
import { CatalogCategoryPage } from '@/pages/portal/catalog-category';
import { SubmitRequestPage } from '@/pages/portal/submit-request';
import { useTheme } from '@/hooks/use-theme';

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <p>{title} — coming soon</p>
    </div>
  );
}

export function App() {
  useTheme();

  return (
    <TooltipProvider>
      <Routes>
        <Route path="/" element={<Navigate to="/portal" replace />} />

        {/* Employee Portal */}
        <Route path="/portal" element={<PortalLayout />}>
          <Route index element={<PortalHome />} />
          <Route path="my-requests" element={<MyRequestsPage />} />
          <Route path="catalog/:categoryId" element={<CatalogCategoryPage />} />
          <Route path="submit/:categoryId?" element={<SubmitRequestPage />} />
          <Route path="book" element={<PlaceholderPage title="Room Booking" />} />
          <Route path="visitors" element={<PlaceholderPage title="Visitor Registration" />} />
          <Route path="order" element={<PlaceholderPage title="Order Catalog" />} />
        </Route>

        {/* Service Desk */}
        <Route path="/desk" element={<DeskLayout />}>
          <Route index element={<Navigate to="/desk/inbox" replace />} />
          <Route path="inbox" element={<InboxPage />} />
          <Route path="tickets" element={<TicketsPage />} />
          <Route path="approvals" element={<PlaceholderPage title="Approvals" />} />
          <Route path="reports" element={<PlaceholderPage title="Reports" />} />
          <Route path="settings" element={<PlaceholderPage title="Settings" />} />
        </Route>
      </Routes>
    </TooltipProvider>
  );
}
