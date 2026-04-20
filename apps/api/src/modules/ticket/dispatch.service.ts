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
    private readonly routingService: RoutingService,
    private readonly slaService: SlaService,
  ) {}

  async dispatch(parentId: string, dto: DispatchDto) {
    const tenant = TenantContext.current();

    // Fix 5: validate title
    if (!dto.title?.trim()) {
      throw new BadRequestException('dispatch requires a non-empty title');
    }

    // Fix 2: getById throws NotFoundException on miss — no null guard needed
    const parent = await this.tickets.getById(parentId) as Record<string, unknown>;
    if (parent.ticket_kind === 'work_order') {
      throw new BadRequestException('cannot dispatch from a work_order; dispatch from the parent case');
    }

    if (parent.status_category === 'pending_approval') {
      throw new BadRequestException('cannot dispatch while parent is pending approval');
    }

    const ticketTypeId = dto.ticket_type_id ?? (parent.ticket_type_id as string | null);
    const locationId = dto.location_id ?? (parent.location_id as string | null);
    const assetId = dto.asset_id ?? (parent.asset_id as string | null);
    const priority = dto.priority ?? ((parent.priority as string | null) ?? 'medium');

    // Fix 3: single consolidated request-type load
    const rtCfg = ticketTypeId
      ? await this.loadRequestTypeConfig(ticketTypeId)
      : { domain: null, sla_policy_id: null };

    // Fix 3: include sla_id in initial insert row
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
      sla_id: rtCfg.sla_policy_id,
    };

    // Fix 1: single evaluate call, store result for reuse
    let routingCtx: Parameters<RoutingService['evaluate']>[0] | null = null;
    let routingEvaluation: Awaited<ReturnType<RoutingService['evaluate']>> | null = null;
    if (!row.assigned_team_id && !row.assigned_user_id && !row.assigned_vendor_id && ticketTypeId) {
      routingCtx = {
        tenant_id: tenant.id,
        ticket_id: 'pending',
        request_type_id: ticketTypeId,
        domain: rtCfg.domain,
        priority,
        asset_id: assetId,
        location_id: locationId,
      };
      routingEvaluation = await this.routingService.evaluate(routingCtx);
      if (routingEvaluation.target) {
        if (routingEvaluation.target.kind === 'team') row.assigned_team_id = routingEvaluation.target.team_id;
        if (routingEvaluation.target.kind === 'user') row.assigned_user_id = routingEvaluation.target.user_id;
        if (routingEvaluation.target.kind === 'vendor') row.assigned_vendor_id = routingEvaluation.target.vendor_id;
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

    // Fix 4: post-insert side effects wrapped — child exists, don't crash on automation failure
    try {
      // Fix 1: reuse stored evaluation — no second DB call
      if (routingCtx && routingEvaluation) {
        routingCtx.ticket_id = child.id as string;
        await this.routingService.recordDecision(child.id as string, routingCtx, routingEvaluation);
      }

      // Fix 3: sla_id already in insert; just start timers
      if (rtCfg.sla_policy_id) {
        await this.slaService.startTimers(child.id as string, tenant.id, rtCfg.sla_policy_id);
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
    } catch (err) {
      console.error('[dispatch] post-insert automation failed', err);
    }

    return child;
  }

  // Fix 3: consolidated single request-type loader
  private async loadRequestTypeConfig(id: string): Promise<{ domain: string | null; sla_policy_id: string | null }> {
    const { data } = await this.supabase.admin
      .from('request_types')
      .select('domain, sla_policy_id')
      .eq('id', id)
      .maybeSingle();
    const d = data as { domain: string | null; sla_policy_id: string | null } | null;
    return { domain: d?.domain ?? null, sla_policy_id: d?.sla_policy_id ?? null };
  }
}
