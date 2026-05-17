import { Module, forwardRef } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { TicketModule } from '../ticket/ticket.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { PermissionGuard } from '../../common/permission-guard';
import { PermissionMetadataGuard } from '../../common/require-permission.decorator';
import { WebhookAdminController } from './webhook-admin.controller';
import { WebhookAdminService } from './webhook-admin.service';
import { WebhookAuthService } from './webhook-auth.service';
import { WebhookEventService } from './webhook-event.service';
import { WebhookIngestController } from './webhook-ingest.controller';
import { WebhookIngestService } from './webhook-ingest.service';
import { WebhookMappingService } from './webhook-mapping.service';

@Module({
  // RLS audit Slice 11.3: WebhookAdminController re-gated AdminGuard →
  // @RequirePermission('webhooks.*'); WebhookIngestController never used
  // AdminGuard, so AuthModule is dropped and the permission guards are
  // provided locally (config-engine.module pattern).
  imports: [TenantModule, forwardRef(() => TicketModule), forwardRef(() => WorkflowModule)],
  providers: [
    PermissionGuard,
    PermissionMetadataGuard,
    WebhookAdminService,
    WebhookAuthService,
    WebhookEventService,
    WebhookIngestService,
    WebhookMappingService,
  ],
  controllers: [WebhookAdminController, WebhookIngestController],
  exports: [WebhookIngestService],
})
export class WebhookModule {}
