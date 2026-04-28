/**
 * Audit-event taxonomy for the daglijst subsystem.
 *
 * Convention matches the cross-spec §10 naming rule (`<domain>.<verb>`).
 * Wired through the existing AuditOutboxService — Sprint 1 emits the
 * generation/lock events; Sprint 2 adds the email-delivery events.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md §3.
 */
export const DaglijstEventType = {
  Generated:                'daglijst.generated',
  Sent:                     'daglijst.sent',
  Regenerated:              'daglijst.regenerated',
  SendFailed:               'daglijst.send_failed',

  OrderPostCutoffChange:    'order.post_cutoff_change',
  OrderPhoneFollowupConfirmed: 'order.phone_followup_confirmed',

  OrderLineStatusInferred:  'order_line_item.status_inferred',
} as const;

export type DaglijstEventType = (typeof DaglijstEventType)[keyof typeof DaglijstEventType];
