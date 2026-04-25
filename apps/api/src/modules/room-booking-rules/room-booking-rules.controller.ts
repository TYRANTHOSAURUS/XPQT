import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../../common/permission-guard';
import { RoomBookingRulesService } from './room-booking-rules.service';
import { SimulationService } from './simulation.service';
import { ImpactPreviewService } from './impact-preview.service';
import { listTemplates } from './rule-templates';
import type {
  CreateRuleDto,
  FromTemplateDto,
  ImpactPreviewDraftDto,
  RuleListFilters,
  SaveScenarioDto,
  SimulateDto,
  UpdateRuleDto,
} from './dto';

/**
 * REST surface for room-booking rules + simulation + impact preview.
 *
 * Permissions:
 *   - Read endpoints require `rooms.admin` (rules are admin-only by design).
 *   - Write endpoints require `rooms.admin`.
 *   - Templates list is also `rooms.admin` because it's only useful inside
 *     the admin editor.
 */
@Controller('room-booking-rules')
export class RoomBookingRulesController {
  constructor(
    private readonly rules: RoomBookingRulesService,
    private readonly simulation: SimulationService,
    private readonly impactPreview: ImpactPreviewService,
    private readonly permissions: PermissionGuard,
  ) {}

  // ── Rules ────────────────────────────────────────────────────────────

  @Get()
  async list(
    @Req() req: Request,
    @Query('target_scope') targetScope?: string,
    @Query('target_id') targetId?: string,
    @Query('active') active?: string,
    @Query('effect') effect?: string,
  ) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    const filters: RuleListFilters = {};
    if (targetScope) filters.target_scope = targetScope as RuleListFilters['target_scope'];
    if (targetId) filters.target_id = targetId;
    if (active !== undefined) filters.active = active === 'true';
    if (effect) filters.effect = effect as RuleListFilters['effect'];
    return this.rules.list(filters);
  }

  @Get('templates')
  async templates(@Req() req: Request) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    return listTemplates();
  }

  @Get(':id')
  async findOne(@Req() req: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    return this.rules.findOne(id);
  }

  @Get(':id/versions')
  async versions(@Req() req: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    return this.rules.versions(id);
  }

  @Post()
  async create(@Req() req: Request, @Body() dto: CreateRuleDto) {
    const { userId } = await this.permissions.requirePermission(req, 'rooms.admin');
    return this.rules.create(dto, userId);
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateRuleDto,
  ) {
    const { userId } = await this.permissions.requirePermission(req, 'rooms.admin');
    return this.rules.update(id, dto, userId);
  }

  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string) {
    const { userId } = await this.permissions.requirePermission(req, 'rooms.admin');
    return this.rules.softDelete(id, userId);
  }

  @Post(':id/restore-version')
  async restoreVersion(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { version_number: number },
  ) {
    const { userId } = await this.permissions.requirePermission(req, 'rooms.admin');
    return this.rules.restoreVersion(id, body.version_number, userId);
  }

  @Post('from-template')
  async fromTemplate(@Req() req: Request, @Body() dto: FromTemplateDto) {
    const { userId } = await this.permissions.requirePermission(req, 'rooms.admin');
    return this.rules.createFromTemplate(dto, userId);
  }

  // ── Simulation ───────────────────────────────────────────────────────

  @Post('simulate')
  async simulate(@Req() req: Request, @Body() dto: SimulateDto) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    return this.simulation.run(dto);
  }

  // ── Impact preview ───────────────────────────────────────────────────

  @Post(':id/impact-preview')
  async impactPreviewById(@Req() req: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    return this.impactPreview.previewById(id);
  }

  @Post('impact-preview/draft')
  async impactPreviewDraft(
    @Req() req: Request,
    @Body() dto: ImpactPreviewDraftDto,
  ) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    return this.impactPreview.previewDraft(dto);
  }
}

/**
 * Saved-scenario CRUD lives on its own path per the spec (§3.1):
 *   GET  /room-booking-simulation-scenarios
 *   POST /room-booking-simulation-scenarios
 *   POST /room-booking-simulation-scenarios/:id/run
 */
@Controller('room-booking-simulation-scenarios')
export class RoomBookingScenariosController {
  constructor(
    private readonly simulation: SimulationService,
    private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  async list(@Req() req: Request) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    return this.simulation.listScenarios();
  }

  @Post()
  async create(@Req() req: Request, @Body() dto: SaveScenarioDto) {
    const { userId } = await this.permissions.requirePermission(req, 'rooms.admin');
    return this.simulation.createScenario(dto, userId);
  }

  @Post(':id/run')
  async run(@Req() req: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    return this.simulation.runSavedScenario(id);
  }
}
