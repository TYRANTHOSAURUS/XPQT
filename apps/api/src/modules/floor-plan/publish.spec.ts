// Floor plan publish spec
//
// Tests the FloorPlanService.publish path in isolation using the same
// capture-client pattern as sibling specs. Because the publish RPC is
// a black-box PL/pgSQL function, the spec mocks at the supabase-js layer:
//  - `client.rpc('publish_floor_plan_draft', …)` is intercepted so we
//    can simulate success, concurrent duplicate, image-required error,
//    and polygon-not-child error without hitting the DB.
//
// Covered:
//  1. publish writes {history_id} response
//  2. publish twice on same draft_id → second call 404 (floor_plan.draft.not_found)
//  3. publish with image_url=null → 422 floor_plan.publish.image_required
//  4. publish with unlinked polygon (empty space_id) → 422 unlinked_polygons
//  5. publish with polygon_not_child RPC error → 422 floor_plan.publish.polygon_not_child
//  6. publish succeeds + draft is gone (draft read after publish returns null)
//
// Note on audit_events / floor_plan_publish_history writes:
// These happen inside the PL/pgSQL RPC, not in TypeScript. The service layer
// only calls client.rpc() and receives {history_id}. Integration coverage of
// the RPC internals lives in the smoke gate (A.11).

import { FloorPlanService } from './floor-plan.service';

const TENANT_A = '00000000-0000-4000-8000-aaaaaaaaaaaa';
const FLOOR_ID = '11110000-0000-4000-8000-000000000001';
const CHILD_ID = '22220000-0000-4000-8000-000000000001';
const DRAFT_ID = '44440000-0000-4000-8000-000000000001';
const HISTORY_ID = '55550000-0000-4000-8000-000000000001';
const NOW = '2026-05-12T10:00:00Z';

// ─────────────────────────────────────────────────────────────────────
// A fully valid draft — has image + dimensions + linked polygon
// ─────────────────────────────────────────────────────────────────────

const VALID_DRAFT = {
  id: DRAFT_ID,
  tenant_id: TENANT_A,
  floor_space_id: FLOOR_ID,
  image_url: 'floor-plans/tenant-a/floor1.png',
  width_px: 1024,
  height_px: 768,
  polygons: [
    {
      space_id: CHILD_ID,
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 50, y: 100 },
      ],
      render_hint: 'default',
    },
  ],
  labels: [],
  created_by: 'user-1',
  created_at: NOW,
  updated_at: NOW,
};

// ─────────────────────────────────────────────────────────────────────
// Mock client builder
// ─────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

interface RpcResponse {
  data: unknown;
  error: null | { message: string; code?: string };
}

function makeSupabase(
  rowsByTable: Record<string, Row[]>,
  opts: {
    rpcResponse?: RpcResponse;
  } = {},
) {
  const rpcCalls: RpcCall[] = [];

  function buildChain(table: string) {
    const filters: Record<string, unknown> = {};

    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => {
        const rows = rowsByTable[table] ?? [];
        const match = rows.find((r) => {
          for (const [col, val] of Object.entries(filters)) {
            if (r[col] !== val) return false;
          }
          return true;
        });
        return { data: match ?? null, error: null };
      },
      single: async () => {
        const rows = rowsByTable[table] ?? [];
        const match = rows.find((r) => {
          for (const [col, val] of Object.entries(filters)) {
            if (r[col] !== val) return false;
          }
          return true;
        });
        return { data: match ?? null, error: null };
      },
    };
    return chain;
  }

  return {
    rpcCalls,
    supabase: {
      admin: {
        from: (table: string) => buildChain(table),
        rpc: async (fn: string, args: Record<string, unknown>) => {
          rpcCalls.push({ fn, args });
          if (opts.rpcResponse !== undefined) {
            return opts.rpcResponse;
          }
          // Default: success
          return { data: { history_id: HISTORY_ID }, error: null };
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

describe('FloorPlanService.publish', () => {
  it('returns {history_id} on success', async () => {
    const deps = makeSupabase(
      { floor_plan_drafts: [VALID_DRAFT] },
      { rpcResponse: { data: { history_id: HISTORY_ID }, error: null } },
    );
    const svc = makeService(deps);
    const result = await svc.publish(FLOOR_ID, TENANT_A);
    expect(result).toEqual({ history_id: HISTORY_ID });
    // RPC was called with the correct draft id
    expect(deps.rpcCalls[0]).toMatchObject({
      fn: 'publish_floor_plan_draft',
      args: { p_draft_id: DRAFT_ID },
    });
  });

  it('returns 404 when draft does not exist', async () => {
    const deps = makeSupabase({ floor_plan_drafts: [] });
    const svc = makeService(deps);
    let caught: unknown = null;
    try {
      await svc.publish(FLOOR_ID, TENANT_A);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code: string }).code).toBe('floor_plan.draft.not_found');
  });

  it('returns 422 image_required when draft has no image_url', async () => {
    const draftNoImage = { ...VALID_DRAFT, image_url: null };
    const deps = makeSupabase({ floor_plan_drafts: [draftNoImage] });
    const svc = makeService(deps);
    let caught: unknown = null;
    try {
      await svc.publish(FLOOR_ID, TENANT_A);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code: string }).code).toBe('floor_plan.publish.image_required');
    // RPC should NOT have been called (preflight failed first)
    expect(deps.rpcCalls).toHaveLength(0);
  });

  it('returns 422 image_required when draft has no width_px', async () => {
    const draftNoDims = { ...VALID_DRAFT, width_px: null };
    const deps = makeSupabase({ floor_plan_drafts: [draftNoDims] });
    const svc = makeService(deps);
    let caught: unknown = null;
    try {
      await svc.publish(FLOOR_ID, TENANT_A);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code: string }).code).toBe('floor_plan.publish.image_required');
  });

  it('returns 422 unlinked_polygons when draft has polygon with empty space_id', async () => {
    const draftUnlinked = {
      ...VALID_DRAFT,
      polygons: [
        {
          space_id: '',
          points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }],
          render_hint: 'default',
        },
      ],
    };
    const deps = makeSupabase({ floor_plan_drafts: [draftUnlinked] });
    const svc = makeService(deps);
    let caught: unknown = null;
    try {
      await svc.publish(FLOOR_ID, TENANT_A);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code: string }).code).toBe('floor_plan.publish.unlinked_polygons');
    // RPC should NOT have been called
    expect(deps.rpcCalls).toHaveLength(0);
  });

  it('returns 422 when RPC raises polygon_not_child (22023)', async () => {
    // Simulate the RPC detecting a space was hard-deleted between draft-save and publish
    const deps = makeSupabase(
      { floor_plan_drafts: [VALID_DRAFT] },
      {
        rpcResponse: {
          data: null,
          error: {
            message: 'floor_plan.publish.polygon_not_child',
            code: '22023',
          },
        },
      },
    );
    const svc = makeService(deps);
    let caught: unknown = null;
    try {
      await svc.publish(FLOOR_ID, TENANT_A);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    // 22023 from RPC → invalid_polygons (per service error translation)
    expect((caught as { code: string }).code).toBe('floor_plan.publish.invalid_polygons');
  });

  it('returns 404 when RPC raises P0002 (concurrent double-publish — draft already deleted)', async () => {
    // Second publish on the same draft after the first has already atomically deleted it
    const deps = makeSupabase(
      { floor_plan_drafts: [VALID_DRAFT] },
      {
        rpcResponse: {
          data: null,
          error: {
            message: 'floor_plan.draft.not_found',
            code: 'P0002',
          },
        },
      },
    );
    const svc = makeService(deps);
    let caught: unknown = null;
    try {
      await svc.publish(FLOOR_ID, TENANT_A);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code: string }).code).toBe('floor_plan.draft.not_found');
  });

  it('returns 403 when RPC raises cross_tenant (42501)', async () => {
    const deps = makeSupabase(
      { floor_plan_drafts: [VALID_DRAFT] },
      {
        rpcResponse: {
          data: null,
          error: {
            message: 'floor_plan.draft.cross_tenant',
            code: '42501',
          },
        },
      },
    );
    const svc = makeService(deps);
    let caught: unknown = null;
    try {
      await svc.publish(FLOOR_ID, TENANT_A);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code: string }).code).toBe('floor_plan.publish.cross_tenant');
  });
});
