import { ReconcilerService } from '../reconciler.service';
import type { GraphEvent } from '../outlook-sync.adapter';

/**
 * The reconciler does three kinds of diffs:
 *   - external event with no Prequest booking slot → webhook_miss_recovered
 *   - booking slot whose external_event_id is no longer in Outlook → orphan_internal
 *   - booking slot + external event with mismatched times → recurrence_drift
 *
 * We unit-test the dispatch logic by stubbing the supabase client and
 * verifying which conflict_types get inserted. The Graph fetch is stubbed
 * to short-circuit; a deeper integration test would use a Graph mock.
 *
 * Post-canonicalisation (2026-05-02, migrations 00276–00278): the legacy
 * `reservations` table is dropped. `loadReservations` now queries
 * `booking_slots` and embeds the parent `bookings` row to read
 * `calendar_event_id` (see reconciler.service.ts:193-219). The mock
 * mirrors that shape — rows expose `bookings: { calendar_event_id }`
 * which the service maps into `external_event_id`.
 */
describe('ReconcilerService.reconcileSpace', () => {
  function buildSvc(opts: {
    reservations: Array<{ id: string; start_at: string; end_at: string; external_event_id: string | null }>;
    graphEvents: GraphEvent[] | null;
  }): { svc: ReconcilerService; insertedTypes: string[] } {
    const insertedTypes: string[] = [];
    const supabase = {
      admin: {
        from: (table: string) => {
          if (table === 'booking_slots') {
            // Service select shape (reconciler.service.ts:195):
            //   'id, start_at, end_at, status, bookings!inner(calendar_event_id)'
            // Chain: select → eq(tenant) → eq(space) → gte(start) → lte(start) → in(status)
            const rows = opts.reservations.map((r) => ({
              id: r.id,
              start_at: r.start_at,
              end_at: r.end_at,
              status: 'confirmed',
              bookings: { calendar_event_id: r.external_event_id },
            }));
            return chainOf({
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    gte: () => ({
                      lte: () => ({
                        in: async () => ({ data: rows, error: null }),
                      }),
                    }),
                  }),
                }),
              }),
            });
          }
          if (table === 'spaces') {
            return chainOf({
              update: () => ({
                eq: async () => ({ data: null, error: null }),
              }),
            });
          }
          if (table === 'room_calendar_conflicts') {
            return chainOf({
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      eq: () => ({
                        maybeSingle: async () => ({ data: null, error: null }),
                      }),
                    }),
                  }),
                }),
              }),
              insert: async (row: { conflict_type: string }) => {
                insertedTypes.push(row.conflict_type);
                return { data: null, error: null };
              },
            });
          }
          return chainOf({});
        },
      },
    } as never;

    const outlookStub = {} as never;
    const svc = new ReconcilerService(supabase, outlookStub);

    // Stub the private Graph call by overriding at runtime.
    (svc as unknown as { fetchCalendarView: () => Promise<GraphEvent[] | null> }).fetchCalendarView =
      async () => opts.graphEvents;

    return { svc, insertedTypes };
  }

  it('raises webhook_miss_recovered for orphan external events', async () => {
    const { svc, insertedTypes } = buildSvc({
      reservations: [],
      graphEvents: [makeGraphEvent('ext-1', '2026-05-12T14:00:00Z', '2026-05-12T15:00:00Z')],
    });
    await svc.reconcileSpace({
      id: 's1',
      tenant_id: 't1',
      name: 'Lotus',
      external_calendar_id: 'lotus@example.com',
      external_calendar_subscription_id: 'sub-1',
    });
    expect(insertedTypes).toContain('webhook_miss_recovered');
  });

  it('raises orphan_internal for reservations whose external event vanished', async () => {
    const { svc, insertedTypes } = buildSvc({
      reservations: [
        { id: 'r1', start_at: '2026-05-12T14:00:00Z', end_at: '2026-05-12T15:00:00Z', external_event_id: 'ext-1' },
      ],
      graphEvents: [],
    });
    await svc.reconcileSpace({
      id: 's1',
      tenant_id: 't1',
      name: 'Lotus',
      external_calendar_id: 'lotus@example.com',
      external_calendar_subscription_id: 'sub-1',
    });
    expect(insertedTypes).toContain('orphan_internal');
  });

  it('raises recurrence_drift for matched events with different times', async () => {
    const { svc, insertedTypes } = buildSvc({
      reservations: [
        { id: 'r1', start_at: '2026-05-12T14:00:00Z', end_at: '2026-05-12T15:00:00Z', external_event_id: 'ext-1' },
      ],
      graphEvents: [makeGraphEvent('ext-1', '2026-05-12T15:00:00Z', '2026-05-12T16:00:00Z')],
    });
    await svc.reconcileSpace({
      id: 's1',
      tenant_id: 't1',
      name: 'Lotus',
      external_calendar_id: 'lotus@example.com',
      external_calendar_subscription_id: 'sub-1',
    });
    expect(insertedTypes).toContain('recurrence_drift');
  });

  it('reports orphan_external when Graph cannot be read', async () => {
    const { svc, insertedTypes } = buildSvc({
      reservations: [],
      graphEvents: null,
    });
    await svc.reconcileSpace({
      id: 's1',
      tenant_id: 't1',
      name: 'Lotus',
      external_calendar_id: 'lotus@example.com',
      external_calendar_subscription_id: 'sub-1',
    });
    expect(insertedTypes).toContain('orphan_external');
  });

  it('clean state inserts no conflicts', async () => {
    const { svc, insertedTypes } = buildSvc({
      reservations: [
        { id: 'r1', start_at: '2026-05-12T14:00:00Z', end_at: '2026-05-12T15:00:00Z', external_event_id: 'ext-1' },
      ],
      graphEvents: [makeGraphEvent('ext-1', '2026-05-12T14:00:00Z', '2026-05-12T15:00:00Z')],
    });
    await svc.reconcileSpace({
      id: 's1',
      tenant_id: 't1',
      name: 'Lotus',
      external_calendar_id: 'lotus@example.com',
      external_calendar_subscription_id: 'sub-1',
    });
    expect(insertedTypes).toEqual([]);
  });
});

function makeGraphEvent(id: string, startIso: string, endIso: string): GraphEvent {
  return {
    id,
    subject: 'Test',
    bodyPreview: '',
    start: { dateTime: startIso.replace('Z', ''), timeZone: 'UTC' },
    end: { dateTime: endIso.replace('Z', ''), timeZone: 'UTC' },
    organizer: { emailAddress: { address: 'a@b.c', name: 'A' } },
    attendees: [],
    isCancelled: false,
  };
}

// Tiny helper so chained Supabase-style stubs are readable.
function chainOf<T extends object>(impl: T): T {
  return impl;
}
