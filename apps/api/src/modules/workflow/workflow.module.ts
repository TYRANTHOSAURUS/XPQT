import { Module } from '@nestjs/common';
import { WorkflowService } from './workflow.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowValidatorService } from './workflow-validator.service';
import { WorkflowSimulatorService } from './workflow-simulator.service';
import { WorkflowController } from './workflow.controller';

@Module({
  providers: [WorkflowService, WorkflowEngineService, WorkflowValidatorService, WorkflowSimulatorService],
  controllers: [WorkflowController],
  exports: [WorkflowService, WorkflowEngineService, WorkflowValidatorService, WorkflowSimulatorService],
})
export class WorkflowModule {}
