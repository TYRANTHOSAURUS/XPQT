import { Module, forwardRef } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { TicketModule } from '../ticket/ticket.module';
import { SlaModule } from '../sla/sla.module';
import { PermissionGuard } from '../../common/permission-guard';
import { PermissionMetadataGuard } from '../../common/require-permission.decorator';
import { WorkflowService } from './workflow.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowValidatorService } from './workflow-validator.service';
import { WorkflowSimulatorService } from './workflow-simulator.service';
import { WorkflowWaitSweeperCron } from './workflow-wait-sweeper.cron';
import { ApprovalCancelSweeperCron } from './approval-cancel-sweeper.cron';
import { WorkflowController } from './workflow.controller';

@Module({
  // B.2.A.Step9 — SlaModule injected so the `update_ticket` node's sla
  // branch can pre-compute timer due_at values via
  // SlaService.buildTimersForRpc (same shape as WorkOrderService).
  imports: [TenantModule, forwardRef(() => TicketModule), forwardRef(() => SlaModule)],
  providers: [
    // RLS audit Slice 11.3: WorkflowController re-gated AdminGuard →
    // @RequirePermission('workflows.*'); AuthModule dropped, the two
    // permission guards provided locally (config-engine.module pattern).
    PermissionGuard,
    PermissionMetadataGuard,
    WorkflowService,
    WorkflowEngineService,
    WorkflowValidatorService,
    WorkflowSimulatorService,
    // Phase 1.C — Tier 1 cron backstop for `wait_timeout_at` expiry.
    // ScheduleModule.forRoot() is wired at app.module.ts:60 already.
    // Spec: docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md §3.5.
    WorkflowWaitSweeperCron,
    // Phase 1.5 sub-step 6.G — backstop for any drift where a
    // workflow_instance is in status='cancelled' but linked approvals
    // are still pending (legacy rows, manual SQL surgery, etc.).
    // PRIMARY path is the cancel_workflow_instance_with_approvals RPC
    // (00400 §2.6.8); this cron sweeps the residue.
    ApprovalCancelSweeperCron,
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
