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
};

function makeSupabase(rowsByTable: Record<string, Array<{ id: string; tenant_id: string; active?: boolean; reservable?: boolean }>>) {
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
});
