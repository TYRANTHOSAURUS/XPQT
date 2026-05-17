import { Controller, Get, Post, Patch, Param, Body } from '@nestjs/common';
import { TenantContext } from '../../common/tenant-context';
import { RequirePermission } from '../../common/require-permission.decorator';
import { WorkflowService } from './workflow.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowSimulatorService } from './workflow-simulator.service';

@Controller('workflows')
export class WorkflowController {
  constructor(
    private readonly workflowService: WorkflowService,
    private readonly engineService: WorkflowEngineService,
    private readonly simulatorService: WorkflowSimulatorService,
  ) {}

  @Get()
  @RequirePermission('workflows.read')
  async list() {
    return this.workflowService.list();
  }

  @Get(':id')
  @RequirePermission('workflows.read')
  async getById(@Param('id') id: string) {
    return this.workflowService.getById(id);
  }

  @Post()
  @RequirePermission('workflows.create')
  async create(@Body() dto: { name: string; entity_type?: string; graph_definition: Record<string, unknown> }) {
    return this.workflowService.create(dto);
  }

  @Patch(':id/graph')
  @RequirePermission('workflows.update')
  async updateGraph(@Param('id') id: string, @Body() dto: { graph_definition: Record<string, unknown> }) {
    return this.workflowService.updateGraph(id, dto.graph_definition);
  }

  @Post(':id/publish')
  @RequirePermission('workflows.publish')
  async publish(@Param('id') id: string) {
    return this.workflowService.publish(id);
  }

  @Post(':id/unpublish')
  @RequirePermission('workflows.publish')
  async unpublish(@Param('id') id: string) {
    return this.workflowService.unpublish(id);
  }

  @Post(':id/clone')
  @RequirePermission('workflows.duplicate')
  async clone(@Param('id') id: string, @Body() dto?: { name?: string }) {
    return this.workflowService.clone(id, dto?.name);
  }

  @Post(':id/simulate')
  @RequirePermission('workflows.test')
  async simulate(@Param('id') id: string, @Body() dto: { ticket?: Record<string, unknown> }) {
    return this.simulatorService.simulate(id, dto?.ticket ?? {});
  }

  @Post(':id/start/:ticketId')
  @RequirePermission('workflows.execute')
  async startForTicket(@Param('id') id: string, @Param('ticketId') ticketId: string) {
    return this.engineService.startForTicket(ticketId, id);
  }

  @Post('instances/:instanceId/resume')
  @RequirePermission('workflows.execute')
  async resume(@Param('instanceId') instanceId: string, @Body() dto?: { edge_condition?: string }) {
    // Cross-tenant write fix (codex post-fix review 2026-05-08): pass tenant
    // explicitly to engine.resume() — the prior fallback branch let an
    // un-tenanted caller resume any tenant's workflow by id alone. The
    // controller always runs inside an authed-request TenantContext, so
    // .current() is the right source.
    const tenant = TenantContext.current();
    return this.engineService.resume(instanceId, tenant.id, dto?.edge_condition);
  }

  @Get('instances/ticket/:ticketId')
  @RequirePermission('workflows.read')
  async getInstancesForTicket(@Param('ticketId') ticketId: string) {
    return this.workflowService.getInstancesForTicket(ticketId);
  }

  @Get('instances/:id')
  @RequirePermission('workflows.read')
  async getInstance(@Param('id') id: string) {
    return this.workflowService.getInstance(id);
  }

  @Get('instances/:id/events')
  @RequirePermission('workflows.read')
  async listInstanceEvents(@Param('id') id: string) {
    return this.workflowService.listInstanceEvents(id);
  }
}
