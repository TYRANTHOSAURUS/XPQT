import { BadRequestException, Injectable, Inject, forwardRef } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import {
  assertTenantOwned,
  validateAssigneesInTenant,
} from '../../common/tenant-validation';
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
    // The parent-close trigger (00134) rejects child inserts under terminal
    // parents at the DB level. Catch it here for a friendly 400 instead of
    // a generic 500.
    if (parent.status_category === 'resolved' || parent.status_category === 'closed') {
      throw new BadRequestException(
        `cannot dispatch a work order on a ${parent.status_category as string} case`,
      );
    }

    const ticketTypeId = dto.ticket_type_id ?? (parent.ticket_type_id as string | null);
    const locationId = dto.location_id ?? (parent.location_id as string | null);
    const assetId = dto.asset_id ?? (parent.asset_id as string | null);
    const priority = dto.priority ?? ((parent.priority as string | null) ?? 'medium');

    // Plan A.2 — gap map §dispatch.service.ts:69,97-99,186. The dispatched
    // row will write ticket_type_id + assigned_*_id + sla_id as FKs to
    // tenant-owned tables; FKs prove existence globally but NOT tenant
    // ownership. Validate every uuid that came from `dto` BEFORE the row
    // insert at line 87 (and BEFORE resolveChildSla returns dto.sla_id).
    //
    // Plan A.4 / Commit 2 (C1) — system actor MUST validate FK refs.
    // The pre-A.4 code passed `skipForSystemActor: actorAuthUid ===
    // SYSTEM_ACTOR` on these calls. That was wrong: system actor should
    // bypass visibility/permission gates (the workflow engine + cron jobs
    // legitimately operate on rows they couldn't otherwise see), but it
    // must NEVER bypass data-integrity validation. Workflow node configs,
    // routing config, and templates are user-authored JSONB — a forged or
    // malformed definition can carry a foreign-tenant uuid and the system
    // actor would write it blind. The dispatch path is the primary
    // entry-point for create_child_tasks; this is the right place to
    // enforce. (Round-4 codex flag: dispatch.service.ts:94, 108, 121, 270.)
    //
    // ticket_type_id only when it came from the DTO — when inherited from
    // parent it was already tenant-loaded by getById's visibility check.
    if (dto.ticket_type_id !== undefined && dto.ticket_type_id !== null) {
      await assertTenantOwned(
        this.supabase,
        'request_types',
        dto.ticket_type_id,
        tenant.id,
        { entityName: 'request type' },
      );
    }
    // Assignees: assigned_team_id / assigned_user_id / assigned_vendor_id.
    // Mirror of TicketService.update + WorkOrderService.updateMetadata.
    await validateAssigneesInTenant(
      this.supabase,
      {
        assigned_team_id: dto.assigned_team_id,
        assigned_user_id: dto.assigned_user_id,
        assigned_vendor_id: dto.assigned_vendor_id,
      },
      tenant.id,
    );
    // Explicit dto.sla_id — null is "No SLA" (valid); a string must be a
    // policy in this tenant. resolveChildSla will return this value blind
    // at line 186 below if we don't validate here first.
    if (typeof dto.sla_id === 'string') {
      await assertTenantOwned(
        this.supabase,
        'sla_policies',
        dto.sla_id,
        tenant.id,
        { entityName: 'SLA policy' },
      );
    }

    // Load request type for routing domain only (NOT for SLA — child SLAs are independent).
    const rtCfg = ticketTypeId
      ? await this.loadRequestTypeConfig(ticketTypeId)
      : { domain: null };

    // Step 1c.4 cutover (data-model-redesign-2026-04-30.md): write directly
    // to public.work_orders. ticket_kind is gone (work_orders is single-kind);
    // parent_kind='case' explicit (dispatch is always case→wo). The reverse
    // shadow trigger keeps tickets in sync during the bridge.
    const row: Record<string, unknown> = {
      tenant_id: tenant.id,
      parent_kind: 'case',
      parent_ticket_id: parentId,
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
    // Plan A.4 / Commit 2 (C1) — actorAuthUid no longer threaded; the
    // override-SLA validator now runs unconditionally (no system-actor
    // bypass).
    const resolvedSlaId = await this.resolveChildSla(dto, row);
    row.sla_id = resolvedSlaId;

    const { data: inserted, error } = await this.supabase.admin
      .from('work_orders')
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
      if (override?.executor_sla_policy_id) {
        // Plan A.2 / Commit 7 / gap map §MEDIUM dispatch.service.ts:199.
        // The scope-override resolver IS tenant-scoped today (its loader
        // filters by tenantId — see scope-override-resolver.service.ts),
        // but defense-in-depth here means a future change to the resolver
        // can't silently re-introduce a cross-tenant FK write. Cheap
        // round-trip; only fires when an override is found.
        //
        // Plan A.4 / Commit 2 (C1) — drop skipForSystemActor. Scope
        // overrides are user-authored config, not pre-trusted system
        // data — system-actor execution paths (create_child_tasks +
        // post-create automation) MUST validate the FK ref. The defense-
        // in-depth guard exists exactly for the system path that bypasses
        // dto-level validation; skipping it for system actor was the
        // bug-class round-4 codex flagged.
        await assertTenantOwned(
          this.supabase,
          'sla_policies',
          override.executor_sla_policy_id,
          tenantId,
          { entityName: 'override executor SLA policy' },
        );
        return override.executor_sla_policy_id;
      }
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

  // Consolidated single request-type loader — domain only (SLA resolved
  // separately via resolveChildSla). Tenant-filtered as defense-in-depth:
  // a foreign-tenant id passed via dto.ticket_type_id is rejected by the
  // assertTenantOwned check above, but inherited values from
  // parent.ticket_type_id were already trust-anchored to the parent's
  // tenant (visibility loadContext + getById). Filtering here too means
  // even if a future caller bypasses dispatch() (or the parent has been
  // mutated mid-call), the loader can't leak a foreign-tenant config.
  private async loadRequestTypeConfig(id: string): Promise<{ domain: string | null }> {
    const tenantId = TenantContext.current().id;
    const { data } = await this.supabase.admin
      .from('request_types')
      .select('domain')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    const d = data as { domain: string | null } | null;
    return { domain: d?.domain ?? null };
  }
}
