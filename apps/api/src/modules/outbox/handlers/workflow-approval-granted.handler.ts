import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../../common/supabase/supabase.service';
import { TenantContext } from '../../../common/tenant-context';
import { WorkflowEngineService } from '../../workflow/workflow-engine.service';
import {
  ApprovalLifecycleEventType,
  type ApprovalLifecyclePayload,
} from '../../approval/event-types';
import { DeadLetterError } from '../dead-letter.error';
import { OutboxHandler, type OutboxEventHandler } from '../outbox-handler.decorator';
import type { OutboxEvent } from '../outbox.types';

/**
 * WorkflowApprovalGrantedHandler — drains `approval.granted` outbox events
 * emitted by `grant_booking_approval` v2 (migration 00403) on the
 * `kind='resolved'` branch when the approval row has a populated
 * `workflow_instance_id` (Phase 1.5 workflow-driven approvals).
 *
 * Phase 1.5 sub-step 6.D.
 *
 * Spec: docs/superpowers/specs/phase-1.5-visual-approval-workflow-plan.md
 *   §2.6.5 (lines 485-487) — handler responsibility.
 *   §6.D (lines 1278-1289) — sub-step spec.
 *
 * Producer: migration 00403's `perform outbox.emit('approval.granted', …)`
 *           inside the v2 grant_booking_approval RPC. Skipped when the
 *           approval row's workflow_instance_id is NULL — legacy
 *           createApprovalRows path falls back to the existing TS-side
 *           onApprovalDecided fan-out at approval.service.ts:847. One
 *           concrete surface per approval; never double-fire.
 *
 * ── What this handler does ──────────────────────────────────────────────
 *
 * 1. Tenant smuggling defense — payload.tenant_id must equal
 *    event.tenant_id (DeadLetterError on mismatch — schema-corruption
 *    canary; the trigger at 00400 block B should have rejected the
 *    cross-tenant link at INSERT time).
 *
 * 2. Verify the workflow_instance exists + is tenant-owned. The
 *    `assert_approvals_workflow_instance_tenant` trigger (00400 block B.1)
 *    rejects cross-tenant links at INSERT time, so a foreign
 *    workflow_instance_id reaching this handler means schema corruption.
 *    DeadLetterError + log to surface for ops.
 *
 * 3. Call `WorkflowEngineService.resume(workflow_instance_id, tenant_id,
 *    final_decision)`. resume()'s atomic claim (workflow-engine.service.ts
 *    :1725-1740 — UPDATE WHERE status='waiting' RETURNING ...) handles
 *    idempotency for concurrent emits: only one caller observes data!=null;
 *    losers no-op. The same claim also covers the cancel-during-grant
 *    race — when the workflow_instance was cancelled (by Change 6 of 6.A,
 *    triggered by booking.cancelled fan-out) between this event's emit and
 *    drain, resume()'s claim returns null + the handler logs + no-ops.
 *
 * 4. The `final_decision` ('approved' | 'rejected') maps directly to the
 *    edge_condition the workflow graph's approval_main node carries:
 *      approved → end_success
 *      rejected → end_failure
 *    The compiled graph at plan §3.3 emits exactly those two edge
 *    conditions; advance() picks the matching edge.
 *
 * ── Idempotency contract ────────────────────────────────────────────────
 *
 * resume()'s atomic claim is the load-bearing guarantee. No separate handler
 * claim on the outbox event row is added — the engine's per-instance claim
 * is sufficient. Concurrent re-deliveries (outbox retry, two workers picking
 * up the same event) all converge to one terminal state.
 *
 * ── Spec divergences worth flagging ─────────────────────────────────────
 *
 * The plan §6.D mentions a `workflow.tenant_mismatch_approval` raise on
 * "cross-tenant link with workflow_instance_id". The actual surface this
 * handler protects: payload.tenant_id != event.tenant_id (tenant smuggling
 * via the outbox); workflow_instance_id whose tenant_id doesn't match
 * event.tenant_id (schema-corruption canary — the trigger should have
 * rejected at INSERT time). Both raise DeadLetterError so the event ends
 * up in dead-letter for ops review.
 */
@Injectable()
@OutboxHandler(ApprovalLifecycleEventType.Granted, { version: 1 })
export class WorkflowApprovalGrantedHandler
  implements OutboxEventHandler<ApprovalLifecyclePayload>
{
  private readonly log = new Logger(WorkflowApprovalGrantedHandler.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly workflowEngine: WorkflowEngineService,
  ) {}

  async handle(event: OutboxEvent<ApprovalLifecyclePayload>): Promise<void> {
    const payload = event.payload;

    // ── 1. Tenant smuggling defense ──────────────────────────────────────
    if (!payload || payload.tenant_id !== event.tenant_id) {
      throw new DeadLetterError(
        `workflow_approval_granted.tenant_mismatch: event.tenant_id=${event.tenant_id} payload.tenant_id=${payload?.tenant_id ?? 'null'}`,
      );
    }

    const {
      approval_id,
      booking_id,
      final_decision,
      workflow_instance_id,
    } = payload;

    if (!workflow_instance_id) {
      // Producer contract: the RPC only emits when workflow_instance_id is
      // populated. A NULL value here means corrupt payload — dead-letter.
      throw new DeadLetterError(
        `workflow_approval_granted.missing_workflow_instance_id: approval=${approval_id} booking=${booking_id}`,
      );
    }

    // ── 2. Verify the workflow_instance exists + is tenant-owned ─────────
    // The 00400 tenant trigger at approvals.workflow_instance_id rejects
    // cross-tenant links at INSERT time; reaching this lookup means either
    // the trigger fired (and the approval row would have rejected) or the
    // instance was deleted post-grant. Either way: no engine work to do.
    const instanceRes = await this.supabase.admin
      .from('workflow_instances')
      .select('id, tenant_id, status')
      .eq('id', workflow_instance_id)
      .eq('tenant_id', event.tenant_id)
      .maybeSingle();

    if (instanceRes.error) {
      // Transient DB wobble — let the outbox retry.
      throw new Error(
        `workflow_approval_granted.instance_read_failed: ${instanceRes.error.message} (event=${event.id} instance=${workflow_instance_id})`,
      );
    }

    if (!instanceRes.data) {
      // Either deleted between RPC commit and drain, OR — and this is the
      // important case — cross-tenant link that somehow made it through the
      // 00400 trigger (schema corruption). DeadLetterError so ops can
      // investigate; we don't want to silently no-op a tenant boundary
      // violation.
      throw new DeadLetterError(
        `workflow.approval_instance_not_found: instance=${workflow_instance_id} tenant=${event.tenant_id} (approval=${approval_id})`,
      );
    }

    const instance = instanceRes.data as {
      id: string;
      tenant_id: string;
      status: string;
    };

    if (instance.status === 'cancelled' || instance.status === 'completed' || instance.status === 'failed') {
      // Terminal state — resume() would no-op via its atomic claim anyway,
      // but logging here makes the audit trail explicit (the approval
      // landed but the parent workflow was already done).
      this.log.log(
        `instance_already_terminal status=${instance.status} instance=${workflow_instance_id} event=${event.id}`,
      );
      return;
    }

    // ── 3. Resolve tenant info for the resume() call's TenantContext.run ─
    // resume() reads TenantContext.current() internally; the outbox worker
    // calls handlers without an ambient tenant. Resolve slug + tier from
    // `tenants` so downstream audit/billing reads see real values (mirrors
    // workflow-engine.service.ts:1780-1788).
    const { data: tenantRow } = await this.supabase.admin
      .from('tenants')
      .select('id, slug, tier')
      .eq('id', event.tenant_id)
      .maybeSingle();
    if (!tenantRow) {
      // Shouldn't happen — the tenants row referenced by the workflow
      // instance must exist (FK). DeadLetterError if it doesn't.
      throw new DeadLetterError(
        `workflow_approval_granted.tenant_not_found: tenant=${event.tenant_id}`,
      );
    }
    const tenantInfo = tenantRow as {
      id: string;
      slug: string;
      tier: 'standard' | 'enterprise';
    };

    // ── 4. Resume the parent workflow_instance ───────────────────────────
    // resume()'s atomic claim is the idempotency guarantee. final_decision
    // becomes the edge_condition the workflow's approval node's outgoing
    // edges match against ('approved' → end_success, 'rejected' →
    // end_failure per the plan §3.3 compiled-graph contract).
    await TenantContext.run(tenantInfo, async () => {
      await this.workflowEngine.resume(
        workflow_instance_id,
        event.tenant_id,
        final_decision,
      );
    });

    this.log.log(
      `resumed instance=${workflow_instance_id} decision=${final_decision} approval=${approval_id} booking=${booking_id} event=${event.id}`,
    );
  }
}
