import { Injectable, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RoutingService } from '../routing/routing.service';
import { SlaService } from '../sla/sla.service';
import { WorkflowEngineService } from '../workflow/workflow-engine.service';
import { ApprovalService } from '../approval/approval.service';

export interface CreateTicketDto {
  ticket_type_id?: string;
  parent_ticket_id?: string;
  ticket_kind?: 'case' | 'work_order';
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
  assigned_vendor_id?: string | null;
  tags?: string[];
  watchers?: string[];
  cost?: number | null;
  satisfaction_rating?: number | null;
  satisfaction_comment?: string | null;
}

export interface ReassignDto {
  assigned_team_id?: string | null;
  assigned_user_id?: string | null;
  assigned_vendor_id?: string | null;
  reason: string;
  rerun_resolver?: boolean;
  actor_person_id?: string;
}

export interface TicketListFilters {
  status_category?: string;
  priority?: string;
  ticket_kind?: 'case' | 'work_order';
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
  attachments?: Array<{ name: string; url?: string; path?: string; size: number; type: string }>;
  metadata?: Record<string, unknown>;
}

interface StoredAttachment {
  name: string;
  url?: string;
  path?: string;
  size: number;
  type: string;
}

const TICKET_ATTACHMENT_BUCKET = 'ticket-attachments';

@Injectable()
export class TicketService {
  private attachmentBucketReady = false;

  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => RoutingService)) private readonly routingService: RoutingService,
    private readonly slaService: SlaService,
    @Inject(forwardRef(() => WorkflowEngineService)) private readonly workflowEngine: WorkflowEngineService,
    @Inject(forwardRef(() => ApprovalService)) private readonly approvalService: ApprovalService,
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
    if (filters.ticket_kind) query = query.eq('ticket_kind', filters.ticket_kind);
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
        ticket_kind: dto.ticket_kind ?? 'case',
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

    // Load full request-type config once — used by approval gate + automation
    const requestTypeCfg = data.ticket_type_id
      ? (await this.supabase.admin
          .from('request_types')
          .select('domain, sla_policy_id, workflow_definition_id, requires_approval, approval_approver_team_id, approval_approver_person_id')
          .eq('id', data.ticket_type_id)
          .single()).data
      : null;

    // ── Approval gate ─────────────────────────────────────────
    // When the request type requires approval, park the ticket in
    // pending_approval and create an approval request. Routing/SLA/workflow
    // happen once approval is granted (see onApprovalDecision).
    if (requestTypeCfg?.requires_approval &&
        (requestTypeCfg.approval_approver_person_id || requestTypeCfg.approval_approver_team_id)) {
      await this.supabase.admin
        .from('tickets')
        .update({ status: 'awaiting_approval', status_category: 'pending_approval' })
        .eq('id', data.id);
      data.status = 'awaiting_approval';
      data.status_category = 'pending_approval';

      await this.approvalService.createSingleStep({
        target_entity_type: 'ticket',
        target_entity_id: data.id,
        approver_person_id: requestTypeCfg.approval_approver_person_id as string | undefined,
        approver_team_id: requestTypeCfg.approval_approver_team_id as string | undefined,
      });

      await this.addActivity(data.id, {
        activity_type: 'system_event',
        visibility: 'system',
        metadata: { event: 'approval_requested' },
      });

      return data;
    }

    // Normal path: routing → SLA → workflow
    await this.runPostCreateAutomation(data, tenant.id, requestTypeCfg);
    return data;
  }

  /**
   * Called by approval flow after a ticket's approval request is resolved.
   * Runs routing/SLA/workflow on approval; marks ticket cancelled on rejection.
   */
  async onApprovalDecision(ticketId: string, outcome: 'approved' | 'rejected') {
    const tenant = TenantContext.current();
    const ticket = await this.getById(ticketId);
    if (ticket.status_category !== 'pending_approval') return;

    if (outcome === 'rejected') {
      await this.supabase.admin
        .from('tickets')
        .update({ status: 'rejected', status_category: 'closed', closed_at: new Date().toISOString() })
        .eq('id', ticketId);
      await this.addActivity(ticketId, {
        activity_type: 'system_event',
        visibility: 'system',
        metadata: { event: 'approval_rejected' },
      });
      return;
    }

    // Approved — move out of pending_approval and run automation
    await this.supabase.admin
      .from('tickets')
      .update({ status: 'new', status_category: 'new' })
      .eq('id', ticketId);
    const ticketRecord = await this.getById(ticketId);

    await this.addActivity(ticketId, {
      activity_type: 'system_event',
      visibility: 'system',
      metadata: { event: 'approval_approved' },
    });

    const cfg = ticketRecord.ticket_type_id
      ? (await this.supabase.admin
          .from('request_types')
          .select('domain, sla_policy_id, workflow_definition_id')
          .eq('id', ticketRecord.ticket_type_id)
          .single()).data
      : null;

    await this.runPostCreateAutomation(ticketRecord as Record<string, unknown>, tenant.id, cfg);
  }

  private async runPostCreateAutomation(
    data: Record<string, unknown>,
    tenantId: string,
    requestTypeCfg: Record<string, unknown> | null,
  ) {
    // ── Auto-routing ──────────────────────────────────────────
    const isWorkOrder = data.ticket_kind === 'work_order';
    if (!isWorkOrder && !data.assigned_team_id && !data.assigned_user_id && !data.assigned_vendor_id) {
      try {
        let effectiveLocation = data.location_id as string | null;
        if (!effectiveLocation && data.asset_id) {
          const { data: asset } = await this.supabase.admin
            .from('assets').select('assigned_space_id').eq('id', data.asset_id as string).single();
          effectiveLocation = (asset?.assigned_space_id as string | null) ?? null;
        }

        const evalCtx = {
          tenant_id: tenantId,
          ticket_id: data.id as string,
          request_type_id: (data.ticket_type_id as string | null) ?? null,
          domain: (requestTypeCfg?.domain as string | null) ?? null,
          priority: data.priority as string | null,
          asset_id: (data.asset_id as string | null) ?? null,
          location_id: effectiveLocation,
        };

        const result = await this.routingService.evaluate(evalCtx);
        await this.routingService.recordDecision(data.id as string, evalCtx, result);

        if (result.target) {
          const updates: Record<string, unknown> = { status_category: 'assigned' };
          if (result.target.kind === 'team') updates.assigned_team_id = result.target.team_id;
          if (result.target.kind === 'user') updates.assigned_user_id = result.target.user_id;
          if (result.target.kind === 'vendor') updates.assigned_vendor_id = result.target.vendor_id;
          if (effectiveLocation && !data.location_id) updates.location_id = effectiveLocation;

          await this.supabase.admin.from('tickets').update(updates).eq('id', data.id as string);
          Object.assign(data, updates);

          await this.addActivity(data.id as string, {
            activity_type: 'system_event',
            visibility: 'system',
            metadata: {
              event: 'auto_routed',
              chosen_by: result.chosen_by,
              strategy: result.strategy,
              rule: result.rule_name,
            },
          });
        }
      } catch (err) {
        console.error('[routing] evaluate failed', err);
      }
    }

    // ── Auto-SLA ──────────────────────────────────────────────
    if (requestTypeCfg?.sla_policy_id) {
      try {
        await this.slaService.startTimers(data.id as string, tenantId, requestTypeCfg.sla_policy_id as string);
        await this.supabase.admin.from('tickets').update({ sla_id: requestTypeCfg.sla_policy_id }).eq('id', data.id as string);
      } catch {
        // SLA failure should not block ticket creation
      }
    }

    // ── Auto-workflow ─────────────────────────────────────────
    if (requestTypeCfg?.workflow_definition_id) {
      try {
        await this.workflowEngine.startForTicket(data.id as string, requestTypeCfg.workflow_definition_id as string);
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

    // ── SLA pause/resume on waiting-state transitions ──────────
    if (changes.status_category || changes.waiting_reason) {
      try {
        await this.applyWaitingStateTransition(id, tenant.id, current, data);
      } catch (err) {
        console.error('[sla] pause/resume failed', err);
      }
    }

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

  /**
   * Explicitly reassign a ticket with a reason. Distinct from plain `update`
   * so we can record a routing_decisions trace row and keep the reason visible
   * in the timeline.
   */
  async reassign(id: string, dto: ReassignDto) {
    const tenant = TenantContext.current();
    const current = await this.getById(id);

    if (!dto.reason?.trim()) {
      throw new Error('reassignment reason is required');
    }

    const prev = {
      team: current.assigned_team_id as string | null,
      user: current.assigned_user_id as string | null,
      vendor: current.assigned_vendor_id as string | null,
    };

    let nextTarget: { kind: 'team' | 'user' | 'vendor'; id: string } | null = null;
    let chosenBy: 'manual_reassign' | 'rerun_resolver' = 'manual_reassign';
    let strategy: string = 'manual';
    let trace: Array<Record<string, unknown>> = [
      { step: 'manual_reassign', matched: true, reason: dto.reason, by: dto.actor_person_id ?? null },
    ];

    if (dto.rerun_resolver) {
      // Clear current assignment and let the resolver pick fresh
      await this.supabase.admin
        .from('tickets')
        .update({ assigned_team_id: null, assigned_user_id: null, assigned_vendor_id: null })
        .eq('id', id);

      const rtCfg = current.ticket_type_id
        ? (await this.supabase.admin
            .from('request_types')
            .select('domain')
            .eq('id', current.ticket_type_id)
            .single()).data
        : null;

      let effectiveLocation = current.location_id as string | null;
      if (!effectiveLocation && current.asset_id) {
        const { data: asset } = await this.supabase.admin
          .from('assets').select('assigned_space_id').eq('id', current.asset_id as string).single();
        effectiveLocation = (asset?.assigned_space_id as string | null) ?? null;
      }

      const evalCtx = {
        tenant_id: tenant.id,
        ticket_id: id,
        request_type_id: (current.ticket_type_id as string | null) ?? null,
        domain: (rtCfg?.domain as string | null) ?? null,
        priority: current.priority as string | null,
        asset_id: (current.asset_id as string | null) ?? null,
        location_id: effectiveLocation,
      };
      const result = await this.routingService.evaluate(evalCtx);
      await this.routingService.recordDecision(id, evalCtx, result);
      if (result.target) {
        if (result.target.kind === 'team') nextTarget = { kind: 'team', id: result.target.team_id };
        else if (result.target.kind === 'user') nextTarget = { kind: 'user', id: result.target.user_id };
        else if (result.target.kind === 'vendor') nextTarget = { kind: 'vendor', id: result.target.vendor_id };
      }
      chosenBy = 'rerun_resolver';
      strategy = result.strategy;
      trace = [
        { step: 'manual_reassign', matched: true, reason: dto.reason, by: dto.actor_person_id ?? null },
        ...(result.trace as unknown as Array<Record<string, unknown>>),
      ];
    } else {
      if (dto.assigned_team_id) nextTarget = { kind: 'team', id: dto.assigned_team_id };
      else if (dto.assigned_user_id) nextTarget = { kind: 'user', id: dto.assigned_user_id };
      else if (dto.assigned_vendor_id) nextTarget = { kind: 'vendor', id: dto.assigned_vendor_id };
    }

    const updates: Record<string, unknown> = {
      assigned_team_id: null,
      assigned_user_id: null,
      assigned_vendor_id: null,
      status_category: nextTarget ? 'assigned' : 'new',
    };
    if (nextTarget?.kind === 'team') updates.assigned_team_id = nextTarget.id;
    if (nextTarget?.kind === 'user') updates.assigned_user_id = nextTarget.id;
    if (nextTarget?.kind === 'vendor') updates.assigned_vendor_id = nextTarget.id;

    await this.supabase.admin.from('tickets').update(updates).eq('id', id).eq('tenant_id', tenant.id);

    await this.supabase.admin.from('routing_decisions').insert({
      tenant_id: tenant.id,
      ticket_id: id,
      strategy,
      chosen_team_id: nextTarget?.kind === 'team' ? nextTarget.id : null,
      chosen_user_id: nextTarget?.kind === 'user' ? nextTarget.id : null,
      chosen_vendor_id: nextTarget?.kind === 'vendor' ? nextTarget.id : null,
      chosen_by: chosenBy,
      trace,
      context: { reason: dto.reason, previous: prev, actor: dto.actor_person_id ?? null },
    });

    await this.addActivity(id, {
      activity_type: 'system_event',
      author_person_id: dto.actor_person_id,
      visibility: 'internal',
      content: dto.reason,
      metadata: {
        event: 'reassigned',
        previous: prev,
        next: nextTarget,
        mode: chosenBy,
      },
    });

    return this.getById(id);
  }

  private async applyWaitingStateTransition(
    ticketId: string,
    tenantId: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ) {
    const slaPolicyId = (after.sla_id ?? before.sla_id) as string | null;
    if (!slaPolicyId) return;

    const { data: policy } = await this.supabase.admin
      .from('sla_policies')
      .select('pause_on_waiting_reasons')
      .eq('id', slaPolicyId)
      .maybeSingle();

    const pauseReasons = (policy?.pause_on_waiting_reasons as string[] | null) ?? [];
    const shouldPause = (t: Record<string, unknown>) =>
      t.status_category === 'waiting' &&
      !!t.waiting_reason &&
      pauseReasons.includes(t.waiting_reason as string);

    const wasPaused = shouldPause(before);
    const isPaused = shouldPause(after);

    if (!wasPaused && isPaused) {
      await this.slaService.pauseTimers(ticketId, tenantId);
    } else if (wasPaused && !isPaused) {
      await this.slaService.resumeTimers(ticketId, tenantId);
    }
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
    if (!data) return [];

    const signedActivities = await Promise.all(
      data.map(async (activity) => {
        const attachments = Array.isArray(activity.attachments)
          ? await Promise.all(
              (activity.attachments as StoredAttachment[]).map(async (attachment) => {
                if (!attachment.path || attachment.url) return attachment;

                const { data: signed, error: signedError } = await this.supabase.admin.storage
                  .from(TICKET_ATTACHMENT_BUCKET)
                  .createSignedUrl(attachment.path, 60 * 60);

                if (signedError || !signed?.signedUrl) return attachment;

                return {
                  ...attachment,
                  url: signed.signedUrl,
                };
              }),
            )
          : [];

        return {
          ...activity,
          attachments,
        };
      }),
    );

    return signedActivities;
  }

  async addActivity(ticketId: string, dto: AddActivityDto, accessToken?: string) {
    const tenant = TenantContext.current();
    const authorPersonId = await this.resolveAuthorPersonId(dto.author_person_id, accessToken);

    const { data, error } = await this.supabase.admin
      .from('ticket_activities')
      .insert({
        tenant_id: tenant.id,
        ticket_id: ticketId,
        activity_type: dto.activity_type,
        author_person_id: authorPersonId,
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

  async uploadActivityAttachments(ticketId: string, files: Array<{
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
  }>) {
    const tenant = TenantContext.current();
    await this.ensureAttachmentBucket();

    const uploads = await Promise.all(
      files.map(async (file) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `${tenant.id}/tickets/${ticketId}/${randomUUID()}-${safeName}`;

        const { error } = await this.supabase.admin.storage
          .from(TICKET_ATTACHMENT_BUCKET)
          .upload(path, file.buffer, {
            contentType: file.mimetype,
            upsert: false,
          });

        if (error) throw error;

        return {
          name: file.originalname,
          path,
          size: file.size,
          type: file.mimetype,
        };
      }),
    );

    return uploads;
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

  private async ensureAttachmentBucket() {
    if (this.attachmentBucketReady) return;

    const { data: buckets, error } = await this.supabase.admin.storage.listBuckets();
    if (error) throw error;

    const exists = buckets?.some((bucket) => bucket.name === TICKET_ATTACHMENT_BUCKET);
    if (!exists) {
      const { error: createError } = await this.supabase.admin.storage.createBucket(
        TICKET_ATTACHMENT_BUCKET,
        {
          public: false,
          fileSizeLimit: '20MB',
        },
      );

      if (createError && !createError.message.toLowerCase().includes('already')) {
        throw createError;
      }
    }

    this.attachmentBucketReady = true;
  }

  private async resolveAuthorPersonId(explicitAuthorPersonId?: string, accessToken?: string) {
    if (!accessToken) return explicitAuthorPersonId;

    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin.auth.getUser(accessToken);
    if (error || !data.user?.email) return explicitAuthorPersonId;

    const { data: person } = await this.supabase.admin
      .from('persons')
      .select('id')
      .eq('tenant_id', tenant.id)
      .ilike('email', data.user.email)
      .maybeSingle();

    return person?.id ?? explicitAuthorPersonId;
  }
}
