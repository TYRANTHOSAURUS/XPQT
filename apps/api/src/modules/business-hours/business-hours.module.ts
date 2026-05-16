import { Module } from '@nestjs/common';
import { BusinessHoursService } from './business-hours.service';
import { BusinessHoursController } from './business-hours.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [BusinessHoursService],
  controllers: [BusinessHoursController],
  exports: [BusinessHoursService],
})
export class BusinessHoursModule {}
