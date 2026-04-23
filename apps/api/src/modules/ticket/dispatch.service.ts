import { BadRequestException, Injectable, Inject, forwardRef } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RoutingService } from '../routing/routing.service';
import { ScopeOverrideResolverService } from '../routing/scope-override-resolver.service';
import { SlaService } from '../sla/sla.service';
import { TicketService, SYSTEM_ACTOR } from './ticket.service';
import { TicketVisibilityService } from './ticket-visibility.service';

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
  /**
   * Executor's SLA policy. `undefined` = fall through to vendor/team defaults.
   * Explicit `null` = "No SLA" — dispatch with no SLA timers running.
   */
  sla_id?: string | null;
}

@Injectable()
export class DispatchService {
  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => TicketService)) private readonly tickets: TicketService,
    private readonly routingService: RoutingService,
    private readonly slaService: SlaService,
    private readonly visibility: TicketVisibilityService,
    private readonly scopeOverrides: ScopeOverrideResolverService,
  ) {}

  async dispatch(parentId: string, dto: DispatchDto, actorAuthUid: string) {
    const tenant = TenantContext.current();

    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertVisible(parentId, ctx, 'write');
    }

    if (!dto.title?.trim()) {
      throw new BadRequestException('dispatch requires a non-empty title');
    }

    // getById throws NotFoundException on miss — no null guard needed
    const parent = await this.tickets.getById(parentId, SYSTEM_ACTOR) as Record<string, unknown>;
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

    // Load request type for routing domain only (NOT for SLA — child SLAs are independent).
    const rtCfg = ticketTypeId
      ? await this.loadRequestTypeConfig(ticketTypeId)
      : { domain: null };

    // Build the row WITHOUT sla_id — resolved after routing fills in assignees.
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
      sla_id: null, // placeholder; resolveChildSla overwrites if it finds one
    };

    // Routing fills in assignees if none were passed.
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
      // Child work-order dispatch → evaluator's 'child_dispatch' hook. During
      // dual-run this is a pass-through to the legacy resolver; once a tenant
      // attaches a child_dispatch_policy and flips routing_v2_mode, the v2
      // split + per-child resolver takes over.
      routingEvaluation = await this.routingService.evaluate(routingCtx, 'child_dispatch');
      if (routingEvaluation.target) {
        if (routingEvaluation.target.kind === 'team') row.assigned_team_id = routingEvaluation.target.team_id;
        if (routingEvaluation.target.kind === 'user') row.assigned_user_id = routingEvaluation.target.user_id;
        if (routingEvaluation.target.kind === 'vendor') row.assigned_vendor_id = routingEvaluation.target.vendor_id;
        row.status_category = 'assigned';
      }
    } else if (row.assigned_team_id || row.assigned_user_id || row.assigned_vendor_id) {
      row.status_category = 'assigned';
    }

    // Resolve child SLA based on (now finalised) assignees + dto override.
    const resolvedSlaId = await this.resolveChildSla(dto, row);
    row.sla_id = resolvedSlaId;

    const { data: inserted, error } = await this.supabase.admin
      .from('tickets')
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    const child = inserted as Record<string, unknown>;

    // Post-insert side effects.
    try {
      if (routingCtx && routingEvaluation) {
        routingCtx.ticket_id = child.id as string;
        await this.routingService.recordDecision(child.id as string, routingCtx, routingEvaluation);
      }

      if (resolvedSlaId) {
        await this.slaService.startTimers(child.id as string, tenant.id, resolvedSlaId);
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
          sla_id: resolvedSlaId,
        },
      }, undefined, SYSTEM_ACTOR);
    } catch (err) {
      console.error('[dispatch] post-insert automation failed', err);
    }

    return child;
  }

  /**
   * Resolve which sla_policy_id to attach to a child work order.
   * Order: explicit dto.sla_id → scope-override executor_sla_policy_id →
   * vendor default → team default → user.team default → null.
   * `dto.sla_id === null` is a deliberate "No SLA" choice and short-circuits.
   *
   * Scope override is looked up against the child's location (falls back to
   * parent location when the child inherits). See live-doc §5.5 + §7.4.
   */
  private async resolveChildSla(
    dto: DispatchDto,
    row: Record<string, unknown>,
  ): Promise<string | null> {
    if (dto.sla_id !== undefined) return dto.sla_id; // explicit (string | null)

    const tenantId = TenantContext.current().id;

    const requestTypeId = row.ticket_type_id as string | null;
    if (requestTypeId) {
      // Asset-only children (no row.location_id but row.asset_id set) must
      // still hit the executor-SLA override — delegate to the centralized
      // effective-location derivation in ScopeOverrideResolverService.
      const override = await this.scopeOverrides.resolve(tenantId, requestTypeId, {
        locationId: (row.location_id as string | null) ?? null,
        assetId: (row.asset_id as string | null) ?? null,
      });
      if (override?.executor_sla_policy_id) return override.executor_sla_policy_id;
    }

    const vendorId = row.assigned_vendor_id as string | null;
    if (vendorId) {
      const { data } = await this.supabase.admin
        .from('vendors')
        .select('default_sla_policy_id')
        .eq('id', vendorId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      const id = (data as { default_sla_policy_id: string | null } | null)?.default_sla_policy_id;
      if (id) return id;
    }

    const teamId = row.assigned_team_id as string | null;
    if (teamId) {
      const { data } = await this.supabase.admin
        .from('teams')
        .select('default_sla_policy_id')
        .eq('id', teamId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      const id = (data as { default_sla_policy_id: string | null } | null)?.default_sla_policy_id;
      if (id) return id;
    }

    const userId = row.assigned_user_id as string | null;
    if (userId) {
      const { data: user } = await this.supabase.admin
        .from('users')
        .select('team_id')
        .eq('id', userId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      const userTeamId = (user as { team_id: string | null } | null)?.team_id;
      if (userTeamId) {
        const { data: team } = await this.supabase.admin
          .from('teams')
          .select('default_sla_policy_id')
          .eq('id', userTeamId)
          .eq('tenant_id', tenantId)
          .maybeSingle();
        const id = (team as { default_sla_policy_id: string | null } | null)?.default_sla_policy_id;
        if (id) return id;
      }
    }

    return null;
  }

  // Consolidated single request-type loader — domain only (SLA resolved separately via resolveChildSla)
  private async loadRequestTypeConfig(id: string): Promise<{ domain: string | null }> {
    const { data } = await this.supabase.admin
      .from('request_types')
      .select('domain')
      .eq('id', id)
      .maybeSingle();
    const d = data as { domain: string | null } | null;
    return { domain: d?.domain ?? null };
  }
}
