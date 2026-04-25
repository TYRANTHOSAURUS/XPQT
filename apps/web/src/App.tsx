import { Routes, Route, Navigate } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
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
import { CriteriaSetsPage } from '@/pages/admin/criteria-sets';
import { CriteriaSetDetailPage } from '@/pages/admin/criteria-set-detail';
import { CriteriaSetMatchesPage } from '@/pages/admin/criteria-set-matches';
import { TeamsPage } from '@/pages/admin/teams';
import { LocationsPage } from '@/pages/admin/locations';
import { SlaPoliciesPage } from '@/pages/admin/sla-policies';
import { SlaPolicyCreatePage } from '@/pages/admin/sla-policy-create';
import { SlaPolicyDetailPage } from '@/pages/admin/sla-policy-detail';
import { RoutingRulesPage } from '@/pages/admin/routing-rules';
import { LocationTeamsPage } from '@/pages/admin/location-teams';
import { SpaceGroupsPage } from '@/pages/admin/space-groups';
import { DomainParentsPage } from '@/pages/admin/domain-parents';
import { FormSchemasPage } from '@/pages/admin/form-schemas';
import { UsersPage } from '@/pages/admin/users';
import { UserRolesPage } from '@/pages/admin/user-roles';
import { RoleDetailPage } from '@/pages/admin/role-detail';
import { UserDetailPage } from '@/pages/admin/user-detail';
import { PersonsPage } from '@/pages/admin/persons';
import { OrganisationsPage } from '@/pages/admin/organisations';
import { OrganisationCreatePage } from '@/pages/admin/organisation-create';
import { OrganisationDetailPage } from '@/pages/admin/organisation-detail';
import { AssetsPage } from '@/pages/admin/assets';
import { BusinessHoursPage } from '@/pages/admin/business-hours';
import { NotificationsPage } from '@/pages/admin/notifications';
import { CatalogHierarchyPage } from '@/pages/admin/catalog-hierarchy';
import { DelegationsPage } from '@/pages/admin/delegations';
import { WorkflowTemplatesPage } from '@/pages/admin/workflow-templates';
import { WorkflowEditorPage } from '@/pages/admin/workflow-editor';
import { WorkflowInstancePage } from '@/pages/admin/workflow-instance';
import { WebhooksPage } from '@/pages/admin/webhooks';
import { WebhookCreatePage } from '@/pages/admin/webhook-create';
import { WebhookDetailPage } from '@/pages/admin/webhook-detail';
import { WebhookEventsPage } from '@/pages/admin/webhook-events';
import { VendorsPage } from '@/pages/admin/vendors';
import { VendorMenusPage } from '@/pages/admin/vendor-menus';
import { VendorMenuDetailPage } from '@/pages/admin/vendor-menu-detail';
import { RoutingStudioPage } from '@/pages/admin/routing-studio';
import { ReportsLayout } from '@/layouts/reports-layout';
import { OverviewReport } from '@/pages/desk/reports/overview';
import { SlaReport } from '@/pages/desk/reports/sla';
import { TeamsReport } from '@/pages/desk/reports/teams';
import { LocationsReport } from '@/pages/desk/reports/locations';
import { ResolutionReport } from '@/pages/desk/reports/resolution';
import { RequestTypesReport } from '@/pages/desk/reports/request-types';
import { AssetsReport } from '@/pages/desk/reports/assets';
import { VendorsReport } from '@/pages/desk/reports/vendors';
import { ApprovalsPage } from '@/pages/desk/approvals';
import { BrandingPage } from '@/pages/admin/branding';
import { AdminIndexPage } from '@/pages/admin';
import { useTheme } from '@/hooks/use-theme';
import { features } from '@/lib/features';
import { BrandingProvider } from '@/hooks/use-branding';
import { ThemeProvider } from '@/providers/theme-provider';

export function App() {
  useTheme();

  return (
    <BrandingProvider>
      <ThemeProvider>
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
            <Route path="requests" element={<MyRequestsPage />} />
            <Route path="my-requests" element={<Navigate to="/portal/requests" replace />} />
            <Route path="catalog/:categoryId" element={<CatalogCategoryPage />} />
            <Route path="submit/:categoryId?" element={<SubmitRequestPage />} />
            {/* Phase 2 placeholders — top nav + bottom tabs link here; redirect home until built */}
            <Route path="rooms"    element={<Navigate to="/portal" replace />} />
            <Route path="visitors" element={<Navigate to="/portal" replace />} />
            <Route path="order"    element={<Navigate to="/portal" replace />} />
            <Route path="account"  element={<Navigate to="/portal" replace />} />
            <Route path="book" element={<Navigate to="/portal/rooms" replace />} />
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
            <Route path="reports" element={<ReportsLayout />}>
              <Route index element={<Navigate to="/desk/reports/overview" replace />} />
              <Route path="overview" element={<OverviewReport />} />
              <Route path="sla" element={<SlaReport />} />
              <Route path="teams" element={<TeamsReport />} />
              <Route path="locations" element={<LocationsReport />} />
              <Route path="resolution" element={<ResolutionReport />} />
              <Route path="request-types" element={<RequestTypesReport />} />
              <Route path="assets" element={<AssetsReport />} />
              <Route path="vendors" element={<VendorsReport />} />
            </Route>
            <Route path="settings" element={<Navigate to="/admin" replace />} />
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
            <Route index element={<AdminIndexPage />} />
            {/* Config */}
            <Route path="request-types" element={<RequestTypesPage />} />
            <Route path="form-schemas" element={<FormSchemasPage />} />
            <Route path="teams" element={<TeamsPage />} />
            <Route path="locations" element={<LocationsPage />} />
            <Route path="locations/:spaceId" element={<LocationsPage />} />
            <Route path="sla-policies" element={<SlaPoliciesPage />} />
            <Route path="sla-policies/new" element={<SlaPolicyCreatePage />} />
            <Route path="sla-policies/:id" element={<SlaPolicyDetailPage />} />
            {/*
             * Legacy routing admin paths. When the Routing Studio flag is on, we
             * redirect these to the unified Studio. Flag-off keeps the old pages
             * reachable so rollback is a single env-var flip.
             */}
            <Route
              path="routing-rules"
              element={
                features.routingStudio
                  ? <Navigate to="/admin/routing-studio?tab=rules" replace />
                  : <RoutingRulesPage />
              }
            />
            <Route
              path="location-teams"
              element={
                features.routingStudio
                  ? <Navigate to="/admin/routing-studio?tab=mappings" replace />
                  : <LocationTeamsPage />
              }
            />
            <Route
              path="space-groups"
              element={
                features.routingStudio
                  ? <Navigate to="/admin/routing-studio?tab=groups" replace />
                  : <SpaceGroupsPage />
              }
            />
            <Route
              path="domain-parents"
              element={
                features.routingStudio
                  ? <Navigate to="/admin/routing-studio?tab=fallbacks" replace />
                  : <DomainParentsPage />
              }
            />
            <Route path="business-hours" element={<BusinessHoursPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="catalog-hierarchy" element={<CatalogHierarchyPage />} />
            <Route path="criteria-sets" element={<CriteriaSetsPage />} />
            <Route path="criteria-sets/:id" element={<CriteriaSetDetailPage />} />
            <Route path="criteria-sets/:id/matches" element={<CriteriaSetMatchesPage />} />
            <Route path="workflow-templates" element={<WorkflowTemplatesPage />} />
            <Route path="workflow-templates/:id" element={<WorkflowEditorPage />} />
            <Route path="workflow-templates/instances/:id" element={<WorkflowInstancePage />} />
            <Route path="webhooks" element={<WebhooksPage />} />
            <Route path="webhooks/new" element={<WebhookCreatePage />} />
            <Route path="webhooks/:id" element={<WebhookDetailPage />} />
            <Route path="webhooks/:id/events" element={<WebhookEventsPage />} />
            {/* People */}
            <Route path="users" element={<UsersPage />} />
            <Route path="users/:id" element={<UserDetailPage />} />
            <Route path="user-roles" element={<UserRolesPage />} />
            <Route path="user-roles/new" element={<RoleDetailPage />} />
            <Route path="user-roles/:id" element={<RoleDetailPage />} />
            <Route path="persons" element={<PersonsPage />} />
            <Route path="organisations" element={<OrganisationsPage />} />
            <Route path="organisations/new" element={<OrganisationCreatePage />} />
            <Route path="organisations/:id" element={<OrganisationDetailPage />} />
            <Route path="delegations" element={<DelegationsPage />} />
            {/* Assets */}
            <Route path="assets" element={<AssetsPage />} />
            {/* Vendors */}
            <Route path="vendors" element={<VendorsPage />} />
            <Route path="vendor-menus" element={<VendorMenusPage />} />
            <Route path="vendor-menus/:id" element={<VendorMenuDetailPage />} />
            {/* Routing Studio (feature-flagged, phase 1: additive only) */}
            {features.routingStudio && (
              <Route path="routing-studio" element={<RoutingStudioPage />} />
            )}
            {/* Branding */}
            <Route path="branding" element={<BrandingPage />} />
          </Route>
        </Routes>
          </TooltipProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrandingProvider>
  );
}
