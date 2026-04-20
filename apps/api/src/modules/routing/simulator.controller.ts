import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { RoutingSimulatorService, SimulatorInput, SimulatorResult } from './simulator.service';
import { DecisionRow, RoutingAuditService } from './audit.service';
import { CoverageResponse, RoutingCoverageService } from './coverage.service';
import { ChosenBy } from './resolver.types';

/**
 * Routing Studio simulator — dry-run, admin-only.
 *
 * No persistence side effects. Reuses ResolverService so simulation results match
 * real ticket-creation behavior exactly.
 */
@Controller('routing/studio')
export class RoutingSimulatorController {
  constructor(
    private readonly simulator: RoutingSimulatorService,
    private readonly audit: RoutingAuditService,
    private readonly coverage: RoutingCoverageService,
  ) {}

  @Post('simulate')
  async simulate(@Body() body: SimulateRequestBody): Promise<SimulatorResult> {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException('Body required');
    }
    if (!body.request_type_id) {
      throw new BadRequestException('request_type_id is required');
    }

    const input: SimulatorInput = {
      request_type_id: body.request_type_id,
      location_id: body.location_id ?? null,
      asset_id: body.asset_id ?? null,
      priority: body.priority ?? null,
      disabled_rule_ids: Array.isArray(body.disabled_rule_ids) ? body.disabled_rule_ids : undefined,
    };
    return this.simulator.simulate(input);
  }

  @Get('decisions')
  async listDecisions(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('chosen_by') chosenBy?: string,
    @Query('ticket_id') ticketId?: string,
    @Query('since') since?: string,
  ): Promise<{ rows: DecisionRow[]; total: number }> {
    return this.audit.listDecisions({
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      offset: offset ? Number.parseInt(offset, 10) : undefined,
      chosen_by: chosenBy as ChosenBy | undefined,
      ticket_id: ticketId,
      since,
    });
  }

  @Get('coverage')
  async coverageMatrix(
    @Query('space_root_id') spaceRootId?: string,
    @Query('domains') domainsCsv?: string,
    @Query('max_cells') maxCells?: string,
  ): Promise<CoverageResponse> {
    return this.coverage.getCoverage({
      space_root_id: spaceRootId,
      domains: domainsCsv ? domainsCsv.split(',').map((d) => d.trim()).filter(Boolean) : undefined,
      max_cells: maxCells ? Number.parseInt(maxCells, 10) : undefined,
    });
  }
}

interface SimulateRequestBody {
  request_type_id: string;
  location_id?: string | null;
  asset_id?: string | null;
  priority?: string | null;
  disabled_rule_ids?: string[];
}
