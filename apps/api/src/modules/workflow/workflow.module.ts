import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { WorkflowService } from './workflow.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowValidatorService } from './workflow-validator.service';
import { WorkflowSimulatorService } from './workflow-simulator.service';
import { WorkflowWebhookService } from './workflow-webhook.service';
import { WorkflowController } from './workflow.controller';
import { WorkflowWebhookController, WorkflowWebhookReceiveController } from './workflow-webhook.controller';

@Module({
  imports: [TenantModule],
  providers: [
    WorkflowService,
    WorkflowEngineService,
    WorkflowValidatorService,
    WorkflowSimulatorService,
    WorkflowWebhookService,
  ],
  controllers: [
    WorkflowController,
    WorkflowWebhookController,
    WorkflowWebhookReceiveController,
  ],
  exports: [
    WorkflowService,
    WorkflowEngineService,
    WorkflowValidatorService,
    WorkflowSimulatorService,
    WorkflowWebhookService,
  ],
})
export class WorkflowModule {}
