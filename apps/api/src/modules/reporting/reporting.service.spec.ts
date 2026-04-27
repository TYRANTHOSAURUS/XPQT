import { BadRequestException } from '@nestjs/common';
import { ReportingService } from './reporting.service';
import { TenantContext } from '../../common/tenant-context';

describe('ReportingService.getBookingsOverview', () => {
  const makeService = (rpcImpl: jest.Mock) => {
    const supabase = { admin: { rpc: rpcImpl } } as any;
    return new ReportingService(supabase);
  };

  const withTenant = <T>(fn: () => Promise<T>) =>
    TenantContext.run({ id: 'tenant-1', slug: 'acme', tier: 'standard' }, fn);

  it('rejects an inverted date window', async () => {
    const rpc = jest.fn();
    const svc = makeService(rpc);
    await expect(
      withTenant(() => svc.getBookingsOverview({
        from: '2026-04-30', to: '2026-04-01', buildingId: null, tz: 'UTC',
      })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects a window > 365 days', async () => {
    const rpc = jest.fn();
    const svc = makeService(rpc);
    await expect(
      withTenant(() => svc.getBookingsOverview({
        from: '2024-01-01', to: '2026-01-01', buildingId: null, tz: 'UTC',
      })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects malformed date inputs', async () => {
    const svc = makeService(jest.fn());
    await expect(
      withTenant(() => svc.getBookingsOverview({
        from: '04/01/2026', to: '04/30/2026', buildingId: null, tz: 'UTC',
      })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('falls back to UTC when timezone is unknown', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: { kpis: {} }, error: null });
    const svc = makeService(rpc);
    await withTenant(() => svc.getBookingsOverview({
      from: '2026-04-01', to: '2026-04-30', buildingId: null, tz: 'Mars/Olympus',
    }));
    expect(rpc).toHaveBeenCalledWith('room_booking_report_overview', expect.objectContaining({
      p_tz: 'UTC',
    }));
  });

  it('passes tenant + params through to the RPC and returns its data', async () => {
    const payload = { kpis: { total_bookings: 42 } };
    const rpc = jest.fn().mockResolvedValue({ data: payload, error: null });
    const svc = makeService(rpc);
    const result = await withTenant(() => svc.getBookingsOverview({
      from: '2026-04-01', to: '2026-04-30', buildingId: 'b-1', tz: 'America/New_York',
    }));
    expect(rpc).toHaveBeenCalledWith('room_booking_report_overview', {
      p_tenant_id: 'tenant-1',
      p_from: '2026-04-01',
      p_to: '2026-04-30',
      p_building_id: 'b-1',
      p_tz: 'America/New_York',
    });
    expect(result).toBe(payload);
  });

  it('surfaces RPC errors as bad requests', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: { message: 'window too large' } });
    const svc = makeService(rpc);
    await expect(
      withTenant(() => svc.getBookingsOverview({
        from: '2026-04-01', to: '2026-04-30', buildingId: null, tz: 'UTC',
      })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
