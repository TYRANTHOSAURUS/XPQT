import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { OutboxHandlerRegistry } from './outbox-handler.registry';
import { OutboxService } from './outbox.service';
import { OutboxWorker } from './outbox.worker';

/**
 * OutboxModule — foundation only (Plan B.1.foundation).
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §9 (module),
 *       §3.2 (service), §4 (worker), §11 #5 (registry/decorator).
 *
 * NOT yet exported / wired:
 *   - BookingCreateAttemptedHandler (separate cutover phase)
 *   - watchdog wiring inside create_booking
 *   - dual-emission shadow mode for compensation
 *
 * Schema/RLS dependencies (DbModule + SupabaseModule are @Global, so no
 * explicit imports needed):
 *   - outbox.events / outbox.events_dead_letter / public.outbox_shadow_results
 *     are created in supabase/migrations/00299_outbox_foundation.sql.
 *   - DiscoveryModule is imported here so OutboxHandlerRegistry can walk all
 *     DI providers at OnModuleInit (spec §9, N1 fold) and self-discover
 *     handlers without a central registration map (= no merge-conflict hot spot).
 */
@Module({
  imports: [DiscoveryModule],
  providers: [OutboxService, OutboxHandlerRegistry, OutboxWorker],
  exports: [OutboxService, OutboxHandlerRegistry],
})
export class OutboxModule {}
