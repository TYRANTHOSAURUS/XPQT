import { TicketService, UpdateTicketDto } from './ticket.service';
import { BadRequestException } from '@nestjs/common';

type Row = {
  id: string;
  tenant_id: string;
  ticket_kind: 'case' | 'work_order';
  status_category: string;
  sla_id: string | null;
};

function makeDeps(parent: Row, openChildren: string[]) {
  let row = { ...parent };
  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        // Step 1c.10c: parent close guard now queries work_orders for children.
        if (table === 'tickets' || table === 'work_orders') {
          return {
            select: (cols?: string) => {
              // children query path: select id from work_orders where parent_ticket_id = X and status not in (resolved, closed)
              if (table === 'work_orders' || (cols && cols.includes('id') && !cols.includes('*'))) {
                return {
                  eq: () => ({
                    eq: () => ({
                      not: () => ({
                        async then(cb: (v: { data: Array<{ id: string }>; error: null }) => unknown) {
                          return cb({ data: openChildren.map((id) => ({ id })), error: null });
                        },
                      }),
                    }),
                  }),
                };
              }
              return {
                eq: () => ({
                  eq: () => ({
                    single: async () => ({ data: row, error: null }),
                  }),
                  single: async () => ({ data: row, error: null }),
                }),
              };
            },
            update: (patch: Record<string, unknown>) => {
              row = { ...row, ...patch };
              return {
                eq: () => ({
                  eq: () => ({
                    select: () => ({ single: async () => ({ data: row, error: null }) }),
                  }),
                  select: () => ({ single: async () => ({ data: row, error: null }) }),
                }),
              };
            },
          } as unknown;
        }
        return {
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        } as unknown;
      }),
    },
  };

  const visibility = {
    loadContext: jest.fn().mockResolvedValue({}),
    assertVisible: jest.fn().mockResolvedValue(undefined),
  };
  const slaService = {
    pauseTimers: jest.fn(), resumeTimers: jest.fn(), completeTimers: jest.fn(), restartTimers: jest.fn(),
  };
  const svc = new TicketService(
    supabase as never, {} as never, slaService as never, {} as never, {} as never, visibility as never,
    { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
  );
  return { svc, row: () => row };
}

describe('TicketService.update — parent close guard', () => {
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue({ id: 't1', subdomain: 't1' });
  });

  it('refuses to resolve a case while it has open children', async () => {
    const { svc } = makeDeps(
      { id: 'c1', tenant_id: 't1', ticket_kind: 'case', status_category: 'assigned', sla_id: null },
      ['wo-a', 'wo-b'],
    );
    await expect(
      svc.update('c1', { status_category: 'resolved' } as UpdateTicketDto, '__system__'),
    ).rejects.toThrow(BadRequestException);
  });

  it('allows resolving a case with no open children', async () => {
    const { svc, row } = makeDeps(
      { id: 'c1', tenant_id: 't1', ticket_kind: 'case', status_category: 'assigned', sla_id: null },
      [],
    );
    await svc.update('c1', { status_category: 'resolved' } as UpdateTicketDto, '__system__');
    expect(row().status_category).toBe('resolved');
  });

  // Step 1c.10c: ticket.service.update is case-only post-cutover. Work-order
  // updates go through dispatch/work-order paths. The "resolve a child WO
  // through ticket.service.update" scenario no longer applies.
  it.skip('OBSOLETE post-1c.10c: allows resolving a child work_order regardless of its siblings', async () => {
    // Test scenario removed — ticket.service.update is case-only now.
  });
});
