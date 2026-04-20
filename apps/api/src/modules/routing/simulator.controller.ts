import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { RoutingSimulatorService, SimulatorInput, SimulatorResult } from './simulator.service';

/**
 * Routing Studio simulator — dry-run, admin-only.
 *
 * No persistence side effects. Reuses ResolverService so simulation results match
 * real ticket-creation behavior exactly.
 */
@Controller('routing/studio')
export class RoutingSimulatorController {
  constructor(private readonly simulator: RoutingSimulatorService) {}

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
}

interface SimulateRequestBody {
  request_type_id: string;
  location_id?: string | null;
  asset_id?: string | null;
  priority?: string | null;
  disabled_rule_ids?: string[];
}
