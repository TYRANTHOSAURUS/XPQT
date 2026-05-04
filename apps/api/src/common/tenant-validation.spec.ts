import { BadRequestException } from '@nestjs/common';
import {
  assertTenantOwned,
  assertTenantOwnedAll,
} from './tenant-validation';

// Hand-rolled supabase chain mock that captures the .eq() filters and the
// .in() filter so tests can assert tenant scope was applied.
type Capture = {
  table: string;
  id?: string;
  ids?: string[];
  tenant_id?: string;
  active?: boolean;
  reservable?: boolean;
  // is(col, null) capture — anonymized_at + left_at for personState='active'
  is_null_cols?: string[];
};

type PersonRow = {
  id: string;
  tenant_id: string;
  active?: boolean;
  reservable?: boolean;
  anonymized_at?: string | null;
  left_at?: string | null;
};

function makeSupabase(rowsByTable: Record<string, Array<PersonRow>>) {
  const captures: Capture[] = [];
  return {
    captures,
    supabase: {
      admin: {
        from: (table: string) => {
          const rows = rowsByTable[table] ?? [];
          const filters: Capture = { table };
          const buildChain = () => {
            const chain: Record<string, unknown> = {
              eq: (col: string, val: unknown) => {
                if (col === 'id') filters.id = val as string;
                else if (col === 'tenant_id') filters.tenant_id = val as string;
                else if (col === 'active') filters.active = val as boolean;
                else if (col === 'reservable') filters.reservable = val as boolean;
                return chain;
              },
              is: (col: string, val: unknown) => {
                if (val === null) {
                  filters.is_null_cols = [...(filters.is_null_cols ?? []), col];
                }
                return chain;
              },
              in: (col: string, val: string[]) => {
                if (col === 'id') filters.ids = val;
                return chain;
              },
              maybeSingle: async () => {
                captures.push({ ...filters });
                const match = rows.find((r) => {
                  if (filters.id && r.id !== filters.id) return false;
                  if (filters.tenant_id && r.tenant_id !== filters.tenant_id) return false;
                  if (filters.active !== undefined && r.active !== filters.active) return false;
                  if (filters.reservable !== undefined && r.reservable !== filters.reservable) return false;
                  for (const col of filters.is_null_cols ?? []) {
                    if ((r as Record<string, unknown>)[col] != null) return false;
                  }
                  return true;
                });
                return { data: match ? { id: match.id } : null, error: null };
              },
              then: undefined as unknown,
            };
            // Make terminal `await` on the chain (used by .in() path) work.
            (chain as unknown as PromiseLike<unknown>).then = (
              onFulfilled: (v: { data: Array<{ id: string }> | null; error: null }) => unknown,
            ) => {
              captures.push({ ...filters });
              const matches = rows.filter((r) => {
                if (filters.tenant_id && r.tenant_id !== filters.tenant_id) return false;
                if (filters.ids && !filters.ids.includes(r.id)) return false;
                if (filters.active !== undefined && r.active !== filters.active) return false;
                for (const col of filters.is_null_cols ?? []) {
                  if ((r as Record<string, unknown>)[col] != null) return false;
                }
                return true;
              });
              return Promise.resolve({
                data: matches.map((r) => ({ id: r.id })),
                error: null,
              }).then(onFulfilled);
            };
            return chain;
          };
          return {
            select: () => buildChain(),
          };
        },
      },
    },
  };
}

describe('assertTenantOwned', () => {
  const TEAM = '00000000-0000-4000-8000-00000000aaaa';
  it('passes when row exists in the tenant', async () => {
    const { supabase, captures } = makeSupabase({
      teams: [{ id: TEAM, tenant_id: 't1' }],
    });
    await expect(
      assertTenantOwned(supabase as never, 'teams', TEAM, 't1'),
    ).resolves.toBeUndefined();
    expect(captures).toEqual([
      { table: 'teams', id: TEAM, tenant_id: 't1' },
    ]);
  });

  it('throws reference.not_in_tenant when row exists but in another tenant', async () => {
    const { supabase } = makeSupabase({
      teams: [{ id: TEAM, tenant_id: 'other-tenant' }],
    });
    await expect(
      assertTenantOwned(supabase as never, 'teams', TEAM, 't1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'reference.not_in_tenant',
        reference_table: 'teams',
        reference_id: TEAM,
      }),
    });
  });

  it('throws reference.invalid_uuid for malformed input', async () => {
    const { supabase } = makeSupabase({});
    await expect(
      assertTenantOwned(supabase as never, 'teams', 'not-a-uuid', 't1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      assertTenantOwned(supabase as never, 'teams', 'not-a-uuid', 't1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'reference.invalid_uuid' }),
    });
  });

  it('honours activeOnly + reservableOnly options', async () => {
    const VALID = '00000000-0000-4000-8000-000000000001';
    const { supabase, captures } = makeSupabase({
      spaces: [
        { id: VALID, tenant_id: 't1', active: true, reservable: true },
      ],
    });
    await expect(
      assertTenantOwned(supabase as never, 'spaces', VALID, 't1', {
        activeOnly: true,
        reservableOnly: true,
      }),
    ).resolves.toBeUndefined();
    expect(captures[0]).toMatchObject({
      table: 'spaces',
      id: VALID,
      tenant_id: 't1',
      active: true,
      reservable: true,
    });
  });

  it('rejects rows that fail the activeOnly check', async () => {
    const VALID = '00000000-0000-4000-8000-000000000001';
    const { supabase } = makeSupabase({
      spaces: [
        { id: VALID, tenant_id: 't1', active: false, reservable: true },
      ],
    });
    await expect(
      assertTenantOwned(supabase as never, 'spaces', VALID, 't1', {
        activeOnly: true,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'reference.not_in_tenant' }),
    });
  });

  it('skipForSystemActor returns without querying', async () => {
    const { supabase, captures } = makeSupabase({});
    await expect(
      assertTenantOwned(supabase as never, 'teams', 'team-1', 't1', {
        skipForSystemActor: true,
      }),
    ).resolves.toBeUndefined();
    expect(captures).toEqual([]);
  });

  it('uses entityName in the error message when provided', async () => {
    const VALID = '00000000-0000-4000-8000-000000000001';
    const { supabase } = makeSupabase({
      sla_policies: [{ id: VALID, tenant_id: 'other' }],
    });
    await expect(
      assertTenantOwned(supabase as never, 'sla_policies', VALID, 't1', {
        entityName: 'SLA policy',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'reference.not_in_tenant',
        message: expect.stringContaining('SLA policy'),
      }),
    });
  });

  // Plan A.4 / Commit 1 (N1) — invariant guard.
  describe('invariant guard for tenantId', () => {
    const VALID = '00000000-0000-4000-8000-000000000001';
    it('throws plain Error (not 400) when tenantId is missing/empty/non-string', async () => {
      const { supabase, captures } = makeSupabase({});
      // empty string
      await expect(
        assertTenantOwned(supabase as never, 'teams', VALID, ''),
      ).rejects.toThrow(/invariant: tenantId required/);
      // undefined cast through the `string` annotation (real-world: missing
      // TenantContext load means tenantId reads as undefined at runtime).
      await expect(
        assertTenantOwned(
          supabase as never,
          'teams',
          VALID,
          undefined as unknown as string,
        ),
      ).rejects.toThrow(/invariant: tenantId required/);
      // Non-string (e.g. someone hands the function a tenant object).
      await expect(
        assertTenantOwned(
          supabase as never,
          'teams',
          VALID,
          { id: 't1' } as unknown as string,
        ),
      ).rejects.toThrow(/invariant: tenantId required/);
      // Should NOT have hit the database for any of these.
      expect(captures).toEqual([]);
    });

    it('does NOT throw the invariant when skipForSystemActor short-circuits', async () => {
      const { supabase, captures } = makeSupabase({});
      // System actor returns early before the invariant guard. This is
      // intentional: system actor on a path with no tenant context is a
      // valid case (cron / startup / dryrun). The guard fires only when
      // we're actually about to query.
      await expect(
        assertTenantOwned(supabase as never, 'teams', VALID, '', {
          skipForSystemActor: true,
        }),
      ).resolves.toBeUndefined();
      expect(captures).toEqual([]);
    });
  });

  // Plan A.4 / Commit 1 (N3) — personState option.
  describe('personState filter', () => {
    const VALID = '00000000-0000-4000-8000-00000000aaaa';

    it("default 'any' does NOT filter on active/anonymized_at/left_at", async () => {
      const { supabase, captures } = makeSupabase({
        persons: [
          { id: VALID, tenant_id: 't1', active: false, anonymized_at: '2026-01-01' },
        ],
      });
      // Even a deactivated + anonymized person passes when personState is
      // omitted — back-compat for existing call sites.
      await expect(
        assertTenantOwned(supabase as never, 'persons', VALID, 't1'),
      ).resolves.toBeUndefined();
      expect(captures[0]).not.toMatchObject({ active: true });
    });

    it("'active' filters out deactivated persons", async () => {
      const { supabase } = makeSupabase({
        persons: [
          { id: VALID, tenant_id: 't1', active: false, anonymized_at: null, left_at: null },
        ],
      });
      await expect(
        assertTenantOwned(supabase as never, 'persons', VALID, 't1', {
          personState: 'active',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'reference.not_in_tenant' }),
      });
    });

    it("'active' filters out anonymized persons", async () => {
      const { supabase } = makeSupabase({
        persons: [
          {
            id: VALID,
            tenant_id: 't1',
            active: true,
            anonymized_at: '2026-01-01',
            left_at: null,
          },
        ],
      });
      await expect(
        assertTenantOwned(supabase as never, 'persons', VALID, 't1', {
          personState: 'active',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'reference.not_in_tenant' }),
      });
    });

    it("'active' filters out off-boarded persons (left_at IS NOT NULL)", async () => {
      const { supabase } = makeSupabase({
        persons: [
          {
            id: VALID,
            tenant_id: 't1',
            active: true,
            anonymized_at: null,
            left_at: '2026-01-01',
          },
        ],
      });
      await expect(
        assertTenantOwned(supabase as never, 'persons', VALID, 't1', {
          personState: 'active',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'reference.not_in_tenant' }),
      });
    });

    it("'active' passes a clean active+non-anonymized+non-left person", async () => {
      const { supabase, captures } = makeSupabase({
        persons: [
          {
            id: VALID,
            tenant_id: 't1',
            active: true,
            anonymized_at: null,
            left_at: null,
          },
        ],
      });
      await expect(
        assertTenantOwned(supabase as never, 'persons', VALID, 't1', {
          personState: 'active',
        }),
      ).resolves.toBeUndefined();
      // Verify the chain applied the filter (active=true + IS NULL on both
      // anonymized_at + left_at).
      expect(captures[0]).toMatchObject({
        table: 'persons',
        id: VALID,
        tenant_id: 't1',
        active: true,
        is_null_cols: expect.arrayContaining(['anonymized_at', 'left_at']),
      });
    });
  });
});

describe('assertTenantOwnedAll', () => {
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';
  const C = '00000000-0000-4000-8000-00000000000c';

  it('returns the deduplicated set when every id is in tenant', async () => {
    const { supabase, captures } = makeSupabase({
      persons: [
        { id: A, tenant_id: 't1' },
        { id: B, tenant_id: 't1' },
      ],
    });
    const out = await assertTenantOwnedAll(
      supabase as never,
      'persons',
      [A, A, B],
      't1',
    );
    expect(out.sort()).toEqual([A, B].sort());
    expect(captures[0]).toMatchObject({ table: 'persons', tenant_id: 't1' });
  });

  it('returns empty for empty / null / undefined input', async () => {
    const { supabase, captures } = makeSupabase({});
    expect(await assertTenantOwnedAll(supabase as never, 'persons', [], 't1')).toEqual([]);
    expect(await assertTenantOwnedAll(supabase as never, 'persons', null, 't1')).toEqual([]);
    expect(await assertTenantOwnedAll(supabase as never, 'persons', undefined, 't1')).toEqual([]);
    expect(captures).toEqual([]);
  });

  it('throws reference.not_in_tenant when at least one id is missing or wrong-tenant', async () => {
    const { supabase } = makeSupabase({
      persons: [
        { id: A, tenant_id: 't1' },
        { id: B, tenant_id: 'other' }, // wrong tenant — should be reported missing
      ],
    });
    await expect(
      assertTenantOwnedAll(supabase as never, 'persons', [A, B], 't1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'reference.not_in_tenant',
        missing_ids: [B],
      }),
    });
  });

  it('throws reference.invalid_uuid for malformed entries', async () => {
    const { supabase } = makeSupabase({});
    await expect(
      assertTenantOwnedAll(supabase as never, 'persons', [A, 'bad'], 't1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'reference.invalid_uuid' }),
    });
  });

  it('throws reference.too_many when array exceeds the cap', async () => {
    const ids = Array.from({ length: 201 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const { supabase } = makeSupabase({});
    await expect(
      assertTenantOwnedAll(supabase as never, 'persons', ids, 't1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'reference.too_many' }),
    });
  });

  it('skipForSystemActor returns empty without querying', async () => {
    const { supabase, captures } = makeSupabase({});
    expect(
      await assertTenantOwnedAll(supabase as never, 'persons', [A, B, C], 't1', {
        skipForSystemActor: true,
      }),
    ).toEqual([]);
    expect(captures).toEqual([]);
  });

  // Plan A.4 / Commit 1 (N1) — invariant guard.
  it('throws plain Error when tenantId is missing/empty/non-string', async () => {
    const { supabase, captures } = makeSupabase({});
    await expect(
      assertTenantOwnedAll(supabase as never, 'persons', [A, B], ''),
    ).rejects.toThrow(/invariant: tenantId required/);
    await expect(
      assertTenantOwnedAll(
        supabase as never,
        'persons',
        [A, B],
        undefined as unknown as string,
      ),
    ).rejects.toThrow(/invariant: tenantId required/);
    expect(captures).toEqual([]);
  });

  it('does NOT throw the invariant for empty/null/undefined ids OR system actor', async () => {
    const { supabase } = makeSupabase({});
    // Empty array short-circuits before the invariant — caller may legitimately
    // pass empty for "no co-hosts to validate".
    await expect(
      assertTenantOwnedAll(supabase as never, 'persons', [], '' as string),
    ).resolves.toEqual([]);
    // System actor short-circuits too.
    await expect(
      assertTenantOwnedAll(supabase as never, 'persons', [A, B], '', {
        skipForSystemActor: true,
      }),
    ).resolves.toEqual([]);
  });

  // Plan A.4 / Commit 1 (N3) — personState option on the array helper.
  describe('personState filter', () => {
    it("default 'any' does NOT filter on active/anonymized_at/left_at", async () => {
      const { supabase } = makeSupabase({
        persons: [
          { id: A, tenant_id: 't1', active: false, anonymized_at: '2026-01-01' },
        ],
      });
      await expect(
        assertTenantOwnedAll(supabase as never, 'persons', [A], 't1'),
      ).resolves.toEqual([A]);
    });

    it("'active' rejects when ANY id is deactivated/anonymized/off-boarded", async () => {
      const { supabase } = makeSupabase({
        persons: [
          { id: A, tenant_id: 't1', active: true, anonymized_at: null, left_at: null },
          { id: B, tenant_id: 't1', active: false, anonymized_at: null, left_at: null },
        ],
      });
      await expect(
        assertTenantOwnedAll(supabase as never, 'persons', [A, B], 't1', {
          personState: 'active',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'reference.not_in_tenant',
          missing_ids: [B],
        }),
      });
    });
  });
});
