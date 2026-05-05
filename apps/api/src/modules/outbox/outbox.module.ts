import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ServiceRoutingModule } from '../service-routing/service-routing.module';
import { SetupWorkOrderHandler } from './handlers/setup-work-order.handler';
import { OutboxHandlerRegistry } from './outbox-handler.registry';
import { OutboxService } from './outbox.service';
import { OutboxWorker } from './outbox.worker';

/**
 * OutboxModule — foundation + setup-work-order handler (B.0.E.1).
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §9 (module),
 *       §3.2 (service), §4 (worker), §11 #5 (registry/decorator),
 *       §7.8 (setup-WO handler).
 *
 * NOT yet exported / wired:
 *   - watchdog wiring inside create_booking
 *   - dual-emission shadow mode for compensation
 *
 * Schema/RLS dependencies (DbModule + SupabaseModule are @Global, so no
 * explicit imports needed):
 *   - outbox.events / outbox.events_dead_letter / public.outbox_shadow_results
 *     are created in supabase/migrations/00299_outbox_foundation.sql.
 *   - public.create_setup_work_order_from_event RPC is created in
 *     supabase/migrations/00306_create_setup_work_order_from_event_rpc.sql
 *     (v8.1 contract — derives identity from outbox.events row, validates
 *     every tenant-owned FK, rejects non-null requester_person_id).
 *   - DiscoveryModule is imported here so OutboxHandlerRegistry can walk all
 *     DI providers at OnModuleInit (spec §9, N1 fold) and self-discover
 *     handlers without a central registration map (= no merge-conflict hot spot).
 *   - ServiceRoutingModule provides the `SetupWorkOrderRowBuilder` the
 *     handler depends on. SetupWorkOrderTriggerService stays exported
 *     from service-routing for non-outbox callers during the cutover; the
 *     legacy two-step write is no longer used by the outbox path.
 */
@Module({
  imports: [DiscoveryModule, ServiceRoutingModule],
  providers: [
    OutboxService,
    OutboxHandlerRegistry,
    OutboxWorker,
    // B.0.E.1 — drains setup_work_order.create_required events via the
    // atomic create_setup_work_order_from_event RPC. Discovered by
    // OutboxHandlerRegistry through the @OutboxHandler decorator.
    SetupWorkOrderHandler,
  ],
  exports: [OutboxService, OutboxHandlerRegistry],
})
export class OutboxModule {}
