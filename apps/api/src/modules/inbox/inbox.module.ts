import { Module } from '@nestjs/common';
import { SupabaseModule } from '../../common/supabase/supabase.module';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

/**
 * InboxModule — read + mark-read surface for `inbox_notifications`.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step E.
 *
 * Sub-step F's React Query hooks consume the routes registered by
 * `InboxController`. Sub-step D's outbox handler does NOT depend on
 * this module — inbox rows are written by the producer RPC (Hybrid C
 * decision in 00393/00394), not by the dispatch handler.
 *
 * Exports `InboxService` so a future module (e.g. a /me dashboard
 * aggregator) can compose the inbox count without re-implementing the
 * actor-resolution + tenant-filter contract.
 */
@Module({
  imports: [SupabaseModule],
  controllers: [InboxController],
  providers: [InboxService],
  exports: [InboxService],
})
export class InboxModule {}
