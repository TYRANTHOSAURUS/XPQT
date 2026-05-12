import { Injectable, Logger } from '@nestjs/common';
import { UUID_RE } from '../../../common/tenant-validation';
import { BookingEditEventType } from '../../reservations/event-types';
import { DeadLetterError } from '../dead-letter.error';
import { OutboxHandler, type OutboxEventHandler } from '../outbox-handler.decorator';
import type { OutboxEvent } from '../outbox.types';

/**
 * BookingApprovalRequiredHandler — drains `booking.approval_required` outbox
 * events emitted by the `edit_booking` RPC when a §3.6.5 row 2/7/8 outcome
 * flipped the booking from final → require_approval and inserted a fresh
 * approval chain.
 *
 * Producer: supabase/migrations/00394_edit_booking_rpc_v5.sql:974-993
 *           (`if v_emit_approval_required then perform outbox.emit(...)`)
 *           — supersedes 00364 v4. v5 splits the v4 mixed `approver_ids`
 *           field into `approver_person_ids` (persons.id values) +
 *           `approver_team_ids` (team ids).
 * Event type literal: apps/api/src/modules/reservations/event-types.ts:51
 *           (`BookingEditEventType.ApprovalRequired`).
 *
 * ── Why this handler ships now (B.4.A.4 — pre-cutover unblock) ───────────
 *
 * Per the event-types doc-comment on lines 40-50, this is the ONLY one of
 * the three new booking edit event types whose dead-lettering has a
 * user-visible consequence: an edit that flips to pending_approval would
 * commit the row but the approver notification would dead-letter as
 * `no_handler_registered`, leaving the chain stalled. Spec §7 makes
 * registering this handler a producer-before-consumer obligation that
 * blocks any TS controller calling `edit_booking`.
 *
 * ── What this handler does NOT do (deferred to B.4.A.5) ──────────────────
 *
 * v1 is a registration STUB: validates the event shape + tenant boundary,
 * logs receipt, returns. Notification dispatch (email approvers, in-app
 * inbox, push) lands in B.4.A.5. The handler shape exists so future
 * notification work can bolt onto a known-validated payload, and so emits
 * stop dead-lettering immediately.
 *
 * Source-of-truth re-reads of `bookings` / approval chain state are
 * intentionally NOT performed here — the actual notification dispatch
 * (B.4.A.5) will own those reads, and adding them now would be dead code
 * that drifts before its consumer arrives.
 *
 * ── Cross-tenant defense (memory: feedback_tenant_id_ultimate_rule) ─────
 *
 * Service-role bypasses RLS, so tenant_id is asserted defensively at the
 * top: payload.tenant_id must equal event.tenant_id, mismatch → terminal
 * dead-letter. Same pattern as sla-timer-repoint.handler.ts:78-82.
 */

export interface BookingApprovalRequiredPayload {
  /** Tenant — duplicated from event.tenant_id for defense-in-depth. */
  tenant_id: string;
  /** Booking row id (aggregate). */
  booking_id: string;
  /** Approval chain row id inserted by edit_booking for this flip. */
  chain_id: string;
  /**
   * Person approver ids — these are `persons.id` values, NOT `users.id`.
   * They originate from `required_approvers[n].id` in the edit plan where
   * `type='person'`. Sub-step D resolves person → user in tenant scope via
   * `users.person_id` JOIN at dispatch time — the same way the inbox INSERT
   * inside the producer RPC already does (see 00394:807-819).
   *
   * v5 (00394) split the v4 mixed `approver_ids` field into two typed arrays
   * so the handler doesn't have to re-classify each id. The self-review
   * remediation on commit 7852ebf0 renamed this from the original
   * `approver_user_ids` because that name lied about the contents (a
   * `users WHERE id = any(...)` lookup against persons.id values would
   * return zero rows).
   */
  approver_person_ids: string[];
  /**
   * Team approver ids. Sub-step D fans these out via team_members.user_id
   * JOIN public.users (tenant-filtered both sides) at dispatch time. The
   * inbox row(s) for these team members were already written by the RPC
   * (Hybrid C); the handler is responsible only for email dispatch.
   */
  approver_team_ids: string[];
  /** ISO timestamp captured by the RPC (v_started_at). */
  started_at: string;
}

@Injectable()
@OutboxHandler(BookingEditEventType.ApprovalRequired, { version: 1 })
export class BookingApprovalRequiredHandler
  implements OutboxEventHandler<BookingApprovalRequiredPayload>
{
  private readonly log = new Logger(BookingApprovalRequiredHandler.name);

  async handle(event: OutboxEvent<BookingApprovalRequiredPayload>): Promise<void> {
    const payload = event.payload;

    // ── 1. Tenant smuggling defense ──────────────────────────────────────
    if (!payload || payload.tenant_id !== event.tenant_id) {
      throw new DeadLetterError(
        `booking.approval_required.tenant_mismatch: event.tenant_id=${event.tenant_id} payload.tenant_id=${payload?.tenant_id}`,
      );
    }

    // ── 2. Validate payload shape ─────────────────────────────────────────
    //
    // Producer is supabase/migrations/00394_edit_booking_rpc_v5.sql:974-993
    // (v5 split mixed `approver_ids` into `approver_person_ids` +
    // `approver_team_ids` — keys are typed at the JSON layer to drop the
    // re-classification step the handler used to do). Any shape mismatch
    // is a contract bug requiring code change, not retry.
    const { booking_id, chain_id, approver_person_ids, approver_team_ids, started_at } = payload;

    if (typeof booking_id !== 'string' || !UUID_RE.test(booking_id)) {
      throw new DeadLetterError(
        `booking.approval_required.booking_id_invalid: '${booking_id}' is not a uuid`,
      );
    }
    if (typeof chain_id !== 'string' || !UUID_RE.test(chain_id)) {
      throw new DeadLetterError(
        `booking.approval_required.chain_id_invalid: '${chain_id}' is not a uuid`,
      );
    }
    if (!Array.isArray(approver_person_ids)) {
      throw new DeadLetterError(
        `booking.approval_required.approver_person_ids_missing: chain=${chain_id}`,
      );
    }
    if (!Array.isArray(approver_team_ids)) {
      throw new DeadLetterError(
        `booking.approval_required.approver_team_ids_missing: chain=${chain_id}`,
      );
    }
    if (approver_person_ids.length === 0 && approver_team_ids.length === 0) {
      throw new DeadLetterError(
        `booking.approval_required.no_approvers: chain=${chain_id} (both person + team arrays empty)`,
      );
    }
    for (const id of approver_person_ids) {
      if (typeof id !== 'string' || !UUID_RE.test(id)) {
        throw new DeadLetterError(
          `booking.approval_required.approver_person_id_invalid: '${id}' is not a uuid (chain=${chain_id})`,
        );
      }
    }
    for (const id of approver_team_ids) {
      if (typeof id !== 'string' || !UUID_RE.test(id)) {
        throw new DeadLetterError(
          `booking.approval_required.approver_team_id_invalid: '${id}' is not a uuid (chain=${chain_id})`,
        );
      }
    }
    if (typeof started_at !== 'string') {
      throw new DeadLetterError(
        `booking.approval_required.started_at_missing: chain=${chain_id}`,
      );
    }
    const startedDate = new Date(started_at);
    if (Number.isNaN(startedDate.getTime())) {
      throw new DeadLetterError(
        `booking.approval_required.started_at_invalid: '${started_at}' is not parseable`,
      );
    }

    // ── 3. Log + return (v1 stub) ────────────────────────────────────────
    //
    // TODO(B.4.A.5 sub-step D): replace this log with email dispatch:
    //   - re-read bookings (tenant_id, id) to confirm pending_approval state
    //   - re-read the approval chain row by chain_id to confirm still pending
    //   - resolve person → user via `users.person_id IN (approver_person_ids)
    //     AND tenant_id = event.tenant_id` (mirrors 00394:807-819); fan out
    //     team_members for each id in approver_team_ids; combine into one
    //     userIds set; dispatch one email per user
    //   - inbox rows are ALREADY written by the producer RPC (Hybrid C);
    //     this handler only sends email
    //   - record an audit event for the dispatch
    // Spec: /tmp/b4a5-plan-v2.md sub-step D.
    this.log.log(
      `booking.approval_required received (stub — sub-step D will dispatch email): ` +
        `booking=${booking_id} chain=${chain_id} ` +
        `persons=${approver_person_ids.length} teams=${approver_team_ids.length} ` +
        `started_at=${started_at} event=${event.id}`,
    );
  }
}
