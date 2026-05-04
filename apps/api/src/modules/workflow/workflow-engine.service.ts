import { BadRequestException, Inject, Injectable, forwardRef } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { assertTenantOwned, validateAssigneesInTenant } from '../../common/tenant-validation';
import { DispatchService } from '../ticket/dispatch.service';

// Plan A.4 / Commit 4 (C3) — workflow `update_ticket` node allowlist.
// node.config.fields was previously written directly to tickets with no
// allowlist, no FK validation, no tenant filter. A forged or imported
// workflow definition could carry:
//   - tenant_id mutation (cross-tenant takeover)
//   - cross-tenant FK refs (assigned_team_id from another tenant)
//   - a payload that overwrites system-managed columns (created_at,
//     updated_at, sla_*_at)
// The allowlist below splits the surface into:
//   1. Safe scalar fields — written verbatim. Schema CHECK constraints
//      and column types catch invalid values; tenant isolation is not
//      a concern (these aren't FKs).
//   2. FK fields — written through assertTenantOwned to prove tenant
//      ownership of the referenced row.
// Anything outside both lists throws workflow.update_ticket_field_not_allowed
// rather than being silently dropped — silent drop hides workflow
// definition bugs and the failure surfaces only in production when the
// admin notices the ticket didn't change as expected.
//
// Doc-drift trigger: this allowlist is the contract for what a workflow
// can write. When tickets gains a new column, decide whether it's safe
// scalar / FK / forbidden, and update both this list AND
// docs/assignments-routing-fulfillment.md (§Routing decision write path).

/** Fields a workflow `update_ticket` node may write directly. */
const UPDATE_TICKET_SAFE_SCALAR_FIELDS = new Set<string>([
  // Status + workflow state
  'status',
  'status_category',
  'waiting_reason',
  // Priority signals
  'priority',
  'impact',
  'urgency',
  // Mode + content
  'interaction_mode',
  'title',
  'description',
  'tags',
  'source_channel',
  // Operational scalars
  'cost',
  'satisfaction_rating',
  'satisfaction_comment',
  'form_data',
  // Closure / cancellation reasons (string only — actor ids are FKs and
  // forbidden; system actor sets those via dedicated paths).
  'close_reason',
  'cancelled_reason',
  'reclassified_reason',
  // Plan window (operator-side only; never surfaced to requesters).
  'planned_start_at',
  'planned_duration_minutes',
]);

/**
 * FK fields a workflow `update_ticket` node may write — but each value
 * MUST be validated against the calling tenant before the UPDATE fires.
 * Map: ticket-column -> { table, entityName, kind: 'assignee' | 'asset' | 'space' | 'rt' | 'sla' | 'person' | 'ticket' | 'wf' }.
 * The validator itself uses assertTenantOwned (or
 * validateAssigneesInTenant for the assigned_* trio).
 */
const UPDATE_TICKET_FK_FIELDS: Record<
  string,
  { table: string; entityName: string }
> = {
  ticket_type_id: { table: 'request_types', entityName: 'request type' },
  parent_ticket_id: { table: 'tickets', entityName: 'parent ticket' },
  requester_person_id: { table: 'persons', entityName: 'requester' },
  requested_for_person_id: { table: 'persons', entityName: 'requested-for' },
  location_id: { table: 'spaces', entityName: 'location' },
  asset_id: { table: 'assets', entityName: 'asset' },
  workflow_id: { table: 'workflow_definitions', entityName: 'workflow' },
  sla_id: { table: 'sla_policies', entityName: 'SLA policy' },
  // assigned_* go through validateAssigneesInTenant (3 tables in one call).
  assigned_team_id: { table: 'teams', entityName: 'team' },
  assigned_user_id: { table: 'users', entityName: 'user' },
  assigned_vendor_id: { table: 'vendors', entityName: 'vendor' },
};

interface WorkflowNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

interface WorkflowEdge {
  from: string;
  to: string;
  condition?: string;
}

interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface EmittedEvent {
  event_type: string;
  node_id?: string;
  node_type?: string;
  decision?: string;
  payload?: Record<string, unknown>;
}

export interface WorkflowRunContext {
  dryRun: boolean;
  simulatedTicket?: Record<string, unknown>;
  events: EmittedEvent[];
  path: string[];
  stoppedAt?: { node_id: string; node_type: string; reason: string };
}

@Injectable()
export class WorkflowEngineService {
  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => DispatchService)) private readonly dispatchService: DispatchService,
  ) {}

  /**
   * Cancel any active workflow_instances for a ticket. Idempotent —
   * safe to call when no active instance exists. Used by reclassification
   * (via the reclassify_ticket RPC which performs the same operation in-txn)
   * and available for any future "cancel workflow" admin action.
   */
  async cancelInstanceForTicket(
    ticketId: string,
    tenantId: string,
    reason: string,
    actorUserId: string | null,
  ): Promise<string[]> {
    const { data } = await this.supabase.admin
      .from('workflow_instances')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancelled_reason: reason,
        cancelled_by: actorUserId,
      })
      .eq('ticket_id', ticketId)
      .eq('tenant_id', tenantId)
      .in('status', ['active', 'waiting'])
      .select('id');

    return (data ?? []).map((row: { id: string }) => row.id);
  }

  async startForTicket(ticketId: string, workflowDefinitionId: string) {
    const tenant = TenantContext.current();

    const { data: definition } = await this.supabase.admin
      .from('workflow_definitions')
      .select('*')
      .eq('id', workflowDefinitionId)
      .single();

    if (!definition) return null;

    const graph = definition.graph_definition as unknown as WorkflowGraph;
    if (!graph?.nodes?.length) return null;

    const triggerNode = graph.nodes.find((n) => n.type === 'trigger');
    if (!triggerNode) return null;

    const { data: instance, error } = await this.supabase.admin
      .from('workflow_instances')
      .insert({
        tenant_id: tenant.id,
        workflow_definition_id: workflowDefinitionId,
        workflow_version: definition.version,
        ticket_id: ticketId,
        current_node_id: triggerNode.id,
        status: 'active',
        context: {},
      })
      .select()
      .single();

    if (error) throw error;

    await this.emit(instance.id, 'instance_started', { node_id: triggerNode.id, node_type: 'trigger' });
    await this.advance(instance.id, graph, triggerNode.id, ticketId);

    return instance;
  }

  async advance(instanceId: string, graph: WorkflowGraph, fromNodeId: string, ticketId: string, edgeCondition?: string, ctx?: WorkflowRunContext) {
    const edges = graph.edges.filter((e) => e.from === fromNodeId);
    if (edges.length === 0) return;

    let nextEdge = edges[0];
    if (edgeCondition) {
      const conditionEdge = edges.find((e) => e.condition === edgeCondition);
      if (conditionEdge) nextEdge = conditionEdge;
    }

    const nextNode = graph.nodes.find((n) => n.id === nextEdge.to);
    if (!nextNode) return;

    if (!ctx?.dryRun) {
      await this.supabase.admin
        .from('workflow_instances')
        .update({ current_node_id: nextNode.id })
        .eq('id', instanceId);
    }

    await this.executeNode(instanceId, graph, nextNode, ticketId, ctx);
  }

  private async executeNode(instanceId: string, graph: WorkflowGraph, node: WorkflowNode, ticketId: string, ctx?: WorkflowRunContext) {
    const tenant = ctx?.dryRun ? null : TenantContext.current();

    await this.emit(instanceId, 'node_entered', { node_id: node.id, node_type: node.type }, ctx);
    if (ctx) ctx.path.push(node.id);

    switch (node.type) {
      case 'trigger':
        await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
        break;

      case 'assign': {
        const teamId = node.config.team_id as string | undefined;
        const userId = node.config.user_id as string | undefined;
        if (!ctx?.dryRun) {
          // Plan A.2 / Commit 7 / gap map §MEDIUM workflow-engine.service.ts:148-154.
          // node.config is user-defined JSONB stored on the workflow definition;
          // the workflow itself is tenant-scoped, but a malformed / forged
          // / imported definition could carry a foreign-tenant uuid that
          // would land on the tickets row blind. Validate before write —
          // skipForSystemActor: false because a workflow execution doesn't
          // have an actor concept; the engine is the system, but the
          // node.config came from user-authored data, so we DO validate.
          if (tenant && (teamId || userId)) {
            await validateAssigneesInTenant(
              this.supabase,
              {
                assigned_team_id: teamId,
                assigned_user_id: userId,
              },
              tenant.id,
            );
          }
          const updates: Record<string, unknown> = {};
          if (teamId) updates.assigned_team_id = teamId;
          if (userId) updates.assigned_user_id = userId;
          if (teamId || userId) updates.status_category = 'assigned';
          await this.supabase.admin.from('tickets').update(updates).eq('id', ticketId);
        }
        await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
        break;
      }

      case 'update_ticket': {
        const fields = node.config.fields as Record<string, unknown> | undefined;
        if (!ctx?.dryRun && fields && tenant) {
          // Plan A.4 / Commit 4 (C3) — see allowlists at the top of this
          // file. node.config.fields is user-authored JSONB on the
          // workflow definition; treat as untrusted at execution time.
          //
          // 1. Bucket the incoming keys.
          const safe: Record<string, unknown> = {};
          const fkUpdates: Record<string, unknown> = {};
          const forbidden: string[] = [];
          for (const [k, v] of Object.entries(fields)) {
            if (UPDATE_TICKET_SAFE_SCALAR_FIELDS.has(k)) {
              safe[k] = v;
            } else if (k in UPDATE_TICKET_FK_FIELDS) {
              fkUpdates[k] = v;
            } else {
              forbidden.push(k);
            }
          }

          // 2. Reject any forbidden fields up-front. Throwing (vs. silent
          // drop) surfaces workflow definition bugs at execution time
          // instead of letting them rot. Critically: `tenant_id`, `id`,
          // `created_at`, `updated_at`, `created_by`, `updated_by`, all
          // sla_* computed columns, and the unknown 'foo' workflow-author
          // typo all land here.
          if (forbidden.length > 0) {
            throw new BadRequestException({
              code: 'workflow.update_ticket_field_not_allowed',
              message: `workflow update_ticket node attempted to write disallowed field(s): ${forbidden.join(', ')}`,
              forbidden_fields: forbidden,
            });
          }

          // 3. Validate each FK against the tenant BEFORE the UPDATE.
          //    null / undefined values are valid (clear the FK).
          //    Assignees go through the trio validator; everything else
          //    through assertTenantOwned.
          const assigneeDiff: {
            assigned_team_id?: unknown;
            assigned_user_id?: unknown;
            assigned_vendor_id?: unknown;
          } = {};
          for (const [field, value] of Object.entries(fkUpdates)) {
            if (value === null || value === undefined) continue;
            if (
              field === 'assigned_team_id' ||
              field === 'assigned_user_id' ||
              field === 'assigned_vendor_id'
            ) {
              (assigneeDiff as Record<string, unknown>)[field] = value;
              continue;
            }
            const fk = UPDATE_TICKET_FK_FIELDS[field];
            if (typeof value !== 'string') {
              throw new BadRequestException({
                code: 'reference.invalid_uuid',
                message: `${fk.entityName} reference must be a string uuid`,
                reference_table: fk.table,
              });
            }
            await assertTenantOwned(
              this.supabase,
              fk.table,
              value,
              tenant.id,
              { entityName: fk.entityName },
            );
          }
          if (
            assigneeDiff.assigned_team_id !== undefined ||
            assigneeDiff.assigned_user_id !== undefined ||
            assigneeDiff.assigned_vendor_id !== undefined
          ) {
            await validateAssigneesInTenant(this.supabase, assigneeDiff, tenant.id);
          }

          // 4. UPDATE with explicit tenant filter — defense-in-depth even
          // though every FK was validated. supabase.admin bypasses RLS.
          const allUpdates = { ...safe, ...fkUpdates };
          if (Object.keys(allUpdates).length > 0) {
            await this.supabase.admin
              .from('tickets')
              .update(allUpdates)
              .eq('id', ticketId)
              .eq('tenant_id', tenant.id);
          }
        }
        await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
        break;
      }

      case 'notification': {
        if (!ctx?.dryRun && tenant) {
          await this.supabase.admin.from('notifications').insert({
            tenant_id: tenant.id,
            notification_type: (node.config.notification_type as string) ?? 'workflow_notification',
            target_channel: 'in_app',
            related_entity_type: 'ticket',
            related_entity_id: ticketId,
            subject: (node.config.subject as string) ?? 'Workflow notification',
            body: (node.config.body as string) ?? '',
            status: 'pending',
          });
        }
        await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
        break;
      }

      case 'condition': {
        const field = node.config.field as string;
        const operator = node.config.operator as string;
        const value = node.config.value;

        let ticket: Record<string, unknown> | null = null;
        if (ctx?.dryRun) {
          ticket = ctx.simulatedTicket ?? {};
        } else {
          const { data } = await this.supabase.admin.from('tickets').select('*').eq('id', ticketId).single();
          ticket = data;
        }
        if (!ticket) break;

        const actual = ticket[field];
        let result = 'default';
        if (operator === 'equals' && actual === value) result = 'true';
        else if (operator === 'not_equals' && actual !== value) result = 'true';
        else if (operator === 'in' && Array.isArray(value) && value.includes(actual)) result = 'true';
        else result = 'false';

        await this.emit(instanceId, 'decision_made', { node_id: node.id, node_type: 'condition', decision: result }, ctx);
        await this.advance(instanceId, graph, node.id, ticketId, result, ctx);
        break;
      }

      case 'create_child_tasks': {
        const tasks = node.config.tasks as Array<{
          title: string;
          description?: string;
          assigned_team_id?: string;
          assigned_user_id?: string;
          assigned_vendor_id?: string;
          interaction_mode?: string;
          priority?: string;
          sla_policy_id?: string | null;
        }> | undefined;

        if (ctx?.dryRun) {
          await this.emit(instanceId, 'node_entered', {
            node_id: node.id, node_type: 'create_child_tasks',
            payload: { dry_run_would_create: tasks?.length ?? 0 },
          }, ctx);
        } else if (tasks && tenant) {
          for (let i = 0; i < tasks.length; i++) {
            const task = tasks[i];
            const title = task.title?.trim() || `Subtask ${i + 1}`;
            try {
              await this.dispatchService.dispatch(ticketId, {
                title,
                description: task.description,
                assigned_team_id: task.assigned_team_id,
                assigned_user_id: task.assigned_user_id,
                assigned_vendor_id: task.assigned_vendor_id,
                priority: task.priority,
                interaction_mode: task.interaction_mode as 'internal' | 'external' | undefined,
                // Pass through ONLY if the task explicitly set the field. `undefined` falls through
                // to DispatchService.resolveChildSla; explicit `null` means "No SLA".
                ...(Object.prototype.hasOwnProperty.call(task, 'sla_policy_id')
                  ? { sla_id: task.sla_policy_id ?? null }
                  : {}),
              }, '__system__');
            } catch (err) {
              console.error('[workflow] create_child_tasks: dispatch failed', err);
            }
          }
        }

        await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
        break;
      }

      case 'approval': {
        if (ctx?.dryRun) {
          ctx.stoppedAt = { node_id: node.id, node_type: 'approval', reason: 'approval' };
          await this.emit(instanceId, 'instance_waiting', { node_id: node.id, node_type: 'approval', payload: { waiting_for: 'approval' } }, ctx);
          return;
        }
        if (tenant) {
          // Plan A.4 / Commit 3 (C2) — workflow approval-node tenant validation.
          // node.config.approver_person_id + approver_team_id come from
          // user-authored workflow JSONB (workflow-engine.service.ts:284-292).
          // The approvals table FK on approver_person_id → persons(id) and
          // approver_team_id → teams(id) only proves global existence;
          // supabase.admin bypasses RLS. A forged / imported definition
          // could carry a foreign-tenant uuid that would land in the
          // approvals row blind, granting visibility + a pending approval
          // routed to the wrong tenant. Validate before insert.
          // null/undefined values are valid (some approver fields are
          // unset by design — e.g. team-only or person-only approval
          // shapes).
          const approverPersonId = node.config.approver_person_id as string | undefined;
          const approverTeamId = node.config.approver_team_id as string | undefined;
          if (approverPersonId) {
            await assertTenantOwned(
              this.supabase,
              'persons',
              approverPersonId,
              tenant.id,
              { entityName: 'approver person' },
            );
          }
          if (approverTeamId) {
            await assertTenantOwned(
              this.supabase,
              'teams',
              approverTeamId,
              tenant.id,
              { entityName: 'approver team' },
            );
          }
          await this.supabase.admin.from('approvals').insert({
            tenant_id: tenant.id,
            target_entity_type: 'ticket',
            target_entity_id: ticketId,
            approver_person_id: approverPersonId,
            approver_team_id: approverTeamId,
            status: 'pending',
          });
        }
        await this.supabase.admin
          .from('workflow_instances')
          .update({ status: 'waiting', waiting_for: 'approval' })
          .eq('id', instanceId);
        await this.emit(instanceId, 'instance_waiting', { node_id: node.id, node_type: 'approval', payload: { waiting_for: 'approval' } });
        break;
      }

      case 'wait_for': {
        const waitType = node.config.wait_type as string;
        if (ctx?.dryRun) {
          ctx.stoppedAt = { node_id: node.id, node_type: 'wait_for', reason: 'wait_for' };
          await this.emit(instanceId, 'instance_waiting', { node_id: node.id, node_type: 'wait_for', payload: { wait_type: waitType } }, ctx);
          return;
        }
        await this.supabase.admin
          .from('workflow_instances')
          .update({ status: 'waiting', waiting_for: waitType })
          .eq('id', instanceId);
        await this.emit(instanceId, 'instance_waiting', { node_id: node.id, node_type: 'wait_for', payload: { wait_type: waitType } });
        break;
      }

      case 'timer': {
        const delayMinutes = node.config.delay_minutes as number | undefined;
        if (ctx?.dryRun) {
          ctx.stoppedAt = { node_id: node.id, node_type: 'timer', reason: 'timer' };
          await this.emit(instanceId, 'instance_waiting', { node_id: node.id, node_type: 'timer', payload: { delay_minutes: delayMinutes } }, ctx);
          return;
        }
        if (delayMinutes) {
          const resumeAt = new Date(Date.now() + delayMinutes * 60_000);
          await this.supabase.admin
            .from('workflow_instances')
            .update({
              status: 'waiting',
              waiting_for: 'timer',
              context: { timer_resume_at: resumeAt.toISOString(), timer_node_id: node.id },
            })
            .eq('id', instanceId);
          await this.emit(instanceId, 'instance_waiting', { node_id: node.id, node_type: 'timer', payload: { resume_at: resumeAt.toISOString() } });
        }
        break;
      }

      case 'end': {
        if (!ctx?.dryRun) {
          await this.supabase.admin
            .from('workflow_instances')
            .update({ status: 'completed', completed_at: new Date().toISOString() })
            .eq('id', instanceId);
        }
        await this.emit(instanceId, 'instance_completed', { node_id: node.id, node_type: 'end' }, ctx);
        break;
      }

      case 'http_request': {
        const method = (node.config.method as string) ?? 'POST';
        const url = node.config.url as string;
        const headers = (node.config.headers as Record<string, string>) ?? {};
        const bodyTemplate = (node.config.body as string) ?? '';
        const saveAs = (node.config.save_response_as as string) ?? '';

        // Load ticket/context for template substitution
        let ticket: Record<string, unknown> | null = null;
        if (ctx?.dryRun) {
          ticket = ctx.simulatedTicket ?? {};
        } else {
          const { data } = await this.supabase.admin.from('tickets').select('*').eq('id', ticketId).single();
          ticket = data;
        }

        const substitutedUrl = this.substituteTemplate(url, { ticket });
        const substitutedHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) {
          substitutedHeaders[k] = this.substituteTemplate(v, { ticket });
        }
        const substitutedBody = this.substituteTemplate(bodyTemplate, { ticket });

        if (ctx?.dryRun) {
          await this.emit(instanceId, 'node_entered', {
            node_id: node.id, node_type: 'http_request',
            payload: { dry_run_would_call: { method, url: substitutedUrl } },
          }, ctx);
          await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
          break;
        }

        try {
          const init: RequestInit = {
            method,
            headers: { 'Content-Type': 'application/json', ...substitutedHeaders },
            signal: AbortSignal.timeout(20000),
          };
          if (method !== 'GET' && method !== 'DELETE' && substitutedBody) {
            init.body = substitutedBody;
          }
          const res = await fetch(substitutedUrl, init);
          let parsed: unknown = null;
          const text = await res.text();
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

          await this.emit(instanceId, 'node_entered', {
            node_id: node.id, node_type: 'http_request',
            payload: { status: res.status, ok: res.ok, url: substitutedUrl, method },
          });

          if (saveAs) {
            const { data: inst } = await this.supabase.admin
              .from('workflow_instances')
              .select('context')
              .eq('id', instanceId)
              .single();
            const newCtx = { ...(inst?.context ?? {}), [saveAs]: parsed };
            await this.supabase.admin
              .from('workflow_instances')
              .update({ context: newCtx })
              .eq('id', instanceId);
          }
        } catch (err) {
          await this.emit(instanceId, 'instance_failed', {
            node_id: node.id, node_type: 'http_request',
            payload: { error: err instanceof Error ? err.message : 'HTTP request failed', url: substitutedUrl },
          });
          // Continue the workflow anyway — the failure is recorded. Alternative: halt.
        }

        await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
        break;
      }

      default:
        await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
    }
  }

  /**
   * Replace `{{ticket.field}}` style tokens with values from `vars`.
   * Supports nested paths (`{{ticket.nested.field}}`) and context (`{{context.key}}`).
   */
  private substituteTemplate(tpl: string, vars: Record<string, unknown>): string {
    if (!tpl) return tpl;
    return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
      const parts = path.split('.');
      let cur: unknown = vars;
      for (const p of parts) {
        if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[p];
        } else {
          return '';
        }
      }
      return cur == null ? '' : typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
    });
  }

  async resume(instanceId: string, edgeCondition?: string) {
    const { data: instance } = await this.supabase.admin
      .from('workflow_instances')
      .select('*, definition:workflow_definitions(*)')
      .eq('id', instanceId)
      .single();

    if (!instance || instance.status !== 'waiting') return;

    const graph = instance.definition.graph_definition as unknown as WorkflowGraph;

    await this.supabase.admin
      .from('workflow_instances')
      .update({ status: 'active', waiting_for: null })
      .eq('id', instanceId);

    await this.emit(instanceId, 'instance_resumed', { payload: { edge_condition: edgeCondition ?? null } });
    await this.advance(instanceId, graph, instance.current_node_id, instance.ticket_id, edgeCondition);
  }

  private async emit(
    instanceId: string,
    event_type: string,
    fields: { node_id?: string; node_type?: string; decision?: string; payload?: Record<string, unknown> } = {},
    ctx?: WorkflowRunContext,
  ) {
    if (ctx?.dryRun) {
      ctx.events.push({ event_type, ...fields });
      return;
    }
    try {
      const tenant = TenantContext.current();
      await this.supabase.admin.from('workflow_instance_events').insert({
        tenant_id: tenant.id,
        workflow_instance_id: instanceId,
        event_type,
        node_id: fields.node_id ?? null,
        node_type: fields.node_type ?? null,
        decision: fields.decision ?? null,
        payload: fields.payload ?? {},
      });
    } catch {
      // Best-effort — workflow engine continues if event log is unavailable
    }
  }
}
