import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../../common/supabase/supabase.service';
import { WorkflowEngineService } from '../../workflow/workflow-engine.service';
import { DeadLetterError } from '../dead-letter.error';
import { OutboxHandler, type OutboxEventHandler } from '../outbox-handler.decorator';
import type { OutboxEvent } from '../outbox.types';

/**
 * WorkflowStartHandler — drains `workflow.start_required` outbox events.
 *
 * Spec: docs/follow-ups/b2-survey-and-design.md §3.9.3 line 2567 +
 *       §3.11 (create_ticket_with_automation no-approval branch) +
 *       §3.5 (grant_ticket_approval) + §3.10 (reclassify_ticket).
 *
 * ── Source-of-truth contract (v8 / C3 sweep) ─────────────────────────────
 *
 * Reads `tickets.workflow_id` at FIRE time as the source of truth. The
 * event payload's `workflow_definition_id` is a wake-up reference, not
 * authoritative:
 *
 *   - Ticket hard-deleted between emit + fire → terminal
 *     `{ kind: 'ticket_not_found' }`, NOT retry-deadletter (v9 / P-I5).
 *   - `ticket.workflow_id IS NULL` → terminal `{ kind: 'no_workflow' }`
 *     (a concurrent reclassify cleared the workflow).
 *   - Event payload's `workflow_definition_id` differs from
 *     `ticket.workflow_id` → `{ kind: 'stale_event' }` no-op. A more
 *     recent reclassify wrote a different workflow + emitted its own
 *     start event; the chain converges because each reclassify writes
 *     the ticket row BEFORE emit (v9 / P-I4).
 *   - Else: call `WorkflowEngineService.startForTicket` which INSERTs
 *     into workflow_instances. With migration 00345's partial unique
 *     index, a concurrent successful insert raises 23505 — caught here
 *     as `{ kind: 'already_started' }` (terminal SUCCESS, not failure).
 *
 * ── Idempotency ───────────────────────────────────────────────────────────
 *
 * Pre-check via SELECT for existing active row + 23505 catch on the
 * INSERT path. Migration 00345's partial unique index is the hard
 * guarantee — even if the pre-check races, the constraint stops the
 * duplicate.
 *
 * Per spec line 2567: "On conflict, returns `{ kind: 'already_started' }`."
 * The constraint guarantees AT MOST ONE active workflow instance per
 * (tenant, ticket) — closes the zombie-event race that existed when the
 * handler trusted the event payload.
 */

export interface WorkflowStartRequiredPayload {
  /** Tenant — duplicated from event.tenant_id for handler convenience + defense-in-depth. */
  tenant_id: string;
  /** Case (tickets) row id. */
  ticket_id: string;
  /** Emitter's view of the workflow definition. Compared against tickets.workflow_id at fire time. */
  workflow_definition_id: string;
}

@Injectable()
@OutboxHandler('workflow.start_required', { version: 1 })
export class WorkflowStartHandler
  implements OutboxEventHandler<WorkflowStartRequiredPayload>
{
  private readonly log = new Logger(WorkflowStartHandler.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly workflowEngine: WorkflowEngineService,
  ) {}

  async handle(event: OutboxEvent<WorkflowStartRequiredPayload>): Promise<void> {
    const { tenant_id, ticket_id, workflow_definition_id: payload_workflow_id } = event.payload;

    // ── 1. Tenant smuggling defense ──────────────────────────────────────
    if (tenant_id !== event.tenant_id) {
      throw new DeadLetterError(
        `workflow_start.tenant_mismatch: event.tenant_id=${event.tenant_id} payload.tenant_id=${tenant_id}`,
      );
    }

    // ── 2. Re-read ticket.workflow_id (source of truth per v8 / C3) ──────
    const ticketRes = await this.supabase.admin
      .from('tickets')
      .select('id, tenant_id, workflow_id')
      .eq('id', ticket_id)
      .eq('tenant_id', event.tenant_id)
      .maybeSingle();

    if (ticketRes.error) {
      throw new Error(`workflow_start.ticket_read_failed: ${ticketRes.error.message}`);
    }

    if (!ticketRes.data) {
      // Hard-deleted. Terminal per v9 / P-I5.
      this.log.log(`ticket_not_found ticket=${ticket_id} event=${event.id}`);
      return;
    }

    const currentWorkflowId = ticketRes.data.workflow_id as string | null;

    if (!currentWorkflowId) {
      this.log.log(`no_workflow ticket=${ticket_id} event=${event.id}`);
      return;
    }

    if (currentWorkflowId !== payload_workflow_id) {
      // Stale event — a more recent reclassify wrote a different workflow.
      // The chain converges via the newer event's own start_required emit.
      this.log.log(
        `stale_event ticket=${ticket_id} payload_wf=${payload_workflow_id} current_wf=${currentWorkflowId} event=${event.id}`,
      );
      return;
    }

    // ── 3. Pre-check for existing active instance ────────────────────────
    //
    // Defense against the constraint exception path — most replays will
    // find a row here and exit cleanly without burning attempts on a
    // 23505. Migration 00345's partial unique index is the hard guarantee;
    // this read is a latency / log-clarity optimisation.
    const existingRes = await this.supabase.admin
      .from('workflow_instances')
      .select('id, status')
      .eq('ticket_id', ticket_id)
      .eq('tenant_id', event.tenant_id)
      .in('status', ['active', 'waiting'])
      .maybeSingle();

    if (existingRes.error) {
      throw new Error(`workflow_start.existing_read_failed: ${existingRes.error.message}`);
    }

    if (existingRes.data) {
      this.log.log(
        `already_started ticket=${ticket_id} instance=${existingRes.data.id} event=${event.id}`,
      );
      return;
    }

    // ── 4. Start the workflow instance ───────────────────────────────────
    //
    // WorkflowEngineService.startForTicket runs inside TenantContext.run
    // (set by OutboxWorker per §4.3). It SELECTs the workflow definition,
    // INSERTs the instance, and kicks off the trigger node.
    //
    // The INSERT may still race against another concurrent handler firing.
    // Migration 00345's partial unique index will raise 23505 on the
    // duplicate; we treat 23505 as success-via-race (`already_started`).
    try {
      const instance = await this.workflowEngine.startForTicket(ticket_id, currentWorkflowId);
      if (!instance) {
        // startForTicket returns null for: definition missing in tenant,
        // empty graph, missing trigger node. None of these are transient.
        throw new DeadLetterError(
          `workflow_start.definition_invalid: workflow_definition=${currentWorkflowId} for ticket=${ticket_id} did not produce a runnable instance (missing definition, empty graph, or missing trigger node)`,
        );
      }
      this.log.log(
        `started ticket=${ticket_id} instance=${(instance as { id: string }).id} workflow=${currentWorkflowId} event=${event.id}`,
      );
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        // 23505 on workflow_instances_active_unique_idx → another handler
        // run beat us to the INSERT. The active row exists; success.
        this.log.log(
          `already_started_via_race ticket=${ticket_id} event=${event.id} — 23505 caught from startForTicket INSERT`,
        );
        return;
      }
      if (err instanceof DeadLetterError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `workflow_start transient error for event=${event.id} ticket=${ticket_id}: ${message}`,
      );
    }
  }

  /**
   * Detect a PG 23505 unique_violation on the workflow_instances active
   * partial unique index. supabase-js surfaces PG errors as PostgrestError
   * with `.code` and `.message`. The constraint name is the migration
   * 00345 index identifier.
   */
  private isUniqueViolation(err: unknown): boolean {
    if (!err) return false;
    const e = err as { code?: string; message?: string; details?: string };
    if (e.code === '23505') return true;
    const msg = `${e.message ?? ''} ${e.details ?? ''}`;
    return msg.includes('23505') || msg.includes('workflow_instances_active_unique_idx');
  }
}
