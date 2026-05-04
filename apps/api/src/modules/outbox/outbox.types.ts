/**
 * Domain Outbox — TypeScript types matching the SQL schema.
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md (v3, commit 83f3ba0)
 * Schema: supabase/migrations/00299_outbox_foundation.sql §1 (outbox.events).
 */

/**
 * The shape of a row in `outbox.events` as seen by the worker. Snake_case
 * mirrors the SQL columns exactly so we can pass-through from raw queries
 * without per-column renames in the hot path.
 */
export interface OutboxEvent<TPayload = Record<string, unknown>> {
  id: string;
  tenant_id: string;
  event_type: string;
  event_version: number;
  aggregate_type: string;
  aggregate_id: string;
  payload: TPayload;
  payload_hash: string;
  idempotency_key: string;
  enqueued_at: string;
  available_at: string;
  processed_at: string | null;
  processed_reason: string | null;
  claim_token: string | null;
  claimed_at: string | null;
  attempts: number;
  last_error: string | null;
  dead_lettered_at: string | null;
}

/**
 * Input shape for the TS-side fire-and-forget emit (spec §3.2).
 *
 * `operationId` is required — combined with `eventType` + `aggregateId` it
 * forms the deterministic idempotency key. There are no anonymous emits
 * (the SQL helper rejects null/empty keys; the TS path enforces the same
 * by typing operationId as required).
 */
export interface OutboxEventInput {
  tenantId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload?: Record<string, unknown>;
  /** Deterministic per-emit discriminator. No anonymous fire-and-forget. */
  operationId: string;
  eventVersion?: number;
}

/**
 * Reasons the dead-letter table records. Matches the §4.2.3 taxonomy.
 */
export type DeadLetterReason =
  | 'max_attempts'
  | 'dead_letter_error'
  | 'tenant_not_found'
  | 'partial_failure_blocker'
  | 'no_handler_registered';
