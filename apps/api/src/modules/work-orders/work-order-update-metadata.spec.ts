// Tests for WorkOrderService.updateMetadata — the title / description /
// cost / tags / watchers edit path. Slice 3.1 of the work-order command
// surface. Mock pattern mirrors the other work-order specs.

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WorkOrderService, SYSTEM_ACTOR } from './work-order.service';

type WorkOrderRow = {
  id: string;
  tenant_id: string;
  title: string | null;
  description: string | null;
  cost: number | null;
  tags: string[] | null;
  watchers: string[] | null;
  // Other fields irrelevant to metadata edits but present on the real row;
  // included so the post-write select('*') behaves like prod.
  status?: string;
  status_category?: string;
  priority?: string;
};

const TENANT = 't1';

function makeDeps(
  initial: WorkOrderRow,
  options: {
    wo_exists?: boolean;
    persons_in_tenant?: string[];
  } = {},
) {
  const exists = options.wo_exists !== false;
  // Default: every person uuid the tests use exists in the tenant. Tests
  // exercising tenant-rejection override with an explicit allowlist.
  const personsInTenant = new Set(
    options.persons_in_tenant ?? ['p1', 'p2', 'p3', 'p4', 'p5'],
  );
  let row: WorkOrderRow = { ...initial };
  const updates: Array<Record<string, unknown>> = [];

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'work_orders') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: exists ? { ...row } : null,
                    error: null,
                  }),
                  single: async () => ({
                    data: exists ? { ...row } : null,
                    error: null,
                  }),
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              updates.push(patch);
              row = { ...row, ...(patch as Partial<WorkOrderRow>) };
              const second = {
                then: (
                  resolve: (v: { data: null; error: null }) => unknown,
                  reject: (e: unknown) => unknown,
                ) => Promise.resolve({ data: null, error: null }).then(resolve, reject),
              };
              return { eq: () => ({ eq: () => second }) };
            },
          } as unknown;
        }
        if (table === 'persons') {
          return {
            select: () => ({
              eq: () => ({
                in: (_col: string, ids: string[]) => ({
                  // The promise-style chain returned by supabase-js's
                  // builder; awaiting yields { data, error }.
                  then: (
                    resolve: (v: { data: Array<{ id: string }>; error: null }) => unknown,
                    reject: (e: unknown) => unknown,
                  ) =>
                    Promise.resolve({
                      data: ids
                        .filter((id) => personsInTenant.has(id))
                        .map((id) => ({ id })),
                      error: null,
                    }).then(resolve, reject),
                }),
              }),
            }),
          } as unknown;
        }
        throw new Error(`unexpected table in mock: ${table}`);
      }),
      rpc: jest.fn(async () => {
        throw new Error('updateMetadata should not call any rpc — visibility floor only');
      }),
    },
  };

  const slaService = {
    restartTimers: jest.fn(),
    pauseTimers: jest.fn(),
    resumeTimers: jest.fn(),
    completeTimers: jest.fn(),
    startTimers: jest.fn(),
  };

  const visibility = {
    loadContext: jest.fn().mockResolvedValue({
      user_id: 'u1',
      person_id: 'p1',
      tenant_id: TENANT,
      team_ids: [],
      role_assignments: [],
      vendor_id: null,
      has_read_all: false,
      has_write_all: true,
    }),
    assertCanPlan: jest.fn().mockResolvedValue(undefined),
  };

  return { row: () => row, updates, supabase, slaService, visibility };
}

function makeSvc(deps: ReturnType<typeof makeDeps>) {
  return new WorkOrderService(
    deps.supabase as never,
    deps.slaService as never,
    deps.visibility as never,
  );
}

describe('WorkOrderService.updateMetadata', () => {
  beforeEach(() => {
    jest
      .spyOn(require('../../common/tenant-context').TenantContext, 'current')
      .mockReturnValue({ id: TENANT, slug: TENANT });
  });

  // ── basic field writes ────────────────────────────────────────────

  it('writes a title change', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      title: 'old',
      description: null,
      cost: null,
      tags: null,
      watchers: null,
    });
    const svc = makeSvc(deps);

    const result = await svc.updateMetadata('wo1', { title: 'new title' }, SYSTEM_ACTOR);

    expect(result.title).toBe('new title');
    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toMatchObject({ title: 'new title' });
    expect(deps.updates[0]).toHaveProperty('updated_at');
  });

  it('writes a description change (string → string)', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      title: 't',
      description: 'old desc',
      cost: null,
      tags: null,
      watchers: null,
    });
    const svc = makeSvc(deps);

    await svc.updateMetadata('wo1', { description: 'new desc' }, SYSTEM_ACTOR);

    expect(deps.updates[0]).toMatchObject({ description: 'new desc' });
  });

  it('writes description=null to clear', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      title: 't',
      description: 'something',
      cost: null,
      tags: null,
      watchers: null,
    });
    const svc = makeSvc(deps);

    await svc.updateMetadata('wo1', { description: null }, SYSTEM_ACTOR);

    expect(deps.updates[0]).toMatchObject({ description: null });
  });

  it('writes a cost change', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      title: 't',
      description: null,
      cost: null,
      tags: null,
      watchers: null,
    });
    const svc = makeSvc(deps);

    await svc.updateMetadata('wo1', { cost: 250.5 }, SYSTEM_ACTOR);

    expect(deps.updates[0]).toMatchObject({ cost: 250.5 });
  });

  it('writes a tags change (replaces whole array)', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      title: 't',
      description: null,
      cost: null,
      tags: ['a', 'b'],
      watchers: null,
    });
    const svc = makeSvc(deps);

    await svc.updateMetadata('wo1', { tags: ['c'] }, SYSTEM_ACTOR);

    expect(deps.updates[0]).toMatchObject({ tags: ['c'] });
  });

  it('writes a watchers change', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      title: 't',
      description: null,
      cost: null,
      tags: null,
      watchers: ['p1'],
    });
    const svc = makeSvc(deps);

    await svc.updateMetadata('wo1', { watchers: ['p1', 'p2'] }, SYSTEM_ACTOR);

    expect(deps.updates[0]).toMatchObject({ watchers: ['p1', 'p2'] });
  });

  // ── multi-field write batches into a single UPDATE ────────────────

  it('batches multiple field changes into a single UPDATE', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      title: 'old',
      description: null,
      cost: null,
      tags: null,
      watchers: null,
    });
    const svc = makeSvc(deps);

    await svc.updateMetadata(
      'wo1',
      { title: 'new', description: 'd', cost: 10, tags: ['x'], watchers: ['p1'] },
      SYSTEM_ACTOR,
    );

    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toMatchObject({
      title: 'new',
      description: 'd',
      cost: 10,
      tags: ['x'],
      watchers: ['p1'],
    });
  });

  // ── no-op fast paths ──────────────────────────────────────────────

  it('no-ops when title is unchanged', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      title: 'same',
      description: null,
      cost: null,
      tags: null,
      watchers: null,
    });
    const svc = makeSvc(deps);

    await svc.updateMetadata('wo1', { title: 'same' }, SYSTEM_ACTOR);

    expect(deps.updates).toHaveLength(0);
  });

  it('no-ops when tags array equals current (deep equality)', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      title: 't',
      description: null,
      cost: null,
      tags: ['a', 'b'],
      watchers: null,
    });
    const svc = makeSvc(deps);

    await svc.updateMetadata('wo1', { tags: ['a', 'b'] }, SYSTEM_ACTOR);

    expect(deps.updates).toHaveLength(0);
  });

  it('does NOT no-op when tags array order differs', async () => {
    // Order-sensitive comparison is correct — tags ordering is meaningful
    // for chip-strip rendering. If we ever switch to set-equality, update
    // both sides.
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      title: 't',
      description: null,
      cost: null,
      tags: ['a', 'b'],
      watchers: null,
    });
    const svc = makeSvc(deps);

    await svc.updateMetadata('wo1', { tags: ['b', 'a'] }, SYSTEM_ACTOR);

    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toMatchObject({ tags: ['b', 'a'] });
  });

  it('partial no-op: writes only the differing fields', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      title: 'unchanged',
      description: 'old',
      cost: null,
      tags: null,
      watchers: null,
    });
    const svc = makeSvc(deps);

    await svc.updateMetadata(
      'wo1',
      { title: 'unchanged', description: 'new' },
      SYSTEM_ACTOR,
    );

    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toMatchObject({ description: 'new' });
    expect(deps.updates[0]).not.toHaveProperty('title');
  });

  // ── validation / errors ───────────────────────────────────────────

  it('rejects an empty DTO', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      title: 't',
      description: null,
      cost: null,
      tags: null,
      watchers: null,
    });
    const svc = makeSvc(deps);

    await expect(svc.updateMetadata('wo1', {}, SYSTEM_ACTOR)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('throws NotFound when work_order does not exist', async () => {
    const deps = makeDeps(
      {
        id: 'wo-missing',
        tenant_id: TENANT,
        title: '',
        description: null,
        cost: null,
        tags: null,
        watchers: null,
      },
      { wo_exists: false },
    );
    const svc = makeSvc(deps);

    await expect(
      svc.updateMetadata('wo-missing', { title: 'x' }, SYSTEM_ACTOR),
    ).rejects.toThrow(NotFoundException);
  });

  // ── visibility gate ───────────────────────────────────────────────

  it('runs assertCanPlan for non-SYSTEM_ACTOR callers', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      title: 'old',
      description: null,
      cost: null,
      tags: null,
      watchers: null,
    });
    const svc = makeSvc(deps);

    await svc.updateMetadata('wo1', { title: 'new' }, 'real-uid');

    expect(deps.visibility.loadContext).toHaveBeenCalledWith('real-uid', TENANT);
    expect(deps.visibility.assertCanPlan).toHaveBeenCalledWith(
      'wo1',
      expect.any(Object),
    );
  });

  it('skips visibility for SYSTEM_ACTOR', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      title: 'old',
      description: null,
      cost: null,
      tags: null,
      watchers: null,
    });
    const svc = makeSvc(deps);

    await svc.updateMetadata('wo1', { title: 'new' }, SYSTEM_ACTOR);

    expect(deps.visibility.loadContext).not.toHaveBeenCalled();
    expect(deps.visibility.assertCanPlan).not.toHaveBeenCalled();
  });

  // ── service-layer guards (full-review hardening) ──────────────────

  it('rejects empty title (whitespace only) at the service layer', async () => {
    // Controller catches this too, but internal callers (workflow engine,
    // cron, SYSTEM_ACTOR) bypass the controller — service must enforce.
    const deps = makeDeps({
      id: 'wo1', tenant_id: TENANT,
      title: 'real', description: null, cost: null, tags: null, watchers: null,
    });
    const svc = makeSvc(deps);

    await expect(
      svc.updateMetadata('wo1', { title: '   ' }, SYSTEM_ACTOR),
    ).rejects.toThrow(BadRequestException);
    expect(deps.updates).toHaveLength(0);
  });

  it('rejects non-finite cost (Infinity, NaN) at the service layer', async () => {
    const deps = makeDeps({
      id: 'wo1', tenant_id: TENANT,
      title: 't', description: null, cost: null, tags: null, watchers: null,
    });
    const svc = makeSvc(deps);

    await expect(
      svc.updateMetadata('wo1', { cost: Number.POSITIVE_INFINITY }, SYSTEM_ACTOR),
    ).rejects.toThrow(BadRequestException);
    await expect(
      svc.updateMetadata('wo1', { cost: Number.NaN }, SYSTEM_ACTOR),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects tags with non-string elements at the service layer', async () => {
    const deps = makeDeps({
      id: 'wo1', tenant_id: TENANT,
      title: 't', description: null, cost: null, tags: null, watchers: null,
    });
    const svc = makeSvc(deps);

    await expect(
      svc.updateMetadata('wo1', { tags: ['ok', 123 as unknown as string] }, SYSTEM_ACTOR),
    ).rejects.toThrow(BadRequestException);
  });

  // ── cost float normalization (full-review #5: NUMERIC round-trip) ─

  it('normalizes cost to 2 dp before comparison so 0.1+0.2 no-ops against 0.3', async () => {
    // 0.1 + 0.2 in IEEE-754 is 0.30000000000000004. Postgres NUMERIC(12,2)
    // stores as 0.30 → refetches as 0.3. Without normalization the no-op
    // fast-path would never fire for fractional cost values and every
    // PATCH would re-write + bump updated_at. Normalize so dto.cost and
    // currentRow.cost can compare cleanly.
    const deps = makeDeps({
      id: 'wo1', tenant_id: TENANT,
      title: 't', description: null, cost: 0.3, tags: null, watchers: null,
    });
    const svc = makeSvc(deps);

    await svc.updateMetadata('wo1', { cost: 0.1 + 0.2 }, SYSTEM_ACTOR);

    expect(deps.updates).toHaveLength(0); // no-op fast path fires.
  });

  it('normalizes a fractional cost write to the persisted 2-dp value', async () => {
    const deps = makeDeps({
      id: 'wo1', tenant_id: TENANT,
      title: 't', description: null, cost: null, tags: null, watchers: null,
    });
    const svc = makeSvc(deps);

    await svc.updateMetadata('wo1', { cost: 12.345 }, SYSTEM_ACTOR);

    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0].cost).toBe(12.35);
  });

  // ── watcher uuid tenant validation (full-review hardening) ────────
  // These tests use a real auth uid instead of SYSTEM_ACTOR because the
  // helper bypasses validation for SYSTEM_ACTOR by design (matches the
  // visibility-gate convention).

  const REAL_PERSON = '11111111-1111-1111-1111-111111111111';
  const OTHER_REAL_PERSON = '22222222-2222-2222-2222-222222222222';
  const GHOST_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const GHOST_UUID_2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  it('rejects watchers that include a ghost (well-formed but unknown) uuid', async () => {
    const deps = makeDeps(
      {
        id: 'wo1', tenant_id: TENANT,
        title: 't', description: null, cost: null, tags: null, watchers: null,
      },
      { persons_in_tenant: [REAL_PERSON, OTHER_REAL_PERSON] },
    );
    const svc = makeSvc(deps);

    await expect(
      svc.updateMetadata('wo1', { watchers: [REAL_PERSON, GHOST_UUID] }, 'real-uid'),
    ).rejects.toThrow(/unknown person id\(s\)/);
    expect(deps.updates).toHaveLength(0);
  });

  it('rejects watchers with malformed uuid (not a uuid format)', async () => {
    // Without the regex pre-filter this would hit Postgres 22P02 cast error
    // and surface as a 500 with PG detail leakage. Pre-filter must produce
    // a clean 400 with the malformed value.
    const deps = makeDeps(
      {
        id: 'wo1', tenant_id: TENANT,
        title: 't', description: null, cost: null, tags: null, watchers: null,
      },
      { persons_in_tenant: [REAL_PERSON] },
    );
    const svc = makeSvc(deps);

    await expect(
      svc.updateMetadata('wo1', { watchers: [REAL_PERSON, 'not-a-uuid'] }, 'real-uid'),
    ).rejects.toThrow(/malformed uuid/);
    expect(deps.updates).toHaveLength(0);
  });

  it('rejects watchers array exceeding the per-request cap', async () => {
    // 201 unique well-formed uuids — over the 200 cap.
    const tooMany = Array.from({ length: 201 }, (_, i) =>
      `cccccccc-cccc-cccc-cccc-${String(i).padStart(12, '0')}`,
    );
    const deps = makeDeps({
      id: 'wo1', tenant_id: TENANT,
      title: 't', description: null, cost: null, tags: null, watchers: null,
    });
    const svc = makeSvc(deps);

    await expect(
      svc.updateMetadata('wo1', { watchers: tooMany }, 'real-uid'),
    ).rejects.toThrow(/array too large/);
  });

  it('accepts watchers that all reference real persons in the tenant', async () => {
    const deps = makeDeps(
      {
        id: 'wo1', tenant_id: TENANT,
        title: 't', description: null, cost: null, tags: null, watchers: null,
      },
      { persons_in_tenant: [REAL_PERSON, OTHER_REAL_PERSON] },
    );
    const svc = makeSvc(deps);

    await svc.updateMetadata(
      'wo1',
      { watchers: [REAL_PERSON, OTHER_REAL_PERSON] },
      'real-uid',
    );

    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toMatchObject({
      watchers: [REAL_PERSON, OTHER_REAL_PERSON],
    });
  });

  it('handles duplicate watcher uuids — dedup before validation', async () => {
    // [p1, p1] should not be rejected as "1 unknown of 2"; the dedup
    // before SELECT means the count comparison is exact.
    const deps = makeDeps(
      {
        id: 'wo1', tenant_id: TENANT,
        title: 't', description: null, cost: null, tags: null, watchers: null,
      },
      { persons_in_tenant: [REAL_PERSON] },
    );
    const svc = makeSvc(deps);

    await svc.updateMetadata(
      'wo1',
      { watchers: [REAL_PERSON, REAL_PERSON] },
      'real-uid',
    );

    expect(deps.updates).toHaveLength(1);
  });

  it('skips validation when watchers is null (clear) or empty array', async () => {
    const deps = makeDeps({
      id: 'wo1', tenant_id: TENANT,
      title: 't', description: null, cost: null, tags: null, watchers: [REAL_PERSON],
    });
    const svc = makeSvc(deps);

    await svc.updateMetadata('wo1', { watchers: null }, 'real-uid');
    await svc.updateMetadata('wo1', { watchers: [] }, 'real-uid');

    expect(
      deps.updates.every(
        (u) =>
          u.watchers === null ||
          (Array.isArray(u.watchers) && (u.watchers as unknown[]).length === 0),
      ),
    ).toBe(true);
  });

  it('SYSTEM_ACTOR bypasses watcher validation (gate convention)', async () => {
    // Defensive vs. trust: workflow engine + cron run as SYSTEM_ACTOR with
    // uuids they generated programmatically; running the SELECT for them
    // is wasted work. Matches the assertCanPlan / assertVisible bypass.
    const deps = makeDeps(
      {
        id: 'wo1', tenant_id: TENANT,
        title: 't', description: null, cost: null, tags: null, watchers: null,
      },
      { persons_in_tenant: [] }, // intentionally empty — no persons.
    );
    const svc = makeSvc(deps);

    // GHOST_UUID would normally reject for a real-uid actor; SYSTEM_ACTOR
    // bypasses validation entirely.
    await svc.updateMetadata('wo1', { watchers: [GHOST_UUID] }, SYSTEM_ACTOR);
    expect(deps.updates).toHaveLength(1);
  });

  // ── orchestrator integration: WorkOrderService.update routes
  // metadata fields to updateMetadata ────────────────────────────────

  it('orchestrator dispatches metadata-only DTOs via updateMetadata', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      title: 'old',
      description: null,
      cost: null,
      tags: null,
      watchers: null,
    });
    const svc = makeSvc(deps);

    await svc.update('wo1', { title: 'new' }, SYSTEM_ACTOR);

    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toMatchObject({ title: 'new' });
  });
});
