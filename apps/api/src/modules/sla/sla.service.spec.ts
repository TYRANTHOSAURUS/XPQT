import { SlaService } from './sla.service';

describe('SlaService.stopTimers', () => {
  it('updates active timers with stopped_at and stopped_reason, scoped to ticket + tenant', async () => {
    const captured: Array<{ patch: Record<string, unknown>; filters: Record<string, unknown> }> = [];

    const chain = (filters: Record<string, unknown>) => ({
      eq: (col: string, val: unknown) => chain({ ...filters, [col]: val }),
      is: (col: string, val: unknown) => chain({ ...filters, [col]: val }),
      then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
    });

    const supabase = {
      admin: {
        from: (table: string) => {
          expect(table).toBe('sla_timers');
          return {
            update: (patch: Record<string, unknown>) => {
              const root = (filters: Record<string, unknown>) => ({
                eq: (col: string, val: unknown) => root({ ...filters, [col]: val }),
                is: (col: string, val: unknown) => {
                  const merged = { ...filters, [col]: val };
                  return {
                    eq: (c: string, v: unknown) => {
                      // Not used in stopTimers chain.
                      captured.push({ patch, filters: { ...merged, [c]: v } });
                      return Promise.resolve({ data: null, error: null });
                    },
                    is: (c: string, v: unknown) => {
                      captured.push({ patch, filters: { ...merged, [c]: v } });
                      return Promise.resolve({ data: null, error: null });
                    },
                  };
                },
              });
              return root({});
            },
          };
        },
      },
    };

    const svc = new SlaService(supabase as any, {} as any, {} as any);
    await svc.stopTimers('t1', 'ten1', 'reclassified');

    expect(captured).toHaveLength(1);
    expect(captured[0].patch.stopped_reason).toBe('reclassified');
    expect(captured[0].patch.stopped_at).toEqual(expect.any(String));
    expect(captured[0].filters).toMatchObject({
      ticket_id: 't1',
      tenant_id: 'ten1',
      stopped_at: null,
      completed_at: null,
    });
  });
});
