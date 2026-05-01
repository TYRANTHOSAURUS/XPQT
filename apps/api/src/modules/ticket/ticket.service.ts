import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RoutingService } from '../routing/routing.service';
import { ScopeOverrideResolverService } from '../routing/scope-override-resolver.service';
import { SlaService } from '../sla/sla.service';
import { WorkflowEngineService } from '../workflow/workflow-engine.service';
import { ApprovalService } from '../approval/approval.service';
import { TicketVisibilityService } from './ticket-visibility.service';

export const SYSTEM_ACTOR = '__system__';

/**
 * Strip characters that PostgREST treats as filter grammar from user-supplied
 * search input before interpolating into a `.or()` clause. We intentionally
 * keep this conservative — the filter still has to fit into a URL query
 * string, and silently dropping commas/parens is far safer than letting them
 * inject extra clauses.
 */
function sanitizePostgrestLike(raw: string): string {
  return raw
    .replace(/[,()\\:]/g, ' ')
    .replace(/[*%]/g, '')
    .trim()
    .slice(0, 120);
}

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
  requested_for_person_id?: string;
  location_id?: string;
  asset_id?: string;
  assigned_team_id?: string;
  assigned_user_id?: string;
  interaction_mode?: string;
  source_channel?: string;
  form_data?: Record<string, unknown>;
  external_system?: string;
  external_id?: string;
}

export interface CreateTicketOptions {
  /**
   * When true, skip the request-type's workflow start inside
   * runPostCreateAutomation. Used by webhook ingest when the webhook row
   * carries its own workflow_id override so exactly one instance starts.
   */
  skipWorkflow?: boolean;
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
  /**
   * Reassigns the executor SLA on a child work order. Refused on parent cases
   * (parent SLA is locked on reassign per docs §SLA-on-reassignment).
   * Triggers SlaService.restartTimers which stops existing timers and starts new ones.
   * Pass `null` to clear the SLA (no timers will run).
   */
  sla_id?: string | null;
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
  status_category?: string | string[];
  priority?: string | string[];
  ticket_kind?: 'case' | 'work_order';
  /**
   * `null` ⇒ unassigned (IS NULL on the column). `string` ⇒ equals.
   * `undefined` ⇒ no filter.
   */
  assigned_team_id?: string | null;
  assigned_user_id?: string | null;
  assigned_vendor_id?: string | null;
  location_id?: string;
  requester_person_id?: string;
  parent_ticket_id?: string | null;
  sla_at_risk?: boolean;
  sla_breached?: boolean;
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

type InboxReason = 'mentioned' | 'assigned_to_me' | 'my_team' | 'watching';

interface InboxActivityPreview {
  id: string;
  content: string | null;
  created_at: string;
  visibility: string;
  attachments: StoredAttachment[];
  author?: { first_name: string; last_name: string } | null;
}

interface InboxActorContext {
  userId: string;
  personId: string;
  email?: string | null;
  fullName: string;
}

interface InboxTicketRow {
  id: string;
  title: string;
  status_category: string;
  priority: string;
  created_at: string;
  requester?: { first_name: string; last_name: string };
  assigned_team?: { id: string; name: string };
  assigned_agent?: { id: string; email: string };
}

const TICKET_ATTACHMENT_BUCKET = 'ticket-attachments';
const INBOX_REASON_PRIORITY: Record<InboxReason, number> = {
  mentioned: 4,
  assigned_to_me: 3,
  my_team: 2,
  watching: 1,
};

@Injectable()
export class TicketService {
  private attachmentBucketReady = false;

  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => RoutingService)) private readonly routingService: RoutingService,
    private readonly slaService: SlaService,
    @Inject(forwardRef(() => WorkflowEngineService)) private readonly workflowEngine: WorkflowEngineService,
    @Inject(forwardRef(() => ApprovalService)) private readonly approvalService: ApprovalService,
    private readonly visibility: TicketVisibilityService,
    private readonly scopeOverrides: ScopeOverrideResolverService,
  ) {}

  async list(filters: TicketListFilters = {}, actorAuthUid: string) {
    const tenant = TenantContext.current();
    const limit = Math.min(filters.limit ?? 50, 100);

    // For non-system actors, run the visibility-scoped RPC
    // `tickets_visible_for_actor` (migration 00187) instead of materializing
    // the visible-ticket-id set in Node and feeding it back as `.in('id',
    // ids)`. The RPC returns SETOF tickets so PostgREST chains the same
    // filter/sort/limit grammar as a plain `.from('tickets')` call. System
    // actors keep the direct table read because they have no user_id to
    // anchor the predicate against.
    let baseBuilder;
    if (actorAuthUid === SYSTEM_ACTOR) {
      baseBuilder = this.supabase.admin.from('tickets');
    } else {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      if (!ctx.user_id && !ctx.has_read_all) {
        // Unknown user in this tenant — no visibility, return nothing.
        return { items: [], next_cursor: null };
      }
      baseBuilder = this.supabase.admin.rpc('tickets_visible_for_actor', {
        p_user_id: ctx.user_id,
        p_tenant_id: tenant.id,
        p_has_read_all: ctx.has_read_all,
      });
    }

    let query = baseBuilder
      .select(`
        *,
        requester:persons!tickets_requester_person_id_fkey(id, first_name, last_name, email),
        location:spaces!tickets_location_id_fkey(id, name, type),
        assigned_team:teams!tickets_assigned_team_id_fkey(id, name),
        assigned_agent:users!tickets_assigned_user_id_fkey(id, email, person:persons!users_person_id_fkey(first_name, last_name))
      `)
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    // Apply filters
    if (filters.status_category) {
      const vals = Array.isArray(filters.status_category) ? filters.status_category : [filters.status_category];
      query = vals.length === 1 ? query.eq('status_category', vals[0]) : query.in('status_category', vals);
    }
    if (filters.priority) {
      const vals = Array.isArray(filters.priority) ? filters.priority : [filters.priority];
      query = vals.length === 1 ? query.eq('priority', vals[0]) : query.in('priority', vals);
    }
    // Step 1c.10c: ticket_kind column dropped. tickets is case-only.
    // Listing work_orders is a separate API surface (TODO step 1c.9).
    // Be EXPLICIT about the contract: kind=work_order on the tickets
    // endpoint returns empty (codex round 4 flagged silent fall-through).
    // kind=case is the implicit default; pass-through.
    if (filters.ticket_kind === 'work_order') {
      return { items: [], next_cursor: null };
    }
    if (filters.assigned_team_id === null) query = query.is('assigned_team_id', null);
    else if (filters.assigned_team_id) query = query.eq('assigned_team_id', filters.assigned_team_id);
    if (filters.assigned_user_id === null) query = query.is('assigned_user_id', null);
    else if (filters.assigned_user_id) query = query.eq('assigned_user_id', filters.assigned_user_id);
    if (filters.assigned_vendor_id === null) query = query.is('assigned_vendor_id', null);
    else if (filters.assigned_vendor_id) query = query.eq('assigned_vendor_id', filters.assigned_vendor_id);
    if (filters.location_id) query = query.eq('location_id', filters.location_id);
    if (filters.requester_person_id) query = query.eq('requester_person_id', filters.requester_person_id);
    if (filters.sla_at_risk === true) query = query.eq('sla_at_risk', true);
    if (filters.sla_breached === true) query = query.not('sla_resolution_breached_at', 'is', null);

    // Parent filter: null = top-level only, specific ID = children of that ticket.
    // Step 1c.10c: tickets is case-only — booking-origin WOs and case-children
    // both live in work_orders now, so the booking_bundle_id IS NULL guard is
    // unnecessary on tickets reads.
    if (filters.parent_ticket_id === null) {
      query = query.is('parent_ticket_id', null);
    } else if (filters.parent_ticket_id) {
      query = query.eq('parent_ticket_id', filters.parent_ticket_id);
    }

    // Cursor-based pagination. Cursor is a `created_at` ISO timestamp — UUIDs
    // are not guaranteed to sort in creation order, so the previous `id`-based
    // cursor was incorrect for any tenant whose ticket-id allocator is not
    // monotonic (which is most of them).
    if (filters.cursor) {
      query = query.lt('created_at', filters.cursor);
    }

    // Text search on title and description.
    // PostgREST `.or()` parses commas and parens as grammar — if we drop raw
    // user input in, a search like `foo,bar` silently splits into a third
    // bogus filter clause. Strip every structural character before
    // interpolating; the remaining ilike `%…%` still does a substring match.
    if (filters.search) {
      const safe = sanitizePostgrestLike(filters.search);
      if (safe.length > 0) {
        query = query.or(`title.ilike.%${safe}%,description.ilike.%${safe}%`);
      }
    }

    const { data, error } = await query;
    if (error) throw error;

    // Step 1c.10c: list reads from tickets (case-only). Synthesize
    // ticket_kind='case' for every item so frontend type contracts hold.
    const items = (data ?? []).map((row: Record<string, unknown>) => ({
      ...row,
      ticket_kind: 'case' as const,
    }));
    return {
      items,
      next_cursor:
        data && data.length === limit ? data[data.length - 1].created_at : null,
    };
  }

  async getInbox(accessToken?: string, limit = 50) {
    const actor = await this.resolveInboxActor(accessToken);
    if (!actor?.personId) {
      return { items: [] };
    }

    const tenant = TenantContext.current();
    const cappedLimit = Math.min(limit, 100);
    const teamIds = actor.userId
      ? await this.listActorTeamIds(actor.userId)
      : [];

    const mentionRefsPromise = actor.fullName
      ? this.supabase.admin
          .from('ticket_activities')
          .select('ticket_id')
          .eq('tenant_id', tenant.id)
          .in('activity_type', ['internal_note', 'external_comment'])
          .in('visibility', ['internal', 'external'])
          .ilike('content', `%@${actor.fullName}%`)
          .order('created_at', { ascending: false })
          .limit(200)
      : Promise.resolve({ data: [] as Array<{ ticket_id: string }>, error: null });

    const [assignedTickets, teamTickets, watchingTickets, mentionRefs] = await Promise.all([
      actor.userId
        ? this.fetchInboxTickets((query) => query.eq('assigned_user_id', actor.userId))
        : Promise.resolve([] as InboxTicketRow[]),
      teamIds.length > 0
        ? this.fetchInboxTickets((query) => query.in('assigned_team_id', teamIds))
        : Promise.resolve([] as InboxTicketRow[]),
      this.fetchInboxTickets((query) => query.contains('watchers', [actor.personId])),
      mentionRefsPromise,
    ]);

    const ticketMap = new Map<string, { ticket: InboxTicketRow; reasons: Set<InboxReason> }>();
    const addTicket = (ticket: InboxTicketRow, reason: InboxReason) => {
      const existing = ticketMap.get(ticket.id);
      if (existing) {
        existing.reasons.add(reason);
        return;
      }

      ticketMap.set(ticket.id, {
        ticket,
        reasons: new Set([reason]),
      });
    };

    assignedTickets.forEach((ticket) => addTicket(ticket, 'assigned_to_me'));
    teamTickets.forEach((ticket) => addTicket(ticket, 'my_team'));
    watchingTickets.forEach((ticket) => addTicket(ticket, 'watching'));

    const mentionTicketIds = Array.from(
      new Set((mentionRefs.data ?? []).map((row) => row.ticket_id as string).filter(Boolean)),
    );
    const missingMentionIds = mentionTicketIds.filter((id) => !ticketMap.has(id));
    const mentionTickets = missingMentionIds.length > 0
      ? await this.fetchInboxTickets((query) => query.in('id', missingMentionIds))
      : [];
    mentionTickets.forEach((ticket) => addTicket(ticket, 'mentioned'));
    mentionTicketIds.forEach((id) => {
      const existing = ticketMap.get(id);
      if (existing) existing.reasons.add('mentioned');
    });

    const candidateIds = Array.from(ticketMap.keys());
    if (candidateIds.length === 0) {
      return { items: [] };
    }

    const { data: activityRows, error: activityError } = await this.supabase.admin
      .from('ticket_activities')
      .select(`
        id,
        ticket_id,
        visibility,
        content,
        attachments,
        created_at,
        author:persons!ticket_activities_author_person_id_fkey(first_name, last_name)
      `)
      .eq('tenant_id', tenant.id)
      .in('activity_type', ['internal_note', 'external_comment'])
      .in('ticket_id', candidateIds)
      .in('visibility', ['internal', 'external'])
      .order('created_at', { ascending: false });

    if (activityError) throw activityError;

    const latestByTicket = new Map<string, InboxActivityPreview>();
    for (const row of activityRows ?? []) {
      const ticketId = row.ticket_id as string;
      const entry = ticketMap.get(ticketId);

      if (entry && this.contentMentionsActor((row.content as string | null) ?? null, actor)) {
        entry.reasons.add('mentioned');
      }

      if (latestByTicket.has(ticketId)) continue;

      latestByTicket.set(ticketId, {
        id: row.id as string,
        content: (row.content as string | null) ?? null,
        created_at: row.created_at as string,
        visibility: row.visibility as string,
        attachments: Array.isArray(row.attachments) ? (row.attachments as StoredAttachment[]) : [],
        author: this.pickSingle(
          row.author as
            | { first_name: string; last_name: string }
            | Array<{ first_name: string; last_name: string }>
            | null,
        ),
      });
    }

    const items = candidateIds
      .map((id) => {
        const entry = ticketMap.get(id);
        if (!entry) return null;

        const latestActivity = latestByTicket.get(id) ?? null;
        const orderedReasons = Array.from(entry.reasons).sort(
          (a, b) => INBOX_REASON_PRIORITY[b] - INBOX_REASON_PRIORITY[a],
        );

        return {
          ...entry.ticket,
          inbox_reason: orderedReasons[0],
          inbox_reasons: orderedReasons,
          latest_activity: latestActivity,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => {
        const reasonDiff =
          INBOX_REASON_PRIORITY[b.inbox_reason as InboxReason] -
          INBOX_REASON_PRIORITY[a.inbox_reason as InboxReason];
        if (reasonDiff !== 0) return reasonDiff;

        const aTime = a.latest_activity?.created_at ?? a.created_at;
        const bTime = b.latest_activity?.created_at ?? b.created_at;
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      })
      .slice(0, cappedLimit);

    return { items };
  }

  async listDistinctTags(actorAuthUid: string): Promise<string[]> {
    const tenant = TenantContext.current();
    // Same predicate-pushdown story as `list()`: prefer the SQL-side
    // visibility join (tickets_visible_for_actor) over materializing the ID
    // set in Node. For tenants with read_all or system actors, fall back to
    // the dedicated `tickets_distinct_tags` RPC so we can still benefit from
    // the GIN index it uses.
    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      if (!ctx.user_id && !ctx.has_read_all) return [];
      if (!ctx.has_read_all) {
        const { data, error } = await this.supabase.admin
          .rpc('tickets_visible_for_actor', {
            p_user_id: ctx.user_id,
            p_tenant_id: tenant.id,
            p_has_read_all: false,
          })
          .select('tags')
          .eq('tenant_id', tenant.id)
          .not('tags', 'is', null);
        if (error) throw error;
        const tagSet = new Set<string>();
        // The Supabase typings for `.rpc(...).select(...)` widen `data` to
        // `Row | Row[]`, so coerce explicitly before iterating.
        const rows = (Array.isArray(data) ? data : data ? [data] : []) as Array<{
          tags?: string[] | null;
        }>;
        for (const row of rows) {
          if (Array.isArray(row.tags)) {
            for (const t of row.tags) tagSet.add(t);
          }
        }
        return Array.from(tagSet).sort();
      }
    }
    const { data, error } = await this.supabase.admin.rpc('tickets_distinct_tags', {
      tenant: tenant.id,
    });
    if (error) throw error;
    return (data ?? []).map((row: { tag: string }) => row.tag);
  }

  async getById(id: string, actorAuthUid: string) {
    const tenant = TenantContext.current();

    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertVisible(id, ctx, 'read');
    }

    // Step 1c.10c: id may live in tickets (case) or work_orders. Try
    // tickets first; only fall back to work_orders on the specific
    // "row not found" case. Other DB errors propagate (codex round 3
    // caught a 404-on-DB-error masking bug here).
    const { data, error } = await this.supabase.admin
      .from('tickets')
      .select(`
        *,
        requester:persons!tickets_requester_person_id_fkey(id, first_name, last_name, email),
        location:spaces!tickets_location_id_fkey(id, name, type, parent_id),
        asset:assets!tickets_asset_id_fkey(id, name, asset_role, serial_number),
        assigned_team:teams!tickets_assigned_team_id_fkey(id, name),
        assigned_agent:users!tickets_assigned_user_id_fkey(id, email, person:persons!users_person_id_fkey(first_name, last_name)),
        assigned_vendor:vendors!tickets_assigned_vendor_id_fkey(id, name),
        request_type:request_types!tickets_ticket_type_id_fkey(id, name, domain)
      `)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .single();

    // PostgREST .single() returns error.code='PGRST116' when no row matches.
    // Other errors are real DB problems and must propagate.
    if (error && (error as { code?: string }).code !== 'PGRST116') {
      throw error;
    }
    if (data) {
      return { ...data, ticket_kind: 'case' as const };
    }

    // No tickets row — try work_orders.
    const woResult = await this.supabase.admin
      .from('work_orders')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (woResult.error) throw woResult.error;
    if (woResult.data) {
      return { ...woResult.data, ticket_kind: 'work_order' as const };
    }
    throw new NotFoundException('Ticket not found');
  }

  async create(
    dto: CreateTicketDto,
    options: CreateTicketOptions = {},
    actorAuthUid: string = SYSTEM_ACTOR,
  ) {
    const tenant = TenantContext.current();

    // If a real user is creating a ticket and didn't pass an explicit
    // requester_person_id, default to their own person record. Prevents
    // anonymous "API direct" creates with no requester attached, and gives
    // every audit trail a real actor.
    if (actorAuthUid !== SYSTEM_ACTOR && !dto.requester_person_id) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      if (ctx.person_id) {
        dto = { ...dto, requester_person_id: ctx.person_id };
      }
    }

    // Step 1c.10c: ticket_kind column dropped from tickets. tickets is
    // case-only now; the dto.ticket_kind value is ignored (work_orders go
    // through dispatch.service.ts / createBookingOriginWorkOrder).
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
        requested_for_person_id: dto.requested_for_person_id ?? dto.requester_person_id,
        location_id: dto.location_id,
        asset_id: dto.asset_id,
        assigned_team_id: dto.assigned_team_id,
        assigned_user_id: dto.assigned_user_id,
        interaction_mode: dto.interaction_mode ?? 'internal',
        source_channel: dto.source_channel ?? 'portal',
        status: 'new',
        status_category: 'new',
        form_data: dto.form_data,
        external_system: dto.external_system,
        external_id: dto.external_id,
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

      // Step 1c.10c: synthesize ticket_kind for frontend contract.
      return { ...data, ticket_kind: 'case' as const };
    }

    // Normal path: routing → SLA → workflow
    await this.runPostCreateAutomation(data, tenant.id, requestTypeCfg, options);
    // Step 1c.10c: synthesize ticket_kind for frontend contract.
    return { ...data, ticket_kind: 'case' as const };
  }

  /**
   * Called by approval flow after a ticket's approval request is resolved.
   * Runs routing/SLA/workflow on approval; marks ticket cancelled on rejection.
   */
  async onApprovalDecision(ticketId: string, outcome: 'approved' | 'rejected') {
    const tenant = TenantContext.current();
    const ticket = await this.getById(ticketId, SYSTEM_ACTOR);
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
    const ticketRecord = await this.getById(ticketId, SYSTEM_ACTOR);

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
    options: CreateTicketOptions = {},
  ) {
    // Step 1c.10c: tickets is case-only. runPostCreateAutomation only runs
    // for cases — work_orders go through dispatch.service.ts +
    // createBookingOriginWorkOrder paths which don't call this. So
    // isWorkOrder is unconditionally false here. Kept as a const to
    // preserve the existing branching logic in this method.
    const isWorkOrder = false;

    // Scope-override lookup is advisory for the resolver (which runs its own
    // copy) but authoritative for workflow / case SLA below. Asset-backed
    // location fallback (locationId → assetId.assigned_space_id → null) lives
    // inside the scope-override service so every consumer sees the same rule.
    // One extra STABLE RPC call when we also need effectiveLocation for the
    // auto-routing branch; the service caches nothing but the overhead is a
    // single-row index lookup.
    const overrideIntake = {
      locationId: (data.location_id as string | null) ?? null,
      assetId: (data.asset_id as string | null) ?? null,
    };
    const effectiveLocation = await this.scopeOverrides.deriveEffectiveLocation(
      tenantId,
      overrideIntake,
    );
    const scopeOverride = (data.ticket_type_id && !isWorkOrder)
      ? await this.scopeOverrides.resolveForLocation(
          tenantId,
          data.ticket_type_id as string,
          effectiveLocation,
        )
      : null;
    const effectiveWorkflowDefinitionId =
      scopeOverride?.workflow_definition_id ??
      (requestTypeCfg?.workflow_definition_id as string | null | undefined) ??
      null;
    const effectiveCaseSlaPolicyId =
      scopeOverride?.case_sla_policy_id ??
      (requestTypeCfg?.sla_policy_id as string | null | undefined) ??
      null;

    // ── Auto-routing ──────────────────────────────────────────
    if (!isWorkOrder && !data.assigned_team_id && !data.assigned_user_id && !data.assigned_vendor_id) {
      try {

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
        const message = err instanceof Error ? err.message : String(err);
        console.error('[routing] evaluate failed', err);
        // Always leave a system-event breadcrumb on the ticket so operators
        // see why their ticket landed unassigned. The previous code only
        // logged to stdout, which was invisible to anyone outside the API box.
        await this.addActivity(data.id as string, {
          activity_type: 'system_event',
          visibility: 'system',
          metadata: { event: 'routing_evaluation_failed', error: message },
        }).catch(() => undefined);
      }
    }

    // ── Auto-SLA ──────────────────────────────────────────────
    // Scope override's case_sla_policy_id wins over request_types.sla_policy_id
    // when set. Null override leaves the request-type default intact.
    if (effectiveCaseSlaPolicyId) {
      try {
        await this.slaService.startTimers(data.id as string, tenantId, effectiveCaseSlaPolicyId);
        await this.supabase.admin.from('tickets').update({ sla_id: effectiveCaseSlaPolicyId }).eq('id', data.id as string);
      } catch (err) {
        // SLA failure should not block ticket creation, but record the breadcrumb.
        const message = err instanceof Error ? err.message : String(err);
        console.error('[sla] start timers failed', err);
        await this.addActivity(data.id as string, {
          activity_type: 'system_event',
          visibility: 'system',
          metadata: { event: 'sla_start_failed', error: message },
        }).catch(() => undefined);
      }
    }

    // ── Auto-workflow ─────────────────────────────────────────
    // Same precedence: scope override's workflow_definition_id wins.
    if (effectiveWorkflowDefinitionId && !options.skipWorkflow) {
      try {
        await this.workflowEngine.startForTicket(data.id as string, effectiveWorkflowDefinitionId);
      } catch (err) {
        // Workflow failure should not block ticket creation, but record it.
        const message = err instanceof Error ? err.message : String(err);
        console.error('[workflow] start failed', err);
        await this.addActivity(data.id as string, {
          activity_type: 'system_event',
          visibility: 'system',
          metadata: { event: 'workflow_start_failed', error: message },
        }).catch(() => undefined);
      }
    }

    return data;
  }

  async update(id: string, dto: UpdateTicketDto, actorAuthUid: string) {
    const tenant = TenantContext.current();

    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertVisible(id, ctx, 'write');

      // Per-action permission gates layered on top of the visibility floor.
      // Mirrors WorkOrderService.{updatePriority, assertAssignPermission}; the
      // catalog has dedicated `tickets.change_priority` + `tickets.assign`
      // keys for a reason. Pre-1c.10c the case-side update path relied solely
      // on `assertVisible('write')`, leaving these per-action gates enforced
      // only on work_orders — a real divergence flagged by full-review. Roles
      // that previously held only `tickets.update` are grandfathered into
      // both keys by migration 00247 to avoid a permission regression for
      // existing tenants.
      const wantsPriorityChange = dto.priority !== undefined;
      const wantsAssignChange =
        dto.assigned_team_id !== undefined ||
        dto.assigned_user_id !== undefined ||
        dto.assigned_vendor_id !== undefined;

      if ((wantsPriorityChange || wantsAssignChange) && !ctx.has_write_all) {
        if (wantsPriorityChange) {
          const { data: hasChange, error: permErr } = await this.supabase.admin.rpc(
            'user_has_permission',
            {
              p_user_id: ctx.user_id,
              p_tenant_id: tenant.id,
              p_permission: 'tickets.change_priority',
            },
          );
          if (permErr) throw permErr;
          if (!hasChange) {
            throw new ForbiddenException(
              'tickets.change_priority permission required to change a ticket priority',
            );
          }
        }
        if (wantsAssignChange) {
          const { data: hasAssign, error: permErr } = await this.supabase.admin.rpc(
            'user_has_permission',
            {
              p_user_id: ctx.user_id,
              p_tenant_id: tenant.id,
              p_permission: 'tickets.assign',
            },
          );
          if (permErr) throw permErr;
          if (!hasAssign) {
            throw new ForbiddenException(
              'tickets.assign permission required to change a ticket assignment',
            );
          }
        }
      }
    }

    // Get current state for change tracking
    const current = await this.getById(id, SYSTEM_ACTOR);

    // Step 1c.10c: tickets is case-only. The previous ticket_kind='case' guards
    // are now unconditional — every ticket here IS a case. SLA-on-case is locked.
    if (dto.sla_id !== undefined) {
      throw new BadRequestException('cannot change sla_id on a case; parent SLA is locked');
    }

    // Parent close guard: case cannot move to resolved/closed while children are open.
    // Children are now in public.work_orders (post-1c.10c). The DB trigger
    // enforce_ticket_parent_close_invariant is the authoritative check; this
    // is a friendlier API-layer precheck.
    if (dto.status_category === 'resolved' || dto.status_category === 'closed') {
      const { data: openChildren } = await this.supabase.admin
        .from('work_orders')
        .select('id')
        .eq('parent_ticket_id', id)
        .eq('tenant_id', tenant.id)
        .not('status_category', 'in', '(resolved,closed)');
      const childIds = (openChildren ?? []).map((c: { id: string }) => c.id);
      if (childIds.length > 0) {
        throw new BadRequestException(
          `cannot close case while children are open: ${childIds.join(', ')}`,
        );
      }
    }

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
        const currentRow = current as Record<string, unknown>;
        const dataRow = data as Record<string, unknown>;
        await this.slaService.applyWaitingStateTransition(
          id,
          tenant.id,
          {
            status_category: (currentRow.status_category as string) ?? '',
            waiting_reason: (currentRow.waiting_reason as string | null) ?? null,
            sla_id: (currentRow.sla_id as string | null) ?? null,
          },
          {
            status_category: (dataRow.status_category as string) ?? '',
            waiting_reason: (dataRow.waiting_reason as string | null) ?? null,
            sla_id: (dataRow.sla_id as string | null) ?? null,
          },
        );
      } catch (err) {
        console.error('[sla] pause/resume failed', err);
      }
    }

    // ── SLA policy change on a child: stop old timers, start fresh ones ──────
    if (changes.sla_id) {
      try {
        await this.slaService.restartTimers(id, tenant.id, changes.sla_id.to as string | null);
        await this.addActivity(id, {
          activity_type: 'system_event',
          visibility: 'system',
          metadata: {
            event: 'sla_changed',
            from_sla_id: changes.sla_id.from,
            to_sla_id: changes.sla_id.to,
          },
        }, undefined, actorAuthUid);
      } catch (err) {
        console.error('[sla] restart on sla_id change failed', err);
      }
    }

    // Log changes as system events.
    //
    // Activity metadata shape: `{ event, previous, next }` with per-field
    // snapshots in `previous`/`next`. Mirrors the WorkOrderService surface
    // (work-order.service.ts:589/845/1039) — code-review C2 alignment.
    // The activity feed renderer (ticket-activity-feed.tsx) reads only
    // `metadata.event` for the system-row label, so the inner shape is free
    // to be whatever serves audit consumers best.
    if (changes.status_category) {
      const previous: Record<string, unknown> = { status_category: changes.status_category.from };
      const next: Record<string, unknown> = { status_category: changes.status_category.to };
      // status (the granular sub-status) frequently changes alongside
      // status_category — include the snapshot if it was in the dto so the
      // audit row captures both axes.
      if (changes.status) {
        previous.status = changes.status.from;
        next.status = changes.status.to;
      }
      // Same for waiting_reason, which is meaningful for waiting-state diffs.
      if (changes.waiting_reason) {
        previous.waiting_reason = changes.waiting_reason.from;
        next.waiting_reason = changes.waiting_reason.to;
      }
      await this.addActivity(id, {
        activity_type: 'system_event',
        visibility: 'system',
        metadata: { event: 'status_changed', previous, next },
      }, undefined, actorAuthUid);
      await this.logDomainEvent(id, 'ticket_status_changed', { previous, next });
    }

    if (changes.assigned_team_id || changes.assigned_user_id || changes.assigned_vendor_id) {
      const previous: Record<string, string | null> = {};
      const next: Record<string, string | null> = {};
      if (changes.assigned_team_id) {
        previous.assigned_team_id = changes.assigned_team_id.from as string | null;
        next.assigned_team_id = changes.assigned_team_id.to as string | null;
      }
      if (changes.assigned_user_id) {
        previous.assigned_user_id = changes.assigned_user_id.from as string | null;
        next.assigned_user_id = changes.assigned_user_id.to as string | null;
      }
      if (changes.assigned_vendor_id) {
        previous.assigned_vendor_id = changes.assigned_vendor_id.from as string | null;
        next.assigned_vendor_id = changes.assigned_vendor_id.to as string | null;
      }
      await this.addActivity(id, {
        activity_type: 'system_event',
        visibility: 'system',
        metadata: {
          event: 'assignment_changed',
          previous,
          next,
        },
      }, undefined, actorAuthUid);
      await this.logDomainEvent(id, 'ticket_assigned', { previous, next });
    }

    // Step 1c.10c: synthesize ticket_kind for frontend contract.
    return { ...data, ticket_kind: 'case' as const };
  }

  /**
   * Explicitly reassign a ticket with a reason. Distinct from plain `update`
   * so we can record a routing_decisions trace row and keep the reason visible
   * in the timeline.
   */
  async reassign(id: string, dto: ReassignDto, actorAuthUid: string) {
    const tenant = TenantContext.current();

    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertVisible(id, ctx, 'write');

      // Reassign is by definition an assignment change — always require the
      // per-action `tickets.assign` permission (or `tickets.write_all`
      // override). Mirrors WorkOrderService.assertAssignPermission.
      if (!ctx.has_write_all) {
        const { data: hasAssign, error: permErr } = await this.supabase.admin.rpc(
          'user_has_permission',
          {
            p_user_id: ctx.user_id,
            p_tenant_id: tenant.id,
            p_permission: 'tickets.assign',
          },
        );
        if (permErr) throw permErr;
        if (!hasAssign) {
          throw new ForbiddenException(
            'tickets.assign permission required to reassign a ticket',
          );
        }
      }
    }

    const current = await this.getById(id, SYSTEM_ACTOR);

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

    // Routing decision audit row. Convention (code-review C5): set the
    // polymorphic columns explicitly on both case + WO sides — the 00232
    // derive trigger remains as a defensive fallback, but writing them
    // here makes the audit row deterministic at write time and removes the
    // "depends on the trigger" coupling. Mirror of work-order.service.ts:1000.
    await this.supabase.admin.from('routing_decisions').insert({
      tenant_id: tenant.id,
      ticket_id: id, // legacy soft pointer; FK to tickets dropped in 00233
      entity_kind: 'case',
      case_id: id,
      strategy,
      chosen_team_id: nextTarget?.kind === 'team' ? nextTarget.id : null,
      chosen_user_id: nextTarget?.kind === 'user' ? nextTarget.id : null,
      chosen_vendor_id: nextTarget?.kind === 'vendor' ? nextTarget.id : null,
      chosen_by: chosenBy,
      trace,
      context: { reason: dto.reason, previous: prev, actor: dto.actor_person_id ?? null },
    });

    // Activity row. Mirrors the WO-side `reassigned` shape
    // (work-order.service.ts:1039) — `reason` included in metadata for
    // parity with WO surface. Code-review C2 alignment.
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
        reason: dto.reason,
      },
    });

    return this.getById(id, SYSTEM_ACTOR);
  }

  async getActivities(ticketId: string, visibility: string | undefined, actorAuthUid: string) {
    const tenant = TenantContext.current();
    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertVisible(ticketId, ctx, 'read');
    }

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

    // Collect every unique attachment path that still needs a signed URL into
    // one batch call. The previous shape signed each attachment in its own
    // round trip (Promise.all over Promise.all), which paid the storage API
    // latency once per file — a 10-comment ticket with two attachments each
    // was 20 sequential signing operations.
    const pathsNeedingSign = new Set<string>();
    for (const activity of data) {
      if (!Array.isArray(activity.attachments)) continue;
      for (const attachment of activity.attachments as StoredAttachment[]) {
        if (attachment.path && !attachment.url) {
          pathsNeedingSign.add(attachment.path);
        }
      }
    }

    const signedByPath = new Map<string, string>();
    if (pathsNeedingSign.size > 0) {
      const { data: signedBatch, error: signedError } = await this.supabase.admin.storage
        .from(TICKET_ATTACHMENT_BUCKET)
        .createSignedUrls(Array.from(pathsNeedingSign), 60 * 60);
      if (!signedError && Array.isArray(signedBatch)) {
        for (const entry of signedBatch) {
          if (entry.path && entry.signedUrl) {
            signedByPath.set(entry.path, entry.signedUrl);
          }
        }
      }
    }

    return data.map((activity) => ({
      ...activity,
      attachments: Array.isArray(activity.attachments)
        ? (activity.attachments as StoredAttachment[]).map((attachment) => {
            if (!attachment.path || attachment.url) return attachment;
            const signedUrl = signedByPath.get(attachment.path);
            return signedUrl ? { ...attachment, url: signedUrl } : attachment;
          })
        : [],
    }));
  }

  async addActivity(ticketId: string, dto: AddActivityDto, accessToken?: string, actorAuthUid: string = SYSTEM_ACTOR) {
    const tenant = TenantContext.current();

    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertVisible(ticketId, ctx, 'write');
    }

    // Resolve author: explicit DTO value > access-token lookup > auth-uid lookup.
    // Internal system_event callers pass actorAuthUid but no access token — the
    // auth-uid fallback ensures those rows are still attributed to a person so
    // the activity feed shows "who did what when" instead of just "what when".
    let authorPersonId = await this.resolveAuthorPersonId(dto.author_person_id, accessToken);
    if (!authorPersonId && actorAuthUid !== SYSTEM_ACTOR) {
      const { data: userRow } = await this.supabase.admin
        .from('users')
        .select('person_id')
        .eq('auth_uid', actorAuthUid)
        .eq('tenant_id', tenant.id)
        .maybeSingle();
      if (userRow?.person_id) authorPersonId = userRow.person_id as string;
    }

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
  }>, actorAuthUid: string = SYSTEM_ACTOR) {
    const tenant = TenantContext.current();

    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertVisible(ticketId, ctx, 'write');
    }

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

  async getChildTasks(parentTicketId: string, actorAuthUid: string) {
    const tenant = TenantContext.current();
    // Step 1c.10c: children are work_orders (live in public.work_orders).
    // ticket_kind column dropped — every child here IS a work_order.
    const childCols =
      'id, title, status, status_category, priority, assigned_team_id, assigned_user_id, assigned_vendor_id, interaction_mode, created_at, resolved_at, sla_id, sla_resolution_due_at, sla_resolution_breached_at';

    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      // Gate on parent (case) visibility first.
      await this.visibility.assertVisible(parentTicketId, ctx, 'read');
      if (!ctx.user_id && !ctx.has_read_all) return [];
      // If the actor can see the parent case, they can see its work_order
      // children. (The visibility model treats children as inheriting parent
      // visibility for read; tighter scoping is a future step 1c.9 concern.)
    }

    const { data, error } = await this.supabase.admin
      .from('work_orders')
      .select(childCols)
      .eq('parent_ticket_id', parentTicketId)
      .eq('tenant_id', tenant.id)
      .order('created_at');

    if (error) throw error;
    // Step 1c.10c: synthesize ticket_kind='work_order' for frontend
    // WorkOrderRow type continuity.
    return (data ?? []).map((row) => ({ ...row, ticket_kind: 'work_order' as const }));
  }

  async bulkUpdate(
    ids: string[],
    dto: UpdateTicketDto,
    actorAuthUid: string = SYSTEM_ACTOR,
  ) {
    const tenant = TenantContext.current();

    if (!Array.isArray(ids) || ids.length === 0) return [];
    // Cap blast radius. The desk UI never selects more than a screenful at a
    // time; an unbounded list here is almost certainly an abuse signal.
    if (ids.length > 200) {
      throw new BadRequestException('bulk update is capped at 200 ids per call');
    }

    // Visibility gate: only update tickets the actor can write. We narrow the
    // id set to the visible (write-eligible) subset rather than rejecting the
    // whole request — matches how the desk surfaces partial-permission cases.
    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      if (!ctx.has_write_all) {
        const allowedIds: string[] = [];
        for (const id of ids) {
          try {
            await this.visibility.assertVisible(id, ctx, 'write');
            allowedIds.push(id);
          } catch {
            // Skip silently — the desk lists the result and surfaces partial
            // outcomes; throwing on the first denied id would surprise users
            // who selected a mix.
          }
        }
        if (allowedIds.length === 0) {
          throw new ForbiddenException('No tickets in selection are writable for this user');
        }
        ids = allowedIds;
      }
    }

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

  private pickSingle<T>(value?: T | T[] | null): T | null {
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }

  private contentMentionsActor(content: string | null | undefined, actor: InboxActorContext) {
    if (!content) return false;

    const aliases = [
      actor.fullName,
      actor.email,
      actor.email?.split('@')[0] ?? null,
    ]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));

    return aliases.some((alias) => {
      const escapedAlias = alias
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/g, '\\s+');
      const mentionPattern = new RegExp(
        `(^|[\\s([{"'])@${escapedAlias}(?=$|[\\s),.:;!?\\]}'"])`,
        'i',
      );

      return mentionPattern.test(content);
    });
  }

  private async fetchInboxTickets(
    applyFilters: (query: any) => any,
  ) {
    const tenant = TenantContext.current();
    let query = this.supabase.admin
      .from('tickets')
      .select(`
        id,
        title,
        status_category,
        priority,
        created_at,
        requester:persons!tickets_requester_person_id_fkey(first_name, last_name),
        assigned_team:teams!tickets_assigned_team_id_fkey(id, name),
        assigned_agent:users!tickets_assigned_user_id_fkey(id, email)
      `)
      .eq('tenant_id', tenant.id);

    query = applyFilters(query);

    const { data, error } = await query.limit(200);
    if (error) throw error;

    return (data ?? []).map((row) => ({
      id: row.id as string,
      title: row.title as string,
      status_category: row.status_category as string,
      priority: row.priority as string,
      created_at: row.created_at as string,
      requester: this.pickSingle(
        row.requester as
          | { first_name: string; last_name: string }
          | Array<{ first_name: string; last_name: string }>
          | null,
      ) ?? undefined,
      assigned_team: this.pickSingle(
        row.assigned_team as
          | { id: string; name: string }
          | Array<{ id: string; name: string }>
          | null,
      ) ?? undefined,
      assigned_agent: this.pickSingle(
        row.assigned_agent as
          | { id: string; email: string }
          | Array<{ id: string; email: string }>
          | null,
      ) ?? undefined,
    })) satisfies InboxTicketRow[];
  }

  private async listActorTeamIds(userId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('team_members')
      .select('team_id')
      .eq('tenant_id', tenant.id)
      .eq('user_id', userId);

    if (error) throw error;
    return (data ?? []).map((row) => row.team_id as string);
  }

  private async resolveInboxActor(accessToken?: string): Promise<InboxActorContext | null> {
    if (!accessToken) return null;

    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin.auth.getUser(accessToken);
    if (error || !data.user) return null;

    let userQuery = await this.supabase.admin
      .from('users')
      .select('id, person_id, email, person:persons!users_person_id_fkey(id, first_name, last_name, email)')
      .eq('tenant_id', tenant.id)
      .eq('auth_uid', data.user.id)
      .maybeSingle();

    if (!userQuery.data && data.user.email) {
      userQuery = await this.supabase.admin
        .from('users')
        .select('id, person_id, email, person:persons!users_person_id_fkey(id, first_name, last_name, email)')
        .eq('tenant_id', tenant.id)
        .ilike('email', data.user.email)
        .maybeSingle();
    }

    if (userQuery.error || !userQuery.data) return null;

    const person = this.pickSingle(
      userQuery.data.person as
        | {
            id: string;
            first_name: string;
            last_name: string;
            email?: string | null;
          }
        | Array<{
            id: string;
            first_name: string;
            last_name: string;
            email?: string | null;
          }>
        | null,
    );

    if (!person?.id) return null;

    return {
      userId: userQuery.data.id as string,
      personId: person.id,
      email: person.email ?? (userQuery.data.email as string | null) ?? data.user.email ?? null,
      fullName: `${person.first_name} ${person.last_name}`.trim(),
    };
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

  /**
   * Booking-origin work order create path. Sibling to dispatch.service —
   * dispatch creates work orders FROM A PARENT CASE; this creates them
   * from a booking bundle / order line, with NO parent case.
   *
   * Used by Slice 2 of the fulfillment-fixes Wave-2 plan: when a service
   * rule on an order line says requires_internal_setup, the matrix
   * (location_service_routing 00194) gives the team + lead time + SLA,
   * and this method materialises the work order. The bundle and line
   * linkage flow through booking_bundle_id and linked_order_line_item_id
   * respectively (00145).
   *
   * Why a separate method (not dispatch.service.ts):
   *   - dispatch refuses ticket_kind='case' parent and inherits parent
   *     state. Booking-origin has no parent case to inherit from.
   *   - We don't run runPostCreateAutomation (no request_type, no SLA via
   *     request_type, no workflow). SLA is provided explicitly by the
   *     matrix lookup; no workflow today (Wave 3 will extend the workflow
   *     editor to fire on order events).
   */
  async createBookingOriginWorkOrder(args: {
    title: string;
    description?: string;
    location_id?: string | null;
    booking_bundle_id: string;
    linked_order_line_item_id: string;
    /** Optional, but strongly preferred — matrix should provide one. */
    assigned_team_id?: string | null;
    assigned_user_id?: string | null;
    assigned_vendor_id?: string | null;
    /**
     * Resolution due date for the work order — typically
     * service_window_start - lead_time_minutes (computed by caller from the
     * matrix). Written directly to tickets.sla_resolution_due_at so the SLA
     * queue + lateness view (00190 fulfillment_units_v.is_late) work
     * correctly without going through sla_timers/sla_policies.
     *
     * We bypass the standard SLA-policy calculation because booking-origin
     * work has a service-window-anchored deadline, not a creation-anchored
     * one. The SLA service can be wired in a later wave if pause/resume
     * semantics are needed for facilities work.
     */
    target_due_at?: string | null;
    priority?: string;
    /**
     * Optional SLA policy from the matrix. We DON'T start sla_timers
     * (creation-anchored math doesn't fit our service-window-anchored
     * deadline). We DO record sla_id on the ticket so the policy is
     * visible in the SLA admin's "where is this policy used" view and
     * isn't silently discarded. Codex 2026-04-30 review caught this
     * dead-config gap.
     */
    sla_policy_id?: string | null;
    /**
     * Free-form snapshot for audit — typically the rule_ids that triggered
     * the auto-creation, the matrix row id, and the original line metadata.
     */
    audit_metadata?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    const tenant = TenantContext.current();

    // Step 1c.4 cutover: write to public.work_orders directly. ticket_kind
    // is gone (work_orders is single-kind); parent_kind='booking_bundle'
    // explicit. The reverse shadow trigger keeps tickets in sync.
    const insertRow: Record<string, unknown> = {
      tenant_id: tenant.id,
      parent_kind: 'booking_bundle',
      parent_ticket_id: null, // booking-origin has no parent case
      booking_bundle_id: args.booking_bundle_id,
      linked_order_line_item_id: args.linked_order_line_item_id,
      title: args.title,
      description: args.description ?? null,
      priority: args.priority ?? 'medium',
      interaction_mode: 'internal',
      status: 'new',
      status_category: args.assigned_team_id || args.assigned_user_id || args.assigned_vendor_id
        ? 'assigned'
        : 'new',
      // Intentionally NOT set: bundle.requester_person_id already captures
      // originator identity, and setting it here would leak this internal
      // operational task into the requester's portal "My Requests" view.
      requester_person_id: null,
      location_id: args.location_id ?? null,
      assigned_team_id: args.assigned_team_id ?? null,
      assigned_user_id: args.assigned_user_id ?? null,
      assigned_vendor_id: args.assigned_vendor_id ?? null,
      sla_id: args.sla_policy_id ?? null,
      sla_resolution_due_at: args.target_due_at ?? null,
      source_channel: 'system',
    };

    const { data, error } = await this.supabase.admin
      .from('work_orders')
      .insert(insertRow)
      .select('id')
      .single();
    if (error) throw error;

    const ticketId = (data as { id: string }).id;

    // System event for audit + activity feed.
    await this.addActivity(ticketId, {
      activity_type: 'system_event',
      visibility: 'system',
      metadata: {
        event: 'booking_origin_work_order_created',
        booking_bundle_id: args.booking_bundle_id,
        linked_order_line_item_id: args.linked_order_line_item_id,
        ...(args.audit_metadata ?? {}),
      },
    });

    await this.logDomainEvent(ticketId, 'booking_origin_work_order_created', {
      ticket_id: ticketId,
      booking_bundle_id: args.booking_bundle_id,
      linked_order_line_item_id: args.linked_order_line_item_id,
      ...(args.audit_metadata ?? {}),
    });

    return { id: ticketId };
  }
}
