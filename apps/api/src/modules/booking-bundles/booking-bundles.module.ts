import { Module } from '@nestjs/common';

import { OrdersModule } from '../orders/orders.module';
import { ServiceCatalogModule } from '../service-catalog/service-catalog.module';
import { BookingBundlesController } from './booking-bundles.controller';
import { BundleService } from './bundle.service';
import { BundleVisibilityService } from './bundle-visibility.service';

@Module({
  imports: [OrdersModule, ServiceCatalogModule],
  providers: [BundleService, BundleVisibilityService],
  controllers: [BookingBundlesController],
  exports: [BundleService, BundleVisibilityService],
})
export class BookingBundlesModule {}
