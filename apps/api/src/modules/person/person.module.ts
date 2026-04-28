import { Module } from '@nestjs/common';
import { PersonService } from './person.service';
import { PersonActivityService } from './person-activity.service';
import { PersonController } from './person.controller';
import { PermissionGuard } from '../../common/permission-guard';

@Module({
  providers: [PersonService, PersonActivityService, PermissionGuard],
  controllers: [PersonController],
  exports: [PersonService, PersonActivityService],
})
export class PersonModule {}
