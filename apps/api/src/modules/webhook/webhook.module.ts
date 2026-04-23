import { Module, forwardRef } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { TicketModule } from '../ticket/ticket.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { WebhookAdminController } from './webhook-admin.controller';
import { WebhookAdminService } from './webhook-admin.service';
import { WebhookAuthService } from './webhook-auth.service';
import { WebhookEventService } from './webhook-event.service';
import { WebhookIngestController } from './webhook-ingest.controller';
import { WebhookIngestService } from './webhook-ingest.service';
import { WebhookMappingService } from './webhook-mapping.service';

@Module({
  imports: [TenantModule, forwardRef(() => TicketModule), forwardRef(() => WorkflowModule)],
  providers: [
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
