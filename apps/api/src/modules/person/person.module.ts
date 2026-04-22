import { Module } from '@nestjs/common';
import { PersonService } from './person.service';
import { PersonController } from './person.controller';
import { PermissionGuard } from '../../common/permission-guard';

@Module({
  providers: [PersonService, PermissionGuard],
  controllers: [PersonController],
  exports: [PersonService],
})
export class PersonModule {}
