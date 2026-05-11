import {
  Inject,
  Injectable,
  forwardRef,
} from '@nestjs/common';
import { buildReclassifyIdempotencyKey } from '@prequest/shared';
import { AppErrors } from '../../common/errors';
import { mapRpcErrorToAppError } from '../../common/errors/map-rpc-error';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RoutingService } from '../routing/routing.service';
import { ScopeOverrideResolverService } from '../routing/scope-override-resolver.service';
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
    // slaService / workflowEngine were the TS-side execution path
    // pre-Step 11. Post-cutover their work moves into the outbox
    // handlers (SlaTimerRepointHandler + WorkflowStartHandler). Kept
    // in the constructor signature so DI stays stable + tests don't
    // need rewrites; `void`-marked below so TS6138 stays quiet.
    private readonly _slaService: SlaService,
    private readonly _workflowEngine: WorkflowEngineService,
    private readonly visibility: TicketVisibilityService,
    private readonly scopeOverrideResolver: ScopeOverrideResolverService,
  ) {
    void this._slaService;
    void this._workflowEngine;
  }

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
    if (!newType) {
      throw AppErrors.notFoundWithCode(
        'reclassify.target_not_found',
        'new request type not found',
      );
    }
    if (!newType.active) {
      throw AppErrors.validationFailed('reclassify.target_inactive', {
        detail: 'new request type is not active',
      });
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
    // B.2.A.Step11 — threaded from RequireClientRequestIdGuard via the
    // controller for `POST /tickets/:id/reclassify`. Used as the
    // idempotency-key seed for the reclassify_ticket RPC
    // (spec §3.10 + §3.9.1).
    clientRequestId?: string,
  ): Promise<unknown> {
    const tenant = TenantContext.current();

    if (!dto.reason || dto.reason.trim().length < 3) {
      throw AppErrors.validationFailed('reclassify.reason_too_short', {
        detail: 'reason must be at least 3 characters',
      });
    }
    if (dto.reason.length > 500) {
      throw AppErrors.validationFailed('reclassify.reason_too_long', {
        detail: 'reason must be at most 500 characters',
      });
    }

    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertVisible(ticketId, ctx, 'write');
    }

    if (!clientRequestId) {
      // Required by the §3.0/§3.10 RPC contract. RequireClientRequestIdGuard
      // catches the HTTP path; this guard catches internal callers (workflow
      // engine, future cron) that bypass the controller.
      throw AppErrors.validationFailed('command_operations.client_request_id_required', {
        detail: 'client_request_id required for reclassify_ticket',
      });
    }

    // computeImpact also performs preflight guards (not child, not closed,
    // types differ, type active). The acknowledgement gate for in-progress
    // child WOs remains a TS preflight — the RPC itself doesn't reason
    // about children (spec line 2636-2639: "WO-side reclassify is out of
    // scope for §3.10").
    const impact = await this.computeImpact(ticketId, dto.newRequestTypeId, actorAuthUid);

    const hasInProgressChildren = impact.children.some((c) => c.is_in_progress);
    if (hasInProgressChildren && !dto.acknowledgedChildrenInProgress) {
      throw AppErrors.validationFailed('reclassify.in_progress_children_unacked', {
        detail: 'in-progress child work orders require acknowledgement',
      });
    }

    const ticket = await this.loadTicket(ticketId, tenant.id);
    if (!ticket) throw AppErrors.notFound('ticket', ticketId);
    const newType = await this.loadRequestType(dto.newRequestTypeId, tenant.id);
    if (!newType) {
      throw AppErrors.notFoundWithCode(
        'reclassify.target_not_found',
        'new request type not found',
      );
    }

    // ── TS plan-build: derive effective location + override + workflow + sla ──
    //
    // The TS-resolved values become the `p_automation_plan` payload the
    // RPC asserts against (spec §3.10 step 5a). PG re-derives the same
    // values from the canonical request_type + scope-override tables;
    // a mismatch + no concurrent edit on the SPECIFIC override row →
    // 'automation_plan.semantic_mismatch'. The narrowing follows the
    // Step 12 codex-S12-I1 v3 pattern (00351).
    const effectiveLocationId = await this.scopeOverrideResolver.deriveEffectiveLocation(
      tenant.id,
      { locationId: ticket.location_id, assetId: ticket.asset_id },
    );
    const effectiveOverride = await this.scopeOverrideResolver.resolveForLocation(
      tenant.id,
      newType.id,
      effectiveLocationId,
    );

    const automationPlan = {
      effective_location_id: effectiveLocationId,
      scope_override_id: effectiveOverride?.id ?? null,
      effective_workflow_definition_id:
        effectiveOverride?.workflow_definition_id ?? newType.workflow_definition_id ?? null,
      effective_sla_policy_id:
        effectiveOverride?.case_sla_policy_id ?? newType.sla_policy_id ?? null,
      _resolution_at: new Date().toISOString(),
    };

    const idempotencyKey = buildReclassifyIdempotencyKey(ticketId, clientRequestId);

    // ── Call the RPC ────────────────────────────────────────────────────
    //
    // Actor passes through as the raw auth_uid; the RPC resolves it to
    // users.id internally (F-CRIT-1 pattern from 00351).
    const actorAuthUidForRpc =
      actorAuthUid === SYSTEM_ACTOR ? null : actorAuthUid;

    const { error: rpcError, data: rpcData } = await this.supabase.admin.rpc(
      'reclassify_ticket',
      {
        p_ticket_id: ticketId,
        p_tenant_id: tenant.id,
        p_actor_user_id: actorAuthUidForRpc,
        p_idempotency_key: idempotencyKey,
        p_payload: {
          new_request_type_id: dto.newRequestTypeId,
          reason: dto.reason,
        },
        p_automation_plan: automationPlan,
      },
    );

    if (rpcError) {
      // The RPC's command_operations gate handles same-key-same-payload
      // (cached_result) and same-key-different-payload (payload_mismatch).
      // Other recognised codes route through mapRpcErrorToAppError.
      throw mapRpcErrorToAppError(rpcError);
    }

    // RPC returned { ticket, follow_ups, concurrent_override_edit }. The
    // ticket row in the response is the raw `public.tickets` shape; the
    // controller / UI wants the enriched read shape, so re-load via
    // TicketService.getById (visibility-aware, joins everything).
    const ticketResponse = await this.tickets.getById(ticketId, SYSTEM_ACTOR);
    const rpcResult = rpcData as
      | { follow_ups?: string[]; concurrent_override_edit?: boolean }
      | null;
    if (
      rpcResult &&
      typeof rpcResult === 'object' &&
      typeof ticketResponse === 'object' &&
      ticketResponse !== null
    ) {
      // Surface the breadcrumb flag + follow-up event types so callers
      // can show "configuration changed mid-form" UX or display which
      // outbox events fired.
      return {
        ...(ticketResponse as Record<string, unknown>),
        follow_ups: rpcResult.follow_ups ?? [],
        concurrent_override_edit: rpcResult.concurrent_override_edit ?? false,
      };
    }
    return ticketResponse;
  }

  // ─────── Guards ───────

  private assertReclassifiable(ticket: TicketRow | null, newRequestTypeId: string): asserts ticket is TicketRow {
    if (!ticket) throw AppErrors.notFound('ticket');
    if (ticket.ticket_kind !== 'case') {
      throw AppErrors.validationFailed('reclassify.work_order_target', {
        detail: 'cannot reclassify child work orders — reclassify the parent',
      });
    }
    if (TERMINAL_CATEGORIES.has(ticket.status_category)) {
      throw AppErrors.conflict('reclassify.terminal_state', {
        detail: 'ticket is closed or resolved; cannot reclassify',
      });
    }
    if (ticket.ticket_type_id === newRequestTypeId) {
      throw AppErrors.validationFailed('reclassify.target_same', {
        detail: 'new request type is the same as current',
      });
    }
  }

  // ─────── Loaders ───────

  private async loadTicket(id: string, tenantId: string): Promise<TicketRow | null> {
    // Step 1c.10c: ticket_kind dropped. Reclassify only operates on cases
    // (assertReclassifiable refuses non-case rows), and tickets is now
    // case-only — synthesize ticket_kind='case' for the type contract.
    const { data } = await this.supabase.admin
      .from('tickets')
      .select(
        'id, tenant_id, ticket_type_id, status_category, assigned_team_id, assigned_user_id, assigned_vendor_id, location_id, asset_id, priority, watchers',
      )
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!data) return null;
    return { ...(data as Omit<TicketRow, 'ticket_kind'>), ticket_kind: 'case' } as TicketRow;
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

