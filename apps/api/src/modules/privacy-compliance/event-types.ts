/**
 * Audit-event type taxonomy for the GDPR baseline subsystem.
 *
 * Convention (cross-spec §10): `<domain>.<verb>[_<qualifier>]`. Every spec that
 * emits audit events must follow this shape so the tenant-wide audit log
 * stays queryable and a SIEM can filter by domain prefix. New events get
 * added here (or in a sibling module's event-types.ts) — never as inline
 * string literals at the call site.
 *
 * Spec: docs/superpowers/specs/2026-04-27-gdpr-baseline-design.md §3.
 */

export const GdprEventType = {
  // Retention worker outcomes
  RetentionAnonymized:        'gdpr.retention_anonymized',
  RetentionHardDeleted:       'gdpr.retention_hard_deleted',
  RetentionRunCompleted:      'gdpr.retention_run_completed',
  RetentionRunSkipped:        'gdpr.retention_run_skipped',          // legal hold or empty scan
  RetentionRunFailed:         'gdpr.retention_run_failed',

  // Data subject requests (Art. 15-22)
  AccessRequestInitiated:     'gdpr.access_request_initiated',
  AccessRequestFulfilled:     'gdpr.access_request_fulfilled',
  AccessRequestDenied:        'gdpr.access_request_denied',
  ErasureRequestInitiated:    'gdpr.erasure_request_initiated',
  ErasureRequestFulfilled:    'gdpr.erasure_request_fulfilled',
  ErasureRequestDenied:       'gdpr.erasure_request_denied',
  ErasureRequestPartial:      'gdpr.erasure_request_partial',
  PortabilityRequestInitiated:'gdpr.portability_request_initiated',
  PortabilityRequestFulfilled:'gdpr.portability_request_fulfilled',

  // Legal holds
  LegalHoldPlaced:            'gdpr.legal_hold_placed',
  LegalHoldReleased:          'gdpr.legal_hold_released',

  // Configuration changes
  LiaUpdated:                 'gdpr.lia_updated',
  RetentionSettingChanged:    'gdpr.retention_setting_changed',

  // Departure cleanup
  DepartureCleanupScheduled:  'gdpr.departure_cleanup_scheduled',
  DepartureCleanupCompleted:  'gdpr.departure_cleanup_completed',

  // Anonymization restore window
  AnonymizationRestored:      'gdpr.anonymization_restored',

  // Read-side audit alias (writes go to personal_data_access_logs, this is the
  // event emitted on bulk/export reads that want a paper trail in audit_events too).
  ReadPersonalData:           'gdpr.read_personal_data',
} as const;

export type GdprEventType = (typeof GdprEventType)[keyof typeof GdprEventType];

/**
 * Permission keys for the GDPR subsystem. Match the dot-notation convention
 * used in `roles.permissions` (e.g. `tickets.read`, `people.update`).
 */
export const GdprPermission = {
  Configure:        'gdpr.configure',           // change retention settings + LIA text
  FulfillRequest:   'gdpr.fulfill_request',     // initiate access/erasure requests
  AuditReads:       'gdpr.audit_reads',         // query personal_data_access_logs
  PlaceLegalHold:   'gdpr.place_legal_hold',    // start/release legal holds
} as const;

export type GdprPermission = (typeof GdprPermission)[keyof typeof GdprPermission];
