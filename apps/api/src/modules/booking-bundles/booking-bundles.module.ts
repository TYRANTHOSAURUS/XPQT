import { Module } from '@nestjs/common';

import { OrdersModule } from '../orders/orders.module';
import { ServiceCatalogModule } from '../service-catalog/service-catalog.module';
import { ServiceRoutingModule } from '../service-routing/service-routing.module';
import { BundleEventBus } from './bundle-event-bus';
import { BundleService } from './bundle.service';
import { BundleVisibilityService } from './bundle-visibility.service';
import { BundleCascadeService } from './bundle-cascade.service';

/**
 * Post-canonicalisation (2026-05-02): the booking IS the bundle (00277:27);
 * the legacy `/booking-bundles/*` HTTP surface is conceptually obsolete and
 * was removed in this slice. The services here (bundle / visibility /
 * cascade / event-bus) keep doing the orchestration work — they're consumed
 * by `BookingFlowService`, `OrderService`, the visitor cascade adapter,
 * etc. — but no controller exposes them directly.
 *
 * Frontend follow-up (separate slice): clients that called `/booking-bundles/*`
 * (`/admin`, `/booking-detail`, `/portal/*`) need to migrate to the
 * canonical `/reservations/*` and a future `/bookings/*` surface. This
 * module no longer registers any HTTP routes.
 */
@Module({
  imports: [OrdersModule, ServiceCatalogModule, ServiceRoutingModule],
  providers: [BundleService, BundleVisibilityService, BundleCascadeService, BundleEventBus],
  controllers: [],
  exports: [BundleService, BundleVisibilityService, BundleCascadeService, BundleEventBus],
})
export class BookingBundlesModule {}
