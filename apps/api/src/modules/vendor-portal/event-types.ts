/**
 * Audit-event taxonomy for the vendor-portal subsystem (Phase B).
 *
 * Convention matches cross-spec §10 (`<domain>.<verb>`). Wired through
 * the existing AuditOutboxService.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md §3.
 */
export const VendorPortalEventType = {
  // Invitation + auth lifecycle (Sprint 1)
  VendorInvited:               'vendor.invited',
  VendorInviteResent:          'vendor.invite_resent',
  VendorUserDeactivated:       'vendor_user.deactivated',
  VendorUserFirstLogin:        'vendor_user.first_login',
  VendorUserLogin:             'vendor_user.login',
  VendorUserLogout:            'vendor_user.logout',
  VendorUserLoginFailed:       'vendor_user.login_failed',

  // Order interactions (Sprint 2-3)
  OrderAcknowledged:           'vendor.order_acknowledged',
  OrderStatusUpdated:          'vendor.order_status_updated',
  OrderDeclined:               'vendor.order_declined',
  OrderViewed:                 'vendor.order_viewed',

  // Daily-list link (cross-spec — Phase A vendor portal)
  DailyListDownloaded:         'vendor.daily_list_downloaded',

  // Webhook delivery (Sprint 4)
  WebhookDelivered:            'vendor.webhook_delivered',
  WebhookFailed:               'vendor.webhook_failed',
} as const;

export type VendorPortalEventType =
  (typeof VendorPortalEventType)[keyof typeof VendorPortalEventType];
