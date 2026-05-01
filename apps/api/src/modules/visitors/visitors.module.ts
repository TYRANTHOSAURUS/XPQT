import { Module, forwardRef } from '@nestjs/common';
import { DbModule } from '../../common/db/db.module';
import { ApprovalModule } from '../approval/approval.module';
import { BookingBundlesModule } from '../booking-bundles/booking-bundles.module';
import { NotificationModule } from '../notification/notification.module';
import { PersonModule } from '../person/person.module';
import { PrivacyComplianceModule } from '../privacy-compliance/privacy-compliance.module';
import { SpaceModule } from '../space/space.module';
import { InvitationService } from './invitation.service';
import { VisitorService } from './visitor.service';

/**
 * Visitor Management v1 — backend module.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §2
 * Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md §Slice 2
 *
 * **Scope of this slice (2a)**: scaffold + state machine + invitation flow.
 * Subsequent slices add:
 *   - 2b: HostNotificationService + VisitorPassPoolService + ReceptionService
 *   - 2c: KioskService + EodSweepWorker
 *   - 2d: BundleCascadeAdapter + VisitorMailDeliveryAdapter + controllers
 *
 * forwardRef on BookingBundlesModule + ApprovalModule:
 *   - BookingBundlesModule: slice 4 wires the bundle cascade adapter as an
 *     event subscriber on BundleService events. Today neither side imports
 *     the other; the forwardRef pre-empts a future cycle.
 *   - ApprovalModule: slice 3 edits the approval dispatcher to call
 *     VisitorService.transitionStatus on grant/deny. Same pre-emption.
 */
@Module({
  imports: [
    DbModule,
    PersonModule,
    NotificationModule,
    PrivacyComplianceModule,
    SpaceModule,
    forwardRef(() => BookingBundlesModule),
    forwardRef(() => ApprovalModule),
  ],
  providers: [VisitorService, InvitationService],
  exports: [VisitorService, InvitationService],
})
export class VisitorsModule {}
