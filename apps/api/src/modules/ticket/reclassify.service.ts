import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
  forwardRef,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RoutingService } from '../routing/routing.service';
import { SlaService } from '../sla/sla.service';
import { WorkflowEngineService } from '../workflow/workflow-engine.service';
import { TicketService, SYSTEM_ACTOR } from './ticket.service';
import { TicketVisibilityService } from './ticket-visibility.service';
import type { ResolverContext, AssignmentTarget } from '../routing/resolver.types';
import type { ReclassifyImpactDto, ReclassifyExecuteDto } from './dto/reclassify.dto';

const IN_PROGRESS_CATEGORIES = new Set(['in_progress', 'assigned']);
const TERMINAL_CATEGORIES = new Set(['closed', 'resolved']);

interface TicketRow {
  id: string;
  tenant_id: string;
  ticket_type_id: string | null;
  ticket_kind: 'case' | 'work_order';
  status_category: string;
  assigned_team_id: string | null;
  assigned_user_id: string | null;
  assigned_vendor_id: string | null;
  location_id: string | null;
  asset_id: string | null;
  priority: string | null;
  watchers: string[] | null;
}

interface RequestTypeRow {
  id: string;
  name: string;
  domain: string | null;
  active: boolean;
  sla_policy_id: string | null;
  workflow_definition_id: string | null;
}

interface WorkflowInstanceWithDef {
  id: string;
  current_node_id: string | null;
  definition_name: string | null;
}

interface SlaPolicyRow {
  id: string;
  name: string;
  response_time_minutes: number | null;
  resolution_time_minutes: number | null;
}

interface TimerRow {
  id: string;
  timer_type: string;
  target_minutes: number;
  started_at: string;
}

interface ChildRow {
  id: string;
  title: string;
  status_category: string;
  assigned_team_id: string | null;
  assigned_user_id: string | null;
  assigned_vendor_id: string | null;
}

@Injectable()
export class ReclassifyService {
  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => TicketService)) private readonly tickets: TicketService,
    private readonly routingService: RoutingService,
    private readonly slaService: SlaService,
    private readonly workflowEngine: WorkflowEngineService,
    private readonly visibility: TicketVisibilityService,
  ) {}

  async computeImpact(
    ticketId: string,
    newRequestTypeId: string,
    actorAuthUid: string,
  ): Promise<ReclassifyImpactDto> {
    const tenant = TenantContext.current();

    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertVisible(ticketId, ctx, 'read');
    }

    const ticket = await this.loadTicket(ticketId, tenant.id);
    this.assertReclassifiable(ticket, newRequestTypeId);

    const [currentType, newType] = await Promise.all([
      ticket.ticket_type_id ? this.loadRequestType(ticket.ticket_type_id, tenant.id) : Promise.resolve(null),
      this.loadRequestType(newRequestTypeId, tenant.id),
    ]);
    if (!newType) throw new NotFoundException('new request type not found');
    if (!newType.active) {
      throw new UnprocessableEntityException('new request type is not active');
    }

    const [workflowInstance, newWorkflowDef, children, activeTimers, newPolicy] = await Promise.all([
      this.loadActiveWorkflowInstance(ticketId, tenant.id),
      newType.workflow_definition_id
        ? this.loadWorkflowDefinition(newType.workflow_definition_id, tenant.id)
        : Promise.resolve(null),
      this.loadChildren(ticketId, tenant.id),
      this.loadActiveTimers(ticketId, tenant.id),
      newType.sla_policy_id ? this.loadSlaPolicy(newType.sla_policy_id, tenant.id) : Promise.resolve(null),
    ]);

    const routingContext = this.buildRoutingContext(ticket, newType);
    const evaluation = await this.routingService.evaluate(routingContext);
    const now = Date.now();

    const currentUserAssignee = ticket.assigned_user_id;
    const newUserAssignee = evaluation.target?.kind === 'user' ? evaluation.target.user_id : null;
    const userBecomesWatcher =
      !!currentUserAssignee &&
      currentUserAssignee !== newUserAssignee &&
      !(ticket.watchers ?? []).includes(currentUserAssignee);

    const [teamNames, userNames, vendorNames] = await Promise.all([
      this.loadNames('teams', this.collectIds(ticket.assigned_team_id, evaluation.target, 'team'), tenant.id),
      this.loadNames('users', this.collectIds(ticket.assigned_user_id, evaluation.target, 'user'), tenant.id, 'email'),
      this.loadNames('vendors', this.collectIds(ticket.assigned_vendor_id, evaluation.target, 'vendor'), tenant.id),
    ]);

    return {
      ticket: {
        id: ticket.id,
        current_request_type: currentType
          ? { id: currentType.id, name: currentType.name }
          : { id: '', name: '(no type)' },
        new_request_type: { id: newType.id, name: newType.name },
      },
      workflow: {
        current_instance: workflowInstance
          ? {
              id: workflowInstance.id,
              definition_name: workflowInstance.definition_name ?? '(unnamed)',
              current_step: workflowInstance.current_node_id ?? '(unknown)',
            }
          : null,
        will_be_cancelled: !!workflowInstance,
        new_definition: newWorkflowDef ? { id: newWorkflowDef.id, name: newWorkflowDef.name } : null,
      },
      children: await this.labelChildren(children, tenant.id),
      sla: {
        active_timers: activeTimers.map((t) => ({
          id: t.id,
          metric_name: t.timer_type,
          elapsed_minutes: Math.max(0, Math.floor((now - new Date(t.started_at).getTime()) / 60000)),
          target_minutes: t.target_minutes,
        })),
        will_be_stopped: activeTimers.length > 0,
        new_policy: newPolicy
          ? {
              id: newPolicy.id,
              name: newPolicy.name,
              metrics: [
                ...(newPolicy.response_time_minutes
                  ? [{ name: 'response', target_minutes: newPolicy.response_time_minutes }]
                  : []),
                ...(newPolicy.resolution_time_minutes
                  ? [{ name: 'resolution', target_minutes: newPolicy.resolution_time_minutes }]
                  : []),
              ],
            }
          : null,
      },
      routing: {
        current_assignment: {
          ...(ticket.assigned_team_id && teamNames[ticket.assigned_team_id]
            ? { team: { id: ticket.assigned_team_id, name: teamNames[ticket.assigned_team_id] } }
            : {}),
          ...(ticket.assigned_user_id && userNames[ticket.assigned_user_id]
            ? { user: { id: ticket.assigned_user_id, name: userNames[ticket.assigned_user_id] } }
            : {}),
          ...(ticket.assigned_vendor_id && vendorNames[ticket.assigned_vendor_id]
            ? { vendor: { id: ticket.assigned_vendor_id, name: vendorNames[ticket.assigned_vendor_id] } }
            : {}),
        },
        new_decision: {
          ...this.targetWithNames(evaluation.target, teamNames, userNames, vendorNames),
          rule_name: evaluation.rule_name ?? evaluation.chosen_by,
          explanation: evaluation.rule_name
            ? `Matched rule: ${evaluation.rule_name}`
            : `Chosen by: ${evaluation.chosen_by}`,
        },
        current_user_will_become_watcher: userBecomesWatcher,
      },
    };
  }

  async execute(
    ticketId: string,
    dto: ReclassifyExecuteDto,
    actorAuthUid: string,
  ): Promise<unknown> {
    const tenant = TenantContext.current();

    if (!dto.reason || dto.reason.trim().length < 3) {
      throw new BadRequestException('reason must be at least 3 characters');
    }
    if (dto.reason.length > 500) {
      throw new BadRequestException('reason must be at most 500 characters');
    }

    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertVisible(ticketId, ctx, 'write');
    }

    // computeImpact also performs preflight guards (not child, not closed, types differ, type active).
    const impact = await this.computeImpact(ticketId, dto.newRequestTypeId, actorAuthUid);

    const hasInProgressChildren = impact.children.some((c) => c.is_in_progress);
    if (hasInProgressChildren && !dto.acknowledgedChildrenInProgress) {
      throw new BadRequestException('in-progress child work orders require acknowledgement');
    }

    const ticket = await this.loadTicket(ticketId, tenant.id);
    if (!ticket) throw new NotFoundException('ticket not found');
    const newType = await this.loadRequestType(dto.newRequestTypeId, tenant.id);
    if (!newType) throw new NotFoundException('new request type not found');

    const routingContext = this.buildRoutingContext(ticket, newType);
    const evaluation = await this.routingService.evaluate(routingContext);
    const target = evaluation.target;

    let actorUserId: string | null = null;
    if (actorAuthUid !== SYSTEM_ACTOR) {
      actorUserId = await this.resolveUserIdFromAuth(actorAuthUid, tenant.id);
      if (!actorUserId) {
        // Caller passed assertVisible via visibility.loadContext, so this should
        // be unreachable. If it happens, fail loudly — unattributable audit
        // events are worse than refusing the operation.
        throw new UnprocessableEntityException('actor user not resolvable in tenant');
      }
    }

    const { error: rpcError } = await this.supabase.admin.rpc('reclassify_ticket', {
      p_ticket_id: ticketId,
      p_tenant_id: tenant.id,
      p_new_request_type_id: dto.newRequestTypeId,
      p_reason: dto.reason,
      p_actor_user_id: actorUserId,
      p_new_assigned_team_id: target?.kind === 'team' ? target.team_id : null,
      p_new_assigned_user_id: target?.kind === 'user' ? target.user_id : null,
      p_new_assigned_vendor_id: target?.kind === 'vendor' ? target.vendor_id : null,
    });

    if (rpcError) {
      if (rpcError.code === '55P03') {
        throw new ConflictException('another reclassify is in progress for this ticket');
      }
      if (rpcError.code === 'P0002' || rpcError.message?.includes('ticket_not_found')) {
        throw new NotFoundException('ticket not found');
      }
      if (rpcError.code === '22023' || rpcError.message?.includes('same_request_type')) {
        throw new BadRequestException('new request type is the same as current');
      }
      throw rpcError;
    }

    // Activity feed entry — shown in the ticket's Activity tab as a system row.
    // One entry per reclassify, including the full impact summary so anyone
    // reviewing the ticket history can see what changed without clicking
    // through to the audit log.
    try {
      await this.tickets.addActivity(ticketId, {
        activity_type: 'system_event',
        visibility: 'system',
        metadata: {
          event: `Reclassified from "${impact.ticket.current_request_type.name}" to "${impact.ticket.new_request_type.name}"`,
          event_type: 'request_type_changed',
          from_request_type: impact.ticket.current_request_type,
          to_request_type: impact.ticket.new_request_type,
          reason: dto.reason,
          closed_child_count: impact.children.length,
          cancelled_workflow: impact.workflow.will_be_cancelled,
        },
      });
    } catch (err) {
      console.error('[reclassify] addActivity failed', err);
    }

    // Post-RPC best-effort side effects. The RPC has already committed; any
    // failure here is recoverable (cron will eventually heal timers, admin can
    // start a workflow manually). We still collect warnings so the caller can
    // surface them in the UI and the tenant can log a follow-up.
    const warnings: Array<{ stage: string; message: string }> = [];

    if (newType.sla_policy_id) {
      // Update sla_id FIRST so the pointer is correct even if startTimers
      // crashes partway through (partial timer rows are the cron's problem,
      // a stale sla_id pointer would mislead every downstream reader).
      try {
        await this.supabase.admin
          .from('tickets')
          .update({ sla_id: newType.sla_policy_id })
          .eq('id', ticketId);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        console.error('[reclassify] update sla_id failed', err);
        warnings.push({ stage: 'update_sla_id', message });
      }
      try {
        await this.slaService.startTimers(ticketId, tenant.id, newType.sla_policy_id);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        console.error('[reclassify] startTimers failed', err);
        warnings.push({ stage: 'start_sla_timers', message });
      }
    } else {
      // No new SLA policy — clear ticket-level SLA computed fields so the UI
      // doesn't show stale due-at values from the old policy's timers.
      try {
        await this.supabase.admin
          .from('tickets')
          .update({
            sla_id: null,
            sla_response_due_at: null,
            sla_resolution_due_at: null,
            sla_response_breached_at: null,
            sla_resolution_breached_at: null,
            sla_at_risk: false,
          })
          .eq('id', ticketId);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        console.error('[reclassify] clear sla fields failed', err);
        warnings.push({ stage: 'clear_sla_fields', message });
      }
    }

    if (newType.workflow_definition_id) {
      try {
        await this.workflowEngine.startForTicket(ticketId, newType.workflow_definition_id);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        console.error('[reclassify] startForTicket failed', err);
        warnings.push({ stage: 'start_workflow', message });
      }
    }

    try {
      await this.routingService.recordDecision(ticketId, routingContext, evaluation);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error('[reclassify] recordDecision failed', err);
      warnings.push({ stage: 'record_routing_decision', message });
    }

    // If any post-RPC stage failed, emit a domain event so the audit trail
    // shows the partial completion. The primary ticket_type_changed event
    // already committed inside the RPC, so this is the appropriate place
    // to record recovery-needed state.
    if (warnings.length > 0) {
      try {
        await this.supabase.admin.from('domain_events').insert({
          tenant_id: tenant.id,
          event_type: 'reclassify_post_rpc_warning',
          entity_type: 'ticket',
          entity_id: ticketId,
          payload: { warnings },
          actor_user_id: actorUserId,
        });
      } catch (err) {
        console.error('[reclassify] failed to record post-rpc warning event', err);
      }
    }

    const ticketResponse = await this.tickets.getById(ticketId, SYSTEM_ACTOR);
    return warnings.length > 0
      ? { ...(ticketResponse as Record<string, unknown>), post_rpc_warnings: warnings }
      : ticketResponse;
  }

  // ─────── Guards ───────

  private assertReclassifiable(ticket: TicketRow | null, newRequestTypeId: string): asserts ticket is TicketRow {
    if (!ticket) throw new NotFoundException('ticket not found');
    if (ticket.ticket_kind !== 'case') {
      throw new BadRequestException('cannot reclassify child work orders — reclassify the parent');
    }
    if (TERMINAL_CATEGORIES.has(ticket.status_category)) {
      throw new ConflictException('ticket is closed or resolved; cannot reclassify');
    }
    if (ticket.ticket_type_id === newRequestTypeId) {
      throw new BadRequestException('new request type is the same as current');
    }
  }

  // ─────── Loaders ───────

  private async loadTicket(id: string, tenantId: string): Promise<TicketRow | null> {
    const { data } = await this.supabase.admin
      .from('tickets')
      .select(
        'id, tenant_id, ticket_type_id, ticket_kind, status_category, assigned_team_id, assigned_user_id, assigned_vendor_id, location_id, asset_id, priority, watchers',
      )
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    return (data as TicketRow | null) ?? null;
  }

  private async loadRequestType(id: string, tenantId: string): Promise<RequestTypeRow | null> {
    const { data } = await this.supabase.admin
      .from('request_types')
      .select('id, name, domain, active, sla_policy_id, workflow_definition_id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    return (data as RequestTypeRow | null) ?? null;
  }

  private async loadActiveWorkflowInstance(
    ticketId: string,
    tenantId: string,
  ): Promise<WorkflowInstanceWithDef | null> {
    const { data } = await this.supabase.admin
      .from('workflow_instances')
      .select('id, current_node_id, workflow_definitions(name)')
      .eq('ticket_id', ticketId)
      .eq('tenant_id', tenantId)
      .in('status', ['active', 'waiting'])
      .limit(1)
      .maybeSingle();

    if (!data) return null;
    const row = data as {
      id: string;
      current_node_id: string | null;
      workflow_definitions: { name: string | null } | { name: string | null }[] | null;
    };
    const defRef = Array.isArray(row.workflow_definitions)
      ? row.workflow_definitions[0]
      : row.workflow_definitions;
    return {
      id: row.id,
      current_node_id: row.current_node_id,
      definition_name: defRef?.name ?? null,
    };
  }

  private async loadWorkflowDefinition(id: string, tenantId: string): Promise<{ id: string; name: string } | null> {
    const { data } = await this.supabase.admin
      .from('workflow_definitions')
      .select('id, name')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    return (data as { id: string; name: string } | null) ?? null;
  }

  private async loadChildren(parentId: string, tenantId: string): Promise<ChildRow[]> {
    const { data } = await this.supabase.admin
      .from('tickets')
      .select('id, title, status_category, assigned_team_id, assigned_user_id, assigned_vendor_id')
      .eq('parent_ticket_id', parentId)
      .eq('tenant_id', tenantId);
    return (data as ChildRow[] | null) ?? [];
  }

  private async loadActiveTimers(ticketId: string, tenantId: string): Promise<TimerRow[]> {
    const { data } = await this.supabase.admin
      .from('sla_timers')
      .select('id, timer_type, target_minutes, started_at')
      .eq('ticket_id', ticketId)
      .eq('tenant_id', tenantId)
      .is('stopped_at', null)
      .is('completed_at', null);
    return (data as TimerRow[] | null) ?? [];
  }

  private async loadSlaPolicy(id: string, tenantId: string): Promise<SlaPolicyRow | null> {
    const { data } = await this.supabase.admin
      .from('sla_policies')
      .select('id, name, response_time_minutes, resolution_time_minutes')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    return (data as SlaPolicyRow | null) ?? null;
  }

  private async loadNames(
    table: 'teams' | 'users' | 'vendors',
    ids: string[],
    tenantId: string,
    displayCol: 'name' | 'email' = 'name',
  ): Promise<Record<string, string>> {
    if (ids.length === 0) return {};
    const { data } = await this.supabase.admin
      .from(table)
      .select(`id, ${displayCol}`)
      .in('id', ids)
      .eq('tenant_id', tenantId);
    const rows = (data as Array<Record<string, string>> | null) ?? [];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.id] = r[displayCol] ?? '(unnamed)';
    return out;
  }

  private async resolveUserIdFromAuth(authUid: string, tenantId: string): Promise<string | null> {
    const { data } = await this.supabase.admin
      .from('users')
      .select('id')
      .eq('auth_uid', authUid)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    return (data?.id as string | undefined) ?? null;
  }

  // ─────── Builders ───────

  private buildRoutingContext(ticket: TicketRow, newType: RequestTypeRow): ResolverContext {
    return {
      tenant_id: ticket.tenant_id,
      ticket_id: ticket.id,
      request_type_id: newType.id,
      domain: newType.domain ?? null,
      priority: ticket.priority ?? null,
      asset_id: ticket.asset_id ?? null,
      location_id: ticket.location_id ?? null,
    };
  }

  private collectIds(current: string | null, target: AssignmentTarget | null, kind: 'team' | 'user' | 'vendor'): string[] {
    const ids = new Set<string>();
    if (current) ids.add(current);
    if (target && target.kind === kind) {
      const key = `${kind}_id` as keyof AssignmentTarget;
      const val = (target as unknown as Record<string, string>)[key];
      if (val) ids.add(val);
    }
    return Array.from(ids);
  }

  private targetWithNames(
    target: AssignmentTarget | null,
    teamNames: Record<string, string>,
    userNames: Record<string, string>,
    vendorNames: Record<string, string>,
  ) {
    if (!target) return {};
    if (target.kind === 'team') return { team: { id: target.team_id, name: teamNames[target.team_id] ?? '(unnamed)' } };
    if (target.kind === 'user') return { user: { id: target.user_id, name: userNames[target.user_id] ?? '(unnamed)' } };
    return { vendor: { id: target.vendor_id, name: vendorNames[target.vendor_id] ?? '(unnamed)' } };
  }

  private async labelChildren(children: ChildRow[], tenantId: string) {
    const teamIds = children.map((c) => c.assigned_team_id).filter((x): x is string => !!x);
    const userIds = children.map((c) => c.assigned_user_id).filter((x): x is string => !!x);
    const vendorIds = children.map((c) => c.assigned_vendor_id).filter((x): x is string => !!x);

    const [teamNames, userNames, vendorNames] = await Promise.all([
      this.loadNames('teams', teamIds, tenantId),
      this.loadNames('users', userIds, tenantId, 'email'),
      this.loadNames('vendors', vendorIds, tenantId),
    ]);

    return children.map((c) => {
      let assignee = null as null | { kind: 'user' | 'vendor' | 'team'; id: string; name: string };
      if (c.assigned_vendor_id) {
        assignee = { kind: 'vendor', id: c.assigned_vendor_id, name: vendorNames[c.assigned_vendor_id] ?? '(vendor)' };
      } else if (c.assigned_user_id) {
        assignee = { kind: 'user', id: c.assigned_user_id, name: userNames[c.assigned_user_id] ?? '(user)' };
      } else if (c.assigned_team_id) {
        assignee = { kind: 'team', id: c.assigned_team_id, name: teamNames[c.assigned_team_id] ?? '(team)' };
      }
      return {
        id: c.id,
        title: c.title,
        status_category: c.status_category,
        is_in_progress: IN_PROGRESS_CATEGORIES.has(c.status_category),
        assignee,
      };
    });
  }
}

