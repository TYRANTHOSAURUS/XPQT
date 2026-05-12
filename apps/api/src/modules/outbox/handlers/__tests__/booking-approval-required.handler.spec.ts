import {
  BookingApprovalRequiredHandler,
  type BookingApprovalRequiredPayload,
} from '../booking-approval-required.handler';
import { DeadLetterError } from '../../dead-letter.error';
import type { OutboxEvent } from '../../outbox.types';

/**
 * B.4.A.4 — `BookingApprovalRequiredHandler.handle` tests.
 *
 * Producer: supabase/migrations/00394_edit_booking_rpc_v5.sql:974-993
 *           (post-B.4.A.5-sub-step-B; supersedes 00364 v4).
 * Event literal: apps/api/src/modules/reservations/event-types.ts:51
 *                (`BookingEditEventType.ApprovalRequired`).
 *
 * v1 is a registration stub — covers:
 *   1. Happy path: well-formed payload resolves without throwing.
 *   2. Tenant smuggling defense (event vs payload mismatch).
 *   3. Malformed payload — missing/invalid uuid, empty approver list,
 *      bad started_at — terminal dead-letter (producer contract bug).
 *
 * Notification dispatch is NOT exercised here — it lands in B.4.A.5 and
 * gets its own integration coverage at that point.
 */

const TENANT_ID = 'a1111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = 'a9999999-9999-4999-8999-999999999999';
const EVENT_ID = 'a2222222-2222-4222-8222-222222222222';
const BOOKING_ID = 'a3333333-3333-4333-8333-333333333333';
const CHAIN_ID = 'a4444444-4444-4444-8444-444444444444';
const APPROVER_A = 'a5555555-5555-4555-8555-555555555555';
const APPROVER_B = 'a6666666-6666-4666-8666-666666666666';

function makeEvent(
  overrides: Partial<OutboxEvent<BookingApprovalRequiredPayload>> = {},
  payloadOverrides: Partial<BookingApprovalRequiredPayload> = {},
): OutboxEvent<BookingApprovalRequiredPayload> {
  return {
    id: EVENT_ID,
    tenant_id: TENANT_ID,
    event_type: 'booking.approval_required',
    event_version: 1,
    aggregate_type: 'booking',
    aggregate_id: BOOKING_ID,
    payload: {
      tenant_id: TENANT_ID,
      booking_id: BOOKING_ID,
      chain_id: CHAIN_ID,
      approver_person_ids: [APPROVER_A, APPROVER_B],
      approver_team_ids: [],
      started_at: '2026-05-12T09:00:00Z',
      ...payloadOverrides,
    },
    payload_hash: 'hash',
    idempotency_key: 'booking.approval_required:' + BOOKING_ID + ':edit-1',
    enqueued_at: '2026-05-12T08:59:00Z',
    available_at: '2026-05-12T08:59:00Z',
    processed_at: null,
    processed_reason: null,
    claim_token: null,
    claimed_at: null,
    attempts: 0,
    last_error: null,
    dead_lettered_at: null,
    ...overrides,
  };
}

describe('BookingApprovalRequiredHandler.handle (B.4.A.4)', () => {
  describe('happy path (stub)', () => {
    it('accepts a well-formed event without throwing', async () => {
      const handler = new BookingApprovalRequiredHandler();
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
    });

    it('accepts a single-approver event', async () => {
      const handler = new BookingApprovalRequiredHandler();
      await expect(
        handler.handle(makeEvent({}, { approver_person_ids: [APPROVER_A], approver_team_ids: [] })),
      ).resolves.toBeUndefined();
    });

    it('accepts a team-only event', async () => {
      const handler = new BookingApprovalRequiredHandler();
      await expect(
        handler.handle(makeEvent({}, { approver_person_ids: [], approver_team_ids: [APPROVER_A] })),
      ).resolves.toBeUndefined();
    });
  });

  describe('tenant smuggling defense', () => {
    it('dead-letters when payload.tenant_id != event.tenant_id', async () => {
      const handler = new BookingApprovalRequiredHandler();
      const event = makeEvent({}, { tenant_id: OTHER_TENANT_ID });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });
  });

  describe('payload shape — terminal dead-letters', () => {
    it('dead-letters on missing booking_id', async () => {
      const handler = new BookingApprovalRequiredHandler();
      const event = makeEvent({}, { booking_id: undefined as unknown as string });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters on non-uuid booking_id', async () => {
      const handler = new BookingApprovalRequiredHandler();
      const event = makeEvent({}, { booking_id: 'not-a-uuid' });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters on missing chain_id', async () => {
      const handler = new BookingApprovalRequiredHandler();
      const event = makeEvent({}, { chain_id: undefined as unknown as string });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters when both approver arrays are empty', async () => {
      const handler = new BookingApprovalRequiredHandler();
      const event = makeEvent({}, { approver_person_ids: [], approver_team_ids: [] });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters on missing approver_person_ids', async () => {
      const handler = new BookingApprovalRequiredHandler();
      const event = makeEvent(
        {},
        { approver_person_ids: undefined as unknown as string[] },
      );
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters on missing approver_team_ids', async () => {
      const handler = new BookingApprovalRequiredHandler();
      const event = makeEvent(
        {},
        { approver_team_ids: undefined as unknown as string[] },
      );
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters when an approver person id is not a uuid', async () => {
      const handler = new BookingApprovalRequiredHandler();
      const event = makeEvent({}, { approver_person_ids: [APPROVER_A, 'bogus'] });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters when an approver team id is not a uuid', async () => {
      const handler = new BookingApprovalRequiredHandler();
      const event = makeEvent({}, { approver_team_ids: ['bogus'] });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters on unparseable started_at', async () => {
      const handler = new BookingApprovalRequiredHandler();
      const event = makeEvent({}, { started_at: 'not-a-date' });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters on missing started_at', async () => {
      const handler = new BookingApprovalRequiredHandler();
      const event = makeEvent({}, { started_at: undefined as unknown as string });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });
  });
});
