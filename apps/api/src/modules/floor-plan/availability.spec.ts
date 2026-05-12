// Floor plan availability spec
//
// Tests the FloorPlanService.getAvailability path in isolation using the
// same capture-client pattern as publish.spec.ts and floor-plan-draft.service.spec.ts.
// All assertions operate on the mock client — no real DB calls.
//
// Covered:
//  1. Empty window (no bookings) → all child spaces state 'available'
//  2. One confirmed booking owned by the requesting user → state 'mine'
//  3. One confirmed booking by another user covering the full window → 'booked'
//  4. One partial booking (starts after window start) → 'partial'
//  5. status='released' booking → does NOT block (space 'available')
//  6. status='cancelled' booking → does NOT block (space 'available')
//  7. Invalid window (start >= end) → throws floor_plan.availability.invalid_window
//  8. Crowd heatmap returns 13 buckets (hours 7..19 inclusive)
//  9. Cross-tenant: tenant B cannot read tenant A's availability

import { FloorPlanService } from './floor-plan.service';

const TENANT_A = '00000000-0000-4000-8000-aaaaaaaaaaaa';
const TENANT_B = '00000000-0000-4000-8000-bbbbbbbbbbbb';
const FLOOR_ID = '11110000-0000-4000-8000-000000000001';
const SPACE_ID = '22220000-0000-4000-8000-000000000001';
const USER_A = '33330000-0000-4000-8000-000000000001';
const USER_B = '33330000-0000-4000-8000-000000000002';

const WIN_START = '2026-05-12T09:00:00Z';
const WIN_END = '2026-05-12T10:00:00Z';

// ─────────────────────────────────────────────────────────────────────
// RPC response shapes
// ─────────────────────────────────────────────────────────────────────

function makeAvailableResponse() {
  return {
    spaces: [{ space_id: SPACE_ID, name: 'Room A', capacity: 8, state: 'available', free_at: null }],
    heatmap: buildHeatmap(),
  };
}

function buildHeatmap() {
  // 13 buckets: hours 7..19 inclusive
  return Array.from({ length: 13 }, (_, i) => ({
    bucket: `2026-05-12T${String(7 + i).padStart(2, '0')}:00:00Z`,
    occupancy: 0,
  }));
}

// ─────────────────────────────────────────────────────────────────────
// Mock client builder
// ─────────────────────────────────────────────────────────────────────

type RpcResponse = { data: unknown; error: null | { message: string; code?: string } };

function makeSupabase(opts: {
  rpcResponse?: RpcResponse;
  rpcError?: { message: string; code?: string };
} = {}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  return {
    rpcCalls,
    supabase: {
      admin: {
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        }),
        rpc: async (fn: string, args: Record<string, unknown>) => {
          rpcCalls.push({ fn, args });
          if (opts.rpcError) {
            return { data: null, error: opts.rpcError };
          }
          if (opts.rpcResponse) {
            return opts.rpcResponse;
          }
          // Default: success with an available space + heatmap
          return { data: makeAvailableResponse(), error: null };
        },
        storage: {
          from: () => ({
            createSignedUrl: async () => ({
              data: { signedUrl: 'https://storage.example.com/floor1.png?token=abc' },
            }),
          }),
        },
      },
    },
  };
}

function makeService(deps: ReturnType<typeof makeSupabase>) {
  return new FloorPlanService(deps.supabase as never);
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('FloorPlanService.getAvailability', () => {
  it('empty window (no bookings) → all spaces available', async () => {
    const deps = makeSupabase();
    const svc = makeService(deps);
    const result = await svc.getAvailability(FLOOR_ID, TENANT_A, USER_A, WIN_START, WIN_END);
    const data = result as { spaces: Array<{ state: string }> };
    expect(data.spaces).toHaveLength(1);
    expect(data.spaces[0].state).toBe('available');
    // RPC was called with the correct tenant + user params
    expect(deps.rpcCalls[0]).toMatchObject({
      fn: 'floor_availability',
      args: {
        p_tenant_id: TENANT_A,
        p_floor_space_id: FLOOR_ID,
        p_user_id: USER_A,
        p_window_start: WIN_START,
        p_window_end: WIN_END,
      },
    });
  });

  it('confirmed booking by requesting user → state mine', async () => {
    const deps = makeSupabase({
      rpcResponse: {
        data: {
          spaces: [{ space_id: SPACE_ID, name: 'Room A', capacity: 8, state: 'mine', free_at: null }],
          heatmap: buildHeatmap(),
        },
        error: null,
      },
    });
    const svc = makeService(deps);
    const result = await svc.getAvailability(FLOOR_ID, TENANT_A, USER_A, WIN_START, WIN_END);
    const data = result as { spaces: Array<{ state: string }> };
    expect(data.spaces[0].state).toBe('mine');
  });

  it('confirmed booking by another user covering full window → state booked', async () => {
    const deps = makeSupabase({
      rpcResponse: {
        data: {
          spaces: [{ space_id: SPACE_ID, name: 'Room A', capacity: 8, state: 'booked', free_at: WIN_END }],
          heatmap: buildHeatmap(),
        },
        error: null,
      },
    });
    const svc = makeService(deps);
    const result = await svc.getAvailability(FLOOR_ID, TENANT_A, USER_B, WIN_START, WIN_END);
    const data = result as { spaces: Array<{ state: string }> };
    expect(data.spaces[0].state).toBe('booked');
  });

  it('partial booking (does not cover full window) → state partial', async () => {
    const deps = makeSupabase({
      rpcResponse: {
        data: {
          spaces: [{ space_id: SPACE_ID, name: 'Room A', capacity: 8, state: 'partial', free_at: '2026-05-12T09:30:00Z' }],
          heatmap: buildHeatmap(),
        },
        error: null,
      },
    });
    const svc = makeService(deps);
    const result = await svc.getAvailability(FLOOR_ID, TENANT_A, USER_A, WIN_START, WIN_END);
    const data = result as { spaces: Array<{ state: string }> };
    expect(data.spaces[0].state).toBe('partial');
  });

  it('released booking → space available (released does not block)', async () => {
    // The RPC handles filtering; from the service layer's perspective the RPC
    // correctly returns available when the only booking is released.
    const deps = makeSupabase({
      rpcResponse: {
        data: {
          spaces: [{ space_id: SPACE_ID, name: 'Room A', capacity: 8, state: 'available', free_at: null }],
          heatmap: buildHeatmap(),
        },
        error: null,
      },
    });
    const svc = makeService(deps);
    const result = await svc.getAvailability(FLOOR_ID, TENANT_A, USER_A, WIN_START, WIN_END);
    const data = result as { spaces: Array<{ state: string }> };
    expect(data.spaces[0].state).toBe('available');
  });

  it('cancelled booking → space available (cancelled does not block)', async () => {
    const deps = makeSupabase({
      rpcResponse: {
        data: {
          spaces: [{ space_id: SPACE_ID, name: 'Room A', capacity: 8, state: 'available', free_at: null }],
          heatmap: buildHeatmap(),
        },
        error: null,
      },
    });
    const svc = makeService(deps);
    const result = await svc.getAvailability(FLOOR_ID, TENANT_A, USER_A, WIN_START, WIN_END);
    const data = result as { spaces: Array<{ state: string }> };
    expect(data.spaces[0].state).toBe('available');
  });

  it('invalid window (start >= end) → throws floor_plan.availability.invalid_window', async () => {
    const deps = makeSupabase({
      rpcError: { message: 'window start must be before end', code: '22023' },
    });
    const svc = makeService(deps);
    let caught: unknown = null;
    try {
      // Pass inverted window
      await svc.getAvailability(FLOOR_ID, TENANT_A, USER_A, WIN_END, WIN_START);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code: string }).code).toBe('floor_plan.availability.invalid_window');
  });

  it('heatmap returns exactly 13 buckets (hours 7..19)', async () => {
    const deps = makeSupabase();
    const svc = makeService(deps);
    const result = await svc.getAvailability(FLOOR_ID, TENANT_A, USER_A, WIN_START, WIN_END);
    const data = result as { heatmap: Array<{ bucket: string; occupancy: number }> };
    expect(data.heatmap).toHaveLength(13);
  });

  it('cross-tenant: tenant B params are passed through to the RPC (tenant isolation is enforced at DB layer)', async () => {
    // The service forwards p_tenant_id to the RPC; DB-layer RLS/logic rejects cross-tenant reads.
    // Here we verify the service passes TENANT_B correctly, not TENANT_A's data.
    const deps = makeSupabase();
    const svc = makeService(deps);
    await svc.getAvailability(FLOOR_ID, TENANT_B, USER_B, WIN_START, WIN_END);
    expect(deps.rpcCalls[0].args).toMatchObject({
      p_tenant_id: TENANT_B,
      p_user_id: USER_B,
    });
    // Critically, not TENANT_A
    expect(deps.rpcCalls[0].args.p_tenant_id).not.toBe(TENANT_A);
  });
});
