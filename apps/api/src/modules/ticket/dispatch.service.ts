import { BadRequestException, Injectable, Inject, forwardRef } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RoutingService } from '../routing/routing.service';
import { SlaService } from '../sla/sla.service';
import { TicketService } from './ticket.service';

export interface DispatchDto {
  title: string;
  description?: string;
  assigned_team_id?: string;
  assigned_user_id?: string;
  assigned_vendor_id?: string;
  priority?: string;
  interaction_mode?: 'internal' | 'external';
  ticket_type_id?: string;
  asset_id?: string;
  location_id?: string;
}

@Injectable()
export class DispatchService {
  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => TicketService)) private readonly tickets: TicketService,
    @Inject(forwardRef(() => RoutingService)) private readonly routingService: RoutingService,
    private readonly slaService: SlaService,
  ) {}

  async dispatch(parentId: string, dto: DispatchDto) {
    const tenant = TenantContext.current();
    const parent = (await this.tickets.getById(parentId)) as Record<string, unknown>;
    if (!parent) throw new BadRequestException(`parent ${parentId} not found`);
    if (parent.ticket_kind === 'work_order') {
      throw new BadRequestException('cannot dispatch from a work_order; dispatch from the parent case');
    }

    const ticketTypeId = dto.ticket_type_id ?? (parent.ticket_type_id as string | null);
    const locationId = dto.location_id ?? (parent.location_id as string | null);
    const assetId = dto.asset_id ?? (parent.asset_id as string | null);
    const priority = dto.priority ?? ((parent.priority as string | null) ?? 'medium');

    const row: Record<string, unknown> = {
      tenant_id: tenant.id,
      parent_ticket_id: parentId,
      ticket_kind: 'work_order',
      ticket_type_id: ticketTypeId,
      title: dto.title,
      description: dto.description ?? null,
      priority,
      interaction_mode: dto.interaction_mode ?? 'internal',
      location_id: locationId,
      asset_id: assetId,
      requester_person_id: (parent.requester_person_id as string | null) ?? null,
      status: 'new',
      status_category: 'new',
      assigned_team_id: dto.assigned_team_id ?? null,
      assigned_user_id: dto.assigned_user_id ?? null,
      assigned_vendor_id: dto.assigned_vendor_id ?? null,
    };

    let routingCtx: Parameters<RoutingService['evaluate']>[0] | null = null;
    if (!row.assigned_team_id && !row.assigned_user_id && !row.assigned_vendor_id && ticketTypeId) {
      const rtCfg = await this.loadRequestTypeDomain(ticketTypeId);
      routingCtx = {
        tenant_id: tenant.id,
        ticket_id: 'pending',
        request_type_id: ticketTypeId,
        domain: rtCfg.domain,
        priority,
        asset_id: assetId,
        location_id: locationId,
      };
      const evaluation = await this.routingService.evaluate(routingCtx);
      if (evaluation.target) {
        if (evaluation.target.kind === 'team') row.assigned_team_id = evaluation.target.team_id;
        if (evaluation.target.kind === 'user') row.assigned_user_id = evaluation.target.user_id;
        if (evaluation.target.kind === 'vendor') row.assigned_vendor_id = evaluation.target.vendor_id;
        row.status_category = 'assigned';
      }
    } else if (row.assigned_team_id || row.assigned_user_id || row.assigned_vendor_id) {
      row.status_category = 'assigned';
    }

    const { data: inserted, error } = await this.supabase.admin
      .from('tickets')
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    const child = inserted as Record<string, unknown>;

    if (routingCtx) {
      routingCtx.ticket_id = child.id as string;
      const evaluation = await this.routingService.evaluate(routingCtx);
      await this.routingService.recordDecision(child.id as string, routingCtx, evaluation);
    }

    if (ticketTypeId) {
      const cfg = await this.loadRequestTypeSla(ticketTypeId);
      if (cfg.sla_policy_id) {
        await this.slaService.startTimers(child.id as string, tenant.id, cfg.sla_policy_id);
        await this.supabase.admin.from('tickets')
          .update({ sla_id: cfg.sla_policy_id })
          .eq('id', child.id as string);
      }
    }

    await this.tickets.addActivity(parentId, {
      activity_type: 'system_event',
      visibility: 'system',
      metadata: {
        event: 'dispatched',
        child_id: child.id,
        assigned_team_id: row.assigned_team_id,
        assigned_user_id: row.assigned_user_id,
        assigned_vendor_id: row.assigned_vendor_id,
      },
    });

    return child;
  }

  private async loadRequestTypeDomain(id: string): Promise<{ domain: string | null }> {
    const { data } = await this.supabase.admin
      .from('request_types')
      .select('domain')
      .eq('id', id)
      .single();
    return { domain: (data as { domain: string | null } | null)?.domain ?? null };
  }

  private async loadRequestTypeSla(id: string): Promise<{ sla_policy_id: string | null }> {
    const { data } = await this.supabase.admin
      .from('request_types')
      .select('sla_policy_id')
      .eq('id', id)
      .single();
    return { sla_policy_id: (data as { sla_policy_id: string | null } | null)?.sla_policy_id ?? null };
  }
}
