import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { WorkflowEngineService, type EmittedEvent, type WorkflowRunContext } from './workflow-engine.service';

interface GraphShape {
  nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>;
  edges: Array<{ from: string; to: string; condition?: string }>;
}

@Injectable()
export class WorkflowSimulatorService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly engine: WorkflowEngineService,
  ) {}

  async simulate(workflowId: string, simulatedTicket: Record<string, unknown>) {
    const tenant = TenantContext.current();
    const { data: definition } = await this.supabase.admin
      .from('workflow_definitions')
      .select('*')
      .eq('id', workflowId)
      .eq('tenant_id', tenant.id)
      .single();
    if (!definition) throw new NotFoundException('Workflow not found');

    const graph = (definition.graph_definition ?? { nodes: [], edges: [] }) as GraphShape;
    const trigger = graph.nodes.find((n) => n.type === 'trigger');
    if (!trigger) {
      return { path: [] as string[], events: [] as EmittedEvent[], terminated: false, errors: ['NO_TRIGGER'] };
    }

    const ctx: WorkflowRunContext = {
      dryRun: true,
      simulatedTicket,
      events: [],
      path: [],
    };

    await this.engine.advance('dry-run', graph, trigger.id, 'dry-run', undefined, ctx);

    const terminated = ctx.events.some((e) => e.event_type === 'instance_completed');
    return {
      path: ctx.path,
      events: ctx.events,
      terminated,
      stoppedAt: ctx.stoppedAt,
    };
  }
}
