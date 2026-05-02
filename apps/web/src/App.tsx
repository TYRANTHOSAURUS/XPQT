import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { Spinner } from '@/components/ui/spinner';
import { AuthProvider } from '@/providers/auth-provider';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { DeskLayout } from '@/layouts/desk-layout';
import { PortalLayout } from '@/layouts/portal-layout';
import { AdminLayout } from '@/layouts/admin-layout';
import { ReportsLayout } from '@/layouts/reports-layout';
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
const MyBookingDetailPage = lazyNamed(() => import('@/pages/portal/me-bookings/detail'), 'MyBookingDetailPage');
const PortalOrderPage = lazyNamed(() => import('@/pages/portal/order'), 'PortalOrderPage');
const PortalCalendarSyncPage = lazyNamed(() => import('@/pages/portal/me/calendar-sync'), 'PortalCalendarSyncPage');
const PortalCalendarSyncCallbackPage = lazyNamed(() => import('@/pages/portal/calendar-sync-callback'), 'PortalCalendarSyncCallbackPage');
const PortalVisitorInvitePage = lazyNamed(() => import('@/pages/portal/visitors/invite'), 'PortalVisitorInvitePage');
const PortalVisitorsExpectedPage = lazyNamed(() => import('@/pages/portal/visitors/expected'), 'PortalVisitorsExpectedPage');
const AdminCalendarSyncPage = lazyNamed(() => import('@/pages/admin/calendar-sync'), 'AdminCalendarSyncPage');
const RoomBookingRulesPage = lazyNamed(() => import('@/pages/admin/room-booking-rules/index'), 'RoomBookingRulesPage');
const RoomBookingRuleDetailPage = lazyNamed(() => import('@/pages/admin/room-booking-rules/detail'), 'RoomBookingRuleDetailPage');
const RoomBookingReportsPage = lazyNamed(() => import('@/pages/admin/room-booking-reports/index'), 'RoomBookingReportsPage');
const RoomBookingUtilizationReport = lazyNamed(() => import('@/pages/admin/room-booking-reports/utilization'), 'RoomBookingUtilizationReport');
const RoomBookingNoShowsReport     = lazyNamed(() => import('@/pages/admin/room-booking-reports/no-shows'),    'RoomBookingNoShowsReport');
const RoomBookingServicesReport    = lazyNamed(() => import('@/pages/admin/room-booking-reports/services'),   'RoomBookingServicesReport');
const RoomBookingDemandReport      = lazyNamed(() => import('@/pages/admin/room-booking-reports/demand'),     'RoomBookingDemandReport');
const CostCentersPage = lazyNamed(() => import('@/pages/admin/cost-centers'), 'CostCentersPage');
const CostCenterDetailPage = lazyNamed(() => import('@/pages/admin/cost-center-detail'), 'CostCenterDetailPage');
const ServiceRoutingPage = lazyNamed(() => import('@/pages/admin/service-routing'), 'ServiceRoutingPage');
const BundleTemplatesPage = lazyNamed(() => import('@/pages/admin/bundle-templates'), 'BundleTemplatesPage');
const BundleTemplateDetailPage = lazyNamed(() => import('@/pages/admin/bundle-template-detail'), 'BundleTemplateDetailPage');
const BookingServicesIndexPage = lazyNamed(() => import('@/pages/admin/booking-services'), 'BookingServicesIndexPage');
const ServiceRulesPage = lazyNamed(() => import('@/pages/admin/service-rules'), 'ServiceRulesPage');
const ServiceRuleDetailPage = lazyNamed(() => import('@/pages/admin/service-rule-detail'), 'ServiceRuleDetailPage');

// Public visitor cancel landing — anonymous; token IS the auth.
// NOT wrapped in ProtectedRoute. Routes outside any layout shell.
const VisitCancelPage = lazyNamed(() => import('@/pages/public/visit-cancel'), 'VisitCancelPage');

// Kiosk-lite — anonymous, building-bound. NOT wrapped in ProtectedRoute.
const KioskLayout = lazyNamed(() => import('@/pages/kiosk/_layout'), 'KioskLayout');
const KioskIdlePage = lazyNamed(() => import('@/pages/kiosk/index'), 'KioskIdlePage');
const KioskSetupPage = lazyNamed(() => import('@/pages/kiosk/setup'), 'KioskSetupPage');
const KioskQrScanPage = lazyNamed(() => import('@/pages/kiosk/qr-scan'), 'KioskQrScanPage');
const KioskNameFallbackPage = lazyNamed(() => import('@/pages/kiosk/name-fallback'), 'KioskNameFallbackPage');
const KioskWalkupPage = lazyNamed(() => import('@/pages/kiosk/walkup'), 'KioskWalkupPage');
const KioskConfirmationPage = lazyNamed(() => import('@/pages/kiosk/confirmation'), 'KioskConfirmationPage');

// Desk
const InboxPage = lazyNamed(() => import('@/pages/desk/inbox'), 'InboxPage');
const DeskSchedulerPage = lazyNamed(() => import('@/pages/desk/scheduler'), 'DeskSchedulerPage');
const DeskBookingsPage = lazyNamed(() => import('@/pages/desk/bookings'), 'DeskBookingsPage');
const BookingDetailPage = lazyNamed(() => import('@/components/booking-detail/booking-detail-page'), 'BookingDetailPage');
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
const RequestTypeDetailPage = lazyNamed(() => import('@/pages/admin/request-type-detail'), 'RequestTypeDetailPage');
const FormSchemasPage = lazyNamed(() => import('@/pages/admin/form-schemas'), 'FormSchemasPage');
const FormSchemaDetailPage = lazyNamed(() => import('@/pages/admin/form-schema-detail'), 'FormSchemaDetailPage');
const TeamsPage = lazyNamed(() => import('@/pages/admin/teams'), 'TeamsPage');
const TeamDetailPage = lazyNamed(() => import('@/pages/admin/team-detail'), 'TeamDetailPage');
const LocationsPage = lazyNamed(() => import('@/pages/admin/locations'), 'LocationsPage');
const SlaPoliciesPage = lazyNamed(() => import('@/pages/admin/sla-policies'), 'SlaPoliciesPage');
const SlaPolicyCreatePage = lazyNamed(() => import('@/pages/admin/sla-policy-create'), 'SlaPolicyCreatePage');
const SlaPolicyDetailPage = lazyNamed(() => import('@/pages/admin/sla-policy-detail'), 'SlaPolicyDetailPage');
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
const PrivacyAdminPage = lazyNamed(() => import('@/pages/admin/privacy'), 'PrivacyAdminPage');
const UsersPage = lazyNamed(() => import('@/pages/admin/users'), 'UsersPage');
const UserDetailPage = lazyNamed(() => import('@/pages/admin/user-detail'), 'UserDetailPage');
const UserRolesPage = lazyNamed(() => import('@/pages/admin/user-roles'), 'UserRolesPage');
const RoleDetailPage = lazyNamed(() => import('@/pages/admin/role-detail'), 'RoleDetailPage');
const PersonsPage = lazyNamed(() => import('@/pages/admin/persons'), 'PersonsPage');
const PersonDetailPage = lazyNamed(() => import('@/pages/admin/person-detail'), 'PersonDetailPage');
const OrganisationsPage = lazyNamed(() => import('@/pages/admin/organisations'), 'OrganisationsPage');
const OrganisationCreatePage = lazyNamed(() => import('@/pages/admin/organisation-create'), 'OrganisationCreatePage');
const OrganisationDetailPage = lazyNamed(() => import('@/pages/admin/organisation-detail'), 'OrganisationDetailPage');
const DelegationsPage = lazyNamed(() => import('@/pages/admin/delegations'), 'DelegationsPage');
const AssetsPage = lazyNamed(() => import('@/pages/admin/assets'), 'AssetsPage');
const AssetDetailPage = lazyNamed(() => import('@/pages/admin/asset-detail'), 'AssetDetailPage');
const VendorsPage = lazyNamed(() => import('@/pages/admin/vendors'), 'VendorsPage');
const VendorDetailPage = lazyNamed(() => import('@/pages/admin/vendor-detail'), 'VendorDetailPage');
const VendorMenusPage = lazyNamed(() => import('@/pages/admin/vendor-menus'), 'VendorMenusPage');
const VendorMenuDetailPage = lazyNamed(() => import('@/pages/admin/vendor-menu-detail'), 'VendorMenuDetailPage');
const BrandingPage = lazyNamed(() => import('@/pages/admin/branding'), 'BrandingPage');
const AdminVisitorTypesPage = lazyNamed(() => import('@/pages/admin/visitors/types'), 'AdminVisitorTypesPage');
const AdminVisitorTypeDetailPage = lazyNamed(() => import('@/pages/admin/visitors/types/detail'), 'AdminVisitorTypeDetailPage');
const AdminVisitorPoolsPage = lazyNamed(() => import('@/pages/admin/visitors/pools'), 'AdminVisitorPoolsPage');
const AdminVisitorPoolDetailPage = lazyNamed(() => import('@/pages/admin/visitors/pools/detail'), 'AdminVisitorPoolDetailPage');
const DeskVisitorsPage = lazyNamed(() => import('@/pages/desk/visitors'), 'DeskVisitorsPage');

function RouteFallback() {
  return (
    <div className="flex h-full min-h-[40vh] w-full items-center justify-center">
      <Spinner className="size-6 text-muted-foreground" />
    </div>
  );
}

/**
 * Redirect helper that preserves the inbound URL's query params while
 * applying the redirect target's preset. The target's params win on
 * conflict (so `?view=today` stays today even if the inbound link had a
 * different `view`), but everything else (`?building=…`, `?q=…`, etc.)
 * passes through. Used to keep `/reception/*` deep-links useful after the
 * desk-shell rebuild.
 */
function ReceptionRedirect({ to }: { to: string }) {
  const loc = useLocation();
  const incoming = new URLSearchParams(loc.search);
  const [pathname, targetSearch = ''] = to.split('?');
  const targetParams = new URLSearchParams(targetSearch);
  for (const [k, v] of incoming) {
    if (!targetParams.has(k)) targetParams.set(k, v);
  }
  const qs = targetParams.toString();
  return <Navigate to={qs ? `${pathname}?${qs}` : pathname} replace />;
}

export function App() {
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

                {/* Public visitor cancel landing — anonymous, token in path.
                    NO ProtectedRoute: visitor isn't logged in. The backend
                    GET /visitors/cancel/:token/preview + POST /visitors/cancel/:token
                    are @Public() and validate via SECURITY DEFINER fns. */}
                <Route path="/visit/cancel/:token" element={<VisitCancelPage />} />

                {/* Kiosk-lite — public, building-bound (anonymous Bearer-token auth
                    on /api/kiosk/*). NO ProtectedRoute: the kiosk has no user. */}
                <Route path="/kiosk" element={<KioskLayout />}>
                  <Route index element={<KioskIdlePage />} />
                  <Route path="setup" element={<KioskSetupPage />} />
                  <Route path="qr-scan" element={<KioskQrScanPage />} />
                  <Route path="name-fallback" element={<KioskNameFallbackPage />} />
                  <Route path="walkup" element={<KioskWalkupPage />} />
                  <Route path="confirmation" element={<KioskConfirmationPage />} />
                </Route>

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
                  {/* Visitors — host invite + upcoming list. The bare /portal/visitors
                      redirects to the host's "expected" list (the meaningful default
                      surface for someone clicking the nav tab). */}
                  <Route path="visitors" element={<Navigate to="/portal/visitors/expected" replace />} />
                  <Route path="visitors/invite" element={<PortalVisitorInvitePage />} />
                  <Route path="visitors/expected" element={<PortalVisitorsExpectedPage />} />
                  <Route path="order"    element={<PortalOrderPage />} />
                  <Route path="account"  element={<Navigate to="/portal/profile" replace />} />
                  <Route path="book" element={<Navigate to="/portal/rooms" replace />} />
                  {/* My bookings — list at /me/bookings, full-route detail at /me/bookings/:id */}
                  <Route path="me/bookings" element={<MyBookingsPage />} />
                  <Route path="me/bookings/:id" element={<MyBookingDetailPage />} />
                  {/* Calendar sync (Outlook) */}
                  <Route path="me/calendar-sync" element={<PortalCalendarSyncPage />} />
                  <Route path="calendar-sync/callback" element={<PortalCalendarSyncCallbackPage />} />
                </Route>

                {/* The legacy /reception/* workspace was removed in the
                    desk-shell rebuild (2026-05-02). Receptionists at
                    smaller tenants ARE service-desk operators wearing
                    the reception hat (per docs/users.md §9), so the
                    front-desk surface lives under /desk/visitors as a
                    peer of /desk/tickets. Old bookmarks redirect. */}
                <Route path="/reception" element={<ReceptionRedirect to="/desk/visitors?view=today" />} />
                <Route path="/reception/today" element={<ReceptionRedirect to="/desk/visitors?view=today" />} />
                <Route path="/reception/passes" element={<ReceptionRedirect to="/desk/visitors?view=arrived" />} />
                <Route path="/reception/yesterday" element={<ReceptionRedirect to="/desk/visitors?view=loose_ends" />} />
                <Route path="/reception/daglijst" element={<ReceptionRedirect to="/desk/visitors?view=today" />} />

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
                  <Route path="bookings/:id" element={<BookingDetailPage />} />
                  <Route path="tickets" element={<TicketsPage />} />
                  <Route path="tickets/:id" element={<TicketDetailPage />} />
                  <Route path="approvals" element={<ApprovalsPage />} />
                  <Route path="visitors" element={<DeskVisitorsPage />} />
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
                    <Route path="bookings" element={<RoomBookingReportsPage />} />
                    <Route path="bookings/utilization" element={<RoomBookingUtilizationReport />} />
                    <Route path="bookings/no-shows"    element={<RoomBookingNoShowsReport />} />
                    <Route path="bookings/services"    element={<RoomBookingServicesReport />} />
                    <Route path="bookings/demand"      element={<RoomBookingDemandReport />} />
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
                  {/* Cost centers (sub-project 2) — GL chargeback codes */}
                  <Route path="cost-centers" element={<CostCentersPage />} />
                  <Route path="cost-centers/:id" element={<CostCenterDetailPage />} />
                  {/* Service routing matrix (Wave 2 Slice 2) — booking-origin work-order routing */}
                  <Route path="service-routing" element={<ServiceRoutingPage />} />
                  {/* Bundle templates (sub-project 2) — pre-filled meeting + service combos */}
                  <Route path="bundle-templates" element={<BundleTemplatesPage />} />
                  <Route path="bundle-templates/:id" element={<BundleTemplateDetailPage />} />
                  {/* Booking services (sub-project 2) — index + service rules */}
                  <Route path="booking-services" element={<BookingServicesIndexPage />} />
                  <Route path="booking-services/rules" element={<ServiceRulesPage />} />
                  <Route path="booking-services/rules/:id" element={<ServiceRuleDetailPage />} />
                  {/* Config */}
                  <Route path="request-types" element={<RequestTypesPage />} />
                  <Route path="request-types/:id" element={<RequestTypeDetailPage />} />
                  <Route path="form-schemas" element={<FormSchemasPage />} />
                  <Route path="form-schemas/:id" element={<FormSchemaDetailPage />} />
                  <Route path="teams" element={<TeamsPage />} />
                  <Route path="teams/:id" element={<TeamDetailPage />} />
                  <Route path="locations" element={<LocationsPage />} />
                  <Route path="locations/:spaceId" element={<LocationsPage />} />
                  <Route path="sla-policies" element={<SlaPoliciesPage />} />
                  <Route path="sla-policies/new" element={<SlaPolicyCreatePage />} />
                  <Route path="sla-policies/:id" element={<SlaPolicyDetailPage />} />
                  {/*
                   * Legacy routing admin paths — kept as redirects so old bookmarks
                   * land on the right Routing Studio tab. The legacy pages and the
                   * `features.routingStudio` flag were removed once Studio became
                   * the canonical surface.
                   */}
                  <Route path="routing-rules" element={<Navigate to="/admin/routing-studio?tab=rules" replace />} />
                  <Route path="location-teams" element={<Navigate to="/admin/routing-studio?tab=child-dispatch" replace />} />
                  <Route path="space-groups" element={<Navigate to="/admin/routing-studio?tab=child-dispatch" replace />} />
                  <Route path="domain-parents" element={<Navigate to="/admin/routing-studio?tab=rules" replace />} />
                  <Route path="business-hours" element={<BusinessHoursPage />} />
                  <Route path="notifications" element={<NotificationsPage />} />
                  <Route path="catalog-hierarchy" element={<CatalogHierarchyPage />} />
                  <Route path="criteria-sets" element={<CriteriaSetsPage />} />
                  <Route path="criteria-sets/:id" element={<CriteriaSetDetailPage />} />
                  <Route path="criteria-sets/:id/matches" element={<CriteriaSetMatchesPage />} />
                  <Route path="workflow-templates" element={<WorkflowTemplatesPage />} />
                  <Route path="workflow-templates/:id" element={<WorkflowEditorPage />} />
                  <Route path="workflow-templates/instances/:id" element={<WorkflowInstancePage />} />
                  <Route path="settings/privacy" element={<PrivacyAdminPage />} />
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
                  <Route path="persons/:id" element={<PersonDetailPage />} />
                  <Route path="organisations" element={<OrganisationsPage />} />
                  <Route path="organisations/new" element={<OrganisationCreatePage />} />
                  <Route path="organisations/:id" element={<OrganisationDetailPage />} />
                  <Route path="delegations" element={<DelegationsPage />} />
                  {/* Assets */}
                  <Route path="assets" element={<AssetsPage />} />
                  <Route path="assets/:id" element={<AssetDetailPage />} />
                  {/* Vendors */}
                  <Route path="vendors" element={<VendorsPage />} />
                  <Route path="vendors/:id" element={<VendorDetailPage />} />
                  <Route path="vendor-menus" element={<VendorMenusPage />} />
                  <Route path="vendor-menus/:id" element={<VendorMenuDetailPage />} />
                  <Route path="routing-studio" element={<RoutingStudioPage />} />
                  {/* Branding */}
                  <Route path="branding" element={<BrandingPage />} />
                  {/* Visitors (slice 9) — types config + pass pools + kiosks */}
                  <Route path="visitors/types" element={<AdminVisitorTypesPage />} />
                  <Route path="visitors/types/:id" element={<AdminVisitorTypeDetailPage />} />
                  <Route path="visitors/pools" element={<AdminVisitorPoolsPage />} />
                  <Route path="visitors/pools/:spaceId" element={<AdminVisitorPoolDetailPage />} />
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
