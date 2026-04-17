import { Controller, Get, Post, Patch, Param, Body } from '@nestjs/common';
import { WorkflowService } from './workflow.service';
import { WorkflowEngineService } from './workflow-engine.service';

@Controller('workflows')
export class WorkflowController {
  constructor(
    private readonly workflowService: WorkflowService,
    private readonly engineService: WorkflowEngineService,
  ) {}

  @Get()
  async list() {
    return this.workflowService.list();
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.workflowService.getById(id);
  }

  @Post()
  async create(@Body() dto: { name: string; entity_type?: string; graph_definition: Record<string, unknown> }) {
    return this.workflowService.create(dto);
  }

  @Patch(':id/graph')
  async updateGraph(@Param('id') id: string, @Body() dto: { graph_definition: Record<string, unknown> }) {
    return this.workflowService.updateGraph(id, dto.graph_definition);
  }

  @Post(':id/publish')
  async publish(@Param('id') id: string) {
    return this.workflowService.publish(id);
  }

  @Post(':id/unpublish')
  async unpublish(@Param('id') id: string) {
    return this.workflowService.unpublish(id);
  }

  @Post(':id/clone')
  async clone(@Param('id') id: string, @Body() dto?: { name?: string }) {
    return this.workflowService.clone(id, dto?.name);
  }

  @Post(':id/start/:ticketId')
  async startForTicket(@Param('id') id: string, @Param('ticketId') ticketId: string) {
    return this.engineService.startForTicket(ticketId, id);
  }

  @Post('instances/:instanceId/resume')
  async resume(@Param('instanceId') instanceId: string, @Body() dto?: { edge_condition?: string }) {
    return this.engineService.resume(instanceId, dto?.edge_condition);
  }

  @Get('instances/ticket/:ticketId')
  async getInstancesForTicket(@Param('ticketId') ticketId: string) {
    return this.workflowService.getInstancesForTicket(ticketId);
  }

  @Get('instances/:id')
  async getInstance(@Param('id') id: string) {
    return this.workflowService.getInstance(id);
  }

  @Get('instances/:id/events')
  async listInstanceEvents(@Param('id') id: string) {
    return this.workflowService.listInstanceEvents(id);
  }
}
