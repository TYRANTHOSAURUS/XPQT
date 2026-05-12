// Floor plan draft service spec
//
// Tests the FloorPlanDraftService in isolation using the same capture-client
// pattern as sibling specs (cross-tenant-fk-leak-misc, order-service-clone-*).
// No real Supabase / DB call — all assertions operate on the mock client.
//
// Covered:
//  1. getOrCreate — creates on first call, idempotent on second call
//  2. update     — valid polygon 200, missing-floor-child polygon 422,
//                  cross-tenant polygon 422, duplicate space_id 422,
//                  empty space_id 200 (draft tolerates unlinked)
//  3. update     — stale If-Match → 409 CAS conflict
//  4. discard    — deletes the draft row

import { FloorPlanDraftService } from './floor-plan-draft.service';

const TENANT_A = '00000000-0000-4000-8000-aaaaaaaaaaaa';
const TENANT_B = '00000000-0000-4000-8000-bbbbbbbbbbbb';
const FLOOR_ID = '11110000-0000-4000-8000-000000000001';
const CHILD_ID = '22220000-0000-4000-8000-000000000001';
const FOREIGN_CHILD_ID = '22220000-0000-4000-8000-000000000099';
const USER_ID = '33330000-0000-4000-8000-000000000001';
const DRAFT_ID = '44440000-0000-4000-8000-000000000001';
const NOW = '2026-05-12T10:00:00Z';
const T1 = NOW;

// Minimal polygon with 3 points — passes DTO validation
const VALID_POLYGON = {
  space_id: CHILD_ID,
  points: [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 50, y: 100 },
  ],
  render_hint: 'default' as const,
};

// ─────────────────────────────────────────────────────────────────────
// Mock client builder
// ─────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/**
 * Builds a minimal Supabase admin mock that records ops.
 *
 * Key design notes to match the actual service call shapes:
 *  - `getOrCreate` runs: insert({ … }).select('*').single()
 *    → the chain continues after insert; single() must return the inserted row.
 *  - `update()` spaces validation runs: .select().in().eq().then
 *    → plain `await` on the builder chain (no .single/.maybeSingle).
 *    The `then` handler resolves with {data: rows[], error: null} for selects.
 *  - `update()` CAS runs: .update({ … }).eq().eq().eq().select().maybeSingle()
 *    → updateResult controls what maybeSingle returns for update ops.
 *  - `delete()` runs: .delete().eq().eq().then
 *    → the `then` handler resolves with deleteError (or null).
 */
function makeSupabase(
  rowsByTable: Record<string, Row[]>,
  opts: {
    /**
     * What maybeSingle() returns when called after an update chain.
     * Defaults to returning the first matching row merged with the payload.
     */
    updateMaybeSingleResult?: { data: Row | null; error: null };
    /**
     * Error to inject into delete operations. null = success.
     */
    deleteError?: { message: string } | null;
  } = {},
) {
  const inserts: Array<{ table: string; row: Row }> = [];
  const deletes: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; filters: Record<string, unknown>; payload: Row }> = [];

  function buildChain(table: string) {
    const filters: Record<string, unknown> = {};
    const inFilters: Record<string, unknown[]> = {};
    let mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let pendingInsertRow: Row | undefined;
    let pendingUpdatePayload: Row | undefined;

    function matchRows(rows: Row[]): Row[] {
      return rows.filter((r) => {
        for (const [col, val] of Object.entries(filters)) {
          if (r[col] !== val) return false;
        }
        for (const [col, vals] of Object.entries(inFilters)) {
          if (!(vals as unknown[]).includes(r[col])) return false;
        }
        return true;
      });
    }

    const chain: Record<string, unknown> & PromiseLike<unknown> = {
      select: () => {
        if (mode !== 'insert' && mode !== 'update') mode = 'select';
        return chain;
      },
      insert: (row: Row) => {
        mode = 'insert';
        pendingInsertRow = row;
        inserts.push({ table, row });
        return chain;
      },
      update: (row: Row) => {
        mode = 'update';
        pendingUpdatePayload = row;
        return chain;
      },
      delete: () => {
        mode = 'delete';
        return chain;
      },
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      in: (col: string, val: unknown[]) => {
        inFilters[col] = val;
        return chain;
      },
      not: () => chain,
      order: () => chain,
      limit: () => chain,

      // --- select/array terminator (plain await on select chain) ---
      then: (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
        let result: unknown;
        if (mode === 'delete') {
          deletes.push({ table, filters: { ...filters, ...inFilters } });
          const err = opts.deleteError !== undefined ? opts.deleteError : null;
          result = Promise.resolve({ data: null, error: err });
        } else if (mode === 'select') {
          // Plain await on select chain — returns {data: Row[], error: null}
          const rows = rowsByTable[table] ?? [];
          result = Promise.resolve({ data: matchRows(rows), error: null });
        } else if (mode === 'update') {
          updates.push({ table, filters: { ...filters }, payload: pendingUpdatePayload! });
          result = Promise.resolve({ data: null, error: null });
        } else {
          result = Promise.resolve({ data: null, error: null });
        }
        return (result as Promise<unknown>).then(onFulfilled, onRejected);
      },

      // --- scalar select terminator ---
      maybeSingle: async () => {
        if (mode === 'update') {
          updates.push({ table, filters: { ...filters }, payload: pendingUpdatePayload! });
          if (opts.updateMaybySingleResult !== undefined) {
            return (opts as { updateMaybySingleResult: unknown }).updateMaybySingleResult;
          }
          // Default: return matching row merged with payload (CAS success)
          const rows = rowsByTable[table] ?? [];
          const match = matchRows(rows)[0] ?? null;
          return {
            data: match ? { ...match, ...pendingUpdatePayload } : null,
            error: null,
          };
        }
        const rows = rowsByTable[table] ?? [];
        const match = matchRows(rows)[0] ?? null;
        return { data: match, error: null };
      },

      // --- single row terminator (insert…select…single) ---
      single: async () => {
        if (mode === 'insert') {
          // Return the just-inserted row with generated fields
          const base = {
            ...pendingInsertRow,
            id: DRAFT_ID,
            created_at: NOW,
            updated_at: NOW,
          };
          return { data: base, error: null };
        }
        const rows = rowsByTable[table] ?? [];
        const match = matchRows(rows)[0] ?? null;
        return { data: match, error: null };
      },
    } as Record<string, unknown> & PromiseLike<unknown>;

    return chain;
  }

  return {
    inserts,
    deletes,
    updates,
    supabase: {
      admin: {
        from: (table: string) => buildChain(table),
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function makeService(deps: ReturnType<typeof makeSupabase>) {
  return new FloorPlanDraftService(deps.supabase as never);
}

// A pre-existing draft row
const EXISTING_DRAFT: Row = {
  id: DRAFT_ID,
  tenant_id: TENANT_A,
  floor_space_id: FLOOR_ID,
  image_url: 'floor-plans/tenant-a/floor1.png',
  width_px: 1024,
  height_px: 768,
  polygons: [],
  labels: [],
  created_by: USER_ID,
  created_at: NOW,
  updated_at: T1,
};

// A child space that IS a child of FLOOR_ID for tenant A
const CHILD_SPACE: Row = {
  id: CHILD_ID,
  tenant_id: TENANT_A,
  parent_id: FLOOR_ID,
  name: 'Room A',
};

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('FloorPlanDraftService.getOrCreate', () => {
  it('returns existing draft on second call (idempotent)', async () => {
    const deps = makeSupabase({
      floor_plan_drafts: [EXISTING_DRAFT],
    });
    const svc = makeService(deps);
    const result = await svc.getOrCreate(FLOOR_ID, USER_ID, TENANT_A);
    expect(result.id).toBe(DRAFT_ID);
    // Should NOT have inserted (draft already existed)
    expect(deps.inserts.filter((i) => i.table === 'floor_plan_drafts')).toHaveLength(0);
  });

  it('creates a new draft when none exists', async () => {
    const deps = makeSupabase({
      floor_plan_drafts: [],
      floor_plans: [],
      spaces: [],
    });
    const svc = makeService(deps);
    const result = await svc.getOrCreate(FLOOR_ID, USER_ID, TENANT_A);
    // Service returns the inserted row (mocked via single() returning insertResult)
    expect(result).toBeDefined();
    expect(result.id).toBe(DRAFT_ID);
    // An insert into floor_plan_drafts must have fired
    const draftInserts = deps.inserts.filter((i) => i.table === 'floor_plan_drafts');
    expect(draftInserts).toHaveLength(1);
    expect(draftInserts[0].row).toMatchObject({
      tenant_id: TENANT_A,
      floor_space_id: FLOOR_ID,
      created_by: USER_ID,
    });
  });
});

describe('FloorPlanDraftService.update', () => {
  it('accepts a valid polygon (space_id is a child of the floor)', async () => {
    const deps = makeSupabase({
      floor_plan_drafts: [EXISTING_DRAFT],
      spaces: [CHILD_SPACE],
    });
    const svc = makeService(deps);
    // No If-Match — unconditional update (updateMaybySingleResult not set → returns merged row)
    const result = await svc.update(FLOOR_ID, TENANT_A, undefined, {
      polygons: [VALID_POLYGON],
    });
    expect(result).toBeDefined();
  });

  it('rejects a polygon whose space_id is not a child of this floor (422)', async () => {
    // Space exists in tenant but its parent_id is NOT FLOOR_ID
    const deps = makeSupabase({
      floor_plan_drafts: [EXISTING_DRAFT],
      spaces: [{ id: CHILD_ID, tenant_id: TENANT_A, parent_id: 'other-floor-uuid' }],
    });
    const svc = makeService(deps);
    let caught: unknown = null;
    try {
      await svc.update(FLOOR_ID, TENANT_A, undefined, {
        polygons: [VALID_POLYGON],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code: string }).code).toBe('floor_plan.draft.invalid_polygons');
  });

  it('rejects a polygon with a cross-tenant space_id (not visible in this tenant)', async () => {
    // space_id not present in TENANT_A spaces at all
    const deps = makeSupabase({
      floor_plan_drafts: [EXISTING_DRAFT],
      // spaces table empty for tenant A — the foreign space won't match the tenant filter
      spaces: [],
    });
    const svc = makeService(deps);
    let caught: unknown = null;
    try {
      await svc.update(FLOOR_ID, TENANT_A, undefined, {
        polygons: [{ ...VALID_POLYGON, space_id: FOREIGN_CHILD_ID }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code: string }).code).toBe('floor_plan.draft.invalid_polygons');
  });

  it('rejects duplicate space_id in polygons array (DTO superRefine)', async () => {
    const deps = makeSupabase({
      floor_plan_drafts: [EXISTING_DRAFT],
      spaces: [CHILD_SPACE],
    });
    const svc = makeService(deps);
    let caught: unknown = null;
    try {
      await svc.update(FLOOR_ID, TENANT_A, undefined, {
        // Same space_id twice → superRefine fires
        polygons: [VALID_POLYGON, VALID_POLYGON],
      });
    } catch (e) {
      caught = e;
    }
    // DTO superRefine fires before DB call — throwZodError produces an AppError
    expect(caught).toBeTruthy();
    // AppError from throwZodError has .status = 422
    expect((caught as { status?: number }).status).toBe(422);
  });

  it('accepts empty space_id (unlinked polygon — draft tolerates, publish rejects)', async () => {
    const deps = makeSupabase({
      floor_plan_drafts: [EXISTING_DRAFT],
      spaces: [],
    });
    const svc = makeService(deps);
    const unlinkedPolygon = { ...VALID_POLYGON, space_id: '' };
    // Should NOT throw — empty space_id is allowed in draft (filter(Boolean) skips it)
    const result = await svc.update(FLOOR_ID, TENANT_A, undefined, {
      polygons: [unlinkedPolygon],
    });
    expect(result).toBeDefined();
  });

  it('returns 409 conflict when If-Match is stale (CAS path)', async () => {
    const T0 = '2026-05-12T09:00:00Z'; // stale timestamp the client holds
    // T1 = NOW = the actual current updated_at on the server

    // We need:
    //  1. The spaces query (for polygon validation) to succeed → spaces array has CHILD_SPACE
    //  2. The update CAS query (WHERE updated_at=T0) to return null (stale)
    //  3. The disambiguate read to find the current row with updated_at=T1

    // The service calls update().eq('updated_at', T0).select().maybeSingle()
    // We use a custom mock that intercepts maybeSingle on updates.

    // Build a per-call mock: first update call returns null (stale); subsequent
    // maybeSingle (the disambiguate read) returns the current row.
    let updateCallCount = 0;

    function buildCustomChain(table: string) {
      const filters: Record<string, unknown> = {};
      const inFilters: Record<string, unknown[]> = {};
      let mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let pendingPayload: Row | undefined;

      function matchRows(rows: Row[]): Row[] {
        return rows.filter((r) => {
          for (const [col, val] of Object.entries(filters)) {
            if (r[col] !== val) return false;
          }
          for (const [col, vals] of Object.entries(inFilters)) {
            if (!(vals as unknown[]).includes(r[col])) return false;
          }
          return true;
        });
      }

      const rowsForTable: Record<string, Row[]> = {
        floor_plan_drafts: [{ ...EXISTING_DRAFT, updated_at: T1 }],
        spaces: [CHILD_SPACE],
      };

      const chain: Record<string, unknown> & PromiseLike<unknown> = {
        select: () => { if (mode !== 'update') mode = 'select'; return chain; },
        update: (row: Row) => { mode = 'update'; pendingPayload = row; return chain; },
        eq: (col: string, val: unknown) => { filters[col] = val; return chain; },
        in: (col: string, val: unknown[]) => { inFilters[col] = val; return chain; },
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        then: (onFulfilled?: (v: unknown) => unknown) => {
          const rows = rowsForTable[table] ?? [];
          return Promise.resolve({ data: matchRows(rows), error: null }).then(onFulfilled);
        },
        maybeSingle: async () => {
          if (mode === 'update') {
            updateCallCount += 1;
            // First update (the CAS update with updated_at=T0) → null (stale)
            // Subsequent maybeSingle on same table = disambiguate read
            return { data: null, error: null };
          }
          // Disambiguate read (select maybeSingle for current updated_at)
          const rows = rowsForTable[table] ?? [];
          const match = matchRows(rows)[0] ?? null;
          return { data: match, error: null };
        },
        single: async () => {
          const rows = rowsForTable[table] ?? [];
          const match = matchRows(rows)[0] ?? null;
          return { data: match, error: null };
        },
      } as Record<string, unknown> & PromiseLike<unknown>;
      return chain;
    }

    const customSupabase = {
      admin: { from: (table: string) => buildCustomChain(table) },
    };

    const svc = new FloorPlanDraftService(customSupabase as never);

    let caught: unknown = null;
    try {
      await svc.update(FLOOR_ID, TENANT_A, T0, {
        polygons: [VALID_POLYGON],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code: string }).code).toBe('floor_plan.draft.stale_update');
    // serverVersion should be T1 (the current row's updated_at) — stored on AppError directly
    expect((caught as { serverVersion?: string }).serverVersion).toBe(T1);
  });
});

describe('FloorPlanDraftService.discard', () => {
  it('deletes the draft row (no error = success)', async () => {
    const deps = makeSupabase(
      { floor_plan_drafts: [EXISTING_DRAFT] },
      { deleteError: null },
    );
    const svc = makeService(deps);
    // Should resolve without throwing
    await expect(svc.discard(FLOOR_ID, TENANT_A)).resolves.toBeUndefined();
    // A delete on floor_plan_drafts must have been captured
    expect(deps.deletes.some((d) => d.table === 'floor_plan_drafts')).toBe(true);
  });

  it('throws server error when delete fails', async () => {
    const deps = makeSupabase(
      { floor_plan_drafts: [EXISTING_DRAFT] },
      { deleteError: { message: 'DB error' } },
    );
    const svc = makeService(deps);
    let caught: unknown = null;
    try {
      await svc.discard(FLOOR_ID, TENANT_A);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code: string }).code).toBe('floor_plan.draft.discard_failed');
  });
});
