import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { Spinner } from '@/components/ui/spinner';
import { AuthProvider } from '@/providers/auth-provider';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { DeskLayout } from '@/layouts/desk-layout';
import { PortalLayout } from '@/layouts/portal-layout';
import { AdminLayout } from '@/layouts/admin-layout';
import { ReportsLayout } from '@/layouts/reports-layout';
import { useTheme } from '@/hooks/use-theme';
import { features } from '@/lib/features';
import { BrandingProvider } from '@/hooks/use-branding';
import { ThemeProvider } from '@/providers/theme-provider';
import { RouteErrorBoundary } from '@/components/route-error-boundary';
import { CommandPaletteProvider } from '@/components/command-palette/command-palette';

/*
 * Route-level code splitting: pages are lazy() so each user only downloads the
 * bundle for routes they actually visit. Layouts, providers, and ProtectedRoute
 * stay eager because they render on every navigation — splitting them just adds
 * a fetch waterfall.
 *
 * Approximate landed-bundle target after splitting:
 * - Portal-only user:  ~250–350 KB  (was ~1.7 MB)
 * - Desk agent:         ~600–700 KB
 * - Admin:              ~1.0–1.2 MB
 *
 * Pages export named components, so the dynamic import maps `m.X` → default.
 */
const lazyNamed = <K extends string>(
  loader: () => Promise<Record<K, React.ComponentType<unknown>>>,
  name: K,
) => lazy(() => loader().then((m) => ({ default: m[name] })));

// Auth
const LoginPage = lazyNamed(() => import('@/pages/auth/login'), 'LoginPage');
const SignUpPage = lazyNamed(() => import('@/pages/auth/signup'), 'SignUpPage');

// Portal
const PortalHome = lazyNamed(() => import('@/pages/portal/home'), 'PortalHome');
const MyRequestsPage = lazyNamed(() => import('@/pages/portal/my-requests'), 'MyRequestsPage');
const RequestDetailPage = lazyNamed(() => import('@/pages/portal/request-detail'), 'RequestDetailPage');
const CatalogCategoryPage = lazyNamed(() => import('@/pages/portal/catalog-category'), 'CatalogCategoryPage');
const SubmitRequestPage = lazyNamed(() => import('@/pages/portal/submit-request'), 'SubmitRequestPage');
const PortalProfilePage = lazyNamed(() => import('@/pages/portal/profile'), 'PortalProfilePage');
const BookRoomPage = lazyNamed(() => import('@/pages/portal/book-room'), 'BookRoomPage');
const MyBookingsPage = lazyNamed(() => import('@/pages/portal/me-bookings'), 'MyBookingsPage');
const PortalCalendarSyncPage = lazyNamed(() => import('@/pages/portal/me/calendar-sync'), 'PortalCalendarSyncPage');
const PortalCalendarSyncCallbackPage = lazyNamed(() => import('@/pages/portal/calendar-sync-callback'), 'PortalCalendarSyncCallbackPage');
const AdminCalendarSyncPage = lazyNamed(() => import('@/pages/admin/calendar-sync'), 'AdminCalendarSyncPage');
const RoomBookingRulesPage = lazyNamed(() => import('@/pages/admin/room-booking-rules/index'), 'RoomBookingRulesPage');
const RoomBookingRuleDetailPage = lazyNamed(() => import('@/pages/admin/room-booking-rules/detail'), 'RoomBookingRuleDetailPage');

// Desk
const InboxPage = lazyNamed(() => import('@/pages/desk/inbox'), 'InboxPage');
const DeskSchedulerPage = lazyNamed(() => import('@/pages/desk/scheduler'), 'DeskSchedulerPage');
const DeskBookingsPage = lazyNamed(() => import('@/pages/desk/bookings'), 'DeskBookingsPage');
const TicketsPage = lazyNamed(() => import('@/pages/desk/tickets'), 'TicketsPage');
const TicketDetailPage = lazyNamed(() => import('@/pages/desk/ticket-detail-page'), 'TicketDetailPage');
const ApprovalsPage = lazyNamed(() => import('@/pages/desk/approvals'), 'ApprovalsPage');

// Desk reports
const OverviewReport = lazyNamed(() => import('@/pages/desk/reports/overview'), 'OverviewReport');
const SlaReport = lazyNamed(() => import('@/pages/desk/reports/sla'), 'SlaReport');
const TeamsReport = lazyNamed(() => import('@/pages/desk/reports/teams'), 'TeamsReport');
const LocationsReport = lazyNamed(() => import('@/pages/desk/reports/locations'), 'LocationsReport');
const ResolutionReport = lazyNamed(() => import('@/pages/desk/reports/resolution'), 'ResolutionReport');
const RequestTypesReport = lazyNamed(() => import('@/pages/desk/reports/request-types'), 'RequestTypesReport');
const AssetsReport = lazyNamed(() => import('@/pages/desk/reports/assets'), 'AssetsReport');
const VendorsReport = lazyNamed(() => import('@/pages/desk/reports/vendors'), 'VendorsReport');

// Admin
const AdminIndexPage = lazyNamed(() => import('@/pages/admin'), 'AdminIndexPage');
const RequestTypesPage = lazyNamed(() => import('@/pages/admin/request-types'), 'RequestTypesPage');
const FormSchemasPage = lazyNamed(() => import('@/pages/admin/form-schemas'), 'FormSchemasPage');
const FormSchemaDetailPage = lazyNamed(() => import('@/pages/admin/form-schema-detail'), 'FormSchemaDetailPage');
const TeamsPage = lazyNamed(() => import('@/pages/admin/teams'), 'TeamsPage');
const LocationsPage = lazyNamed(() => import('@/pages/admin/locations'), 'LocationsPage');
const SlaPoliciesPage = lazyNamed(() => import('@/pages/admin/sla-policies'), 'SlaPoliciesPage');
const SlaPolicyCreatePage = lazyNamed(() => import('@/pages/admin/sla-policy-create'), 'SlaPolicyCreatePage');
const SlaPolicyDetailPage = lazyNamed(() => import('@/pages/admin/sla-policy-detail'), 'SlaPolicyDetailPage');
const RoutingRulesPage = lazyNamed(() => import('@/pages/admin/routing-rules'), 'RoutingRulesPage');
const LocationTeamsPage = lazyNamed(() => import('@/pages/admin/location-teams'), 'LocationTeamsPage');
const SpaceGroupsPage = lazyNamed(() => import('@/pages/admin/space-groups'), 'SpaceGroupsPage');
const DomainParentsPage = lazyNamed(() => import('@/pages/admin/domain-parents'), 'DomainParentsPage');
const RoutingStudioPage = lazyNamed(() => import('@/pages/admin/routing-studio'), 'RoutingStudioPage');
const BusinessHoursPage = lazyNamed(() => import('@/pages/admin/business-hours'), 'BusinessHoursPage');
const NotificationsPage = lazyNamed(() => import('@/pages/admin/notifications'), 'NotificationsPage');
const CatalogHierarchyPage = lazyNamed(() => import('@/pages/admin/catalog-hierarchy'), 'CatalogHierarchyPage');
const CriteriaSetsPage = lazyNamed(() => import('@/pages/admin/criteria-sets'), 'CriteriaSetsPage');
const CriteriaSetDetailPage = lazyNamed(() => import('@/pages/admin/criteria-set-detail'), 'CriteriaSetDetailPage');
const CriteriaSetMatchesPage = lazyNamed(() => import('@/pages/admin/criteria-set-matches'), 'CriteriaSetMatchesPage');
const WorkflowTemplatesPage = lazyNamed(() => import('@/pages/admin/workflow-templates'), 'WorkflowTemplatesPage');
const WorkflowEditorPage = lazyNamed(() => import('@/pages/admin/workflow-editor'), 'WorkflowEditorPage');
const WorkflowInstancePage = lazyNamed(() => import('@/pages/admin/workflow-instance'), 'WorkflowInstancePage');
const WebhooksPage = lazyNamed(() => import('@/pages/admin/webhooks'), 'WebhooksPage');
const WebhookCreatePage = lazyNamed(() => import('@/pages/admin/webhook-create'), 'WebhookCreatePage');
const WebhookDetailPage = lazyNamed(() => import('@/pages/admin/webhook-detail'), 'WebhookDetailPage');
const WebhookEventsPage = lazyNamed(() => import('@/pages/admin/webhook-events'), 'WebhookEventsPage');
const UsersPage = lazyNamed(() => import('@/pages/admin/users'), 'UsersPage');
const UserDetailPage = lazyNamed(() => import('@/pages/admin/user-detail'), 'UserDetailPage');
const UserRolesPage = lazyNamed(() => import('@/pages/admin/user-roles'), 'UserRolesPage');
const RoleDetailPage = lazyNamed(() => import('@/pages/admin/role-detail'), 'RoleDetailPage');
const PersonsPage = lazyNamed(() => import('@/pages/admin/persons'), 'PersonsPage');
const OrganisationsPage = lazyNamed(() => import('@/pages/admin/organisations'), 'OrganisationsPage');
const OrganisationCreatePage = lazyNamed(() => import('@/pages/admin/organisation-create'), 'OrganisationCreatePage');
const OrganisationDetailPage = lazyNamed(() => import('@/pages/admin/organisation-detail'), 'OrganisationDetailPage');
const DelegationsPage = lazyNamed(() => import('@/pages/admin/delegations'), 'DelegationsPage');
const AssetsPage = lazyNamed(() => import('@/pages/admin/assets'), 'AssetsPage');
const VendorsPage = lazyNamed(() => import('@/pages/admin/vendors'), 'VendorsPage');
const VendorMenusPage = lazyNamed(() => import('@/pages/admin/vendor-menus'), 'VendorMenusPage');
const VendorMenuDetailPage = lazyNamed(() => import('@/pages/admin/vendor-menu-detail'), 'VendorMenuDetailPage');
const BrandingPage = lazyNamed(() => import('@/pages/admin/branding'), 'BrandingPage');

function RouteFallback() {
  return (
    <div className="flex h-full min-h-[40vh] w-full items-center justify-center">
      <Spinner className="size-6 text-muted-foreground" />
    </div>
  );
}

export function App() {
  useTheme();

  return (
    <BrandingProvider>
      <ThemeProvider>
        <AuthProvider>
          <TooltipProvider>
            <Toaster position="top-right" richColors />
            <CommandPaletteProvider>
            <RouteErrorBoundary>
              <Suspense fallback={<RouteFallback />}>
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
                  <Route path="requests/:id" element={<RequestDetailPage />} />
                  <Route path="my-requests" element={<Navigate to="/portal/requests" replace />} />
                  <Route path="catalog/:categoryId" element={<CatalogCategoryPage />} />
                  <Route path="submit/:categoryId?" element={<SubmitRequestPage />} />
                  <Route path="profile"  element={<PortalProfilePage />} />
                  {/* Phase 2 placeholders — top nav + bottom tabs link here; redirect home until built */}
                  <Route path="rooms"    element={<BookRoomPage />} />
                  <Route path="visitors" element={<Navigate to="/portal" replace />} />
                  <Route path="order"    element={<Navigate to="/portal" replace />} />
                  <Route path="account"  element={<Navigate to="/portal/profile" replace />} />
                  <Route path="book" element={<Navigate to="/portal/rooms" replace />} />
                  {/* My bookings — :id auto-opens the right-side detail drawer */}
                  <Route path="me/bookings" element={<MyBookingsPage />} />
                  <Route path="me/bookings/:id" element={<MyBookingsPage />} />
                  {/* Calendar sync (Outlook) */}
                  <Route path="me/calendar-sync" element={<PortalCalendarSyncPage />} />
                  <Route path="calendar-sync/callback" element={<PortalCalendarSyncCallbackPage />} />
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
                  <Route path="scheduler" element={<DeskSchedulerPage />} />
                  <Route path="bookings" element={<DeskBookingsPage />} />
                  <Route path="tickets" element={<TicketsPage />} />
                  <Route path="tickets/:id" element={<TicketDetailPage />} />
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
                  {/* Calendar sync (Outlook) — admin sync-health + conflicts inbox */}
                  <Route path="calendar-sync" element={<AdminCalendarSyncPage />} />
                  {/* Room booking rules (D-engine) — index + detail */}
                  <Route path="room-booking-rules" element={<RoomBookingRulesPage />} />
                  <Route path="room-booking-rules/:id" element={<RoomBookingRuleDetailPage />} />
                  {/* Config */}
                  <Route path="request-types" element={<RequestTypesPage />} />
                  <Route path="form-schemas" element={<FormSchemasPage />} />
                  <Route path="form-schemas/:id" element={<FormSchemaDetailPage />} />
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
              </Suspense>
            </RouteErrorBoundary>
            </CommandPaletteProvider>
          </TooltipProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrandingProvider>
  );
}
