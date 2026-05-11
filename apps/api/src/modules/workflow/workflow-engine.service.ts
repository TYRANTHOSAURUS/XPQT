import { Inject, Injectable, forwardRef } from '@nestjs/common';
import {
  buildWorkflowAssignmentIdempotencyKey,
  buildWorkflowUpdateTicketIdempotencyKey,
} from '@prequest/shared';
import { AppError, mapRpcErrorToAppError } from '../../common/errors';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { assertTenantOwned } from '../../common/tenant-validation';
import { DispatchService } from '../ticket/dispatch.service';
import { SlaService } from '../sla/sla.service';

// B.2.A.Step9 — workflow `update_ticket` node allowlist (option 2).
//
// Pre-Step 9, the engine accepted a 29-field surface (20 "safe scalar"
// + 9 FK) and wrote directly to `tickets`. That surface drifted away
// from the §3.0 `update_entity_combined` orchestrator (00335 v5) which
// only branches on a narrow set of patches. Step 9 cuts the engine
// over to the orchestrator and tightens the allowlist to the 14
// fields the orchestrator actually handles — anything else is rejected
// with `workflow.update_ticket_field_not_allowed`.
//
// Why fail loud (not silent drop): a silently-dropped field hides a
// workflow-author bug. Throwing at execution time surfaces it on the
// audit feed for ops triage and forces the author to either remove
// the orphan field or push an orchestrator branch extension up to
// Product. Per `project_no_wave1_yet` memory (no production tenant
// depends on these workflows), risk-free in customer terms.
//
// The 17 orphan fields and their phased remediation are documented in
// `docs/follow-ups/b2-followups.md` (new "workflow update_ticket
// orphan fields" entry under §3.0 Step 9 closeout).
//
// Doc-drift trigger: this allowlist is the contract for what a workflow
// can write. When the §3.0 orchestrator extends its branches, decide
// whether a new field belongs here, and update
// `docs/assignments-routing-fulfillment.md` (§Workflow engine writes).

/**
 * The 14 fields the §3.0 `update_entity_combined` orchestrator accepts,
 * partitioned into the orchestrator's six branches. Used by
 * `buildPatchesFromUpdateTicketNode` to bucket node-config keys into
 * the patches payload, and by the up-front allowlist check to reject
 * anything that doesn't belong.
 *
 * Branch citations:
 *   - status:     00335:159-160 (status / status_category / waiting_reason)
 *   - priority:   00335:163     (priority)
 *   - assignment: 00335:161     (assigned_team_id / _user_id / _vendor_id)
 *   - sla:        00335:162     (sla_id; timers built TS-side)
 *   - plan:       00335:164     (planned_start_at / planned_duration_minutes;
 *                                WO-only — see §Plan branch below)
 *   - metadata:   00335:165     (title / description / cost / tags / watchers)
 */
const UPDATE_TICKET_STATUS_FIELDS = new Set<string>([
  'status',
  'status_category',
  'waiting_reason',
]);
const UPDATE_TICKET_PRIORITY_FIELDS = new Set<string>(['priority']);
const UPDATE_TICKET_ASSIGNMENT_FIELDS = new Set<string>([
  'assigned_team_id',
  'assigned_user_id',
  'assigned_vendor_id',
]);
const UPDATE_TICKET_SLA_FIELDS = new Set<string>(['sla_id']);
const UPDATE_TICKET_PLAN_FIELDS = new Set<string>([
  'planned_start_at',
  'planned_duration_minutes',
]);
const UPDATE_TICKET_METADATA_FIELDS = new Set<string>([
  'title',
  'description',
  'cost',
  'tags',
  'watchers',
]);

/** The full 14-field allowlist (union of the six branch sets). */
const UPDATE_TICKET_ALLOWED_FIELDS: ReadonlySet<string> = new Set<string>([
  ...UPDATE_TICKET_STATUS_FIELDS,
  ...UPDATE_TICKET_PRIORITY_FIELDS,
  ...UPDATE_TICKET_ASSIGNMENT_FIELDS,
  ...UPDATE_TICKET_SLA_FIELDS,
  ...UPDATE_TICKET_PLAN_FIELDS,
  ...UPDATE_TICKET_METADATA_FIELDS,
]);

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
    // B.2.A.Step9 — `update_ticket` node's sla branch needs pre-computed
    // timer due_at values (business-hours-adjusted) before calling
    // `update_entity_combined`. Mirrors `WorkOrderService` injection
    // pattern at apps/api/src/modules/work-orders/work-order.service.ts
    // (sla branch at :469-480 calls the same helper).
    private readonly slaService: SlaService,
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

    // Cross-tenant FK leak fix (security audit 2026-05-08, site 1):
    // workflow_definitions read keyed by id alone. supabase.admin bypasses
    // RLS, so a foreign-tenant workflow uuid (e.g. smuggled via a request
    // type pointing across tenants) would be returned blind and used to
    // start an instance — branching on a foreign workflow's nodes/edges.
    // Filter by tenant.
    const { data: definition } = await this.supabase.admin
      .from('workflow_definitions')
      .select('*')
      .eq('id', workflowDefinitionId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();

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
      // Cross-tenant FK leak fix (security audit 2026-05-08, codex post-fix
      // review): the prior version updated workflow_instances by id alone.
      // supabase.admin bypasses RLS, so a colliding instance id would let one
      // tenant advance another tenant's workflow. advance() is only invoked
      // from inside a TenantContext.run scope (startForTicket → controller's
      // ambient context; executeNode → tenant resolved at the top of each
      // node branch; resume() → TenantContext.run({id: instance.tenant_id})).
      // Filter the write defensively.
      const advTenant = TenantContext.current();
      await this.supabase.admin
        .from('workflow_instances')
        .update({ current_node_id: nextNode.id })
        .eq('id', instanceId)
        .eq('tenant_id', advTenant.id);
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
        // B.2.A.Step9 — workflow engine `assign` node cutover to §3.2
        // `set_entity_assignment` RPC (00327 v2). Spec lines 1870-1873.
        //
        // Pre-Step 9 this node wrote directly to `tickets.assigned_*`
        // via `.from('tickets').update(...)`, bypassing:
        //   - the orchestrator's idempotency cache (command_operations)
        //   - the orchestrator's atomic activity / domain_event emission
        //   - the RPC's defense-in-depth tenant FK validation
        //   - the cross-table polymorphism (status_category transition
        //     handled by 00327, not by the workflow engine)
        //
        // The RPC's payload schema is `{assigned_team_id, assigned_user_id,
        // assigned_vendor_id}` (00327:64-71). All three are optional;
        // unset keys keep current value, explicit null clears. The
        // workflow engine's node.config carries `team_id` and `user_id`
        // historically — preserve that shape on the node-config side
        // and translate to the RPC's canonical keys. No `vendor_id` on
        // node.config today (the assign UI doesn't surface vendor
        // assignment from a workflow); add when the editor supports it.
        //
        // Idempotency key shape: workflow:assignment:<instance>:<node>:<entity>.
        // Stable across replays (same instance + same node + same entity
        // ⇒ same key ⇒ command_operations short-circuits).
        const teamId = node.config.team_id as string | undefined;
        const userId = node.config.user_id as string | undefined;
        if (!ctx?.dryRun) {
          if (tenant && (teamId !== undefined || userId !== undefined)) {
            // Tenant-validate FKs at the RPC layer (00327 validates via
            // `validate_assignees_in_tenant`). TS-side validation removed
            // — the RPC is the single source of truth post-cutover.
            const payload: Record<string, unknown> = {};
            if (teamId !== undefined) payload.assigned_team_id = teamId;
            if (userId !== undefined) payload.assigned_user_id = userId;

            const idempotencyKey = buildWorkflowAssignmentIdempotencyKey(
              instanceId,
              node.id,
              ticketId,
            );
            // Resolve entity kind: cases live in `tickets`; work_orders
            // live in `work_orders` (post step1c.10c). The workflow
            // engine's instances bind to one or the other via the
            // calling ticket id; today every workflow_instance.ticket_id
            // points at a case (tickets table), per the auto-workflow
            // start path at ticket.service.ts:902-917. Step 11 will add
            // WO-side workflow instances; until then 'case' is correct
            // for every live caller.
            const { error } = await this.supabase.admin.rpc(
              'set_entity_assignment',
              {
                p_entity_id: ticketId,
                p_entity_kind: 'case',
                p_tenant_id: tenant.id,
                // Workflow engine has no actor — the engine itself is
                // the system actor. Null lets the RPC's actor lookup
                // (00327:98-103 pattern) fall through cleanly.
                p_actor_user_id: null,
                p_idempotency_key: idempotencyKey,
                p_payload: payload,
              },
            );
            if (error) throw mapRpcErrorToAppError(error);
          }
        }
        await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
        break;
      }

      case 'update_ticket': {
        // B.2.A.Step9 — workflow engine `update_ticket` node cutover to
        // §3.0 `update_entity_combined` RPC (00335 v5). Spec lines 1870-1873.
        //
        // Pre-Step 9 this node wrote directly to `tickets` via
        // `.from('tickets').update(...)`, with a 29-field allowlist
        // that drifted far from what the §3.0 orchestrator actually
        // supports. Option 2 (decided 2026-05-11): tighten the
        // allowlist to the orchestrator's 14-field surface and reject
        // anything else with `workflow.update_ticket_field_not_allowed`.
        //
        // The 17 orphan fields and their phased remediation are
        // documented in docs/follow-ups/b2-followups.md.
        const fields = node.config.fields as Record<string, unknown> | undefined;
        if (!ctx?.dryRun && fields && tenant) {
          // 1. Reject any field outside the tightened allowlist up-front.
          //    Throwing (vs. silent drop) surfaces workflow definition
          //    bugs at execution time. Per `project_no_wave1_yet` memory
          //    no production tenant currently depends on these workflows
          //    — risk-free in customer terms.
          const offendingFields = Object.keys(fields).filter(
            (k) => !UPDATE_TICKET_ALLOWED_FIELDS.has(k),
          );
          if (offendingFields.length > 0) {
            // 422 unprocessable entity (not 400): the request payload
            // is syntactically valid jsonb of the right shape, but the
            // workflow definition itself is misconfigured — only an
            // admin can fix it. Detail names the offending fields so
            // the audit log surfaces actionable triage data; the
            // user-facing copy (messages.en/nl) points to the
            // followups doc for the supported set.
            throw new AppError('workflow.update_ticket_field_not_allowed', 422, {
              detail: `workflow update_ticket node attempted to write disallowed field(s): ${offendingFields.join(', ')}`,
            });
          }

          // 2. Honest no-op short-circuit: empty fields object ⇒ no work.
          //    Same shape as TicketService.update at ticket.service.ts:1118-1125.
          const fieldKeys = Object.keys(fields);
          if (fieldKeys.length === 0) {
            await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
            break;
          }

          // 3. Build the orchestrator patches payload, bucketing each
          //    allowlisted field into its branch. Mirrors the case-side
          //    `TicketService.buildPatchesPayloadForCase` shape exactly.
          const patches = await this.buildPatchesFromUpdateTicketFields(
            fields,
            tenant.id,
          );

          if (Object.keys(patches).length === 0) {
            // Could happen if the field set was non-empty but all keys
            // were filtered out by hasOwnProperty semantics (shouldn't
            // happen given the allowlist gate above, but defensive).
            await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
            break;
          }

          // 4. Resolve entity kind. Today every workflow_instance.ticket_id
          //    points at a case (per the auto-workflow start path at
          //    ticket.service.ts:902-917). Plan branch will raise
          //    `update_entity_combined.plan_not_supported_on_case` if a
          //    workflow author writes planned_start_at on a case; that's
          //    the right shape — the engine has no way to author a WO-
          //    targeted workflow today. Step 11 will resolve WO-side
          //    workflow instances by inspecting workflow_instances.parent_kind.
          const idempotencyKey = buildWorkflowUpdateTicketIdempotencyKey(
            instanceId,
            node.id,
            ticketId,
          );
          const { error } = await this.supabase.admin.rpc(
            'update_entity_combined',
            {
              p_entity_kind: 'case',
              p_entity_id: ticketId,
              p_tenant_id: tenant.id,
              // Workflow engine is the system actor. Null lets the
              // RPC's actor lookup (00335:241-252) fall through.
              p_actor_user_id: null,
              p_idempotency_key: idempotencyKey,
              p_patches: patches,
            },
          );
          if (error) throw mapRpcErrorToAppError(error);
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
          // Cross-tenant FK leak fix (site 2): condition node reads tickets
          // by id alone and BRANCHES on the result. A workflow_instance
          // pointing at a foreign-tenant ticket (or an id collision) would
          // route execution based on another tenant's data. Filter by
          // tenant — when no context is set (resume() callsite, see site 5
          // fix below), fall back to instance.tenant_id captured upstream.
          const condTenant = TenantContext.currentOrNull();
          let q = this.supabase.admin.from('tickets').select('*').eq('id', ticketId);
          if (condTenant) q = q.eq('tenant_id', condTenant.id);
          const { data } = await q.maybeSingle();
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
        } else if (tasks && tasks.length > 0 && tenant) {
          // B.2.A.Step8 — cut over from per-task loop to the atomic batch RPC
          // (`dispatch_child_work_orders_batch` 00337). Spec §3.4
          // lines 2228-2234: a single tx commits all N children or rolls
          // back the entire batch, eliminating the partial-fanout failure
          // mode where the workflow advanced after dispatch #3 of 5 failed
          // (§1.18, severity:critical).
          //
          // Stable clientRequestId per (instanceId, node.id) — workflow
          // resume replays the same node with the same id, so the batch
          // idempotency key is stable across retries.
          const clientRequestId = `workflow:${instanceId}:${node.id}`;
          const taskDtos = tasks.map((task, i) => ({
            title: task.title?.trim() || `Subtask ${i + 1}`,
            description: task.description,
            assigned_team_id: task.assigned_team_id,
            assigned_user_id: task.assigned_user_id,
            assigned_vendor_id: task.assigned_vendor_id,
            priority: task.priority,
            interaction_mode: task.interaction_mode as 'internal' | 'external' | undefined,
            // sla_policy_id semantics preserved: explicit key (including
            // null) passes through; absent falls back to resolveChildSla.
            ...(Object.prototype.hasOwnProperty.call(task, 'sla_policy_id')
              ? { sla_id: task.sla_policy_id ?? null }
              : {}),
          }));
          try {
            await this.dispatchService.dispatchBatch(
              ticketId,
              taskDtos,
              '__system__',
              clientRequestId,
            );
          } catch (err) {
            // Codex-S8-I3 (F-IMP-3): the pre-remediation behaviour was
            // to console.error + advance the workflow as if nothing
            // happened. That silently leaves the workflow in a state
            // that says "child tasks created" when in fact ZERO were
            // committed (batch is all-or-nothing). Same severity class
            // as the legacy per-task swallow that F-CRIT-4 retired.
            //
            // Fix: halt the workflow at this node. Mark the instance
            // status='failed' so ops can see it on the workflow run +
            // re-investigate / re-run. Emit a node_failed event so the
            // audit feed records the reason. Do NOT call advance() —
            // the workflow's claim that children exist would be a lie.
            console.error('[workflow] create_child_tasks: batch dispatch failed', err);
            if (tenant) {
              await this.supabase.admin
                .from('workflow_instances')
                .update({ status: 'failed' })
                .eq('id', instanceId)
                .eq('tenant_id', tenant.id);
            }
            await this.emit(
              instanceId,
              'node_failed',
              {
                node_id: node.id,
                node_type: 'create_child_tasks',
                payload: {
                  reason: 'dispatch_batch_failed',
                  message: err instanceof Error ? err.message : String(err),
                  task_count: taskDtos.length,
                },
              },
              ctx,
            );
            break;
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
        // Cross-tenant write fix (codex post-fix review 2026-05-08): the
        // approval/wait/timer/end branches all mutated workflow_instances by
        // id alone. tenant guaranteed non-null in non-dry-run path (set at
        // the top of executeNode). Add explicit .eq('tenant_id', …).
        if (tenant) {
          await this.supabase.admin
            .from('workflow_instances')
            .update({ status: 'waiting', waiting_for: 'approval' })
            .eq('id', instanceId)
            .eq('tenant_id', tenant.id);
        }
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
        if (tenant) {
          await this.supabase.admin
            .from('workflow_instances')
            .update({ status: 'waiting', waiting_for: waitType })
            .eq('id', instanceId)
            .eq('tenant_id', tenant.id);
        }
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
        if (delayMinutes && tenant) {
          const resumeAt = new Date(Date.now() + delayMinutes * 60_000);
          await this.supabase.admin
            .from('workflow_instances')
            .update({
              status: 'waiting',
              waiting_for: 'timer',
              context: { timer_resume_at: resumeAt.toISOString(), timer_node_id: node.id },
            })
            .eq('id', instanceId)
            .eq('tenant_id', tenant.id);
          await this.emit(instanceId, 'instance_waiting', { node_id: node.id, node_type: 'timer', payload: { resume_at: resumeAt.toISOString() } });
        }
        break;
      }

      case 'end': {
        if (!ctx?.dryRun && tenant) {
          await this.supabase.admin
            .from('workflow_instances')
            .update({ status: 'completed', completed_at: new Date().toISOString() })
            .eq('id', instanceId)
            .eq('tenant_id', tenant.id);
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
        // Cross-tenant FK leak fix (site 3) — EXFILTRATION VECTOR.
        // This node reads tickets.* and substitutes EVERY column into
        // user-authored URL/body/header templates, then sends the result
        // to a user-authored URL. Without a tenant filter, a workflow
        // instance pointing at a foreign-tenant ticket (or an id
        // collision) would exfiltrate the foreign tenant's row to THIS
        // tenant's webhook. Filter by tenant; resume() now installs a
        // tenant context so currentOrNull() resolves.
        let ticket: Record<string, unknown> | null = null;
        if (ctx?.dryRun) {
          ticket = ctx.simulatedTicket ?? {};
        } else {
          const httpTenant = TenantContext.currentOrNull();
          let q = this.supabase.admin.from('tickets').select('*').eq('id', ticketId);
          if (httpTenant) q = q.eq('tenant_id', httpTenant.id);
          const { data } = await q.maybeSingle();
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
            // Cross-tenant FK leak fix (site 4): saveAs reads + writes
            // workflow_instances.context by id alone. Without a tenant
            // filter, a foreign-tenant instance with a colliding id could
            // be read (leak) and overwritten (tamper). Filter both the
            // read and the update. Falls back to no extra filter when no
            // tenant context is set (shouldn't happen post site-5 fix,
            // but defensive).
            const saveTenant = TenantContext.currentOrNull();
            let readQ = this.supabase.admin
              .from('workflow_instances')
              .select('context')
              .eq('id', instanceId);
            if (saveTenant) readQ = readQ.eq('tenant_id', saveTenant.id);
            const { data: inst } = await readQ.maybeSingle();
            const newCtx = { ...(inst?.context ?? {}), [saveAs]: parsed };
            let writeQ = this.supabase.admin
              .from('workflow_instances')
              .update({ context: newCtx })
              .eq('id', instanceId);
            if (saveTenant) writeQ = writeQ.eq('tenant_id', saveTenant.id);
            await writeQ;
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
   * Build the `p_patches` jsonb payload for `update_entity_combined`
   * (00335 v5) from a workflow `update_ticket` node's `config.fields`
   * object. Mirrors `TicketService.buildPatchesPayloadForCase` shape so
   * the engine and the controller PATCH path produce identical patches
   * for the same logical input.
   *
   * The caller must have already enforced the 14-field allowlist via
   * `UPDATE_TICKET_ALLOWED_FIELDS`. This method assumes every key in
   * `fields` is valid; unknown keys are dropped silently by the
   * bucketing (a defense-in-depth no-op given the allowlist gate).
   *
   * SLA branch: when `sla_id` is non-null, the orchestrator requires a
   * pre-computed `timers[]` array (00330:202-205 / 00335:357-373). The
   * business-hours calendar resolution lives in TS, so we call
   * `SlaService.buildTimersForRpc` here — same shape as the WO-side
   * helper at work-order.service.ts:469-480. A null sla_id clears the
   * policy (RPC's stop-only path); timers[] is omitted.
   *
   * Plan branch: the orchestrator rejects `plan` on cases
   * (00335:170-173). Workflow definitions today never start on a WO,
   * so a plan field on an update_ticket node is a misconfiguration —
   * the RPC's raise (`plan_not_supported_on_case`) surfaces it
   * cleanly. We still forward the keys; failing fast at the RPC layer
   * is the right shape.
   */
  private async buildPatchesFromUpdateTicketFields(
    fields: Record<string, unknown>,
    tenantId: string,
  ): Promise<Record<string, unknown>> {
    const has = (k: string) => Object.prototype.hasOwnProperty.call(fields, k);
    const patches: Record<string, unknown> = {};

    // Status branch — top-level (00335:159-160 / 254-281).
    if (has('status')) patches.status = fields.status;
    if (has('status_category')) patches.status_category = fields.status_category;
    if (has('waiting_reason')) patches.waiting_reason = fields.waiting_reason;

    // Priority — top-level (00335:163 / 283-337).
    if (has('priority')) patches.priority = fields.priority;

    // Assignment grouped (00335:161 / 339-355). Keys map verbatim:
    // assigned_team_id / assigned_user_id / assigned_vendor_id.
    if (
      has('assigned_team_id') ||
      has('assigned_user_id') ||
      has('assigned_vendor_id')
    ) {
      const assignment: Record<string, unknown> = {};
      if (has('assigned_team_id'))
        assignment.assigned_team_id = fields.assigned_team_id;
      if (has('assigned_user_id'))
        assignment.assigned_user_id = fields.assigned_user_id;
      if (has('assigned_vendor_id'))
        assignment.assigned_vendor_id = fields.assigned_vendor_id;
      patches.assignment = assignment;
    }

    // SLA grouped (00335:162 / 357-373). RPC schema: `{sla_id, timers?}`
    // per 00330:98-108. Non-null sla_id requires timers[]; null sla_id
    // clears (timers[] omitted).
    if (has('sla_id')) {
      const slaPayload: Record<string, unknown> = { sla_id: fields.sla_id };
      if (fields.sla_id !== null && fields.sla_id !== undefined) {
        slaPayload.timers = await this.slaService.buildTimersForRpc(
          fields.sla_id as string,
          tenantId,
        );
      }
      patches.sla = slaPayload;
    }

    // Plan grouped (00335:164 / 375-481). WO-only — orchestrator rejects
    // on case with `plan_not_supported_on_case` (00335:170-173). Keys
    // forwarded verbatim; RPC fails fast on misconfiguration.
    if (has('planned_start_at') || has('planned_duration_minutes')) {
      const plan: Record<string, unknown> = {};
      if (has('planned_start_at')) plan.planned_start_at = fields.planned_start_at;
      if (has('planned_duration_minutes'))
        plan.planned_duration_minutes = fields.planned_duration_minutes;
      patches.plan = plan;
    }

    // Metadata grouped (00335:165 / 483-706).
    if (
      has('title') ||
      has('description') ||
      has('cost') ||
      has('tags') ||
      has('watchers')
    ) {
      const metadata: Record<string, unknown> = {};
      if (has('title')) metadata.title = fields.title;
      if (has('description')) metadata.description = fields.description;
      if (has('cost')) metadata.cost = fields.cost;
      if (has('tags')) metadata.tags = fields.tags;
      if (has('watchers')) metadata.watchers = fields.watchers;
      patches.metadata = metadata;
    }

    return patches;
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

  /**
   * Resume a waiting workflow instance.
   *
   * Cross-tenant FK leak fix (codex post-fix review 2026-05-08): the prior
   * implementation accepted only `instanceId` and relied on ambient
   * `TenantContext` if present, falling back to `instance.tenant_id` when
   * unset. That fallback branch existed for a hypothetical caller that has
   * no TenantContext — but the only real caller is the WorkflowController,
   * which always runs inside an authed-request TenantContext. Drop the
   * fallback: require `tenantId` explicitly. Forces every caller to prove
   * which tenant it's resuming as.
   *
   * The instance lookup filters by tenant_id; a cross-tenant resume attempt
   * (any instanceId not in the caller's tenant) returns null and exits with
   * no side effect.
   */
  async resume(instanceId: string, tenantId: string, edgeCondition?: string) {
    // Two-step read: load instance ONLY (no embedded definition). The
    // PostgREST embed `definition:workflow_definitions(*)` would FK-traverse
    // server-side without an independent tenant filter — a foreign
    // workflow_definition_id (FK-smuggle) would load a foreign graph and
    // execute it. Audit finding: separate query so the second SELECT can
    // be tenant-filtered explicitly.
    const { data: instance } = await this.supabase.admin
      .from('workflow_instances')
      .select('*')
      .eq('id', instanceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!instance || instance.status !== 'waiting') return;

    const { data: definition } = await this.supabase.admin
      .from('workflow_definitions')
      .select('*')
      .eq('id', instance.workflow_definition_id as string)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!definition) return;

    const graph = (definition as { graph_definition: unknown }).graph_definition as WorkflowGraph;
    // Reuse ambient TenantContext if it matches; otherwise resolve full
    // TenantInfo (slug + tier) from `tenants` so downstream audit/billing
    // reads see real values.
    const ambient = TenantContext.currentOrNull();
    let tenantInfo: { id: string; slug: string; tier: 'standard' | 'enterprise' };
    if (ambient && ambient.id === tenantId) {
      tenantInfo = ambient;
    } else {
      const { data: tenantRow } = await this.supabase.admin
        .from('tenants')
        .select('id, slug, tier')
        .eq('id', tenantId)
        .maybeSingle();
      if (!tenantRow) return;
      tenantInfo = tenantRow as { id: string; slug: string; tier: 'standard' | 'enterprise' };
    }

    await TenantContext.run(tenantInfo, async () => {
      await this.supabase.admin
        .from('workflow_instances')
        .update({ status: 'active', waiting_for: null })
        .eq('id', instanceId)
        .eq('tenant_id', tenantInfo.id);

      await this.emit(instanceId, 'instance_resumed', { payload: { edge_condition: edgeCondition ?? null } });
      await this.advance(instanceId, graph, instance.current_node_id, instance.ticket_id, edgeCondition);
    });
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
