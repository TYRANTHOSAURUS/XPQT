import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider } from '@/providers/auth-provider';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { LoginPage } from '@/pages/auth/login';
import { SignUpPage } from '@/pages/auth/signup';
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
import { FormSchemasPage } from '@/pages/admin/form-schemas';
import { UsersPage } from '@/pages/admin/users';
import { PersonsPage } from '@/pages/admin/persons';
import { AssetsPage } from '@/pages/admin/assets';
import { BusinessHoursPage } from '@/pages/admin/business-hours';
import { NotificationsPage } from '@/pages/admin/notifications';
import { CatalogCategoriesPage } from '@/pages/admin/catalog-categories';
import { DelegationsPage } from '@/pages/admin/delegations';
import { WorkflowTemplatesPage } from '@/pages/admin/workflow-templates';
import { WorkflowEditorPage } from '@/pages/admin/workflow-editor';
import { ReportsPage } from '@/pages/desk/reports';
import { ApprovalsPage } from '@/pages/desk/approvals';
import { useTheme } from '@/hooks/use-theme';

export function App() {
  useTheme();

  return (
    <AuthProvider>
      <TooltipProvider>
        <Toaster position="top-right" richColors />
        <Routes>
          <Route path="/" element={<Navigate to="/portal" replace />} />

          {/* Auth pages — no layout */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignUpPage />} />

          {/* Employee Portal — requires auth */}
          <Route
            path="/portal"
            element={
              <ProtectedRoute>
                <PortalLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<PortalHome />} />
            <Route path="my-requests" element={<MyRequestsPage />} />
            <Route path="catalog/:categoryId" element={<CatalogCategoryPage />} />
            <Route path="submit/:categoryId?" element={<SubmitRequestPage />} />
            <Route path="book" element={<Navigate to="/portal" replace />} />
            <Route path="visitors" element={<Navigate to="/portal" replace />} />
            <Route path="order" element={<Navigate to="/portal" replace />} />
          </Route>

          {/* Service Desk — requires auth + agent role */}
          <Route
            path="/desk"
            element={
              <ProtectedRoute requiredRole="agent">
                <DeskLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="/desk/inbox" replace />} />
            <Route path="inbox" element={<InboxPage />} />
            <Route path="tickets" element={<TicketsPage />} />
            <Route path="approvals" element={<ApprovalsPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="settings" element={<Navigate to="/admin/request-types" replace />} />
          </Route>

          {/* Admin — requires auth + admin role */}
          <Route
            path="/admin"
            element={
              <ProtectedRoute requiredRole="admin">
                <AdminLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="/admin/request-types" replace />} />
            {/* Config */}
            <Route path="request-types" element={<RequestTypesPage />} />
            <Route path="form-schemas" element={<FormSchemasPage />} />
            <Route path="teams" element={<TeamsPage />} />
            <Route path="locations" element={<LocationsPage />} />
            <Route path="sla-policies" element={<SlaPoliciesPage />} />
            <Route path="routing-rules" element={<RoutingRulesPage />} />
            <Route path="business-hours" element={<BusinessHoursPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="catalog-categories" element={<CatalogCategoriesPage />} />
            <Route path="workflow-templates" element={<WorkflowTemplatesPage />} />
            <Route path="workflow-templates/:id" element={<WorkflowEditorPage />} />
            {/* People */}
            <Route path="users" element={<UsersPage />} />
            <Route path="persons" element={<PersonsPage />} />
            <Route path="delegations" element={<DelegationsPage />} />
            {/* Assets */}
            <Route path="assets" element={<AssetsPage />} />
          </Route>
        </Routes>
      </TooltipProvider>
    </AuthProvider>
  );
}
