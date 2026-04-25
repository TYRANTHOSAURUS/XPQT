import type { GraphEvent } from '../outlook-sync.adapter';
import { RoomMailboxService } from '../room-mailbox.service';

// We construct the service with empty deps because `translate` is a pure
// method that only uses its arguments.
function makeService(): RoomMailboxService {
  return new RoomMailboxService(
    {} as never,
    {} as never,
  );
}

describe('RoomMailboxService.translate', () => {
  const baseEvent: GraphEvent = {
    id: 'AAMkAGY3...==',
    subject: 'Quarterly review',
    bodyPreview: 'Discuss Q2 plans',
    start: { dateTime: '2026-05-12T14:00:00.0000000', timeZone: 'UTC' },
    end:   { dateTime: '2026-05-12T15:00:00.0000000', timeZone: 'UTC' },
    organizer: { emailAddress: { address: 'alice@example.com', name: 'Alice' } },
    attendees: [
      { emailAddress: { address: 'bob@example.com', name: 'Bob' }, type: 'required' },
      { emailAddress: { address: 'carol@example.com', name: 'Carol' }, type: 'optional' },
    ],
    isCancelled: false,
  };

  it('maps Graph event to a CreateReservationInput draft', () => {
    const svc = makeService();
    const draft = svc.translate(baseEvent, 'tenant-1', 'space-1');
    expect(draft.tenant_id).toBe('tenant-1');
    expect(draft.space_id).toBe('space-1');
    expect(draft.start_at).toBe('2026-05-12T14:00:00.000Z');
    expect(draft.end_at).toBe('2026-05-12T15:00:00.000Z');
    expect(draft.description).toBe('Quarterly review');
    expect(draft.organizer_email).toBe('alice@example.com');
    expect(draft.attendee_emails).toEqual(['bob@example.com', 'carol@example.com']);
    expect(draft.attendee_count).toBe(2);
    expect(draft.external_event_id).toBe('AAMkAGY3...==');
    expect(draft.source).toBe('calendar_sync');
  });

  it('treats missing subject as null description', () => {
    const svc = makeService();
    const draft = svc.translate({ ...baseEvent, subject: null }, 't', 's');
    expect(draft.description).toBeNull();
  });

  it('counts at least one attendee even if list is empty', () => {
    const svc = makeService();
    const draft = svc.translate({ ...baseEvent, attendees: [] }, 't', 's');
    expect(draft.attendee_emails).toEqual([]);
    expect(draft.attendee_count).toBe(1);
  });

  it('skips attendees without an email address', () => {
    const svc = makeService();
    const draft = svc.translate(
      {
        ...baseEvent,
        attendees: [
          { emailAddress: { address: 'bob@example.com', name: 'Bob' }, type: 'required' },
          { emailAddress: { address: '', name: 'Anonymous' }, type: 'required' },
        ],
      },
      't',
      's',
    );
    expect(draft.attendee_emails).toEqual(['bob@example.com']);
  });
});
