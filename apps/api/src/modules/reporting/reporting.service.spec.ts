import { BadRequestException } from '@nestjs/common';
import { ReportingService } from './reporting.service';
import { TenantContext } from '../../common/tenant-context';

// Bookings overview reports were rewritten by the 2026-05-02 booking-
// canonicalization (migrations 00276–00281): the legacy `reservations` /
// `booking_bundles` tables are gone, the supporting RPCs were dropped in
// 00279, and `ReportingService.getBookings*` now degrade to a
// BadRequestException ("temporarily unavailable") until the reports are
// reimplemented against `bookings` + `booking_slots`. See
// reporting.service.ts:165-213 (the `unavailableBookingReport` helper +
// the five public methods that delegate to it).
//
// These tests pin the *current* contract: input validation still runs
// first (so we keep cheap shape feedback), and only after the inputs
// pass does the service throw the unavailable error. No RPC is ever
// invoked.

describe('ReportingService.getBookings* (canonicalization rewrite — RPCs dropped)', () => {
  const makeService = (rpcImpl: jest.Mock = jest.fn()) => {
    const supabase = { admin: { rpc: rpcImpl } } as any;
    return { svc: new ReportingService(supabase), rpc: rpcImpl };
  };

  const withTenant = <T>(fn: () => Promise<T>) =>
    TenantContext.run({ id: 'tenant-1', slug: 'acme', tier: 'standard' }, fn);

  // Pulled inline so the assertion matches the literal message thrown by
  // `ReportingService.unavailableBookingReport` (reporting.service.ts:210).
  const unavailableMessage = (rpc: string) =>
    `Report '${rpc}' is temporarily unavailable while the bookings reports are migrated to the canonical bookings/booking_slots schema.`;

  describe('getBookingsOverview', () => {
    it('rejects an inverted date window (validation runs before unavailability)', async () => {
      const { svc, rpc } = makeService();
      await expect(
        withTenant(() => svc.getBookingsOverview({
          from: '2026-04-30', to: '2026-04-01', buildingId: null, tz: 'UTC',
        })),
      ).rejects.toMatchObject({
        message: 'from must be on or before to',
      });
      expect(rpc).not.toHaveBeenCalled();
    });

    it('rejects a window > 365 days', async () => {
      const { svc, rpc } = makeService();
      await expect(
        withTenant(() => svc.getBookingsOverview({
          from: '2024-01-01', to: '2026-01-01', buildingId: null, tz: 'UTC',
        })),
      ).rejects.toMatchObject({
        message: 'window too large (max 365 days)',
      });
      expect(rpc).not.toHaveBeenCalled();
    });

    it('rejects malformed date inputs', async () => {
      const { svc, rpc } = makeService();
      await expect(
        withTenant(() => svc.getBookingsOverview({
          from: '04/01/2026', to: '04/30/2026', buildingId: null, tz: 'UTC',
        })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('throws "report unavailable" once inputs validate (even with unknown tz)', async () => {
      // Unknown timezones used to fall back to UTC and continue to the RPC.
      // Now the RPC is gone, so any input that passes shape validation
      // ends up at the unavailable-report throw — including weird tz.
      const { svc, rpc } = makeService();
      await expect(
        withTenant(() => svc.getBookingsOverview({
          from: '2026-04-01', to: '2026-04-30', buildingId: null, tz: 'Mars/Olympus',
        })),
      ).rejects.toMatchObject({
        message: unavailableMessage('room_booking_report_overview'),
      });
      expect(rpc).not.toHaveBeenCalled();
    });

    it('throws "report unavailable" for valid windows + buildings (no RPC fired)', async () => {
      const { svc, rpc } = makeService();
      await expect(
        withTenant(() => svc.getBookingsOverview({
          from: '2026-04-01', to: '2026-04-30', buildingId: 'b-1', tz: 'America/New_York',
        })),
      ).rejects.toMatchObject({
        message: unavailableMessage('room_booking_report_overview'),
      });
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ['getBookingsUtilization', 'room_booking_utilization_report'],
    ['getBookingsNoShows',     'room_booking_no_shows_report'],
    ['getBookingsServices',    'room_booking_services_report'],
    ['getBookingsDemand',      'room_booking_demand_report'],
  ] as const)('%s', (method, rpcName) => {
    it(`throws "${rpcName} unavailable" for valid inputs (no RPC fired)`, async () => {
      const { svc, rpc } = makeService();
      await expect(
        withTenant(() => (svc as any)[method]({
          from: '2026-04-01', to: '2026-04-30', buildingId: 'b-1', tz: 'Europe/Amsterdam',
        })),
      ).rejects.toMatchObject({
        message: unavailableMessage(rpcName),
      });
      expect(rpc).not.toHaveBeenCalled();
    });

    it(`rejects an inverted window for ${method} before reaching the unavailable throw`, async () => {
      const { svc, rpc } = makeService();
      await expect(
        withTenant(() => (svc as any)[method]({
          from: '2026-05-01', to: '2026-04-01', buildingId: null, tz: 'UTC',
        })),
      ).rejects.toMatchObject({
        message: 'from must be on or before to',
      });
      expect(rpc).not.toHaveBeenCalled();
    });
  });
});
