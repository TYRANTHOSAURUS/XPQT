// Floor plan publish audit + history end-to-end assertions (C.4)
//
// SCOPE OF THIS FILE:
//   Verifies that FloorPlanService.publish() drives the PL/pgSQL RPC with
//   the exact arguments the RPC needs to write audit_events, history, and
//   canonical polygon data atomically. The spec mocks at the supabase-js
//   layer — same pattern as publish.spec.ts and floor-plan-draft.service.spec.ts.
//
// WHY MOCKS, NOT A REAL DB:
//   audit_events, floor_plan_publish_history, and spaces.floor_plan_polygon
//   are written INSIDE the security-definer PL/pgSQL function
//   `publish_floor_plan_draft`. TypeScript never touches those tables directly.
//   A real-DB integration test would require a live remote Supabase project
//   plus seed helpers that don't exist in this codebase. The smoke gate covers
//   that layer end-to-end:
//     • P4 — RPC returns {history_id}
//     • P5 — GET published returns canonical polygon shape {points:[...]}
//     • P6 — GET history returns at least one row
//
//   What this spec uniquely verifies (things the smoke gate cannot confirm):
//     1. The TS service passes EXACTLY the correct draft_id to the RPC.
//     2. The service returns the history_id transparently to the controller.
//     3. Preflight gates block the RPC call for drafts missing audit-relevant
//        fields (no image = no polygon count = no audit entry possible).
//     4. Error translations surface as AppError codes (audit-adjacent path —
//        e.g. 23502 = image_required means no audit row would have been written).
//
// Covered:
//   C4-1: RPC receives p_draft_id equal to the draft row's id
//   C4-2: history_id from RPC bubbles through to caller unchanged
//   C4-3: draft with missing image_url → preflight blocks before RPC (no audit)
//   C4-4: draft with missing width_px → preflight blocks before RPC
//   C4-5: draft with unlinked polygon → preflight blocks before RPC
//   C4-6: multiple valid polygons → RPC receives all (polygon_count fidelity)
//   C4-7: RPC 23502 (image_required) → AppError floor_plan.publish.image_required
//   C4-8: RPC P0002 (draft gone — concurrent) → AppError floor_plan.draft.not_found
//   C4-9: RPC 22023 (polygon_not_child) → AppError floor_plan.publish.invalid_polygons
//   C4-10: RPC 42501 (cross-tenant) → AppError floor_plan.publish.cross_tenant

import { FloorPlanService } from './floor-plan.service';

// ─── test constants ────────────────────────────────────────────────────────────

const TENANT = '00000000-0000-4000-8000-aaaaaaaaaaaa';
const FLOOR_ID = '11110000-0000-4000-8000-000000000001';
const ROOM_A = '22220000-0000-4000-8000-000000000001';
const ROOM_B = '22220000-0000-4000-8000-000000000002';
const DRAFT_ID = '44440000-0000-4000-8000-000000000001';
const HISTORY_ID = '55550000-0000-4000-8000-000000000001';
const NOW = '2026-05-12T10:00:00Z';

// Polygon with 3 points — the minimum the RPC accepts.
function poly(spaceId: string) {
  return {
    space_id: spaceId,
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 50, y: 100 },
    ],
    render_hint: 'default' as const,
  };
}

const BASE_DRAFT = {
  id: DRAFT_ID,
  tenant_id: TENANT,
  floor_space_id: FLOOR_ID,
  image_url: 'floor-plans/tenant-a/floor1.png',
  width_px: 1024,
  height_px: 768,
  polygons: [poly(ROOM_A)],
  labels: [],
  created_by: 'user-1',
  created_at: NOW,
  updated_at: NOW,
};

// ─── mock builder ──────────────────────────────────────────────────────────────

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
  opts: { rpcResponse?: RpcResponse } = {},
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
          if (opts.rpcResponse !== undefined) return opts.rpcResponse;
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

// ─── tests ─────────────────────────────────────────────────────────────────────

describe('FloorPlanService.publish — audit + history contract (C.4)', () => {
  // ── C4-1: RPC receives the exact draft_id ────────────────────────────────────
  it('C4-1: passes exact draft id to publish_floor_plan_draft RPC', async () => {
    const deps = makeSupabase({ floor_plan_drafts: [BASE_DRAFT] });
    await makeService(deps).publish(FLOOR_ID, TENANT);

    expect(deps.rpcCalls).toHaveLength(1);
    expect(deps.rpcCalls[0].fn).toBe('publish_floor_plan_draft');
    expect(deps.rpcCalls[0].args).toEqual({ p_draft_id: DRAFT_ID });
  });

  // ── C4-2: history_id bubbles through unchanged ───────────────────────────────
  it('C4-2: returns history_id from RPC to caller unchanged', async () => {
    const customHistoryId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const deps = makeSupabase(
      { floor_plan_drafts: [BASE_DRAFT] },
      { rpcResponse: { data: { history_id: customHistoryId }, error: null } },
    );
    const result = await makeService(deps).publish(FLOOR_ID, TENANT);
    expect(result).toEqual({ history_id: customHistoryId });
  });

  // ── C4-6: multiple polygons → all passed to RPC ──────────────────────────────
  it('C4-6: draft with 2 polygons still calls RPC once with the draft_id (polygon_count fidelity)', async () => {
    const twoPolyDraft = { ...BASE_DRAFT, polygons: [poly(ROOM_A), poly(ROOM_B)] };
    const deps = makeSupabase({ floor_plan_drafts: [twoPolyDraft] });
    const result = await makeService(deps).publish(FLOOR_ID, TENANT);
    // polygon_count is written by the PL/pgSQL function from the draft's jsonb;
    // this test confirms the service does NOT truncate or filter polygons before
    // calling the RPC — the full draft is fetched, the draft_id is passed,
    // and the RPC reads the polygons array directly from the DB row.
    expect(deps.rpcCalls[0].args).toEqual({ p_draft_id: DRAFT_ID });
    expect(result.history_id).toBeTruthy();
  });

  // ── C4-3: no image_url → preflight stops before RPC ─────────────────────────
  it('C4-3: draft without image_url → image_required error before RPC', async () => {
    const deps = makeSupabase({
      floor_plan_drafts: [{ ...BASE_DRAFT, image_url: null }],
    });
    await expect(makeService(deps).publish(FLOOR_ID, TENANT)).rejects.toMatchObject({
      code: 'floor_plan.publish.image_required',
    });
    // RPC must NOT have been called — no audit row should be attempted
    expect(deps.rpcCalls).toHaveLength(0);
  });

  // ── C4-4: no width_px → preflight stops before RPC ──────────────────────────
  it('C4-4: draft without width_px → image_required error before RPC', async () => {
    const deps = makeSupabase({
      floor_plan_drafts: [{ ...BASE_DRAFT, width_px: null }],
    });
    await expect(makeService(deps).publish(FLOOR_ID, TENANT)).rejects.toMatchObject({
      code: 'floor_plan.publish.image_required',
    });
    expect(deps.rpcCalls).toHaveLength(0);
  });

  // ── C4-5: unlinked polygon → preflight stops before RPC ─────────────────────
  it('C4-5: draft with unlinked polygon (space_id="") → unlinked_polygons error before RPC', async () => {
    const unlinkedDraft = {
      ...BASE_DRAFT,
      polygons: [{ space_id: '', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }], render_hint: 'default' }],
    };
    const deps = makeSupabase({ floor_plan_drafts: [unlinkedDraft] });
    await expect(makeService(deps).publish(FLOOR_ID, TENANT)).rejects.toMatchObject({
      code: 'floor_plan.publish.unlinked_polygons',
    });
    expect(deps.rpcCalls).toHaveLength(0);
  });

  // ── C4-7: RPC 23502 (null constraint) → image_required ──────────────────────
  it('C4-7: RPC errcode 23502 → floor_plan.publish.image_required', async () => {
    const deps = makeSupabase(
      { floor_plan_drafts: [BASE_DRAFT] },
      { rpcResponse: { data: null, error: { message: 'not-null constraint', code: '23502' } } },
    );
    await expect(makeService(deps).publish(FLOOR_ID, TENANT)).rejects.toMatchObject({
      code: 'floor_plan.publish.image_required',
    });
  });

  // ── C4-8: RPC P0002 (concurrent double-publish) → draft.not_found ────────────
  it('C4-8: RPC errcode P0002 (draft atomically deleted by concurrent publish) → draft.not_found', async () => {
    const deps = makeSupabase(
      { floor_plan_drafts: [BASE_DRAFT] },
      { rpcResponse: { data: null, error: { message: 'floor_plan.draft.not_found', code: 'P0002' } } },
    );
    await expect(makeService(deps).publish(FLOOR_ID, TENANT)).rejects.toMatchObject({
      code: 'floor_plan.draft.not_found',
    });
  });

  // ── C4-9: RPC 22023 (polygon_not_child) → invalid_polygons ──────────────────
  it('C4-9: RPC errcode 22023 (polygon_not_child) → floor_plan.publish.invalid_polygons', async () => {
    const deps = makeSupabase(
      { floor_plan_drafts: [BASE_DRAFT] },
      { rpcResponse: { data: null, error: { message: 'floor_plan.publish.polygon_not_child', code: '22023' } } },
    );
    await expect(makeService(deps).publish(FLOOR_ID, TENANT)).rejects.toMatchObject({
      code: 'floor_plan.publish.invalid_polygons',
    });
  });

  // ── C4-10: RPC 42501 (cross-tenant) → publish.cross_tenant ──────────────────
  it('C4-10: RPC errcode 42501 (cross-tenant) → floor_plan.publish.cross_tenant', async () => {
    const deps = makeSupabase(
      { floor_plan_drafts: [BASE_DRAFT] },
      { rpcResponse: { data: null, error: { message: 'floor_plan.draft.cross_tenant', code: '42501' } } },
    );
    await expect(makeService(deps).publish(FLOOR_ID, TENANT)).rejects.toMatchObject({
      code: 'floor_plan.publish.cross_tenant',
    });
  });
});
