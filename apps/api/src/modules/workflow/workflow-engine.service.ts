import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

interface WorkflowNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

interface WorkflowEdge {
  from: string;
  to: string;
  condition?: string; // e.g. 'approved', 'rejected', 'default'
}

interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

@Injectable()
export class WorkflowEngineService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Start a workflow for a ticket.
   * Creates a workflow instance and advances to the first node after the trigger.
   */
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

    // Find the trigger node
    const triggerNode = graph.nodes.find((n) => n.type === 'trigger');
    if (!triggerNode) return null;

    // Create the workflow instance
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

    // Advance past the trigger to the first real node
    await this.advance(instance.id, graph, triggerNode.id, ticketId);

    return instance;
  }

  /**
   * Advance a workflow instance to the next node.
   * Executes the current node's action and follows the outgoing edge.
   */
  async advance(instanceId: string, graph: WorkflowGraph, fromNodeId: string, ticketId: string, edgeCondition?: string) {
    // Find the outgoing edge(s)
    const edges = graph.edges.filter((e) => e.from === fromNodeId);
    if (edges.length === 0) return; // No outgoing edges — end of path

    // Select the right edge based on condition
    let nextEdge = edges[0]; // default: first edge
    if (edgeCondition) {
      const conditionEdge = edges.find((e) => e.condition === edgeCondition);
      if (conditionEdge) nextEdge = conditionEdge;
    }

    const nextNode = graph.nodes.find((n) => n.id === nextEdge.to);
    if (!nextNode) return;

    // Update instance to current node
    await this.supabase.admin
      .from('workflow_instances')
      .update({ current_node_id: nextNode.id })
      .eq('id', instanceId);

    // Execute the node
    await this.executeNode(instanceId, graph, nextNode, ticketId);
  }

  /**
   * Execute a single workflow node.
   */
  private async executeNode(instanceId: string, graph: WorkflowGraph, node: WorkflowNode, ticketId: string) {
    const tenant = TenantContext.current();

    switch (node.type) {
      case 'trigger':
        // Trigger already fired — advance to next
        await this.advance(instanceId, graph, node.id, ticketId);
        break;

      case 'assign': {
        const teamId = node.config.team_id as string | undefined;
        const userId = node.config.user_id as string | undefined;
        const updates: Record<string, unknown> = {};
        if (teamId) updates.assigned_team_id = teamId;
        if (userId) updates.assigned_user_id = userId;
        if (teamId || userId) updates.status_category = 'assigned';

        await this.supabase.admin.from('tickets').update(updates).eq('id', ticketId);
        await this.advance(instanceId, graph, node.id, ticketId);
        break;
      }

      case 'update_ticket': {
        const fields = node.config.fields as Record<string, unknown> | undefined;
        if (fields) {
          await this.supabase.admin.from('tickets').update(fields).eq('id', ticketId);
        }
        await this.advance(instanceId, graph, node.id, ticketId);
        break;
      }

      case 'notification': {
        // Create a notification — the notification service would handle actual delivery
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
        await this.advance(instanceId, graph, node.id, ticketId);
        break;
      }

      case 'condition': {
        // Evaluate condition against ticket data
        const { data: ticket } = await this.supabase.admin
          .from('tickets')
          .select('*')
          .eq('id', ticketId)
          .single();

        if (!ticket) break;

        const field = node.config.field as string;
        const operator = node.config.operator as string;
        const value = node.config.value;
        const actual = ticket[field];

        let result = 'default';
        if (operator === 'equals' && actual === value) result = 'true';
        else if (operator === 'not_equals' && actual !== value) result = 'true';
        else if (operator === 'in' && Array.isArray(value) && value.includes(actual)) result = 'true';
        else result = 'false';

        await this.advance(instanceId, graph, node.id, ticketId, result);
        break;
      }

      case 'create_child_tasks': {
        const tasks = node.config.tasks as Array<{
          title: string;
          description?: string;
          assigned_team_id?: string;
          interaction_mode?: string;
          priority?: string;
        }> | undefined;

        if (tasks) {
          const { data: parentTicket } = await this.supabase.admin
            .from('tickets')
            .select('tenant_id, requester_person_id, location_id')
            .eq('id', ticketId)
            .single();

          if (parentTicket) {
            for (const task of tasks) {
              await this.supabase.admin.from('tickets').insert({
                tenant_id: tenant.id,
                parent_ticket_id: ticketId,
                title: task.title,
                description: task.description,
                assigned_team_id: task.assigned_team_id,
                interaction_mode: task.interaction_mode ?? 'internal',
                priority: task.priority ?? 'medium',
                requester_person_id: parentTicket.requester_person_id,
                location_id: parentTicket.location_id,
                status: 'new',
                status_category: 'new',
                source_channel: 'workflow',
              });
            }
          }
        }

        await this.advance(instanceId, graph, node.id, ticketId);
        break;
      }

      case 'approval': {
        // Create an approval request and pause the workflow
        await this.supabase.admin.from('approvals').insert({
          tenant_id: tenant.id,
          target_entity_type: 'ticket',
          target_entity_id: ticketId,
          approver_person_id: node.config.approver_person_id as string | undefined,
          approver_team_id: node.config.approver_team_id as string | undefined,
          status: 'pending',
        });

        // Pause the workflow — it will be resumed when the approval is responded to
        await this.supabase.admin
          .from('workflow_instances')
          .update({ status: 'waiting', waiting_for: 'approval' })
          .eq('id', instanceId);
        break;
      }

      case 'wait_for': {
        const waitType = node.config.wait_type as string; // 'child_tasks', 'status', 'event'
        await this.supabase.admin
          .from('workflow_instances')
          .update({ status: 'waiting', waiting_for: waitType })
          .eq('id', instanceId);
        break;
      }

      case 'timer': {
        const delayMinutes = node.config.delay_minutes as number | undefined;
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
        }
        break;
      }

      case 'end': {
        await this.supabase.admin
          .from('workflow_instances')
          .update({ status: 'completed', completed_at: new Date().toISOString() })
          .eq('id', instanceId);
        break;
      }

      default:
        // Unknown node type — advance to next
        await this.advance(instanceId, graph, node.id, ticketId);
    }
  }

  /**
   * Resume a waiting workflow instance (called when an approval is completed,
   * child tasks are resolved, or a timer fires).
   */
  async resume(instanceId: string, edgeCondition?: string) {
    const { data: instance } = await this.supabase.admin
      .from('workflow_instances')
      .select('*, definition:workflow_definitions(*)')
      .eq('id', instanceId)
      .single();

    if (!instance || instance.status !== 'waiting') return;

    const graph = instance.definition.graph_definition as unknown as WorkflowGraph;

    // Mark as active
    await this.supabase.admin
      .from('workflow_instances')
      .update({ status: 'active', waiting_for: null })
      .eq('id', instanceId);

    // Advance from the current node
    await this.advance(instanceId, graph, instance.current_node_id, instance.ticket_id, edgeCondition);
  }
}
