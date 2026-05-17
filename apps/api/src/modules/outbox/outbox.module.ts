import { Module, forwardRef } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { RoutingModule } from '../routing/routing.module';
import { ServiceRoutingModule } from '../service-routing/service-routing.module';
import { SlaModule } from '../sla/sla.module';
import { VisitorsModule } from '../visitors/visitors.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { BookingApprovalRequiredHandler } from './handlers/booking-approval-required.handler';
import { BookingCancelledCascadeHandler } from './handlers/booking-cancelled-cascade.handler';
import { RoutingEvaluationHandler } from './handlers/routing-evaluation.handler';
import { SetupWorkOrderHandler } from './handlers/setup-work-order.handler';
import { SlaTimerHandler } from './handlers/sla-timer-recompute.handler';
import { SlaTimerRepointHandler } from './handlers/sla-timer-repoint.handler';
import {
  WorkflowSpawnWakeCore,
  WorkflowSpawnWakeOnBookingCancelledHandler,
  WorkflowSpawnWakeOnBookingCreatedHandler,
  WorkflowSpawnWakeOnBookingStatusChangedHandler,
} from './handlers/workflow-spawn-wake.handler';
import { WorkflowStartHandler } from './handlers/workflow-start.handler';
import { WorkflowApprovalGrantedHandler } from './handlers/workflow-approval-granted.handler';
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
 *     events emitted by `edit_booking` v5 (00394:974-993) when a §3.6.5
 *     row 2/7/8 outcome flipped a booking to require_approval. B.4.A.5
 *     sub-step D: re-reads approval state for chain_id (architect C3
 *     sla-timer-repoint pattern), resolves person + team approvers to
 *     users (tenant-filtered), enriches the typed payload (booking +
 *     space + requester JOINs), and dispatches one email per resolved
 *     user via NotificationsService — with idempotencyKey =
 *     `<event.id>:<userId>` so at-least-once outbox retries stay
 *     exactly-once at Resend. Per-user dispatch failures are isolated.
 *     Inbox rows are written atomically by the producer RPC (Hybrid C).
 *     B.4.A.5 supersedes the B.4.A.4 stub.
 *   - WorkflowSpawnWakeOnBookingCreated/Cancelled/StatusChangedHandler —
 *     three thin shells around WorkflowSpawnWakeCore (Universal Workflow
 *     Architecture Phase 1.A; spec
 *     docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md
 *     §3.5 LOCKED Tier 2 wake). Drain booking.created/cancelled/status_changed
 *     events emitted by 00372/00373 + Phase 2's transition_booking_status
 *     RPC; atomically claim matching rows in workflow_instance_links and
 *     resume the parent workflow_instance via WorkflowEngineService.resume().
 *     The three-class split is required by the registry pattern (one
 *     @OutboxHandler per class — registry throws on duplicate metadata
 *     key). All three delegate to the shared WorkflowSpawnWakeCore so
 *     state + dependencies aren't duplicated.
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
    NotificationsModule,
    forwardRef(() => SlaModule),
    forwardRef(() => WorkflowModule),
    // Booking-audit Slice 2 (audit 03 P0-1/P1-5): BookingCancelledCascade
    // Handler reuses BundleCascadeAdapter (visitor cascade) +
    // BookingNotificationsService (requester reservation_cancelled notif
    // + audit). forwardRef both — they are large modules and the import
    // is one-directional (no module imports OutboxModule), but forwardRef
    // keeps Nest's resolver order-insensitive.
    forwardRef(() => VisitorsModule),
    forwardRef(() => ReservationsModule),
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
    // Booking-audit Slice 2 (audit 03 P0-1/P1-5) — durable user-cancel
    // cascade. Drains `booking.cancel_cascade_required` (emitted by
    // cancel_booking_with_cascade RPC 00408, distinct from the
    // booking.cancelled event the workflow wake handler consumes — the
    // registry forbids two handlers on one (event_type, version)).
    // Reuses BundleCascadeAdapter (visitor cascade) +
    // BookingNotificationsService (requester notif). Idempotent under
    // at-least-once retry (audit-existence dedup on the requester notif;
    // visitor transition is a no-op when already terminal).
    BookingCancelledCascadeHandler,
    // Universal Workflow Architecture Phase 1.A — Tier 2 wake mechanism.
    // Core does the work; per-event shells own the @OutboxHandler decoration.
    WorkflowSpawnWakeCore,
    WorkflowSpawnWakeOnBookingCreatedHandler,
    WorkflowSpawnWakeOnBookingCancelledHandler,
    WorkflowSpawnWakeOnBookingStatusChangedHandler,
    // Phase 1.5 sub-step 6.D — drain 00403's `approval.granted` outbox
    // events; calls WorkflowEngineService.resume(...) on the parent
    // workflow_instance.
    WorkflowApprovalGrantedHandler,
  ],
  exports: [OutboxService, OutboxHandlerRegistry],
})
export class OutboxModule {}
