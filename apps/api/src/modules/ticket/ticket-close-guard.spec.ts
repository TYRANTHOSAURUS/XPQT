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
        if (table === 'tickets') {
          return {
            select: (cols?: string) => {
              // children query path: select id from tickets where parent_ticket_id = X and status not in (resolved, closed)
              if (cols && cols.includes('id') && !cols.includes('*')) {
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

  it('allows resolving a child work_order regardless of its siblings', async () => {
    const { svc, row } = makeDeps(
      { id: 'wo1', tenant_id: 't1', ticket_kind: 'work_order', status_category: 'assigned', sla_id: null },
      ['wo-a'],
    );
    await svc.update('wo1', { status_category: 'resolved' } as UpdateTicketDto, '__system__');
    expect(row().status_category).toBe('resolved');
  });
});
