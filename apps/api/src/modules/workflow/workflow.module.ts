import { Module, forwardRef } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { TicketModule } from '../ticket/ticket.module';
import { SlaModule } from '../sla/sla.module';
import { WorkflowService } from './workflow.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowValidatorService } from './workflow-validator.service';
import { WorkflowSimulatorService } from './workflow-simulator.service';
import { WorkflowController } from './workflow.controller';

@Module({
  // B.2.A.Step9 — SlaModule injected so the `update_ticket` node's sla
  // branch can pre-compute timer due_at values via
  // SlaService.buildTimersForRpc (same shape as WorkOrderService).
  imports: [TenantModule, forwardRef(() => TicketModule), forwardRef(() => SlaModule)],
  providers: [
    WorkflowService,
    WorkflowEngineService,
    WorkflowValidatorService,
    WorkflowSimulatorService,
  ],
  controllers: [WorkflowController],
  exports: [
    WorkflowService,
    WorkflowEngineService,
    WorkflowValidatorService,
    WorkflowSimulatorService,
  ],
})
export class WorkflowModule {}
