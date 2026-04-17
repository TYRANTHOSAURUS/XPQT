import { Test } from '@nestjs/testing';
import { TicketService } from './ticket.service';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RoutingService } from '../routing/routing.service';
import { SlaService } from '../sla/sla.service';
import { WorkflowEngineService } from '../workflow/workflow-engine.service';
import { ApprovalService } from '../approval/approval.service';

describe('TicketService.listDistinctTags', () => {
  const tenantAId = '00000000-0000-0000-0000-00000000000a';
  const tenantBId = '00000000-0000-0000-0000-00000000000b';

  let service: TicketService;
  let supabase: { admin: any };
  let rpcMock: jest.Mock;

  beforeEach(async () => {
    rpcMock = jest.fn();
    supabase = {
      admin: {
        rpc: rpcMock,
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TicketService,
        { provide: SupabaseService, useValue: supabase },
        { provide: RoutingService, useValue: {} },
        { provide: SlaService, useValue: {} },
        { provide: WorkflowEngineService, useValue: {} },
        { provide: ApprovalService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(TicketService);
  });

  it('returns distinct tenant-scoped tags sorted alphabetically', async () => {
    rpcMock.mockResolvedValue({ data: [{ tag: 'billing' }, { tag: 'hvac' }, { tag: 'urgent' }], error: null });

    const result = await TenantContext.run(
      { id: tenantAId, subdomain: 'a' } as any,
      () => service.listDistinctTags(),
    );

    expect(result).toEqual(['billing', 'hvac', 'urgent']);
    expect(rpcMock).toHaveBeenCalledWith('tickets_distinct_tags', { tenant: tenantAId });
  });

  it('passes the current tenant id — never leaks across tenants', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });

    await TenantContext.run({ id: tenantBId, subdomain: 'b' } as any, () => service.listDistinctTags());

    expect(rpcMock).toHaveBeenCalledWith('tickets_distinct_tags', { tenant: tenantBId });
  });

  it('returns [] when the RPC returns no data', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });

    const result = await TenantContext.run(
      { id: tenantAId, subdomain: 'a' } as any,
      () => service.listDistinctTags(),
    );

    expect(result).toEqual([]);
  });

  it('throws when the RPC returns an error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });

    await expect(
      TenantContext.run({ id: tenantAId, subdomain: 'a' } as any, () => service.listDistinctTags()),
    ).rejects.toBeTruthy();
  });
});
