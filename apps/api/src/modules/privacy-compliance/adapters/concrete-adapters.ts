import { DbService } from '../../../common/db/db.service';
import type { DataCategoryAdapter } from '../data-category.adapter';
import {
  makeHardDeleteByDateAdapter,
  makeNoOpAdapter,
  makePendingSpecAdapter,
} from './factory';

/**
 * Built-in adapters expressed via the factories. Categories without a
 * dedicated class file live here for compactness — one place to read the
 * full coverage matrix.
 *
 * Each function takes DbService so the registration module can compose
 * adapters without DI awkwardness around factory-returned providers.
 */

export function buildWebhookNotificationsAdapter(db: DbService): DataCategoryAdapter {
  return makeHardDeleteByDateAdapter(
    {
      category: 'webhook_notifications',
      description: 'Inbound webhook event log — payloads may contain PII.',
      defaultRetentionDays: 30,
      capRetentionDays: 365,
      table: 'webhook_events',
      dateColumn: 'received_at',
    },
    db,
  );
}

export function buildEmailNotificationsAdapter(db: DbService): DataCategoryAdapter {
  // The platform's notification log table is `notifications`; its rows
  // include the recipient_person_id and the message body. Hard-delete
  // past retention; preserve nothing — these are operational sends.
  return makeHardDeleteByDateAdapter(
    {
      category: 'email_notifications',
      description: 'Outbound notification log (email/in-app sends).',
      defaultRetentionDays: 30,
      capRetentionDays: 365,
      table: 'notifications',
      dateColumn: 'created_at',
      exportForPerson: async (db, tenantId, personId) => {
        const records = await db.queryMany(
          `select id, notification_type, target_channel, related_entity_type,
                  related_entity_id, subject, status, sent_at, read_at, created_at
             from notifications
            where tenant_id = $1 and recipient_person_id = $2
            order by created_at desc
            limit 5000`,
          [tenantId, personId],
        );
        return {
          category: 'email_notifications',
          description: 'Outbound notifications sent to the subject.',
          records,
          totalCount: records.length,
        };
      },
      erasureRefs: async (db, tenantId, personId) => {
        const rows = await db.queryMany<{ id: string }>(
          `select id from notifications
            where tenant_id = $1 and recipient_person_id = $2`,
          [tenantId, personId],
        );
        return rows.map((r) => ({
          category: 'email_notifications',
          resourceType: 'notifications',
          resourceId: r.id,
          tenantId,
        }));
      },
    },
    db,
  );
}

/** Categories deferred to other workers / no warehoused PII. */
export function buildNoOpAdapters(): DataCategoryAdapter[] {
  return [
    makeNoOpAdapter({
      category: 'calendar_event_content',
      description: 'Outlook event body content.',
      defaultRetentionDays: 0,
      capRetentionDays: 0,
      legalBasis: 'none',
      rationale: 'not warehoused — fetched on-demand from MS Graph',
    }),
    makeNoOpAdapter({
      category: 'past_bookings',
      description: 'Historical reservations — 7-year accounting retention.',
      defaultRetentionDays: 2555,
      capRetentionDays: null,
      legalBasis: 'legal_obligation',
      rationale: 'PII via FK to persons; PersonsAdapter handles the actual scrub on departure',
    }),
    makeNoOpAdapter({
      category: 'past_orders',
      description: 'Historical orders — 7-year accounting retention.',
      defaultRetentionDays: 2555,
      capRetentionDays: null,
      legalBasis: 'legal_obligation',
      rationale: 'PII via FK to persons; PersonsAdapter handles the actual scrub on departure',
    }),
    makeNoOpAdapter({
      category: 'personal_data_access_logs',
      description: 'Read-side audit log — monthly partitioned.',
      defaultRetentionDays: 365,
      capRetentionDays: 730,
      legalBasis: 'legitimate_interest',
      rationale: 'partition-drop via RetentionWorker.maintainPdalPartitions',
    }),
    makeNoOpAdapter({
      category: 'person_preferences',
      description: 'User notification preferences and settings.',
      defaultRetentionDays: 30,
      capRetentionDays: 30,
      legalBasis: 'contract',
      rationale: 'no separate preferences table today; folded into PersonsAdapter at retention age',
    }),
  ];
}

/** Categories whose backing table ships with a downstream spec. */
export function buildPendingSpecAdapters(): DataCategoryAdapter[] {
  return [
    makePendingSpecAdapter({
      category: 'visitor_photos_ids',
      description: 'Visitor photo + ID scan storage.',
      defaultRetentionDays: 90,
      capRetentionDays: 180,
      legalBasis: 'legitimate_interest',
      pendingSpec: 'visitor management spec — visitors module backend agent',
    }),
    makePendingSpecAdapter({
      category: 'cctv_footage',
      description: 'CCTV recording storage.',
      defaultRetentionDays: 28,
      capRetentionDays: 28,
      legalBasis: 'legitimate_interest',
      pendingSpec: 'not in any active spec; placeholder — Tier 3',
    }),
    makePendingSpecAdapter({
      category: 'calendar_attendees_snapshot',
      description: 'Snapshot of calendar attendees at booking time.',
      defaultRetentionDays: 90,
      capRetentionDays: 365,
      legalBasis: 'legitimate_interest',
      pendingSpec: 'MS Graph integration — Phase 2 attendee snapshot table',
    }),
    makePendingSpecAdapter({
      category: 'daglijst_pdfs',
      description: 'Generated daily-list PDFs for paper vendors.',
      defaultRetentionDays: 90,
      capRetentionDays: 365,
      legalBasis: 'legitimate_interest',
      pendingSpec: 'vendor portal Phase A (daglijst) spec',
    }),
    makePendingSpecAdapter({
      category: 'ghost_persons',
      description: 'Auto-created person rows for Outlook attendees.',
      defaultRetentionDays: 365,
      capRetentionDays: 730,
      legalBasis: 'legitimate_interest',
      pendingSpec: 'MS Graph integration — Phase 2 ghost person creation',
    }),
    makePendingSpecAdapter({
      category: 'vendor_user_data',
      description: 'Vendor portal user accounts.',
      defaultRetentionDays: 730,
      capRetentionDays: 1825,
      legalBasis: 'contract',
      pendingSpec: 'vendor portal Phase B spec',
    }),
  ];
}
