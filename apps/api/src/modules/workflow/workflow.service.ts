import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

@Injectable()
export class WorkflowService {
  constructor(private readonly supabase: SupabaseService) {}

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

  async create(dto: { name: string; entity_type?: string; graph_definition: Record<string, unknown> }) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('workflow_definitions')
      .insert({
        tenant_id: tenant.id,
        name: dto.name,
        entity_type: dto.entity_type ?? 'ticket',
        graph_definition: dto.graph_definition,
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
}
