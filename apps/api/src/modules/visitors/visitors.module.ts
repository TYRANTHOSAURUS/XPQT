import { Module, forwardRef } from '@nestjs/common';
import { DbModule } from '../../common/db/db.module';
import { PermissionGuard } from '../../common/permission-guard';
import { ApprovalModule } from '../approval/approval.module';
import { AuthModule } from '../auth/auth.module';
import { BookingBundlesModule } from '../booking-bundles/booking-bundles.module';
import { NotificationModule } from '../notification/notification.module';
import { PersonModule } from '../person/person.module';
import { PrivacyComplianceModule } from '../privacy-compliance/privacy-compliance.module';
import { SpaceModule } from '../space/space.module';
import { VisitorsAdminController } from './admin.controller';
import { BundleCascadeAdapter } from './bundle-cascade.adapter';
import { EodSweepWorker } from './eod-sweep.worker';
import { HostNotificationService } from './host-notification.service';
import { InvitationService } from './invitation.service';
import { KioskAuthGuard } from './kiosk-auth.guard';
import { KioskController } from './kiosk.controller';
import { KioskService } from './kiosk.service';
import { VisitorPassPoolService } from './pass-pool.service';
import { ReceptionController } from './reception.controller';
import { ReceptionService } from './reception.service';
import { VisitorEventBus } from './visitor-event-bus';
import { VisitorMailDeliveryAdapter } from './visitor-mail-delivery.adapter';
import { VisitorService } from './visitor.service';
import { VisitorsController } from './visitors.controller';

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
 *   - 2c: KioskService + KioskAuthGuard + EodSweepWorker (cron + lease)
 *         + BundleCascadeAdapter (event subscriber stub) +
 *         VisitorMailDeliveryAdapter (wraps email_delivery_events).
 *
 * Subsequent slices:
 *   - 2d: controllers (REST endpoints for portal / reception / kiosk / admin).
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
    AuthModule,
    forwardRef(() => BookingBundlesModule),
    forwardRef(() => ApprovalModule),
  ],
  controllers: [
    VisitorsController,
    ReceptionController,
    KioskController,
    VisitorsAdminController,
  ],
  providers: [
    VisitorService,
    InvitationService,
    VisitorPassPoolService,
    VisitorEventBus,
    HostNotificationService,
    ReceptionService,
    VisitorMailDeliveryAdapter,
    BundleCascadeAdapter,
    KioskAuthGuard,
    KioskService,
    EodSweepWorker,
    PermissionGuard,
  ],
  exports: [
    VisitorService,
    InvitationService,
    VisitorPassPoolService,
    HostNotificationService,
    ReceptionService,
    VisitorEventBus,
    VisitorMailDeliveryAdapter,
    KioskAuthGuard,
    KioskService,
    EodSweepWorker,
  ],
})
export class VisitorsModule {}
