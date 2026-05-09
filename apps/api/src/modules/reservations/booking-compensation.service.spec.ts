import { AppError } from '../../common/errors';
import { BookingCompensationService } from './booking-compensation.service';
import { TenantContext } from '../../common/tenant-context';

// Phase 1.3 — Bug #1 (atomic booking + service via RPC + boundary).
//
// Spec for BookingCompensationService — the thin wrapper over
// `delete_booking_with_guard` (migration 00292). Three scenarios per
// docs/superpowers/plans/2026-05-04-architecture-phase-1-correctness-bugs.md
// Phase 1.3 — Tests (TDD) #1:
//
//   1. RPC returns { kind: 'rolled_back' } → service returns
//      { kind: 'rolled_back', bookingId } unchanged.
//   2. RPC returns { kind: 'partial_failure', blocked_by: [...] } → service
//      returns { kind: 'partial_failure', bookingId, blockedBy }.
//   3. RPC throws / returns error → service surfaces as a
//      BadRequestException with code 'booking.compensation_failed' so the
//      boundary can distinguish from the operation's original error.

describe('BookingCompensationService', () => {
  const TENANT = { id: 'T', slug: 't', tier: 'standard' as const };
  const BOOKING_ID = 'B-1';

  function makeSupabase(opts: { rpcResponse: { data: unknown; error: unknown } }) {
    const calls = { rpc: [] as Array<{ fn: string; args: unknown }> };
    const admin = {
      rpc: (fn: string, args: unknown) => {
        calls.rpc.push({ fn, args });
        return Promise.resolve(opts.rpcResponse);
      },
    };
    return { admin, calls };
  }

  it('forwards a rolled_back outcome from the RPC', async () => {
    const supabase = makeSupabase({
      rpcResponse: { data: { kind: 'rolled_back' }, error: null },
    });
    const svc = new BookingCompensationService(supabase as never);

    const outcome = await TenantContext.run(TENANT, () => svc.deleteBooking(BOOKING_ID));

    expect(outcome).toEqual({ kind: 'rolled_back', bookingId: BOOKING_ID });
    expect(supabase.calls.rpc).toHaveLength(1);
    expect(supabase.calls.rpc[0]).toEqual({
      fn: 'delete_booking_with_guard',
      args: { p_booking_id: BOOKING_ID, p_tenant_id: TENANT.id },
    });
  });

  it('forwards a partial_failure outcome with blocked_by from the RPC', async () => {
    const supabase = makeSupabase({
      rpcResponse: {
        data: { kind: 'partial_failure', blocked_by: ['recurrence_series'] },
        error: null,
      },
    });
    const svc = new BookingCompensationService(supabase as never);

    const outcome = await TenantContext.run(TENANT, () => svc.deleteBooking(BOOKING_ID));

    expect(outcome).toEqual({
      kind: 'partial_failure',
      bookingId: BOOKING_ID,
      blockedBy: ['recurrence_series'],
    });
  });

  it('surfaces an RPC error as BadRequestException(booking.compensation_failed)', async () => {
    const supabase = makeSupabase({
      rpcResponse: { data: null, error: { message: 'connection lost' } },
    });
    const svc = new BookingCompensationService(supabase as never);

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () => svc.deleteBooking(BOOKING_ID));
    } catch (err) {
      caught = err;
    }

    // /full-review v3 fix — the compensation RPC failing is server-class
    // (booking persists in unknown state, user can't fix via input changes)
    // per CLAUDE.md error-handling spec §3.3. Phase 7.A.2.c.ii: AppError
    // replaces InternalServerErrorException; structured booking_id +
    // rpc_error fields are now folded into `detail` (the wire shape only
    // carries detail / fields[]).
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ code: 'booking.compensation_failed', status: 500 });
    expect((caught as AppError).detail).toContain(BOOKING_ID);
    expect((caught as AppError).detail).toContain('connection lost');
  });

  it('surfaces a malformed RPC payload as InternalServerErrorException(booking.compensation_failed)', async () => {
    // Defensive — guards against future RPC drift returning {} or null.
    const supabase = makeSupabase({
      rpcResponse: { data: null, error: null },
    });
    const svc = new BookingCompensationService(supabase as never);

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () => svc.deleteBooking(BOOKING_ID));
    } catch (err) {
      caught = err;
    }

    // /full-review v3 fix — same severity promotion as the connection-lost
    // path above. Malformed payload from the compensation RPC is server-
    // class data corruption.
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ code: 'booking.compensation_failed', status: 500 });
    expect((caught as AppError).detail).toContain(BOOKING_ID);
  });
});
