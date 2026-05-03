import { MealWindowsService, type MealWindowRow } from './meal-windows.service';
import type { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

interface EqCall {
  col: string;
  val: unknown;
}

function buildSupabase(rows: MealWindowRow[]) {
  const eqCalls: EqCall[] = [];
  const builder: any = {
    from: () => builder,
    select: () => builder,
    eq: (col: string, val: unknown) => {
      eqCalls.push({ col, val });
      return builder;
    },
    order: () => Promise.resolve({ data: rows, error: null }),
  };
  return { supabase: { admin: builder } as unknown as SupabaseService, eqCalls };
}

describe('MealWindowsService.list', () => {
  it('returns active meal windows scoped to current tenant, ordered by start_time', async () => {
    const rows: MealWindowRow[] = [
      {
        id: 'w1',
        tenant_id: 't1',
        label: 'Lunch',
        start_time: '11:30:00',
        end_time: '13:30:00',
        active: true,
      },
    ];
    const { supabase, eqCalls } = buildSupabase(rows);
    const svc = new MealWindowsService(supabase);
    const result = await TenantContext.run(
      { id: 't1', slug: 't1', tier: 'standard' },
      () => svc.list(),
    );
    expect(result).toEqual(rows);
    expect(eqCalls).toEqual([
      { col: 'tenant_id', val: 't1' },
      { col: 'active', val: true },
    ]);
  });
});
