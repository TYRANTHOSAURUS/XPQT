/**
 * Contract for a "data category" — the unit at which retention, anonymization,
 * export, and erasure are reasoned about. Every PII-bearing entity in the
 * platform registers exactly one adapter against the registry.
 *
 * Adding a new PII-bearing table:
 *   1. Add the category to seed_default_retention_for_tenant() in the next migration.
 *   2. Implement DataCategoryAdapter for that category.
 *   3. Register it in PrivacyComplianceModule.
 *   4. CI lint (Sprint 5) will fail if a PII-bearing migration ships without
 *      a registered adapter.
 *
 * Spec: docs/superpowers/specs/2026-04-27-gdpr-baseline-design.md §2 + §3.
 */

export interface EntityRef {
  /** The data category this ref belongs to (matches DataCategoryAdapter.category). */
  category: string;
  /** Resource table name, e.g. 'persons', 'visitors', 'audit_events'. */
  resourceType: string;
  /** Primary key of the resource. */
  resourceId: string;
  /** Tenant scope of the resource. Required for cross-tenant safety in batch ops. */
  tenantId: string;
  /**
   * Person ids whose PII is referenced by this row. Used by the orchestrator
   * to filter out refs covered by a person-level legal hold. Adapters populate
   * with the union of all person FK columns on the row (e.g. visitors:
   * [person_id, host_person_id]; notifications: [recipient_person_id]).
   * Empty / undefined means the row is not person-linked.
   */
  subjectPersonIds?: string[];
}

/** A section of the per-person export bundle (one per category). */
export interface ExportSection {
  category: string;
  /** Human-readable description for the export bundle. */
  description: string;
  /** Records belonging to this person, structured per the adapter's choice. */
  records: unknown[];
  /** Total record count (may exceed records.length for paginated/streaming exports). */
  totalCount: number;
}

export interface AnonymizeContext {
  /**
   * Why is this anonymization happening?
   *   - `retention`         (default): nightly worker; 7-day restore window applies.
   *   - `erasure_request`:  subject-driven Art. 17 erasure; NO restore window —
   *                         adapters MUST skip the snapshot to prevent recovery.
   *   - `departure_cleanup`: triggered by `persons.left_at`; behaves like retention.
   */
  reason: 'retention' | 'erasure_request' | 'departure_cleanup';
  /** Initiating admin user (DSR fulfillments); null for the retention worker. */
  initiatedByUserId?: string | null;
}

export type LegalBasis =
  | 'legitimate_interest'
  | 'consent'
  | 'legal_obligation'
  | 'contract'
  | 'none';

export interface DataCategoryAdapter {
  /** Stable identifier matching tenant_retention_settings.data_category. */
  readonly category: string;
  /** Short human-readable label (English; i18n at the UI layer). */
  readonly description: string;
  /** Default retention in days; mirrored in seed_default_retention_for_tenant(). */
  readonly defaultRetentionDays: number;
  /** Cap retention in days; null = no cap. */
  readonly capRetentionDays: number | null;
  /** Lawful basis under GDPR Art. 6. */
  readonly legalBasis: LegalBasis;

  /**
   * Find resources whose retention window has expired. The retentionDays
   * parameter is the per-tenant effective setting (may be shorter than default).
   * Implementations MUST scope by tenantId AND skip resources already
   * anonymized (idempotency).
   */
  scanForExpired(tenantId: string, retentionDays: number): Promise<EntityRef[]>;

  /**
   * Replace PII fields in-place with placeholders, preserving FK integrity
   * (id stays). After this call, .scanForExpired must NOT return the same
   * refs — the adapter's "is anonymized" predicate must flip.
   *
   * `context.reason` lets the orchestrator distinguish retention from
   * subject-driven erasure. Adapters MUST propagate this to
   * AnonymizationAuditService.snapshotTx so erasure does NOT create a
   * 7-day restore window (defeats Art. 17). Default is `retention`.
   */
  anonymize(refs: EntityRef[], context?: AnonymizeContext): Promise<void>;

  /**
   * Hard-delete records that have no anonymization path (e.g. cctv_footage,
   * daglijst_pdfs — both files in storage). Most categories use anonymize().
   */
  hardDelete(refs: EntityRef[]): Promise<void>;

  /**
   * Build the per-person export section for Art. 15 access requests.
   * Returns rows scoped to this category that reference the subject person.
   */
  exportForPerson(tenantId: string, personId: string): Promise<ExportSection>;

  /**
   * Refs of resources this category owns for the given person, used during
   * Art. 17 erasure. Default behaviour is "anonymize"; the orchestrator
   * decides whether to call anonymize() or hardDelete() per category type.
   */
  erasureRefs(tenantId: string, personId: string): Promise<EntityRef[]>;
}
