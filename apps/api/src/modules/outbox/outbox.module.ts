import { Module, forwardRef } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { RoutingModule } from '../routing/routing.module';
import { ServiceRoutingModule } from '../service-routing/service-routing.module';
import { SlaModule } from '../sla/sla.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { BookingApprovalRequiredHandler } from './handlers/booking-approval-required.handler';
import { RoutingEvaluationHandler } from './handlers/routing-evaluation.handler';
import { SetupWorkOrderHandler } from './handlers/setup-work-order.handler';
import { SlaTimerHandler } from './handlers/sla-timer-recompute.handler';
import { SlaTimerRepointHandler } from './handlers/sla-timer-repoint.handler';
import { WorkflowStartHandler } from './handlers/workflow-start.handler';
import { OutboxHandlerRegistry } from './outbox-handler.registry';
import { OutboxService } from './outbox.service';
import { OutboxWorker } from './outbox.worker';

/**
 * OutboxModule — foundation + B.0.E + B.2.A.Step12 handlers.
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §9 (module),
 *       §3.2 (service), §4 (worker), §11 #5 (registry/decorator),
 *       §7.8 (setup-WO handler).
 *
 *       docs/follow-ups/b2-survey-and-design.md §3.9.3 line 2564 / 2567
 *       (SlaTimerHandler + WorkflowStartHandler contracts).
 *
 * Registered handlers (discovered by OutboxHandlerRegistry via the
 * @OutboxHandler decorator):
 *
 *   - SetupWorkOrderHandler — drains `setup_work_order.create_required`
 *     events via the atomic `create_setup_work_order_from_event` RPC
 *     (B.0.E.1). Shipped 2026-05-04.
 *   - SlaTimerHandler — drains `sla.timer_recompute_required` events
 *     via the atomic `start_sla_timers` RPC (migration 00347). Reads
 *     `tickets.sla_id` at fire time as source of truth per v8 / C3.
 *     B.2.A.Step12 commit 2.
 *   - WorkflowStartHandler — drains `workflow.start_required` events
 *     via `WorkflowEngineService.startForTicket`. Reads
 *     `tickets.workflow_id` at fire time as source of truth per v8 / C3.
 *     Idempotent via migration 00345's partial unique index +
 *     handler-side 23505 catch. B.2.A.Step12 commit 2.
 *   - SlaTimerRepointHandler — drains `sla.timer_repointed_required`
 *     events via `repoint_sla_timer` RPC (00353 v2). STOPs old-policy
 *     active timers + INSERTs fresh timers under the new policy in one
 *     PG tx. Idempotent short-circuit on (tenant, ticket, new_policy)
 *     (00353 step 4). B.2.A.Step11 commit 1.
 *   - RoutingEvaluationHandler — drains `routing.evaluation_required`
 *     events. Calls `RoutingService.evaluate`, then `set_entity_assignment`
 *     RPC if the resolver picks a different target. Always inserts a
 *     `routing_decisions` audit row (including `unassigned` outcomes).
 *     Sets `tickets.routing_status='idle'` on success or `'failed'` on
 *     resolver / RPC errors. B.2.A.Step11 commit 1.
 *   - BookingApprovalRequiredHandler — drains `booking.approval_required`
 *     events emitted by `edit_booking` (00364:1059-1080) when a §3.6.5
 *     row 2/7/8 outcome flipped a booking to require_approval. v1 is a
 *     registration STUB (validates payload + tenant boundary, logs);
 *     notification dispatch lands in B.4.A.5. Required pre-cutover per
 *     event-types.ts:40-51 — without it, edit-driven approval flips
 *     stall silently. B.4.A.4.
 *
 * Schema/RLS dependencies (DbModule + SupabaseModule are @Global, so no
 * explicit imports needed):
 *   - outbox.events / outbox.events_dead_letter / public.outbox_shadow_results
 *     are created in supabase/migrations/00299_outbox_foundation.sql.
 *   - public.start_sla_timers RPC + sla_timers_active_unique_idx are
 *     created in 00347 + 00346 respectively.
 *   - public.repoint_sla_timer RPC is created in 00348 / v2 in 00353.
 *   - public.set_entity_assignment RPC is created in 00326 / v2 in 00327.
 *   - public.workflow_instances_active_unique_idx is created in 00345.
 *   - DiscoveryModule is imported here so OutboxHandlerRegistry can walk all
 *     DI providers at OnModuleInit (spec §9, N1 fold) and self-discover
 *     handlers without a central registration map.
 *   - ServiceRoutingModule provides SetupWorkOrderRowBuilder.
 *   - SlaModule (forwardRef to break circular with TicketModule chain)
 *     provides BusinessHoursService for both SLA timer handlers.
 *   - WorkflowModule (forwardRef) provides WorkflowEngineService for
 *     WorkflowStartHandler's start path.
 *   - RoutingModule provides RoutingService for the RoutingEvaluationHandler.
 */
@Module({
  imports: [
    DiscoveryModule,
    ServiceRoutingModule,
    RoutingModule,
    forwardRef(() => SlaModule),
    forwardRef(() => WorkflowModule),
  ],
  providers: [
    OutboxService,
    OutboxHandlerRegistry,
    OutboxWorker,
    SetupWorkOrderHandler,
    SlaTimerHandler,
    SlaTimerRepointHandler,
    WorkflowStartHandler,
    RoutingEvaluationHandler,
    BookingApprovalRequiredHandler,
  ],
  exports: [OutboxService, OutboxHandlerRegistry],
})
export class OutboxModule {}
