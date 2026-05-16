import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  buildPatchIdempotencyKey,
  buildCreateTicketIdempotencyKey,
  buildCreateTicketId,
} from '@prequest/shared';
import { AppErrors, mapRpcErrorToAppError } from '../../common/errors';
import { hasOwnDefined } from '../../common/has-own-defined';
import { SupabaseService } from '../../common/supabase/supabase.service';
import {
  assertTenantOwned,
  validateAssigneesInTenant,
  validateWatcherIdsInTenant,
} from '../../common/tenant-validation';
import { TenantContext } from '../../common/tenant-context';
import { RoutingService } from '../routing/routing.service';
import { ScopeOverrideResolverService } from '../routing/scope-override-resolver.service';
import { SlaService } from '../sla/sla.service';
import { WorkflowEngineService } from '../workflow/workflow-engine.service';
import { ApprovalService } from '../approval/approval.service';
import { TicketVisibilityService } from './ticket-visibility.service';

/**
 * Naming asymmetry — intentional (B.2 §0.1).
 *
 * Runtime row columns use the SHORT form: `tickets.ticket_type_id`,
 * `tickets.workflow_id`, `tickets.sla_id`. Configuration tables and
 * the public API use the LONG form: `request_type_id`,
 * `workflow_definition_id`, `sla_policy_id`.
 *
 * This file uses both forms — short when reading/writing the runtime
 * row, long when reading/writing config (request_types,
 * workflow_definitions, sla_policies). DO NOT "normalise" them.
 *
 * Audit: docs/follow-ups/phase-8-naming-audit.md §2.C/D/E.
 */

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
  // F-IMP-6: vendor assignee mirror for defense-in-depth against the
  // caller-assignee gate. The RPC's gate (00350:430-431) already checks
  // all three; the DTO doesn't surface vendor in any current code path,
  // but typing it keeps the TS gate aligned with the RPC.
  assigned_vendor_id?: string;
  interaction_mode?: string;
  source_channel?: string;
  form_data?: Record<string, unknown>;
  external_system?: string;
  external_id?: string;
}

export interface CreateTicketOptions {
  /**
   * Pre-empts PG's semantic re-derivation for workflow_definition_id.
   * Webhook ingest passes the webhook row's `workflow_id` here when the
   * webhook carries an explicit override — the RPC bypasses the
   * workflow-mismatch gate, writes `tickets.workflow_id = <forced>`, and
   * the `workflow.start_required` outbox emit carries the forced id so
   * the WorkflowStartHandler starts the right workflow with no separate
   * `startForTicket` call (closes the race that existed under
   * `skipWorkflow` + explicit start). Spec §3.11 / F-CRIT-2 / Option B.
   *
   * Replaces the legacy `skipWorkflow` flag (post-cutover no-op since
   * 00349; removed in 00350 + this commit).
   */
  forceWorkflowDefinitionId?: string;
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
    // B.2.A.Step12 §3.11: the legacy create() path inlined
    // approvalService.createSingleStep — that's now owned by the
    // create_ticket_with_automation RPC (00349). The injection is
    // RETAINED (underscore-prefixed) to preserve the constructor
    // ordering for existing test fixtures that mock by position. Will
    // be removed when the test fixtures migrate to NestJS testing
    // module factories.
    @Inject(forwardRef(() => ApprovalService)) private readonly approvalService: ApprovalService,
    private readonly visibility: TicketVisibilityService,
    private readonly scopeOverrides: ScopeOverrideResolverService,
  ) {
    // B.2.A.Step12 §3.11: approvalService is currently unused by this
    // service (the RPC owns approval row creation) but the injection is
    // RETAINED to preserve constructor positional ordering for existing
    // test fixtures that mock by position. Void-reference to silence the
    // unused-locals lint. Future cleanup: migrate tests to NestJS testing
    // factories then drop this injection.
    void this.approvalService;
    // B.2.A.Step10 reland: slaService + workflowEngine were called by
    // runPostCreateAutomation. With that method deleted (the
    // grant_ticket_approval RPC + the §3.9.3 handlers own the
    // post-grant SLA / workflow start), both injections are now unused
    // by this service. Kept on the constructor for positional-ordering
    // compatibility with existing test fixtures (same rationale as
    // approvalService above). Future cleanup: migrate tests to NestJS
    // testing factories then drop these injections.
    void this.slaService;
    void this.workflowEngine;
  }

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

  /**
   * Count + urgency snapshot for the desk-shell rail badge. Wraps
   * `getInbox` and counts the result. Note: this re-runs the full inbox
   * composition (mention scan + 3 parallel ticket queries + activity
   * hydration). It is NOT a cheap COUNT(*) query — the activity
   * hydration is unused for count purposes but the bounded result set
   * (≤100) keeps the worst case manageable.
   *
   * TODO(perf): split out a fast-path that returns just `count + urgency`
   * without composing activities or sorting. Track in
   * docs/superpowers/specs/2026-05-02-main-menu-redesign-design.md §Open
   * follow-ups when raised.
   *
   * Urgency is true when any item is an @-mention OR has priority='critical'.
   */
  async getInboxCount(accessToken?: string): Promise<{ count: number; hasUrgency: boolean }> {
    const { items } = await this.getInbox(accessToken, 100);
    const hasUrgency = items.some(
      (item) =>
        item.priority === 'critical' ||
        item.inbox_reason === 'mentioned',
    );
    return { count: items.length, hasUrgency };
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
    throw AppErrors.notFound('ticket', id);
  }

  async create(
    dto: CreateTicketDto,
    options: CreateTicketOptions = {},
    actorAuthUid: string = SYSTEM_ACTOR,
    // B.2.A.Step12 §3.11 — threaded from RequireClientRequestIdGuard
    // via the controller for `POST /tickets`. Used as the idempotency-
    // key seed for `create_ticket_with_automation` (00349). Same actor
    // + same clientRequestId ⇒ same key ⇒ command_operations
    // short-circuits the retry. See spec §3.9.1 + §3.11.
    clientRequestId?: string,
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

    // ── B.2.A.Step12 §3.11 cutover ─────────────────────────────────────
    //
    // Pre-cutover this method INSERTed tickets via supabase-js then called
    // `runPostCreateAutomation` which fanned into routing + SLA + workflow
    // across multiple round-trips. If any post-INSERT step failed, the
    // ticket committed in a partial-onboarding state — exactly the
    // "multi-step writes must be PL/pgSQL RPCs" violation B.2.A is
    // closing across the entire command surface.
    //
    // Post-cutover the TS plan-build phase resolves the effective
    // location / scope-override / workflow / SLA (and optionally runs
    // the routing resolver), then hands a single
    // `create_ticket_with_automation` RPC the user payload + plan.
    // The RPC owns the atomic write set and emits outbox events.

    // Idempotency key seed: clientRequestId required (per F-CRIT-1).
    // SYSTEM_ACTOR callers (webhook ingest, cron) must still pass one —
    // typically a deterministic derivative of the upstream identifier.
    const effectiveClientRequestId = clientRequestId ?? randomUUID();
    const idempotencyKey = buildCreateTicketIdempotencyKey(
      actorAuthUid,
      effectiveClientRequestId,
    );

    // Deterministic ticket_id from idempotency key. Retry mints the
    // same id; the RPC's command_operations gate then returns the
    // cached_result without re-inserting.
    const preMintedTicketId = buildCreateTicketId(idempotencyKey);

    // ── TS plan-build phase ────────────────────────────────────────────
    //
    // Mirror the order at apps/api/src/modules/ticket/ticket.service.ts
    // (legacy runPostCreateAutomation) so the PG semantic-mismatch gate
    // doesn't trigger on the happy path.

    // 1. Effective location: explicit → asset-derived → null.
    const effectiveLocationId = await this.scopeOverrides.deriveEffectiveLocation(
      tenant.id,
      {
        locationId: dto.location_id ?? null,
        assetId: dto.asset_id ?? null,
      },
    );

    // 2. Request-type config (FOR SHARE inside the RPC; here just for
    //    workflow/sla fallback math + approval-gate-prediction).
    const requestTypeCfg = dto.ticket_type_id
      ? (
          await this.supabase.admin
            .from('request_types')
            .select(
              'id, domain, sla_policy_id, workflow_definition_id, requires_approval, approval_approver_team_id, approval_approver_person_id',
            )
            .eq('id', dto.ticket_type_id)
            .eq('tenant_id', tenant.id)
            .maybeSingle()
        ).data
      : null;

    // 3. Scope override + effective workflow/SLA derivation.
    const scopeOverride = dto.ticket_type_id
      ? await this.scopeOverrides.resolveForLocation(
          tenant.id,
          dto.ticket_type_id,
          effectiveLocationId,
        )
      : null;
    const effectiveWorkflowDefinitionId =
      (scopeOverride?.workflow_definition_id as string | null | undefined) ??
      (requestTypeCfg?.workflow_definition_id as string | null | undefined) ??
      null;
    const effectiveSlaPolicyId =
      (scopeOverride?.case_sla_policy_id as string | null | undefined) ??
      (requestTypeCfg?.sla_policy_id as string | null | undefined) ??
      null;

    // 4. (Optional) routing resolver — sync per §3.9.2 v4. Skipped if
    //    caller passed an assignee or if request type requires approval
    //    (routing happens at grant time via §3.5 — future RPC).
    // F-IMP-6: include assigned_vendor_id in the caller-assignee gate.
    // RPC at 00350:430-431 already checks all three; the TS DTO doesn't
    // currently carry vendor (so this is latent today) but mirroring the
    // RPC defensively closes the gap when DTO grows that field.
    const callerProvidedAssignee = Boolean(
      dto.assigned_team_id || dto.assigned_user_id || dto.assigned_vendor_id,
    );
    const willRequireApproval =
      requestTypeCfg?.requires_approval === true &&
      (requestTypeCfg.approval_approver_person_id ||
        requestTypeCfg.approval_approver_team_id);
    let routingDecision: Record<string, unknown> | null = null;
    let routingTrace: Record<string, unknown> | null = null;
    if (!callerProvidedAssignee && !willRequireApproval && dto.ticket_type_id) {
      try {
        const evalCtx = {
          tenant_id: tenant.id,
          ticket_id: preMintedTicketId,
          request_type_id: dto.ticket_type_id,
          domain: (requestTypeCfg?.domain as string | null) ?? null,
          priority: dto.priority ?? null,
          asset_id: dto.asset_id ?? null,
          location_id: effectiveLocationId,
        };
        const evalResult = await this.routingService.evaluate(evalCtx);
        routingDecision = {
          chosen_by: evalResult.chosen_by,
          strategy: evalResult.strategy,
          rule_id: evalResult.rule_id,
          team_id: evalResult.target?.kind === 'team' ? evalResult.target.team_id : null,
          user_id: evalResult.target?.kind === 'user' ? evalResult.target.user_id : null,
          vendor_id:
            evalResult.target?.kind === 'vendor' ? evalResult.target.vendor_id : null,
        };
        routingTrace = {
          input: {
            request_type_id: dto.ticket_type_id,
            location_id: effectiveLocationId,
            asset_id: dto.asset_id ?? null,
          },
          trace: evalResult.trace,
        };
      } catch (err) {
        // Resolver failure: leave the ticket unassigned, but DON'T fail
        // the create. The RPC will commit the ticket without a routing
        // decision row; the breadcrumb activity row from the resolver
        // path is best-effort.
        console.error('[routing] evaluate failed during create plan-build', err);
        routingDecision = null;
        routingTrace = null;
      }
    }

    // 5. Build automation_plan + call the RPC.
    const automationPlan = {
      effective_location_id: effectiveLocationId,
      scope_override_id: (scopeOverride?.id as string | undefined) ?? null,
      effective_workflow_definition_id: effectiveWorkflowDefinitionId,
      effective_sla_policy_id: effectiveSlaPolicyId,
      routing_decision: routingDecision,
      routing_trace: routingTrace,
      _resolution_at: new Date().toISOString(),
    };

    const inputPayload: Record<string, unknown> = {
      ticket_id: preMintedTicketId,
      request_type_id: dto.ticket_type_id,
      parent_ticket_id: dto.parent_ticket_id ?? null,
      requester_person_id: dto.requester_person_id,
      requested_for_person_id: dto.requested_for_person_id ?? dto.requester_person_id,
      title: dto.title,
      description: dto.description ?? null,
      priority: dto.priority ?? 'medium',
      impact: dto.impact ?? null,
      urgency: dto.urgency ?? null,
      location_id: dto.location_id ?? null,
      asset_id: dto.asset_id ?? null,
      assigned_team_id: dto.assigned_team_id ?? null,
      assigned_user_id: dto.assigned_user_id ?? null,
      assigned_vendor_id: dto.assigned_vendor_id ?? null,
      watchers: [],
      source_channel: dto.source_channel ?? 'portal',
      interaction_mode: dto.interaction_mode ?? 'internal',
      form_data: dto.form_data ?? null,
      external_system: dto.external_system ?? null,
      external_id: dto.external_id ?? null,
      // F-CRIT-2 / Option B: optional webhook-ingest workflow override.
      // When present, the RPC pre-empts semantic re-derivation for
      // workflow_definition_id and emits workflow.start_required with
      // this value — no separate startForTicket call required.
      force_workflow_definition_id: options.forceWorkflowDefinitionId ?? null,
    };

    // Resolve auth_uid → users.id for the RPC's actor stamp (it then
    // maps users.id → person_id internally via users.auth_uid).
    const actorAuthUidParam =
      actorAuthUid === SYSTEM_ACTOR ? null : actorAuthUid;

    const rpcRes = await this.supabase.admin.rpc('create_ticket_with_automation', {
      p_input: inputPayload,
      p_automation_plan: automationPlan,
      p_tenant_id: tenant.id,
      p_actor_user_id: actorAuthUidParam,
      p_idempotency_key: idempotencyKey,
    });
    if (rpcRes.error) throw mapRpcErrorToAppError(rpcRes.error);

    const out = rpcRes.data as
      | {
          ticket: Record<string, unknown>;
          follow_ups: string[];
          concurrent_override_edit: boolean;
        }
      | null;
    if (!out || !out.ticket) {
      throw AppErrors.server('create_ticket_with_automation.malformed_response');
    }

    // Step 1c.10c: synthesize ticket_kind for frontend contract.
    // F-CRIT-2 / Option B: options.forceWorkflowDefinitionId is the
    // post-cutover replacement for the legacy skipWorkflow flag. Webhook
    // ingest threads it via inputPayload.force_workflow_definition_id;
    // the RPC owns the override → no race window between TS create + a
    // separate startForTicket call.
    return { ...(out.ticket as Record<string, unknown>), ticket_kind: 'case' as const } as Record<string, unknown> & { ticket_kind: 'case' };
  }

  // B.2.A.Step10 reland — `onApprovalDecision` + `runPostCreateAutomation`
  // were deleted in this commit. Their multi-step write sequence
  // (tickets UPDATE → re-fetch → activity → optional routing/SLA/workflow
  // fan-out) was the headline lie §1.3 + §1.19 called out: there was no
  // transaction wrapping the steps, so a mid-flow crash left the ticket
  // in pending_approval with no path forward. The atomic
  // `grant_ticket_approval` RPC (00356 / spec §3.5) replaces all of it:
  //
  //   - State-machine guard (`status_category=='pending_approval'`) is
  //     the conditional `if v_ticket.status_category = 'pending_approval'`
  //     check at step 10 of the RPC.
  //   - Tickets UPDATE for rejected → closed | approved → new lives in
  //     step 10.
  //   - The post-grant routing/SLA/workflow fan-out is now three outbox
  //     events (sla.timer_recompute_required, routing.evaluation_required,
  //     workflow.start_required) emitted at step 11 — drained by the
  //     respective §3.9.3 handlers shipped in Step 11 + Step 12.
  //
  // The `runPostCreateAutomation` private helper was the second caller
  // of routingService.evaluate / slaService.startTimers /
  // workflowEngine.startForTicket. With its only caller (this method)
  // deleted, the helper is dead — also removed in this commit.
  //
  // The `force_workflow_definition_id` webhook override path (Step 12)
  // does NOT touch this helper — it threads through the RPC's
  // p_input.force_workflow_definition_id parameter instead.

  async update(
    id: string,
    dto: UpdateTicketDto,
    actorAuthUid: string,
    // B.2.A Commit B (§3.0 controller cutover) — threaded from
    // RequireClientRequestIdGuard via the controller for `PATCH /tickets/:id`.
    // The orchestrator idempotency key is minted via
    // `buildPatchIdempotencyKey('case', …)` from
    // `@prequest/shared/idempotency` — single source of truth shared
    // with the smoke scripts. Un-underscored from `_clientRequestId`
    // (Step 2 placeholder) now that the value is actually consumed.
    clientRequestId?: string,
  ) {
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
            throw AppErrors.forbidden(
              'ticket.priority_change_forbidden',
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
            throw AppErrors.forbidden(
              'ticket.assign_forbidden',
              'tickets.assign permission required to change a ticket assignment',
            );
          }
        }
      }
    }

    // Tenant-validate watcher + assignee uuids early so malformed/ghost
    // uuids reject with a clean 400 before paying the cost of the getById
    // round-trip + close-guard SELECT. Mirrors the WO side ordering.
    //
    // Watchers — closes ghost-uuid vector; does NOT close within-tenant
    // unauthorized share (subscriber semantics).
    //
    // Assignees — closes ghost-uuid + cross-tenant id smuggling on
    // `assigned_team_id` / `assigned_user_id` / `assigned_vendor_id`.
    // Pre-fix, the case side accepted any uuid (FK + RLS don't carry a
    // tenant composite check on these columns); WorkOrderService.
    // updateAssignment validated, TicketService.update did not — same
    // shape of gap, larger blast radius (assignment grants ownership).
    if (dto.watchers !== undefined) {
      await validateWatcherIdsInTenant(this.supabase, dto.watchers, tenant.id, {
        skipForSystemActor: actorAuthUid === SYSTEM_ACTOR,
      });
    }
    if (
      dto.assigned_team_id !== undefined ||
      dto.assigned_user_id !== undefined ||
      dto.assigned_vendor_id !== undefined
    ) {
      await validateAssigneesInTenant(
        this.supabase,
        {
          assigned_team_id: dto.assigned_team_id,
          assigned_user_id: dto.assigned_user_id,
          assigned_vendor_id: dto.assigned_vendor_id,
        },
        tenant.id,
        { skipForSystemActor: actorAuthUid === SYSTEM_ACTOR },
      );
    }

    // Plan A.2 / Commit 4 / gap map §ticket.service.ts:951-953 — defense
    // in depth on dto.sla_id. The rejection below makes the validation
    // unreachable today (every dto.sla_id !== undefined path throws), but
    // if a future change relaxes that gate (e.g. allow desk admins to
    // re-attach a parent SLA), the validation here ensures we don't
    // reintroduce the cross-tenant smuggling vector. Cheap (string
    // typecheck + a single SELECT) and structurally correct.
    if (typeof dto.sla_id === 'string') {
      await assertTenantOwned(
        this.supabase,
        'sla_policies',
        dto.sla_id,
        tenant.id,
        {
          entityName: 'SLA policy',
          skipForSystemActor: actorAuthUid === SYSTEM_ACTOR,
        },
      );
    }

    // Get current state for change tracking
    const current = await this.getById(id, SYSTEM_ACTOR);

    // Step 1c.10c: tickets is case-only. The previous ticket_kind='case' guards
    // are now unconditional — every ticket here IS a case. SLA-on-case is locked.
    if (dto.sla_id !== undefined) {
      throw AppErrors.validationFailed('ticket.case_sla_immutable', {
        detail: 'cannot change sla_id on a case; parent SLA is locked',
      });
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
        throw AppErrors.validationFailed('ticket.children_open_cannot_close', {
          detail: `cannot close case while children are open: ${childIds.join(', ')}`,
        });
      }
    }

    // Cost is `numeric(12,2)` in Postgres — exact 2-dp decimal. JS sends
    // IEEE-754 floats, so a UI-derived `0.1 + 0.2 = 0.30000000000000004`
    // PATCH would round to 0.30 on write but compare against 0.3 on the
    // next refetch — the no-op fast-path below would never fire and every
    // PATCH with a fractional cost would re-write the row. Normalize at
    // the TS boundary so the orchestrator's `payload_hash` is stable
    // across replays and the RPC's idempotency cache hits cleanly.
    //
    // The combined RPC (00333:542) also `round((... ->>'cost')::numeric, 2)`
    // before persisting — defence in depth.
    const dtoNormalized: typeof dto = { ...dto };
    if (
      Object.prototype.hasOwnProperty.call(dto, 'cost') &&
      typeof dto.cost === 'number' &&
      Number.isFinite(dto.cost)
    ) {
      dtoNormalized.cost = Math.round(dto.cost * 100) / 100;
    }

    // ──────────────────────────────────────────────────────────────────
    // B.2.A Commit B (§3.0 controller cutover) — the multi-table TS write
    // path (tickets UPDATE + ticket_activities INSERT + domain_events
    // INSERT + sla_timers reshuffle) has moved into `update_entity_combined`
    // (00333 v3). TS continues to own preflight (permission gates above,
    // tenant validation above, sla_id immutability + parent close guard
    // above, cost normalization above). The single RPC commits every
    // branch in one transaction; nested idempotency keys per spec §3.0.
    //
    // Citations:
    //   - 00333:182-187 — branch detection on top-level keys.
    //   - 00333:295    — inner sentinel `__combined__:`.
    //   - spec line 1892 — outer idempotency key shape.
    // ──────────────────────────────────────────────────────────────────
    const patches = this.buildPatchesPayloadForCase(dtoNormalized);

    // Honest no-op short-circuit: no branch keys ⇒ no write to attempt.
    // The RPC's `update_entity_combined.invalid_patches` does NOT cover
    // "valid object, zero recognised branches" — it would just return a
    // noop result. Save the round-trip + idempotency-cache pollution.
    if (Object.keys(patches).length === 0) {
      // satisfaction_* fall through to the side-write below; if neither
      // is set, return the current row unchanged.
      const wantsSatisfaction =
        Object.prototype.hasOwnProperty.call(dto, 'satisfaction_rating') ||
        Object.prototype.hasOwnProperty.call(dto, 'satisfaction_comment');
      if (!wantsSatisfaction) return current;
    }

    if (Object.keys(patches).length > 0) {
      // F-CRIT-1 (plan-review 2026-05-11): explicit defense-in-depth.
      // The controller's RequireClientRequestIdGuard (I1) normally
      // ensures clientRequestId is present at the HTTP boundary, but
      // internal callers that bypass the controller (e.g. the future
      // workflow-engine cutover in Step 9) would silently get a fresh
      // randomUUID per call — a real idempotency footgun where "retry"
      // mints a new key. Reject explicitly here so any non-HTTP caller
      // surfaces the missing-id error instead of corrupting replay
      // semantics.
      if (!clientRequestId) {
        throw AppErrors.badRequest(
          'command_operations.client_request_id_required',
          'PATCH /tickets/:id requires X-Client-Request-Id header per I1 (RequireClientRequestIdGuard).',
        );
      }
      const { error } = await this.supabase.admin.rpc('update_entity_combined', {
        p_entity_kind: 'case',
        p_entity_id: id,
        p_tenant_id: tenant.id,
        // Per 00325:89-94 — `p_actor_user_id` is the SUPABASE AUTH UID
        // (users.auth_uid), NOT users.id. SYSTEM_ACTOR collapses to null
        // so the RPC's lookup at 00333:268-274 falls back cleanly.
        p_actor_user_id: actorAuthUid === SYSTEM_ACTOR ? null : actorAuthUid,
        p_idempotency_key: buildPatchIdempotencyKey('case', id, clientRequestId),
        p_patches: patches,
      });
      if (error) throw mapRpcErrorToAppError(error);
    }

    // satisfaction_rating + satisfaction_comment are not part of the
    // §3.0 RPC patches schema (00333 supports status / priority /
    // assignment / sla / plan / metadata only). They have no audit-row
    // or domain-event side effects — the legacy write path applied them
    // via the catch-all `Object.entries` block with no activity emission.
    // Preserve the API surface here as a direct UPDATE (gated by the
    // same preflight permission/visibility checks above). Used by the
    // satisfaction-survey workflow; not exercised by the desk UI today.
    if (
      Object.prototype.hasOwnProperty.call(dto, 'satisfaction_rating') ||
      Object.prototype.hasOwnProperty.call(dto, 'satisfaction_comment')
    ) {
      const satPatch: Record<string, unknown> = {};
      if (Object.prototype.hasOwnProperty.call(dto, 'satisfaction_rating')) {
        satPatch.satisfaction_rating = dto.satisfaction_rating;
      }
      if (Object.prototype.hasOwnProperty.call(dto, 'satisfaction_comment')) {
        satPatch.satisfaction_comment = dto.satisfaction_comment;
      }
      const { error: satErr } = await this.supabase.admin
        .from('tickets')
        .update(satPatch)
        .eq('id', id)
        .eq('tenant_id', tenant.id);
      if (satErr) throw satErr;
    }

    // Refetch so the response shape matches today's API contract
    // (joined requester / location / asset / assigned_* / request_type).
    // SYSTEM_ACTOR bypasses visibility — preflight above already checked
    // the actor's write permission.
    return await this.getById(id, SYSTEM_ACTOR);
  }

  /**
   * Build the `p_patches` jsonb payload for `update_entity_combined`
   * (00333) from an UpdateTicketDto. Uses key-presence (`hasOwnProperty`)
   * — absent key ⇒ no branch; present key with `null` ⇒ explicit clear
   * where the column allows.
   *
   * Citations: 00333:182-187 (branch detection) + 00333:289-295 (status
   * payload shape) + 00333:362-377 (assignment payload shape) + 00333:
   * 379-395 (sla payload shape) + 00333:397-503 (plan payload shape) +
   * 00333:505-732 (metadata payload shape).
   *
   * Case-only — caller must enforce `sla_id` immutability before this
   * helper sees the dto (the §3.0 RPC accepts `sla` on cases, but our
   * product rule says parent SLAs are locked; ticket.service.ts:1049
   * is the gate).
   */
  private buildPatchesPayloadForCase(
    dto: UpdateTicketDto,
  ): Record<string, unknown> {
    const patches: Record<string, unknown> = {};
    // F-IMP-2 (plan-review 2026-05-11): align with WO side — presence
    // requires hasOwnProperty AND value !== undefined. Without the
    // undefined guard a caller passing `{ title: undefined }` would
    // populate metadata.title=undefined and trigger the metadata
    // branch on a no-op.
    const has = (k: keyof UpdateTicketDto) => hasOwnDefined(dto, k);

    // ── Status branch — top-level keys (00333:182, 277-303).
    if (has('status')) patches.status = dto.status;
    if (has('status_category')) patches.status_category = dto.status_category;
    if (has('waiting_reason')) patches.waiting_reason = dto.waiting_reason;

    // ── Priority — top-level (00333:185, 305-359).
    if (has('priority')) patches.priority = dto.priority;

    // ── Assignment — grouped under `assignment` (00333:183, 361-377).
    if (
      has('assigned_team_id') ||
      has('assigned_user_id') ||
      has('assigned_vendor_id')
    ) {
      const assignment: Record<string, unknown> = {};
      if (has('assigned_team_id'))
        assignment.assigned_team_id = dto.assigned_team_id;
      if (has('assigned_user_id'))
        assignment.assigned_user_id = dto.assigned_user_id;
      if (has('assigned_vendor_id'))
        assignment.assigned_vendor_id = dto.assigned_vendor_id;
      patches.assignment = assignment;
    }

    // ── Metadata — grouped under `metadata` (00333:187, 505-732).
    // description is NOT a top-level Update DTO field on the case-side
    // surface today; check both names defensively to keep parity with
    // the WO side and future UpdateTicketDto growth.
    const metadata: Record<string, unknown> = {};
    if (has('title')) metadata.title = dto.title;
    if (has('description')) metadata.description = dto.description;
    if (has('cost')) metadata.cost = dto.cost;
    if (has('tags')) metadata.tags = dto.tags;
    if (has('watchers')) metadata.watchers = dto.watchers;
    if (Object.keys(metadata).length > 0) {
      patches.metadata = metadata;
    }

    // sla / plan branches NOT emitted on the case path. sla_id rejected
    // upstream by ticket.service.ts:1049 (case SLA immutability). plan
    // rejected by the RPC's early gate at 00333:192-194 (case has no
    // plan columns per 00011_tickets.sql:1-44).

    return patches;
  }

  /**
   * Explicitly reassign a ticket with a reason. Distinct from plain `update`
   * so we can record a routing_decisions trace row and keep the reason visible
   * in the timeline.
   */
  async reassign(
    id: string,
    dto: ReassignDto,
    actorAuthUid: string,
    // B.2.A I1 — threaded from RequireClientRequestIdGuard via the
    // controller for `POST /tickets/:id/reassign`. Plumbed only today;
    // Step 3+ uses it as the idempotency-key seed for the
    // set_entity_assignment RPC (spec §3.2 + §3.9.1).
    _clientRequestId?: string,
  ) {
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
          throw AppErrors.forbidden(
            'ticket.assign_forbidden',
            'tickets.assign permission required to reassign a ticket',
          );
        }
      }
    }

    const current = await this.getById(id, SYSTEM_ACTOR);

    if (!dto.reason?.trim()) {
      throw AppErrors.validationFailed('ticket.reassignment_reason_required', {
        detail: 'reassignment reason is required',
      });
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
        .eq('id', id)
        .eq('tenant_id', tenant.id);

      const rtCfg = current.ticket_type_id
        ? (await this.supabase.admin
            .from('request_types')
            .select('domain')
            .eq('id', current.ticket_type_id)
            .eq('tenant_id', tenant.id)
            .maybeSingle()).data
        : null;

      let effectiveLocation = current.location_id as string | null;
      if (!effectiveLocation && current.asset_id) {
        const { data: asset } = await this.supabase.admin
          .from('assets')
          .select('assigned_space_id')
          .eq('id', current.asset_id as string)
          .eq('tenant_id', tenant.id)
          .maybeSingle();
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

      // Plan A.2 / Commit 4 / gap map analogue of work-order rerunAssignmentResolver.
      // Routing definitions are tenant-scoped, but the resolver result is
      // a structured payload — if a routing-table compromise, rule import,
      // or test-time override returned a foreign uuid, we'd write it
      // blind to the tickets row. Validate before propagating into
      // `updates` below.
      if (nextTarget) {
        await validateAssigneesInTenant(
          this.supabase,
          nextTarget.kind === 'team'
            ? { assigned_team_id: nextTarget.id }
            : nextTarget.kind === 'user'
              ? { assigned_user_id: nextTarget.id }
              : { assigned_vendor_id: nextTarget.id },
          tenant.id,
          { skipForSystemActor: actorAuthUid === SYSTEM_ACTOR },
        );
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

  /**
   * Audit 02 / P0-1 + P2-5: bulk update is no longer a raw
   * `.from('tickets').update(dto).in('id', ids)` back door. Every id is
   * routed through the canonical single-path `update()`, which owns the
   * full B.2.A guarantee set: per-action permission gates
   * (`tickets.change_priority` / `tickets.assign`), watcher/assignee
   * tenant validation, `sla_id` immutability, parent-close-while-children
   * -open guard, cost float-normalisation, the `update_entity_combined`
   * RPC with `command_operations` idempotency + audit/activity + domain
   * event, and the satisfaction fold. There is no separate validation to
   * keep in sync — bulk == N× the hardened path.
   *
   * Idempotency: a single `clientRequestId` is shared by the batch and
   * `update()` derives a deterministic per-id key
   * (`patch:case:<id>:<crid>` via buildPatchIdempotencyKey), so a network
   * retry of the whole batch replays each id exactly once.
   *
   * Partial success: per the error-handling spec (CLAUDE.md "Bulk ops use
   * results[] + partialSuccess"), one bad id never aborts the batch. The
   * caller gets a per-id outcome; permission denials surface as an `error`
   * row, not a silent drop.
   */
  async bulkUpdate(
    ids: string[],
    dto: UpdateTicketDto,
    actorAuthUid: string = SYSTEM_ACTOR,
    clientRequestId?: string,
  ): Promise<{
    results: Array<{
      id: string;
      status: 'ok' | 'error';
      data?: unknown;
      error?: { code: string; message: string };
    }>;
    okCount: number;
    errorCount: number;
    partialSuccess: boolean;
  }> {
    if (!Array.isArray(ids) || ids.length === 0) {
      return { results: [], okCount: 0, errorCount: 0, partialSuccess: false };
    }
    // Cap blast radius. The desk UI never selects more than a screenful at a
    // time; an unbounded list here is almost certainly an abuse signal.
    if (ids.length > 200) {
      throw AppErrors.validationFailed('ticket.bulk_cap_exceeded', {
        detail: 'bulk update is capped at 200 ids per call',
      });
    }
    // De-dupe: the same id twice in one batch maps to the same per-id
    // idempotency key — the second would replay the first's cached result,
    // but emitting two result rows for one id is confusing. Collapse first.
    const uniqueIds = Array.from(new Set(ids));

    const results: Array<{
      id: string;
      status: 'ok' | 'error';
      data?: unknown;
      error?: { code: string; message: string };
    }> = [];

    for (const id of uniqueIds) {
      try {
        const data = await this.update(id, dto, actorAuthUid, clientRequestId);
        results.push({ id, status: 'ok', data });
      } catch (err) {
        const code =
          (err as { code?: string } | null)?.code ??
          (err as { name?: string } | null)?.name ??
          'unknown.server_error';
        const message =
          err instanceof Error ? err.message : String(err ?? 'bulk update failed');
        results.push({ id, status: 'error', error: { code, message } });
      }
    }

    const okCount = results.filter((r) => r.status === 'ok').length;
    const errorCount = results.length - okCount;
    return {
      results,
      okCount,
      errorCount,
      partialSuccess: okCount > 0 && errorCount > 0,
    };
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
   * and this method materialises the work order. The booking and line
   * linkage flow through `work_orders.booking_id` (renamed from
   * `booking_bundle_id` in 00278:87) and `linked_order_line_item_id`
   * respectively (00213).
   *
   * Why a separate method (not dispatch.service.ts):
   *   - dispatch refuses ticket_kind='case' parent and inherits parent
   *     state. Booking-origin has no parent case to inherit from.
   *   - We don't run runPostCreateAutomation (no request_type, no SLA via
   *     request_type, no workflow). SLA is provided explicitly by the
   *     matrix lookup; no workflow today (Wave 3 will extend the workflow
   *     editor to fire on order events).
   *
   * Argument name `booking_bundle_id` kept for caller-signature stability
   * during the rewrite; semantically it's the booking id (canonicalisation
   * collapsed bundles into bookings — 00277:27).
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
    // is gone (work_orders is single-kind); the canonical parent_kind
    // discriminator is 'booking' post-canonicalization (00288 tightened
    // the CHECK from the legacy 'booking_bundle' label). The FK column is
    // `booking_id` (00278:87). Reverse shadow trigger keeps tickets in sync.
    const insertRow: Record<string, unknown> = {
      tenant_id: tenant.id,
      parent_kind: 'booking',
      parent_ticket_id: null, // booking-origin has no parent case
      booking_id: args.booking_bundle_id,
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

    // System event for audit + activity feed. The legacy `booking_bundle_id`
    // alias was dropped post-canonicalization (verified via grep: zero
    // consumers of metadata.booking_bundle_id across apps/api + apps/web).
    // The canonical key is `booking_id` (00278:87).
    await this.addActivity(ticketId, {
      activity_type: 'system_event',
      visibility: 'system',
      metadata: {
        event: 'booking_origin_work_order_created',
        booking_id: args.booking_bundle_id,
        linked_order_line_item_id: args.linked_order_line_item_id,
        ...(args.audit_metadata ?? {}),
      },
    });

    await this.logDomainEvent(ticketId, 'booking_origin_work_order_created', {
      ticket_id: ticketId,
      booking_id: args.booking_bundle_id,
      linked_order_line_item_id: args.linked_order_line_item_id,
      ...(args.audit_metadata ?? {}),
    });

    return { id: ticketId };
  }
}
