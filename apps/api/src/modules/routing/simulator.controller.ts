import { BadRequestException, Body, Controller, Get, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { RoutingV2Mode } from '@prequest/shared';
import { RoutingSimulatorService, SimulatorInput, SimulatorResult } from './simulator.service';
import { DecisionRow, DualRunLogRow, RoutingAuditService } from './audit.service';
import { CoverageResponse, RoutingCoverageService } from './coverage.service';
import { ChosenBy } from './resolver.types';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { PermissionGuard } from '../../common/permission-guard';

/**
 * Routing Studio simulator — dry-run, admin-only.
 *
 * No persistence side effects. Reuses ResolverService so simulation results match
 * real ticket-creation behavior exactly.
 */
const VALID_MODES: RoutingV2Mode[] = ['off', 'dualrun', 'shadow', 'v2_only'];

@Controller('routing/studio')
export class RoutingSimulatorController {
  constructor(
    private readonly simulator: RoutingSimulatorService,
    private readonly audit: RoutingAuditService,
    private readonly coverage: RoutingCoverageService,
    private readonly supabase: SupabaseService,
    private readonly permissions: PermissionGuard,
  ) {}

  /**
   * Tenant-level routing_v2_mode read/write. Progression is
   * off → dualrun → shadow → v2_only and back.
   * The evaluator caches the mode for 30s, so changes propagate within
   * that window rather than immediately — the response includes
   * cache_ttl_ms so the UI can show a countdown.
   */
  @Get('mode')
  async getMode(): Promise<{ mode: RoutingV2Mode; cache_ttl_ms: number }> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('tenants')
      .select('feature_flags')
      .eq('id', tenant.id)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    const raw = (data?.feature_flags as Record<string, unknown> | null)?.routing_v2_mode;
    const mode: RoutingV2Mode =
      raw === 'dualrun' || raw === 'shadow' || raw === 'v2_only' ? raw : 'off';
    return { mode, cache_ttl_ms: 30_000 };
  }

  @Patch('mode')
  async setMode(@Body() body: { mode?: string }): Promise<{ mode: RoutingV2Mode }> {
    const tenant = TenantContext.current();
    if (!body?.mode || !VALID_MODES.includes(body.mode as RoutingV2Mode)) {
      throw new BadRequestException(
        `mode must be one of: ${VALID_MODES.join(', ')}`,
      );
    }
    const mode = body.mode as RoutingV2Mode;

    // Read current flags so we update the single key without clobbering others.
    const { data: tenantRow, error: readErr } = await this.supabase.admin
      .from('tenants')
      .select('feature_flags')
      .eq('id', tenant.id)
      .maybeSingle();
    if (readErr) throw new BadRequestException(readErr.message);
    const currentFlags = (tenantRow?.feature_flags as Record<string, unknown>) ?? {};
    const nextFlags = mode === 'off'
      ? Object.fromEntries(Object.entries(currentFlags).filter(([k]) => k !== 'routing_v2_mode'))
      : { ...currentFlags, routing_v2_mode: mode };

    const { error: writeErr } = await this.supabase.admin
      .from('tenants')
      .update({ feature_flags: nextFlags })
      .eq('id', tenant.id);
    if (writeErr) throw new BadRequestException(writeErr.message);

    return { mode };
  }

  @Post('simulate')
  async simulate(
    @Req() request: Request,
    @Body() body: SimulateRequestBody,
  ): Promise<SimulatorResult> {
    // Simulator exposes cross-person portal availability and studio internals —
    // require an admin-grade permission so authenticated non-admins can't probe
    // another person's trace.
    await this.permissions.requirePermission(request, 'routing_studio:access');

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
      include_v2: Boolean(body.include_v2),
      // Portal-scope extension (docs/portal-scope-slice.md §5.6)
      simulate_as_person_id: body.simulate_as_person_id ?? null,
      current_location_id: body.current_location_id ?? null,
      acting_for_location_id: body.acting_for_location_id ?? null,
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

  @Get('dualrun-logs')
  async listDualRunLogs(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('hook') hook?: string,
    @Query('only_divergent') onlyDivergent?: string,
    @Query('since') since?: string,
  ): Promise<{ rows: DualRunLogRow[]; total: number }> {
    return this.audit.listDualRunLogs({
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      offset: offset ? Number.parseInt(offset, 10) : undefined,
      hook: hook === 'case_owner' || hook === 'child_dispatch' ? hook : undefined,
      only_divergent: onlyDivergent === 'true' || onlyDivergent === '1',
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

  @Put('coverage/cell')
  async setCoverageCell(@Body() body: SetCellRequestBody) {
    if (!body || typeof body !== 'object') throw new BadRequestException('Body required');
    if (!body.space_id || !body.domain) {
      throw new BadRequestException('space_id and domain are required');
    }
    const assignee =
      body.assignee && body.assignee.kind && body.assignee.id
        ? { kind: body.assignee.kind, id: body.assignee.id }
        : null;
    return this.coverage.setCell({
      space_id: body.space_id,
      domain: body.domain,
      assignee,
    });
  }
}

interface SetCellRequestBody {
  space_id: string;
  domain: string;
  assignee: { kind: 'team' | 'vendor'; id: string } | null;
}

interface SimulateRequestBody {
  request_type_id: string;
  location_id?: string | null;
  asset_id?: string | null;
  priority?: string | null;
  disabled_rule_ids?: string[];
  include_v2?: boolean;
  // Portal-scope extension
  simulate_as_person_id?: string | null;
  current_location_id?: string | null;
  acting_for_location_id?: string | null;
}
