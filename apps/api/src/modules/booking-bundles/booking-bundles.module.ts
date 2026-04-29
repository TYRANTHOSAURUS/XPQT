import { Module } from '@nestjs/common';

import { OrdersModule } from '../orders/orders.module';
import { ServiceCatalogModule } from '../service-catalog/service-catalog.module';
import { ServiceRoutingModule } from '../service-routing/service-routing.module';
import { BookingBundlesController } from './booking-bundles.controller';
import { BundleService } from './bundle.service';
import { BundleVisibilityService } from './bundle-visibility.service';
import { BundleCascadeService } from './bundle-cascade.service';

@Module({
  imports: [OrdersModule, ServiceCatalogModule, ServiceRoutingModule],
  providers: [BundleService, BundleVisibilityService, BundleCascadeService],
  controllers: [BookingBundlesController],
  exports: [BundleService, BundleVisibilityService, BundleCascadeService],
})
export class BookingBundlesModule {}
