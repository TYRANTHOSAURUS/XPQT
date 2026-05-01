import { TicketService, UpdateTicketDto } from './ticket.service';
import { BadRequestException } from '@nestjs/common';

type Row = {
  id: string;
  tenant_id: string;
  ticket_kind: 'case' | 'work_order';
  status_category: string;
  sla_id: string | null;
};

function makeDeps(initial: Row) {
  let row = { ...initial };
  const updates: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'tickets') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: async () => ({ data: row, error: null }),
                }),
                single: async () => ({ data: row, error: null }),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              updates.push(patch);
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
        // Catch-all for ticket_activities + domain_events + anything else the update path touches.
        return {
          insert: (a: Record<string, unknown>) => {
            activities.push(a);
            return {
              select: () => ({
                single: async () => ({ data: { ...a, id: 'generated' }, error: null }),
              }),
            };
          },
        } as unknown;
      }),
    },
  };

  const slaService = {
    restartTimers: jest.fn().mockResolvedValue(undefined),
    pauseTimers: jest.fn().mockResolvedValue(undefined),
    resumeTimers: jest.fn().mockResolvedValue(undefined),
    completeTimers: jest.fn().mockResolvedValue(undefined),
  };

  return { row: () => row, updates, activities, supabase, slaService };
}

function makeSvc(deps: ReturnType<typeof makeDeps>) {
  const visibility = {
    loadContext: jest.fn().mockResolvedValue({}),
    assertVisible: jest.fn().mockResolvedValue(undefined),
  };
  const routingService = {} as never;
  const workflowEngine = {} as never;
  const approvalService = {} as never;
  return new TicketService(
    deps.supabase as never,
    routingService,
    deps.slaService as never,
    workflowEngine,
    approvalService,
    visibility as never,
    { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
  );
}

describe('TicketService.update — sla_id', () => {
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue({ id: 't1', subdomain: 't1' });
  });

  it('refuses sla_id change on a parent case', async () => {
    const deps = makeDeps({ id: 'c1', tenant_id: 't1', ticket_kind: 'case', status_category: 'assigned', sla_id: 'sla-old' });
    const svc = makeSvc(deps);
    await expect(
      svc.update('c1', { sla_id: 'sla-new' } as UpdateTicketDto, '__system__'),
    ).rejects.toThrow(BadRequestException);
    expect(deps.slaService.restartTimers).not.toHaveBeenCalled();
  });

  // Step 1c.10c: ticket.service.update is case-only post-cutover. SLA edits
  // on work_orders moved to WorkOrderService.updateSla — see
  // `apps/api/src/modules/work-orders/work-order-sla-edit.spec.ts`.
});
