import { Module } from '@nestjs/common';
import { CatalogMenuService } from './catalog-menu.service';
import { CatalogMenuController } from './catalog-menu.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [CatalogMenuService],
  controllers: [CatalogMenuController],
  exports: [CatalogMenuService],
})
export class CatalogMenuModule {}
