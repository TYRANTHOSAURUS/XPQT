import { BadRequestException } from '@nestjs/common';
import { ReportingService } from './reporting.service';
import { TenantContext } from '../../common/tenant-context';

// Bookings overview reports were rewritten by the 2026-05-02 booking-
// canonicalization (migrations 00276–00281). The 5 supporting RPCs were
// dropped in 00279 and rebuilt in 00289 against the canonical
// `bookings` + `booking_slots` schema. `ReportingService.getBookings*`
// validates inputs (cheap shape feedback before the roundtrip) and then
// pass-throughs to `supabase.admin.rpc(<rpc-name>, { p_tenant_id,
// p_from, p_to, p_building_id, p_tz })`. See reporting.service.ts:165-219
// (the public methods + the `callBookingReport` helper).

describe('ReportingService.getBookings* (canonical RPC pass-through)', () => {
  const makeService = (rpcImpl?: jest.Mock) => {
    const rpc = rpcImpl ?? jest.fn().mockResolvedValue({ data: { rows: [] }, error: null });
    const supabase = { admin: { rpc } } as any;
    return { svc: new ReportingService(supabase), rpc };
  };

  const withTenant = <T>(fn: () => Promise<T>) =>
    TenantContext.run({ id: 'tenant-1', slug: 'acme', tier: 'standard' }, fn);

  describe('getBookingsOverview', () => {
    it('rejects an inverted date window before any RPC call', async () => {
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

    it('rejects a window > 365 days before any RPC call', async () => {
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

    it('rejects malformed date inputs before any RPC call', async () => {
      const { svc, rpc } = makeService();
      await expect(
        withTenant(() => svc.getBookingsOverview({
          from: '04/01/2026', to: '04/30/2026', buildingId: null, tz: 'UTC',
        })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('falls back to UTC when timezone is unknown (no error, RPC fires)', async () => {
      // validateTimezone catches unknown IANA zones and returns 'UTC' rather
      // than throwing — better UX for old browsers / weird locales. The RPC
      // still gets called with p_tz='UTC'.
      const { svc, rpc } = makeService();
      const result = await withTenant(() =>
        svc.getBookingsOverview({
          from: '2026-04-01', to: '2026-04-30', buildingId: null, tz: 'Mars/Olympus',
        }),
      );
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith('room_booking_report_overview', {
        p_tenant_id: 'tenant-1',
        p_from: '2026-04-01',
        p_to: '2026-04-30',
        p_building_id: null,
        p_tz: 'UTC',
      });
      expect(result).toEqual({ rows: [] });
    });

    it('passes tenant + params through to the RPC and returns its data', async () => {
      const expected = { kpis: { total_bookings: 42 } };
      const rpc = jest.fn().mockResolvedValue({ data: expected, error: null });
      const { svc } = makeService(rpc);
      const result = await withTenant(() =>
        svc.getBookingsOverview({
          from: '2026-04-01', to: '2026-04-30', buildingId: 'b-1', tz: 'America/New_York',
        }),
      );
      expect(rpc).toHaveBeenCalledWith('room_booking_report_overview', {
        p_tenant_id: 'tenant-1',
        p_from: '2026-04-01',
        p_to: '2026-04-30',
        p_building_id: 'b-1',
        p_tz: 'America/New_York',
      });
      expect(result).toEqual(expected);
    });

    it('surfaces RPC errors as BadRequestException with the underlying message', async () => {
      const rpc = jest.fn().mockResolvedValue({ data: null, error: { message: 'window too large (> 365 days)' } });
      const { svc } = makeService(rpc);
      await expect(
        withTenant(() =>
          svc.getBookingsOverview({
            from: '2026-04-01', to: '2026-04-30', buildingId: null, tz: 'UTC',
          }),
        ),
      ).rejects.toMatchObject({
        message: 'window too large (> 365 days)',
      });
    });
  });

  describe.each([
    ['getBookingsUtilization', 'room_booking_utilization_report'],
    ['getBookingsNoShows',     'room_booking_no_shows_report'],
    ['getBookingsServices',    'room_booking_services_report'],
    ['getBookingsDemand',      'room_booking_demand_report'],
  ] as const)('%s', (method, rpcName) => {
    it(`calls ${rpcName} with the same window/tenant contract as overview`, async () => {
      const expected = { ok: true };
      const rpc = jest.fn().mockResolvedValue({ data: expected, error: null });
      const { svc } = makeService(rpc);
      const result = await withTenant(() =>
        (svc as any)[method]({
          from: '2026-04-01', to: '2026-04-30', buildingId: 'b-1', tz: 'Europe/Amsterdam',
        }),
      );
      expect(rpc).toHaveBeenCalledWith(rpcName, {
        p_tenant_id: 'tenant-1',
        p_from: '2026-04-01',
        p_to: '2026-04-30',
        p_building_id: 'b-1',
        p_tz: 'Europe/Amsterdam',
      });
      expect(result).toEqual(expected);
    });

    it(`rejects an inverted window for ${method} before reaching the RPC`, async () => {
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
