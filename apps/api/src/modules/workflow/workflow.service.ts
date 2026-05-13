import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { AppError, AppErrors } from '../../common/errors';
import { WorkflowValidatorService } from './workflow-validator.service';
import { WorkflowEngineService, type WorkflowEntityKind } from './workflow-engine.service';

interface Graph {
  nodes: Array<{ id: string; type: string; config: Record<string, unknown>; position?: { x: number; y: number } }>;
  edges: Array<{ from: string; to: string; condition?: string }>;
}

@Injectable()
export class WorkflowService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly validator: WorkflowValidatorService,
    // Phase 1.5 sub-step 6.A.Y: `start({...})` overload routes to engine.
    // forwardRef because WorkflowEngineService also depends on this module
    // for `workflow.service.ts`-typed reads in some test paths.
    @Inject(forwardRef(() => WorkflowEngineService))
    private readonly engine: WorkflowEngineService,
  ) {}

  /**
   * Phase 1.5 sub-step 6.A.Y — polymorphic start entry point.
   *
   * Routes by `entityKind`:
   *   - `'case'`       → `engine.startForTicket(entityId, definitionId)`
   *                       (legacy: entityId is the ticket/case row id).
   *   - `'booking'`    → `engine.startForBooking(entityId, definitionId)`
   *                       (Phase 1.5 new path; writes booking_id +
   *                       entity_kind='booking'; gates definition status=
   *                       'published').
   *   - `'work_order'` → not implemented in Phase 1.5; throws
   *                       `workflow.advance_failed`. Future Phase 1.B.x
   *                       slice ships this.
   *
   * `tenantId` is honored — `TenantContext.run({...})` MUST be active at
   * the call site (every NestJS controller path already wraps with the
   * tenant middleware). The engine's `startFor*` methods read
   * `TenantContext.current()` internally.
   *
   * Returns the inserted workflow_instances row.
   */
  async start(args: {
    definitionId: string;
    entityKind: WorkflowEntityKind;
    entityId: string;
    tenantId: string;
  }): Promise<unknown> {
    if (args.entityKind === 'case') {
      return this.engine.startForTicket(args.entityId, args.definitionId);
    }
    if (args.entityKind === 'booking') {
      return this.engine.startForBooking(args.entityId, args.definitionId);
    }
    if (args.entityKind === 'work_order') {
      throw AppErrors.server('workflow.advance_failed', {
        detail: 'work_order start not implemented in Phase 1.5',
      });
    }
    // Exhaustive guard — narrow the union.
    const _exhaustive: never = args.entityKind;
    throw new AppError('workflow.advance_failed', 500, {
      detail: `unknown entityKind: ${String(_exhaustive)}`,
    });
  }

  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('workflow_definitions')
      .select('id, name, entity_type, version, status, created_at, published_at')
      .eq('tenant_id', tenant.id)
      .order('name');

    if (error) throw error;
    return data;
  }

  async getById(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('workflow_definitions')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .single();

    if (error || !data) throw AppErrors.notFoundWithCode('workflow.not_found', 'Workflow not found');
    return data;
  }

  async create(dto: { name: string; entity_type?: string; graph_definition?: Record<string, unknown> }) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('workflow_definitions')
      .insert({
        tenant_id: tenant.id,
        name: dto.name,
        // Default to 'case' (NOT 'ticket'). Phase 0 migration 00369
        // widens the entity_type CHECK to ('case','work_order','booking')
        // and drops the column default of 'ticket' from 00009:8 — sending
        // 'ticket' would violate the new CHECK. Phase 4 editor adds an
        // explicit entity_type picker; until then, callers that omit
        // entity_type get 'case' (the dominant historical use).
        entity_type: dto.entity_type ?? 'case',
        graph_definition: dto.graph_definition ?? { nodes: [], edges: [] },
        status: 'draft',
        version: 1,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateGraph(id: string, graphDefinition: Record<string, unknown>) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('workflow_definitions')
      .update({ graph_definition: graphDefinition })
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .eq('status', 'draft')
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async publish(id: string) {
    const tenant = TenantContext.current();
    const wf = await this.getById(id);
    const result = this.validator.validate((wf.graph_definition ?? { nodes: [], edges: [] }) as Graph);
    if (!result.ok) {
      throw AppErrors.validationFailed('workflow.invalid', { detail: 'Workflow is invalid' });
    }
    const { data, error } = await this.supabase.admin
      .from('workflow_definitions')
      .update({ status: 'published', published_at: new Date().toISOString() })
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async unpublish(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('workflow_definitions')
      .update({ status: 'draft', published_at: null })
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async clone(id: string, name?: string) {
    const tenant = TenantContext.current();
    const original = await this.getById(id);
    const newGraph = this.regenerateNodeIds((original.graph_definition ?? { nodes: [], edges: [] }) as Graph);
    const { data, error } = await this.supabase.admin
      .from('workflow_definitions')
      .insert({
        tenant_id: tenant.id,
        name: name ?? `${original.name} (copy)`,
        entity_type: original.entity_type,
        graph_definition: newGraph,
        status: 'draft',
        version: 1,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async getInstancesForTicket(ticketId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('workflow_instances')
      .select('*')
      .eq('ticket_id', ticketId)
      .eq('tenant_id', tenant.id);

    if (error) throw error;
    return data;
  }

  async getInstance(instanceId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('workflow_instances')
      .select('*, definition:workflow_definitions(*)')
      .eq('id', instanceId)
      .eq('tenant_id', tenant.id)
      .single();
    if (error || !data) throw AppErrors.notFoundWithCode('workflow_instance.not_found', 'Instance not found');
    return data;
  }

  async listInstanceEvents(instanceId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('workflow_instance_events')
      .select('*')
      .eq('workflow_instance_id', instanceId)
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data;
  }

  private regenerateNodeIds(graph: Graph): Graph {
    const idMap = new Map<string, string>();
    const nodes = graph.nodes.map((n) => {
      const newId = `n_${Math.random().toString(36).slice(2, 10)}`;
      idMap.set(n.id, newId);
      return { ...n, id: newId };
    });
    const edges = graph.edges.map((e) => ({ ...e, from: idMap.get(e.from) ?? e.from, to: idMap.get(e.to) ?? e.to }));
    return { nodes, edges };
  }
}
