import { Module } from '@nestjs/common';
import { DbModule } from '../../common/db/db.module';
import { PrivacyComplianceModule } from '../privacy-compliance/privacy-compliance.module';
import { VendorAuthService } from './vendor-auth.service';

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
  providers: [VendorAuthService],
  exports: [VendorAuthService],
})
export class VendorPortalModule {}
