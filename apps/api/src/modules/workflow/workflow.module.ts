import { Module } from '@nestjs/common';
import { WorkflowService } from './workflow.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowController } from './workflow.controller';

@Module({
  providers: [WorkflowService, WorkflowEngineService],
  controllers: [WorkflowController],
  exports: [WorkflowService, WorkflowEngineService],
})
export class WorkflowModule {}
