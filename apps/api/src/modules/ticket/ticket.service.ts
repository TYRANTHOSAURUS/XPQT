import { Injectable, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RoutingService } from '../routing/routing.service';
import { SlaService } from '../sla/sla.service';
import { WorkflowEngineService } from '../workflow/workflow-engine.service';

export interface CreateTicketDto {
  ticket_type_id?: string;
  parent_ticket_id?: string;
  title: string;
  description?: string;
  priority?: string;
  impact?: string;
  urgency?: string;
  requester_person_id: string;
  location_id?: string;
  asset_id?: string;
  assigned_team_id?: string;
  assigned_user_id?: string;
  interaction_mode?: string;
  source_channel?: string;
  form_data?: Record<string, unknown>;
}

export interface UpdateTicketDto {
  title?: string;
  description?: string;
  status?: string;
  status_category?: string;
  waiting_reason?: string | null;
  priority?: string;
  assigned_team_id?: string | null;
  assigned_user_id?: string | null;
  tags?: string[];
  watchers?: string[];
  cost?: number | null;
  satisfaction_rating?: number | null;
  satisfaction_comment?: string | null;
}

export interface TicketListFilters {
  status_category?: string;
  priority?: string;
  assigned_team_id?: string;
  assigned_user_id?: string;
  location_id?: string;
  requester_person_id?: string;
  parent_ticket_id?: string | null;
  sla_at_risk?: boolean;
  search?: string;
  cursor?: string; // ticket ID for cursor-based pagination
  limit?: number;
}

export interface AddActivityDto {
  activity_type: string;
  author_person_id?: string;
  visibility: string;
  content?: string;
  attachments?: Array<{ name: string; url: string; size: number; type: string }>;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class TicketService {
  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => RoutingService)) private readonly routingService: RoutingService,
    private readonly slaService: SlaService,
    @Inject(forwardRef(() => WorkflowEngineService)) private readonly workflowEngine: WorkflowEngineService,
  ) {}

  async list(filters: TicketListFilters = {}) {
    const tenant = TenantContext.current();
    const limit = Math.min(filters.limit ?? 50, 100);

    let query = this.supabase.admin
      .from('tickets')
      .select(`
        *,
        requester:persons!tickets_requester_person_id_fkey(id, first_name, last_name, email),
        location:spaces!tickets_location_id_fkey(id, name, type),
        assigned_team:teams!tickets_assigned_team_id_fkey(id, name),
        assigned_agent:users!tickets_assigned_user_id_fkey(id, email)
      `)
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    // Apply filters
    if (filters.status_category) query = query.eq('status_category', filters.status_category);
    if (filters.priority) query = query.eq('priority', filters.priority);
    if (filters.assigned_team_id) query = query.eq('assigned_team_id', filters.assigned_team_id);
    if (filters.assigned_user_id) query = query.eq('assigned_user_id', filters.assigned_user_id);
    if (filters.location_id) query = query.eq('location_id', filters.location_id);
    if (filters.requester_person_id) query = query.eq('requester_person_id', filters.requester_person_id);
    if (filters.sla_at_risk === true) query = query.eq('sla_at_risk', true);

    // Parent filter: null = top-level only, specific ID = children of that ticket
    if (filters.parent_ticket_id === null) {
      query = query.is('parent_ticket_id', null);
    } else if (filters.parent_ticket_id) {
      query = query.eq('parent_ticket_id', filters.parent_ticket_id);
    }

    // Cursor-based pagination
    if (filters.cursor) {
      query = query.lt('id', filters.cursor);
    }

    // Text search on title and description
    if (filters.search) {
      query = query.or(`title.ilike.%${filters.search}%,description.ilike.%${filters.search}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    return {
      items: data ?? [],
      next_cursor: data && data.length === limit ? data[data.length - 1].id : null,
    };
  }

  async getById(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('tickets')
      .select(`
        *,
        requester:persons!tickets_requester_person_id_fkey(id, first_name, last_name, email, department),
        location:spaces!tickets_location_id_fkey(id, name, type, parent_id),
        asset:assets!tickets_asset_id_fkey(id, name, asset_role, serial_number),
        assigned_team:teams!tickets_assigned_team_id_fkey(id, name),
        assigned_agent:users!tickets_assigned_user_id_fkey(id, email),
        request_type:request_types!tickets_ticket_type_id_fkey(id, name, domain)
      `)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .single();

    if (error || !data) throw new NotFoundException('Ticket not found');
    return data;
  }

  async create(dto: CreateTicketDto) {
    const tenant = TenantContext.current();

    const { data, error } = await this.supabase.admin
      .from('tickets')
      .insert({
        tenant_id: tenant.id,
        ticket_type_id: dto.ticket_type_id,
        parent_ticket_id: dto.parent_ticket_id,
        title: dto.title,
        description: dto.description,
        priority: dto.priority ?? 'medium',
        impact: dto.impact,
        urgency: dto.urgency,
        requester_person_id: dto.requester_person_id,
        location_id: dto.location_id,
        asset_id: dto.asset_id,
        assigned_team_id: dto.assigned_team_id,
        assigned_user_id: dto.assigned_user_id,
        interaction_mode: dto.interaction_mode ?? 'internal',
        source_channel: dto.source_channel ?? 'portal',
        status: 'new',
        status_category: 'new',
        form_data: dto.form_data,
      })
      .select()
      .single();

    if (error) throw error;

    // Log system event
    await this.addActivity(data.id, {
      activity_type: 'system_event',
      visibility: 'system',
      metadata: { event: 'ticket_created' },
    });

    // Log domain event
    await this.logDomainEvent(data.id, 'ticket_created', { ticket_id: data.id });

    // ── Auto-routing ──────────────────────────────────────────
    // If no team was explicitly assigned, evaluate routing rules
    if (!data.assigned_team_id && !data.assigned_user_id) {
      try {
        const requestType = data.ticket_type_id
          ? await this.supabase.admin.from('request_types').select('domain').eq('id', data.ticket_type_id).single()
          : null;

        const routingResult = await this.routingService.evaluate({
          ticket_type_id: data.ticket_type_id,
          domain: requestType?.data?.domain,
          location_id: data.location_id,
          priority: data.priority,
        });

        if (routingResult.assigned_team_id || routingResult.assigned_user_id) {
          const updates: Record<string, unknown> = {};
          if (routingResult.assigned_team_id) updates.assigned_team_id = routingResult.assigned_team_id;
          if (routingResult.assigned_user_id) updates.assigned_user_id = routingResult.assigned_user_id;
          updates.status_category = 'assigned';

          await this.supabase.admin.from('tickets').update(updates).eq('id', data.id);
          Object.assign(data, updates);

          await this.addActivity(data.id, {
            activity_type: 'system_event',
            visibility: 'system',
            metadata: { event: 'auto_routed', rule: routingResult.rule_name },
          });
        }
      } catch {
        // Routing failure should not block ticket creation
      }
    }

    // ── Auto-SLA ──────────────────────────────────────────────
    // Start SLA timers if the request type has a linked SLA policy
    if (data.ticket_type_id) {
      try {
        const { data: requestType } = await this.supabase.admin
          .from('request_types')
          .select('sla_policy_id')
          .eq('id', data.ticket_type_id)
          .single();

        if (requestType?.sla_policy_id) {
          await this.slaService.startTimers(data.id, tenant.id, requestType.sla_policy_id);
          await this.supabase.admin.from('tickets').update({ sla_id: requestType.sla_policy_id }).eq('id', data.id);
        }
      } catch {
        // SLA failure should not block ticket creation
      }
    }

    // ── Auto-workflow ─────────────────────────────────────────
    // Start workflow if the request type has a linked workflow definition
    if (data.ticket_type_id) {
      try {
        const { data: requestType } = await this.supabase.admin
          .from('request_types')
          .select('workflow_definition_id')
          .eq('id', data.ticket_type_id)
          .single();

        if (requestType?.workflow_definition_id) {
          await this.workflowEngine.startForTicket(data.id, requestType.workflow_definition_id);
        }
      } catch {
        // Workflow failure should not block ticket creation
      }
    }

    return data;
  }

  async update(id: string, dto: UpdateTicketDto) {
    const tenant = TenantContext.current();

    // Get current state for change tracking
    const current = await this.getById(id);

    const updateData: Record<string, unknown> = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined && (current as Record<string, unknown>)[key] !== value) {
        updateData[key] = value;
        changes[key] = { from: (current as Record<string, unknown>)[key], to: value };
      }
    }

    if (Object.keys(updateData).length === 0) return current;

    // Handle status transitions
    if (updateData.status_category === 'resolved' && !current.resolved_at) {
      updateData.resolved_at = new Date().toISOString();
    }
    if (updateData.status_category === 'closed' && !current.closed_at) {
      updateData.closed_at = new Date().toISOString();
    }

    const { data, error } = await this.supabase.admin
      .from('tickets')
      .update(updateData)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();

    if (error) throw error;

    // Log changes as system events
    if (changes.status_category) {
      await this.addActivity(id, {
        activity_type: 'system_event',
        visibility: 'system',
        metadata: { event: 'status_changed', ...changes.status_category },
      });
      await this.logDomainEvent(id, 'ticket_status_changed', changes.status_category);
    }

    if (changes.assigned_team_id || changes.assigned_user_id) {
      await this.addActivity(id, {
        activity_type: 'system_event',
        visibility: 'system',
        metadata: {
          event: 'assignment_changed',
          team: changes.assigned_team_id,
          user: changes.assigned_user_id,
        },
      });
      await this.logDomainEvent(id, 'ticket_assigned', {
        team: changes.assigned_team_id,
        user: changes.assigned_user_id,
      });
    }

    return data;
  }

  async getActivities(ticketId: string, visibility?: string) {
    const tenant = TenantContext.current();

    let query = this.supabase.admin
      .from('ticket_activities')
      .select(`
        *,
        author:persons!ticket_activities_author_person_id_fkey(id, first_name, last_name)
      `)
      .eq('ticket_id', ticketId)
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: true });

    // For employee-facing views, only show external + system events
    if (visibility === 'external') {
      query = query.in('visibility', ['external', 'system']);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  async addActivity(ticketId: string, dto: AddActivityDto) {
    const tenant = TenantContext.current();

    const { data, error } = await this.supabase.admin
      .from('ticket_activities')
      .insert({
        tenant_id: tenant.id,
        ticket_id: ticketId,
        activity_type: dto.activity_type,
        author_person_id: dto.author_person_id,
        visibility: dto.visibility,
        content: dto.content,
        attachments: dto.attachments ?? [],
        metadata: dto.metadata,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async getChildTasks(parentTicketId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('tickets')
      .select('id, title, status, status_category, priority, assigned_team_id, assigned_user_id, interaction_mode, created_at, resolved_at')
      .eq('parent_ticket_id', parentTicketId)
      .eq('tenant_id', tenant.id)
      .order('created_at');

    if (error) throw error;
    return data;
  }

  async bulkUpdate(ids: string[], dto: UpdateTicketDto) {
    const tenant = TenantContext.current();

    const { data, error } = await this.supabase.admin
      .from('tickets')
      .update(dto as Record<string, unknown>)
      .in('id', ids)
      .eq('tenant_id', tenant.id)
      .select();

    if (error) throw error;
    return data;
  }

  private async logDomainEvent(entityId: string, eventType: string, payload: Record<string, unknown>) {
    const tenant = TenantContext.current();
    await this.supabase.admin
      .from('domain_events')
      .insert({
        tenant_id: tenant.id,
        event_type: eventType,
        entity_type: 'ticket',
        entity_id: entityId,
        payload,
      });
  }
}
