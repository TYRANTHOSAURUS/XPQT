import { Module } from '@nestjs/common';

import { BookingBundlesController } from './booking-bundles.controller';
import { BundleService } from './bundle.service';

@Module({
  providers: [BundleService],
  controllers: [BookingBundlesController],
  exports: [BundleService],
})
export class BookingBundlesModule {}
