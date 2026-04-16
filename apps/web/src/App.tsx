import { Routes, Route, Navigate } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DeskLayout } from '@/layouts/desk-layout';
import { PortalLayout } from '@/layouts/portal-layout';
import { AdminLayout } from '@/layouts/admin-layout';
import { InboxPage } from '@/pages/desk/inbox';
import { TicketsPage } from '@/pages/desk/tickets';
import { PortalHome } from '@/pages/portal/home';
import { MyRequestsPage } from '@/pages/portal/my-requests';
import { CatalogCategoryPage } from '@/pages/portal/catalog-category';
import { SubmitRequestPage } from '@/pages/portal/submit-request';
import { RequestTypesPage } from '@/pages/admin/request-types';
import { TeamsPage } from '@/pages/admin/teams';
import { LocationsPage } from '@/pages/admin/locations';
import { SlaPoliciesPage } from '@/pages/admin/sla-policies';
import { RoutingRulesPage } from '@/pages/admin/routing-rules';
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

        {/* Admin */}
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="/admin/request-types" replace />} />
          <Route path="request-types" element={<RequestTypesPage />} />
          <Route path="teams" element={<TeamsPage />} />
          <Route path="locations" element={<LocationsPage />} />
          <Route path="sla-policies" element={<SlaPoliciesPage />} />
          <Route path="routing-rules" element={<RoutingRulesPage />} />
          <Route path="business-hours" element={<PlaceholderPage title="Business Hours" />} />
          <Route path="notifications" element={<PlaceholderPage title="Notification Templates" />} />
        </Route>
      </Routes>
    </TooltipProvider>
  );
}
