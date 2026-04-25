import { Module } from '@nestjs/common';
import { PermissionGuard } from '../../common/permission-guard';
import { PredicateEngineService } from './predicate-engine.service';
import { RuleResolverService } from './rule-resolver.service';
import { RoomBookingRulesService } from './room-booking-rules.service';
import { SimulationService } from './simulation.service';
import { ImpactPreviewService } from './impact-preview.service';
import {
  RoomBookingRulesController,
  RoomBookingScenariosController,
} from './room-booking-rules.controller';

/**
 * Phase B of the Room Booking Foundation. Owns:
 *   - room_booking_rules CRUD + version history
 *   - 12 starter rule templates (compile params → predicate)
 *   - rule resolver (single-space + bulk picker path)
 *   - rule-evaluation predicate engine (with org / business-hours helpers)
 *   - simulation (saved scenarios + dry-run with optional draft rules)
 *   - impact preview (replay against last 30 days of reservations)
 *
 * Exports the resolver + engine so Phase C's BookingFlowService can consume
 * them without back-channel access to the schema.
 */
@Module({
  providers: [
    PermissionGuard,
    PredicateEngineService,
    RuleResolverService,
    RoomBookingRulesService,
    SimulationService,
    ImpactPreviewService,
  ],
  controllers: [RoomBookingRulesController, RoomBookingScenariosController],
  exports: [
    PredicateEngineService,
    RuleResolverService,
    RoomBookingRulesService,
    SimulationService,
    ImpactPreviewService,
  ],
})
export class RoomBookingRulesModule {}
