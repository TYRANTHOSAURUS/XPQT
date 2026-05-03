import { MealWindowsService, type MealWindowRow } from './meal-windows.service';
import type { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

function buildSupabase(rows: MealWindowRow[]): SupabaseService {
  const builder: any = {
    from: () => builder,
    select: () => builder,
    eq: () => builder,
    order: () => Promise.resolve({ data: rows, error: null }),
  };
  return { admin: builder } as unknown as SupabaseService;
}

describe('MealWindowsService.list', () => {
  it('returns all active meal windows for the current tenant', async () => {
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
    const svc = new MealWindowsService(buildSupabase(rows));
    const result = await TenantContext.run(
      { id: 't1', slug: 't1', tier: 'standard' },
      () => svc.list(),
    );
    expect(result).toEqual(rows);
  });
});
