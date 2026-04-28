import { Module } from '@nestjs/common';
import { DbModule } from '../../common/db/db.module';
import { PrivacyComplianceModule } from '../privacy-compliance/privacy-compliance.module';
import { VendorAuthController } from './vendor-auth.controller';
import { VendorAuthService } from './vendor-auth.service';
import { LoggingVendorMailer, VENDOR_MAILER } from './vendor-mailer.service';
import { VendorOrderController } from './vendor-order.controller';
import { VendorOrderService } from './vendor-order.service';
import { VendorPortalGuard } from './vendor-portal.guard';

/**
 * Vendor portal — Phase B.
 *
 * Sprint 1 ships: magic-link auth tables + VendorAuthService skeleton +
 * audit event taxonomy.
 *
 * Sprint 2: /vendor/auth/redeem controller, /vendor/inbox + /vendor/orders/:id
 *           pages, VendorOrderService with PII-minimized projections.
 * Sprint 3: status updates, decline, realtime push to desk.
 * Sprint 4: email magic-link delivery, webhook channel, PWA.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md.
 */
@Module({
  imports: [DbModule, PrivacyComplianceModule],
  controllers: [VendorAuthController, VendorOrderController],
  providers: [
    VendorAuthService,
    VendorOrderService,
    VendorPortalGuard,
    LoggingVendorMailer,
    {
      provide: VENDOR_MAILER,
      // Sprint 1: log-only dev mailer. Sprint 4 swaps in a real EU
      // delivery provider (Postmark / Resend) here.
      useExisting: LoggingVendorMailer,
    },
  ],
  exports: [VendorAuthService, VendorOrderService, VendorPortalGuard, VENDOR_MAILER],
})
export class VendorPortalModule {}
