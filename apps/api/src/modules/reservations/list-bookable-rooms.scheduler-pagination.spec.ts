import { ListBookableRoomsService } from './list-bookable-rooms.service';
import { TenantContext } from '../../common/tenant-context';
import type { ActorContext } from './dto/types';

// B.3.1 — pagination shape on scheduler_data RPC.
//
// Pre-fix (00286_scheduler_data_drop_legacy_keys.sql:65, 156, 217):
// the RPC ran `jsonb_agg(...) limit 2000` which is a no-op against a
// single-row aggregate scalar. The aggregator scanned every matching
// slot regardless of count. This spec exercises the 00296 contract: the
// RPC now returns rooms_total / rooms_truncated / reservations_total /
// reservations_truncated / reservations_next_cursor, and the TS layer
// forwards them onto loadSchedulerData()'s return shape.

describe('ListBookableRoomsService.loadSchedulerData — 00296 pagination meta', () => {
  const TENANT = { id: 'T', slug: 't', tier: 'standard' as const };

  function makeRpcResult(opts: {
    roomCount: number;
    reservationCount: number;
    roomsTotal?: number;
    reservationsTotal?: number;
    roomsTruncated?: boolean;
    reservationsTruncated?: boolean;
    reservationsNextCursor?: string | null;
  }) {
    const rooms = Array.from({ length: opts.roomCount }, (_, i) => ({
      space_id: `space-${i}`,
      name: `Room ${i}`,
      space_type: 'meeting_room',
      image_url: null,
      capacity: 4,
      min_attendees: null,
      amenities: [],
      keywords: [],
      parent_chain: [],
    }));
    const reservations = Array.from({ length: opts.reservationCount }, (_, i) => ({
      id: `booking-${i}`,
      tenant_id: TENANT.id,
      slot_id: `slot-${i}`,
      reservation_type: 'room',
      space_id: `space-${i % Math.max(opts.roomCount, 1)}`,
      start_at: `2026-06-01T${String(i % 24).padStart(2, '0')}:00:00Z`,
      end_at: `2026-06-01T${String((i + 1) % 24).padStart(2, '0')}:00:00Z`,
      status: 'confirmed',
    }));
    return {
      rooms,
      reservations,
      rooms_total: opts.roomsTotal ?? opts.roomCount,
      rooms_truncated: opts.roomsTruncated ?? false,
      reservations_total: opts.reservationsTotal ?? opts.reservationCount,
      reservations_truncated: opts.reservationsTruncated ?? false,
      reservations_next_cursor: opts.reservationsNextCursor ?? null,
    };
  }

  function buildService(rpcImpl: jest.Mock) {
    const supabase = { admin: {} };
    const db = { rpc: rpcImpl };
    const ruleResolver = { resolveBulk: jest.fn() };
    const ranking = { score: jest.fn() };
    return new ListBookableRoomsService(
      supabase as never,
      db as never,
      ruleResolver as never,
      ranking as never,
    );
  }

  const actor: ActorContext = {
    user_id: 'U',
    person_id: 'P',
    tenant_id: TENANT.id,
    is_service_desk: true,
  } as never;

  it('forwards pagination meta when the RPC reports a small result set (no truncation)', async () => {
    const rpc = jest.fn(async () =>
      makeRpcResult({ roomCount: 3, reservationCount: 12 }),
    );
    const svc = buildService(rpc);
    const result = await TenantContext.run(TENANT, () =>
      svc.loadSchedulerData(
        { start_at: '2026-06-01T00:00:00Z', end_at: '2026-06-02T00:00:00Z' },
        actor,
      ),
    );
    expect(result.rooms_total).toBe(3);
    expect(result.rooms_truncated).toBe(false);
    expect(result.reservations_total).toBe(12);
    expect(result.reservations_truncated).toBe(false);
    expect(result.reservations_next_cursor).toBe(null);
    expect(result.reservations).toHaveLength(12);
    expect(result.rooms).toHaveLength(3);
  });

  it('surfaces truncation flags + next_cursor when the RPC bounds the result set', async () => {
    // Contrived large fixture: 1000 slots in window, RPC bounded at 200.
    // The test verifies (a) the bounded slice is what's returned, and
    // (b) the meta tells the UI the bound was hit (for the truncation
    // banner) without us simulating the 1000-row scan in TS.
    const BOUNDED = 200;
    const TRUE_TOTAL = 1000;
    const rpc = jest.fn(async () =>
      makeRpcResult({
        roomCount: 50,
        reservationCount: BOUNDED,
        reservationsTotal: TRUE_TOTAL,
        reservationsTruncated: true,
        reservationsNextCursor: '2026-06-01T08:00:00.000Z__slot-199',
      }),
    );
    const svc = buildService(rpc);
    const result = await TenantContext.run(TENANT, () =>
      svc.loadSchedulerData(
        {
          start_at: '2026-06-01T00:00:00Z',
          end_at: '2026-06-02T00:00:00Z',
          reservation_limit: BOUNDED,
        },
        actor,
      ),
    );
    expect(result.reservations).toHaveLength(BOUNDED);
    expect(result.reservations_total).toBe(TRUE_TOTAL);
    expect(result.reservations_truncated).toBe(true);
    expect(result.reservations_next_cursor).toBe(
      '2026-06-01T08:00:00.000Z__slot-199',
    );

    // Confirm the new params reach the RPC layer with the right names —
    // the function signature change in 00296 added p_search,
    // p_reservation_limit, p_room_limit. The TS caller MUST pass these
    // by name (positional would land on the wrong param when defaults
    // are skipped).
    const call = rpc.mock.calls[0];
    expect(call[0]).toBe('scheduler_data');
    const args = call[1] as Record<string, unknown>;
    expect(args.p_reservation_limit).toBe(BOUNDED);
    expect(args.p_room_limit).toBe(200);
    expect(args.p_search).toBeNull();
  });

  it('passes the trimmed search term to the RPC and drops empty strings', async () => {
    const rpc = jest.fn(async () =>
      makeRpcResult({ roomCount: 1, reservationCount: 0 }),
    );
    const svc = buildService(rpc);
    await TenantContext.run(TENANT, () =>
      svc.loadSchedulerData(
        {
          start_at: '2026-06-01T00:00:00Z',
          end_at: '2026-06-02T00:00:00Z',
          search: '   Boardroom 12  ',
        },
        actor,
      ),
    );
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_search).toBe('Boardroom 12');

    // Empty/whitespace search — null on the wire so the SQL function
    // skips the LIKE filter entirely.
    rpc.mockClear();
    await TenantContext.run(TENANT, () =>
      svc.loadSchedulerData(
        {
          start_at: '2026-06-01T00:00:00Z',
          end_at: '2026-06-02T00:00:00Z',
          search: '   ',
        },
        actor,
      ),
    );
    const args2 = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args2.p_search).toBeNull();
  });
});
