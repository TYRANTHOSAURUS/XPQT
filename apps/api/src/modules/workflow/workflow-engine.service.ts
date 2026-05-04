import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { validateAssigneesInTenant } from '../../common/tenant-validation';
import { DispatchService } from '../ticket/dispatch.service';

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
        if (!ctx?.dryRun && fields) {
          await this.supabase.admin.from('tickets').update(fields).eq('id', ticketId);
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
          await this.supabase.admin.from('approvals').insert({
            tenant_id: tenant.id,
            target_entity_type: 'ticket',
            target_entity_id: ticketId,
            approver_person_id: node.config.approver_person_id as string | undefined,
            approver_team_id: node.config.approver_team_id as string | undefined,
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
