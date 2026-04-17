import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { WorkflowValidatorService } from './workflow-validator.service';

interface Graph {
  nodes: Array<{ id: string; type: string; config: Record<string, unknown>; position?: { x: number; y: number } }>;
  edges: Array<{ from: string; to: string; condition?: string }>;
}

@Injectable()
export class WorkflowService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly validator: WorkflowValidatorService,
  ) {}

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

    if (error || !data) throw new NotFoundException('Workflow not found');
    return data;
  }

  async create(dto: { name: string; entity_type?: string; graph_definition?: Record<string, unknown> }) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('workflow_definitions')
      .insert({
        tenant_id: tenant.id,
        name: dto.name,
        entity_type: dto.entity_type ?? 'ticket',
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
      throw new BadRequestException({ message: 'Workflow is invalid', errors: result.errors });
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
    if (error || !data) throw new NotFoundException('Instance not found');
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
