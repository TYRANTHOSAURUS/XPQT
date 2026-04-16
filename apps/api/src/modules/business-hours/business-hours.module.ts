import { Module } from '@nestjs/common';
import { BusinessHoursService } from './business-hours.service';
import { BusinessHoursController } from './business-hours.controller';

@Module({
  providers: [BusinessHoursService],
  controllers: [BusinessHoursController],
  exports: [BusinessHoursService],
})
export class BusinessHoursModule {}
