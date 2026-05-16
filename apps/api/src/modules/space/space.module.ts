import { Module } from '@nestjs/common';
import { SpaceService } from './space.service';
import { SpaceController } from './space.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [SpaceService],
  controllers: [SpaceController],
  exports: [SpaceService],
})
export class SpaceModule {}
