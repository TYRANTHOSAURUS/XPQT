/**
 * Tests for BundleService.editLine — the booking-detail "edit a service
 * line" path. Covers the post-codex hardening:
 *   - requester_notes is read + written (the field added to replace the
 *     overloaded dietary_notes for non-catering notes)
 *   - empty-string requester_notes normalizes to null
 *   - expected_updated_at CAS rejects stale-browser writes
 *   - frozen statuses still reject
 *   - no-op patches return current state without UPDATE
 *
 * The mock surface is intentionally minimal — just the chain methods the
 * editLine code path actually calls. Other BundleService methods are
 * untouched.
 */

import { BundleService } from './bundle.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT = '11111111-1111-4111-8111-111111111111';
const LINE_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TS_OLD = '2026-04-30T10:00:00.000Z';
const TS_NEW = '2026-04-30T10:05:00.000Z';

type LineRow = {
  id: string;
  tenant_id: string;
  order_id: string;
  quantity: number;
  unit_price: number | null;
  line_total: number | null;
  service_window_start_at: string | null;
  service_window_end_at: string | null;
  requester_notes: string | null;
  updated_at: string;
  fulfillment_status: string;
  linked_ticket_id: string | null;
};

function row(overrides: Partial<LineRow> = {}): LineRow {
  return {
    id: LINE_ID,
    tenant_id: TENANT,
    order_id: 'order-1',
    quantity: 5,
    unit_price: 10,
    line_total: 50,
    service_window_start_at: null,
    service_window_end_at: null,
    requester_notes: null,
    updated_at: TS_OLD,
    fulfillment_status: 'ordered',
    linked_ticket_id: null,
    ...overrides,
  };
}

interface UpdateRecord {
  patch: Record<string, unknown>;
  filters: Array<{ kind: 'eq'; col: string; val: unknown }>;
}

function makeService(opts: {
  loaded: LineRow | null;
  /** When set, the UPDATE returns this row (post-write). When null,
   *  simulates a 0-row CAS-rejected write. */
  updated: LineRow | null;
}) {
  const updates: UpdateRecord[] = [];

  // Build a chain that records `eq()` calls and ends in `select().maybeSingle()`.
  const buildUpdateChain = (patch: Record<string, unknown>) => {
    const filters: UpdateRecord['filters'] = [];
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    chain.eq = (col: string, val: unknown) => {
      filters.push({ kind: 'eq', col, val });
      return chain;
    };
    chain.select = () => ({
      maybeSingle: () => {
        updates.push({ patch, filters });
        return Promise.resolve({ data: opts.updated, error: null });
      },
    });
    return chain;
  };

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'order_line_items') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: opts.loaded, error: null }),
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => buildUpdateChain(patch),
          };
        }
        if (table === 'tickets') {
          // Window-shift cascade lookup — empty array bypasses it.
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    in: () => Promise.resolve({ data: [], error: null }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'audit_events') {
          // best-effort audit insert — ignore.
          return {
            insert: () => Promise.resolve({ data: null, error: null }),
          };
        }
        throw new Error(`unexpected table in editLine test: ${table}`);
      }),
    },
  };

  const svc = new BundleService(
    supabase as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, updates };
}

describe('BundleService.editLine', () => {
  beforeEach(() => {
    TenantContext.run({ id: TENANT, slug: 'test', tier: 'standard' }, () => {
      // sentinel — actual usage wraps the call in TenantContext.run below.
    });
  });

  it('persists requester_notes (trim + non-empty)', async () => {
    const { svc, updates } = makeService({
      loaded: row({ requester_notes: null }),
      updated: row({ requester_notes: 'No nuts please' }),
    });

    const result = await TenantContext.run(
      { id: TENANT, slug: 'test', tier: 'standard' },
      () =>
        svc.editLine({
          line_id: LINE_ID,
          patch: { requester_notes: '  No nuts please  ' },
        }),
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toEqual({ requester_notes: 'No nuts please' });
    expect(result.requester_notes).toBe('No nuts please');
  });

  it('normalizes empty / whitespace-only requester_notes to null', async () => {
    const { svc, updates } = makeService({
      loaded: row({ requester_notes: 'something' }),
      updated: row({ requester_notes: null }),
    });

    await TenantContext.run({ id: TENANT, slug: 'test', tier: 'standard' }, () =>
      svc.editLine({
        line_id: LINE_ID,
        patch: { requester_notes: '   ' },
      }),
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toEqual({ requester_notes: null });
  });

  it('rejects stale-browser write when expected_updated_at mismatches', async () => {
    const { svc, updates } = makeService({
      loaded: row({ updated_at: TS_NEW }),
      updated: row(),
    });

    await expect(
      TenantContext.run({ id: TENANT, slug: 'test', tier: 'standard' }, () =>
        svc.editLine({
          line_id: LINE_ID,
          patch: { requester_notes: 'late' },
          expected_updated_at: TS_OLD,
        }),
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'line_state_changed' }),
    });
    // CAS guard fires before the UPDATE runs.
    expect(updates).toHaveLength(0);
  });

  it('passes expected_updated_at through to the UPDATE filter when matching', async () => {
    const { svc, updates } = makeService({
      loaded: row({ updated_at: TS_OLD }),
      updated: row({ requester_notes: 'ok', updated_at: TS_NEW }),
    });

    await TenantContext.run({ id: TENANT, slug: 'test', tier: 'standard' }, () =>
      svc.editLine({
        line_id: LINE_ID,
        patch: { requester_notes: 'ok' },
        expected_updated_at: TS_OLD,
      }),
    );

    expect(updates).toHaveLength(1);
    const cols = updates[0].filters.map((f) => f.col);
    expect(cols).toContain('updated_at');
    const updatedAtFilter = updates[0].filters.find((f) => f.col === 'updated_at');
    expect(updatedAtFilter?.val).toBe(TS_OLD);
  });

  it.each(['preparing', 'delivered', 'cancelled'])(
    'refuses to edit a frozen line in %s state',
    async (status) => {
      const { svc, updates } = makeService({
        loaded: row({ fulfillment_status: status }),
        updated: row(),
      });

      await expect(
        TenantContext.run({ id: TENANT, slug: 'test', tier: 'standard' }, () =>
          svc.editLine({
            line_id: LINE_ID,
            patch: { requester_notes: 'too late' },
          }),
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'line_frozen' }),
      });
      expect(updates).toHaveLength(0);
    },
  );

  it('returns current state without UPDATE when patch is a no-op', async () => {
    const current = row({
      requester_notes: 'same',
      quantity: 5,
      service_window_start_at: '2026-05-01T10:00:00.000Z',
      service_window_end_at: '2026-05-01T11:00:00.000Z',
    });
    const { svc, updates } = makeService({ loaded: current, updated: current });

    const result = await TenantContext.run(
      { id: TENANT, slug: 'test', tier: 'standard' },
      () =>
        svc.editLine({
          line_id: LINE_ID,
          patch: {
            requester_notes: 'same',
            quantity: 5,
            service_window_start_at: '2026-05-01T10:00:00.000Z',
            service_window_end_at: '2026-05-01T11:00:00.000Z',
          },
        }),
    );

    expect(updates).toHaveLength(0);
    expect(result).toEqual({
      line_id: current.id,
      quantity: current.quantity,
      line_total: current.line_total,
      service_window_start_at: current.service_window_start_at,
      service_window_end_at: current.service_window_end_at,
      requester_notes: current.requester_notes,
      updated_at: current.updated_at,
    });
  });
});
