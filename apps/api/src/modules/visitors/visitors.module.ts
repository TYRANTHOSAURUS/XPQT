import { Module, forwardRef } from '@nestjs/common';
import { DbModule } from '../../common/db/db.module';
import { ApprovalModule } from '../approval/approval.module';
import { BookingBundlesModule } from '../booking-bundles/booking-bundles.module';
import { NotificationModule } from '../notification/notification.module';
import { PersonModule } from '../person/person.module';
import { PrivacyComplianceModule } from '../privacy-compliance/privacy-compliance.module';
import { SpaceModule } from '../space/space.module';
import { HostNotificationService } from './host-notification.service';
import { InvitationService } from './invitation.service';
import { VisitorPassPoolService } from './pass-pool.service';
import { ReceptionService } from './reception.service';
import { VisitorEventBus } from './visitor-event-bus';
import { VisitorService } from './visitor.service';

/**
 * Visitor Management v1 — backend module.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §2
 * Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md §Slice 2
 *
 * Slices shipped:
 *   - 2a: scaffold + state machine (VisitorService) + invitation flow.
 *   - 2b: VisitorPassPoolService + HostNotificationService + ReceptionService
 *         + VisitorEventBus (in-process SSE bus for the browser
 *         Notification API channel).
 *
 * Subsequent slices:
 *   - 2c: KioskService + EodSweepWorker
 *   - 2d: BundleCascadeAdapter + VisitorMailDeliveryAdapter + controllers
 *
 * forwardRef on BookingBundlesModule + ApprovalModule:
 *   - BookingBundlesModule: slice 4 wires the bundle cascade adapter as an
 *     event subscriber on BundleService events. Today neither side imports
 *     the other; the forwardRef pre-empts a future cycle.
 *   - ApprovalModule: slice 3 edits the approval dispatcher to call
 *     VisitorService.transitionStatus on grant/deny. Same pre-emption.
 *
 * VisitorPassPoolService is exported so the bundle cascade adapter
 * (slice 4) and any other module that needs to manipulate passes can
 * inject it.
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
  providers: [
    VisitorService,
    InvitationService,
    VisitorPassPoolService,
    VisitorEventBus,
    HostNotificationService,
    ReceptionService,
  ],
  exports: [
    VisitorService,
    InvitationService,
    VisitorPassPoolService,
    HostNotificationService,
    ReceptionService,
    VisitorEventBus,
  ],
})
export class VisitorsModule {}
