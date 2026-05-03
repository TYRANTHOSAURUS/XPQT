import { ConflictGuardService } from './conflict-guard.service';

describe('ConflictGuardService.isExclusionViolation', () => {
  // The constructor takes a SupabaseService; for this pure-logic test we
  // pass a typed cast since isExclusionViolation doesn't read it.
  const svc = new ConflictGuardService({} as never);

  it('detects 23P01 SQLSTATE on the error', () => {
    expect(svc.isExclusionViolation({ code: '23P01', message: 'whatever' })).toBe(true);
  });

  it('detects via the message when the constraint name appears', () => {
    expect(svc.isExclusionViolation({
      code: '99999',
      message: 'something something reservations_no_overlap something',
    })).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(svc.isExclusionViolation({ code: '23505', message: 'duplicate key' })).toBe(false);
    expect(svc.isExclusionViolation({ message: 'random' })).toBe(false);
    expect(svc.isExclusionViolation(null)).toBe(false);
    expect(svc.isExclusionViolation(undefined)).toBe(false);
    expect(svc.isExclusionViolation('plain string')).toBe(false);
  });
});

describe('ConflictGuardService.snapshotBuffersForBooking', () => {
  // Dependency injection: a tiny fake supabase + tenant-context bridge.
  // The service queries existing neighbours; we vary the fake to exercise
  // the same-requester back-to-back collapse logic.
  //
  // Post-canonicalisation (2026-05-02): slots no longer carry
  // requester_person_id directly. The service queries `booking_slots` with
  // a PostgREST embed `bookings(requester_person_id)` (see
  // conflict-guard.service.ts:163-172) and reads the requester from the
  // embedded `bookings` object (lines 174-192). The mock rows must mirror
  // that shape — flat `requester_person_id` was the legacy reservations
  // schema and would silently empty-string out under the new code.

  function makeSvc(neighbours: Array<{
    id: string;
    start_at: string;
    end_at: string;
    bookings: { requester_person_id: string } | null;
  }>) {
    const supabase = {
      admin: {
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: () => ({
                  or: () => Promise.resolve({ data: neighbours, error: null }),
                }),
              }),
            }),
          }),
        }),
      },
    };
    // Bypass TenantContext.current() by stubbing global mock
    // We use jest.spyOn after instantiating in the test below.
    return new ConflictGuardService(supabase as never);
  }

  it('keeps full buffers when no same-requester neighbour is touching', async () => {
    const svc = makeSvc([
      { id: 'a', start_at: '2026-05-01T08:00:00Z', end_at: '2026-05-01T08:30:00Z',
        bookings: { requester_person_id: 'OTHER' } },
    ]);
    jest.spyOn(require('../../common/tenant-context').TenantContext, 'current').mockReturnValue({ id: 'T' } as never);

    const out = await svc.snapshotBuffersForBooking({
      space_id: 'S',
      requester_person_id: 'ME',
      start_at: '2026-05-01T09:00:00Z',
      end_at: '2026-05-01T10:00:00Z',
      room_setup_buffer_minutes: 15,
      room_teardown_buffer_minutes: 15,
    });
    expect(out).toEqual({ setup_buffer_minutes: 15, teardown_buffer_minutes: 15 });
  });

  it('zeros setup buffer when the immediately-prior booking is mine', async () => {
    const svc = makeSvc([
      { id: 'prior', start_at: '2026-05-01T08:00:00Z', end_at: '2026-05-01T09:00:00Z',
        bookings: { requester_person_id: 'ME' } },
    ]);
    jest.spyOn(require('../../common/tenant-context').TenantContext, 'current').mockReturnValue({ id: 'T' } as never);

    const out = await svc.snapshotBuffersForBooking({
      space_id: 'S',
      requester_person_id: 'ME',
      start_at: '2026-05-01T09:00:00Z',
      end_at: '2026-05-01T10:00:00Z',
      room_setup_buffer_minutes: 15,
      room_teardown_buffer_minutes: 15,
    });
    expect(out.setup_buffer_minutes).toBe(0);
    expect(out.teardown_buffer_minutes).toBe(15);
  });

  it('zeros teardown buffer when the immediately-following booking is mine', async () => {
    const svc = makeSvc([
      { id: 'next', start_at: '2026-05-01T10:00:00Z', end_at: '2026-05-01T11:00:00Z',
        bookings: { requester_person_id: 'ME' } },
    ]);
    jest.spyOn(require('../../common/tenant-context').TenantContext, 'current').mockReturnValue({ id: 'T' } as never);

    const out = await svc.snapshotBuffersForBooking({
      space_id: 'S',
      requester_person_id: 'ME',
      start_at: '2026-05-01T09:00:00Z',
      end_at: '2026-05-01T10:00:00Z',
      room_setup_buffer_minutes: 15,
      room_teardown_buffer_minutes: 15,
    });
    expect(out.setup_buffer_minutes).toBe(15);
    expect(out.teardown_buffer_minutes).toBe(0);
  });

  it('keeps full buffers when room has none configured', async () => {
    const svc = makeSvc([]);
    jest.spyOn(require('../../common/tenant-context').TenantContext, 'current').mockReturnValue({ id: 'T' } as never);

    const out = await svc.snapshotBuffersForBooking({
      space_id: 'S',
      requester_person_id: 'ME',
      start_at: '2026-05-01T09:00:00Z',
      end_at: '2026-05-01T10:00:00Z',
      room_setup_buffer_minutes: 0,
      room_teardown_buffer_minutes: 0,
    });
    expect(out).toEqual({ setup_buffer_minutes: 0, teardown_buffer_minutes: 0 });
  });
});
