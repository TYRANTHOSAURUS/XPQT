import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { BusinessHoursService, BusinessHoursCalendar } from './business-hours.service';
import { NotificationService } from '../notification/notification.service';
import type {
  EscalationThreshold,
  SlaTimerRow,
  TimerType,
  ThresholdTargetType,
  RecordedAction,
} from './sla-threshold.types';
import { crossingKey } from './sla-threshold.types';
import { percentElapsed, selectApplicableThresholds } from './sla-threshold.helpers';
import { AppErrors, mapRpcErrorToAppError } from '../../common/errors';
import { probeCommandOperationSuccess } from '../../common/command-operations-probe';
import { buildSlaEscalationIdempotencyKey } from '@prequest/shared';

@Injectable()
export class SlaService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly businessHours: BusinessHoursService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Step 1c.10c helper: SLA-related updates to a ticket-shaped row need to
   * route to the right table based on whether the id is a case (tickets)
   * or a work_order (work_orders). Try tickets first; if no row matches
   * (case id never matches a wo and vice versa — UUIDs are globally
   * unique across both tables), fall back to work_orders.
   *
   * Pre-1c.10c the same logic was implicit (every row lived in tickets).
   * Post-cutover, this helper hides the dispatch from every SLA call site.
   */
  private async updateTicketOrWorkOrder(
    id: string,
    patch: Record<string, unknown>,
    tenantId?: string,
  ): Promise<void> {
    let q1 = this.supabase.admin.from('tickets').update(patch).eq('id', id);
    if (tenantId) q1 = q1.eq('tenant_id', tenantId);
    // Codex round 3: don't ignore real DB errors on the first attempt.
    const { data: caseHit, error: caseErr } = await q1.select('id').maybeSingle();
    if (caseErr) throw caseErr;
    if (caseHit) return;

    let q2 = this.supabase.admin.from('work_orders').update(patch).eq('id', id);
    if (tenantId) q2 = q2.eq('tenant_id', tenantId);
    // Step 1c.10c: detect "id in neither" rather than silently succeeding —
    // hides stale timer/crossing references otherwise. Use .select('id') so
    // we can count affected rows.
    const { data: woHit, error } = await q2.select('id').maybeSingle();
    if (error) throw error;
    if (!woHit) {
      throw AppErrors.server('sla.target_missing', {
        detail: `updateTicketOrWorkOrder: id ${id} not found in tickets or work_orders`,
      });
    }
  }

  /**
   * Start SLA timers when a ticket is created.
   * Called by the ticket service after ticket creation.
   *
   * Plan A.2 / gap map §sla.service.ts:65-71. The policy load MUST be
   * tenant-scoped. Without the tenant filter a caller passing a
   * cross-tenant slaPolicyId would resolve the policy globally (FK
   * exists, supabase.admin bypasses RLS), then create timers and
   * mirror response/resolution due dates from the wrong tenant's
   * escalation thresholds + business-hours calendar. The mirror is
   * already partially closed at applyWaitingStateTransition (line 270);
   * this closes the equivalent gap on the create path.
   */
  async startTimers(ticketId: string, tenantId: string, slaPolicyId: string) {
    const { data: policy, error: policyError } = await this.supabase.admin
      .from('sla_policies')
      .select('*')
      .eq('id', slaPolicyId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (policyError || !policy) return;

    const calendar = await this.loadCalendar(policy.business_hours_calendar_id as string | null);
    const now = new Date();
    const timers: Array<Record<string, unknown>> = [];

    if (policy.response_time_minutes) {
      const responseDue = this.businessHours.addBusinessMinutes(calendar, now, policy.response_time_minutes);
      timers.push({
        tenant_id: tenantId,
        ticket_id: ticketId,
        sla_policy_id: slaPolicyId,
        timer_type: 'response',
        target_minutes: policy.response_time_minutes,
        due_at: responseDue.toISOString(),
        business_hours_calendar_id: policy.business_hours_calendar_id,
      });

      // Step 1c.10c: route to tickets (case) or work_orders.
      await this.updateTicketOrWorkOrder(ticketId, {
        sla_response_due_at: responseDue.toISOString(),
      }, tenantId);
    }

    if (policy.resolution_time_minutes) {
      const resolutionDue = this.businessHours.addBusinessMinutes(calendar, now, policy.resolution_time_minutes);
      timers.push({
        tenant_id: tenantId,
        ticket_id: ticketId,
        sla_policy_id: slaPolicyId,
        timer_type: 'resolution',
        target_minutes: policy.resolution_time_minutes,
        due_at: resolutionDue.toISOString(),
        business_hours_calendar_id: policy.business_hours_calendar_id,
      });

      await this.updateTicketOrWorkOrder(ticketId, {
        sla_resolution_due_at: resolutionDue.toISOString(),
      }, tenantId);
    }

    if (timers.length > 0) {
      await this.supabase.admin.from('sla_timers').insert(timers);
    }
  }

  /**
   * Build the `timers[]` payload for `update_entity_sla` (00330) and its
   * orchestrator wrapper `update_entity_combined` (00333 §3.0). Returns the
   * pre-computed business-hours-adjusted due_at values for response and
   * resolution timers, in the shape the RPC's `jsonb_to_recordset` expects
   * (00330:279-284). No DB writes — the RPC owns the INSERT.
   *
   * Pre-conditions:
   *   - `slaPolicyId` is tenant-owned (caller already validated, or the
   *     RPC's `validate_entity_in_tenant` will reject before insert).
   *
   * Returns an empty array when the policy carries neither response nor
   * resolution thresholds — the caller's branch should then treat the
   * write as a clear-only (sla_id may still be non-null but the RPC will
   * raise `timers_required`). This matches the historical
   * `SlaService.startTimers` skip-when-empty behaviour (line 88+ / 106+).
   *
   * Used by `TicketService.update` + `WorkOrderService.update` (B.2.A
   * Commit B controller cutover) so the RPC receives the timers array
   * alongside `sla_id` instead of TS computing them post-write via the
   * legacy `restartTimers` path.
   */
  async buildTimersForRpc(
    slaPolicyId: string,
    tenantId: string,
  ): Promise<
    Array<{
      timer_type: 'response' | 'resolution';
      target_minutes: number;
      due_at: string;
      business_hours_calendar_id: string | null;
    }>
  > {
    const { data: policy } = await this.supabase.admin
      .from('sla_policies')
      .select('response_time_minutes, resolution_time_minutes, business_hours_calendar_id')
      .eq('id', slaPolicyId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!policy) {
      // F-IMP-4 (plan-review 2026-05-11): explicit 404 instead of
      // returning []. Previously a missing policy returned an empty
      // timers array and let the RPC raise
      // `update_entity_sla.timers_required` — which maps to 500 (a
      // programmer-error code: TS skipped its responsibility to
      // compute timers when sla_id is non-null). The actual problem
      // is "policy does not exist in tenant" → 404 is the right
      // surface, with a registered code the renderer knows.
      throw AppErrors.notFoundWithCode(
        'sla.policy_not_found',
        `SLA policy ${slaPolicyId} not found in tenant.`,
      );
    }

    // CODEX-B-3 (2026-05-11): reject SLA policies that have no targets.
    // sla_policies.response_time_minutes + resolution_time_minutes are
    // BOTH nullable in schema (00008:8-9); the admin POST/PATCH at
    // sla-policy.controller.ts:79-93 accepts that shape. But the timer-
    // build contract for the RPC requires at least one timer in the
    // payload — without targets we return `[]`, the RPC sees a non-null
    // sla_id without timers, and raises `update_entity_sla.timers_required`
    // which maps to 500 (a programmer-error code). The real problem is
    // user/admin configuration — "this policy has no SLA targets" — and
    // surfaces best as a 400 with a registered code the renderer knows.
    // codex final-pass (2026-05-11): treat 0 and non-positive as "no target"
    // alongside null. The truthiness checks at the timer-emit sites below
    // already skip 0, so admitting all-zero / all-null / mixed-zero-and-null
    // policies past this guard produces an empty timers[] and falls through
    // to the RPC's `update_entity_sla.timers_required` raise (500). Reject
    // up front with the registered 400 code instead. Schema permits 0
    // (00008_sla_policies.sql:8); sla-policy.controller.ts:80 accepts the
    // DTO blindly — the validation responsibility lands here.
    //
    // No `detail` argument on the throw: detail-override leaks the policy
    // UUID and DB column names past `normalize.ts:181` precedence and
    // overrides the curated registry copy in messages.{en,nl}.ts. The
    // registered code is the user-facing contract; the original policy id
    // is captured via the call site's logging context, not the wire.
    const responseValid =
      typeof policy.response_time_minutes === 'number' &&
      policy.response_time_minutes > 0;
    const resolutionValid =
      typeof policy.resolution_time_minutes === 'number' &&
      policy.resolution_time_minutes > 0;
    if (!responseValid && !resolutionValid) {
      throw AppErrors.badRequest('sla.policy_has_no_targets');
    }

    const calendar = await this.loadCalendar(
      (policy.business_hours_calendar_id as string | null) ?? null,
    );
    const now = new Date();
    const timers: Array<{
      timer_type: 'response' | 'resolution';
      target_minutes: number;
      due_at: string;
      business_hours_calendar_id: string | null;
    }> = [];

    if (policy.response_time_minutes) {
      const responseDue = this.businessHours.addBusinessMinutes(
        calendar,
        now,
        policy.response_time_minutes as number,
      );
      timers.push({
        timer_type: 'response',
        target_minutes: policy.response_time_minutes as number,
        due_at: responseDue.toISOString(),
        business_hours_calendar_id: (policy.business_hours_calendar_id as string | null) ?? null,
      });
    }

    if (policy.resolution_time_minutes) {
      const resolutionDue = this.businessHours.addBusinessMinutes(
        calendar,
        now,
        policy.resolution_time_minutes as number,
      );
      timers.push({
        timer_type: 'resolution',
        target_minutes: policy.resolution_time_minutes as number,
        due_at: resolutionDue.toISOString(),
        business_hours_calendar_id: (policy.business_hours_calendar_id as string | null) ?? null,
      });
    }

    return timers;
  }

  private async loadCalendar(calendarId: string | null): Promise<BusinessHoursCalendar | null> {
    if (!calendarId) return null;
    const { data } = await this.supabase.admin
      .from('business_hours_calendars')
      .select('time_zone, working_hours, holidays')
      .eq('id', calendarId)
      .maybeSingle();
    return (data as BusinessHoursCalendar | null) ?? null;
  }

  /**
   * Pause SLA timers when a ticket enters a waiting state.
   */
  async pauseTimers(ticketId: string, tenantId: string) {
    const now = new Date();

    await this.supabase.admin
      .from('sla_timers')
      .update({ paused: true, paused_at: now.toISOString() })
      .eq('ticket_id', ticketId)
      .eq('tenant_id', tenantId)
      .eq('paused', false)
      .is('completed_at', null)
      .is('stopped_at', null);

    await this.updateTicketOrWorkOrder(ticketId, {
      sla_paused: true,
      sla_paused_at: now.toISOString(),
    }, tenantId);
  }

  /**
   * Stop all active SLA timers for a ticket (distinct from pause and from
   * breach-completion). Used by reclassification and any future "tear down
   * old SLA" flow. Sets stopped_at + stopped_reason so historical reports
   * can show "timer ran for N minutes before being stopped."
   */
  async stopTimers(ticketId: string, tenantId: string, reason: string) {
    const now = new Date().toISOString();
    await this.supabase.admin
      .from('sla_timers')
      .update({ stopped_at: now, stopped_reason: reason })
      .eq('ticket_id', ticketId)
      .eq('tenant_id', tenantId)
      .is('stopped_at', null)
      .is('completed_at', null);
  }

  /**
   * Resume SLA timers when a ticket leaves a waiting state.
   * Shifts due_at by the business minutes that elapsed during the pause
   * (so if the pause happened entirely outside working hours, due_at doesn't move).
   */
  async resumeTimers(ticketId: string, tenantId: string) {
    const now = new Date();

    const { data: timers } = await this.supabase.admin
      .from('sla_timers')
      .select('*')
      .eq('ticket_id', ticketId)
      .eq('tenant_id', tenantId)
      .eq('paused', true)
      .is('completed_at', null)
      .is('stopped_at', null);

    for (const timer of timers ?? []) {
      const calendar = await this.loadCalendar(timer.business_hours_calendar_id as string | null);
      const pausedAt = new Date(timer.paused_at);
      const businessMinutesPaused = this.businessHours.businessMinutesBetween(calendar, pausedAt, now);
      const newTotalPaused = (timer.total_paused_minutes ?? 0) + businessMinutesPaused;

      const currentDue = new Date(timer.due_at);
      const newDue = businessMinutesPaused > 0
        ? this.businessHours.addBusinessMinutes(calendar, currentDue, businessMinutesPaused)
        : currentDue;

      await this.supabase.admin
        .from('sla_timers')
        .update({
          paused: false,
          paused_at: null,
          total_paused_minutes: newTotalPaused,
          due_at: newDue.toISOString(),
        })
        .eq('id', timer.id);
    }

    // Update ticket computed fields
    const { data: activeTimers } = await this.supabase.admin
      .from('sla_timers')
      .select('timer_type, due_at')
      .eq('ticket_id', ticketId)
      .eq('tenant_id', tenantId)
      .is('completed_at', null)
      .is('stopped_at', null);

    const updates: Record<string, unknown> = { sla_paused: false, sla_paused_at: null };
    for (const t of activeTimers ?? []) {
      if (t.timer_type === 'response') updates.sla_response_due_at = t.due_at;
      if (t.timer_type === 'resolution') updates.sla_resolution_due_at = t.due_at;
    }

    await this.updateTicketOrWorkOrder(ticketId, updates, tenantId);
  }

  /**
   * Complete SLA timers when a ticket is resolved.
   */
  async completeTimers(ticketId: string, tenantId: string, timerType?: string) {
    const now = new Date();

    let query = this.supabase.admin
      .from('sla_timers')
      .update({ completed_at: now.toISOString() })
      .eq('ticket_id', ticketId)
      .eq('tenant_id', tenantId)
      .is('completed_at', null)
      .is('stopped_at', null);

    if (timerType) query = query.eq('timer_type', timerType);

    await query;
  }

  /**
   * Apply pause/resume on SLA timers when a ticket OR work_order's
   * status_category transitions to/from 'waiting'. The pause is conditional
   * on the SLA policy's `pause_on_waiting_reasons` array containing the new
   * waiting_reason — a policy with an empty pause_on_waiting_reasons list
   * never triggers pause.
   *
   * Pre-§3.0 both TicketService.update (cases) and
   * WorkOrderService.updateStatus (work_orders) called this directly.
   * Post-§3.0 cutover, the equivalent pause/resume logic lives inside
   * `update_entity_combined` (00335 v5) so the status branch fires the
   * timer churn inside the same transaction. This helper stays for
   * future internal callers (workflow engine, cron) until they go
   * through `update()` too. Cross-table polymorphism is handled by
   * pauseTimers/resumeTimers via updateTicketOrWorkOrder.
   */
  async applyWaitingStateTransition(
    entityId: string,
    tenantId: string,
    before: { status_category: string; waiting_reason: string | null; sla_id: string | null },
    after: { status_category: string; waiting_reason: string | null; sla_id: string | null },
  ): Promise<void> {
    const slaPolicyId = after.sla_id ?? before.sla_id;
    if (!slaPolicyId) return;

    // Tenant-scoped lookup. supabase.admin bypasses RLS so a foreign-tenant
    // sla_id (somehow planted on a row) would otherwise resolve to the
    // wrong-tenant pause_on_waiting_reasons array. Pre-existing gap from the
    // case-side helper; widened to work_orders by the Slice 2 extraction.
    // Code-review finding C1.
    const { data: policy } = await this.supabase.admin
      .from('sla_policies')
      .select('pause_on_waiting_reasons')
      .eq('id', slaPolicyId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    const pauseReasons =
      ((policy as { pause_on_waiting_reasons: string[] | null } | null)?.pause_on_waiting_reasons) ?? [];
    const shouldPause = (state: { status_category: string; waiting_reason: string | null }) =>
      state.status_category === 'waiting' &&
      !!state.waiting_reason &&
      pauseReasons.includes(state.waiting_reason);

    const wasPaused = shouldPause(before);
    const isPaused = shouldPause(after);

    if (!wasPaused && isPaused) {
      await this.pauseTimers(entityId, tenantId);
    } else if (wasPaused && !isPaused) {
      await this.resumeTimers(entityId, tenantId);
    }
  }

  /**
   * Stop existing timers and start fresh ones from a new policy.
   * Used when a child ticket's sla_id is reassigned (parent cases keep SLA on reassign).
   * If `newSlaPolicyId` is null, only stops existing timers (effectively "switch to No SLA").
   */
  async restartTimers(ticketId: string, tenantId: string, newSlaPolicyId: string | null) {
    await this.completeTimers(ticketId, tenantId);

    // Clear ticket-level SLA computed fields. startTimers will re-set them if a policy is provided.
    await this.updateTicketOrWorkOrder(ticketId, {
      sla_response_due_at: null,
      sla_resolution_due_at: null,
      sla_response_breached_at: null,
      sla_resolution_breached_at: null,
      sla_at_risk: false,
      sla_paused: false,
      sla_paused_at: null,
    }, tenantId);

    if (newSlaPolicyId) {
      await this.startTimers(ticketId, tenantId, newSlaPolicyId);
    }
  }

  /**
   * Scheduled job: check for SLA breaches every minute.
   * Updates ticket computed fields for fast queue queries.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async checkBreaches() {
    const now = new Date();

    // Find timers that are past due and not yet breached
    const { data: breachedTimers } = await this.supabase.admin
      .from('sla_timers')
      .select('id, ticket_id, tenant_id, timer_type, due_at')
      .eq('breached', false)
      .eq('paused', false)
      .is('completed_at', null)
      .is('stopped_at', null)
      .lt('due_at', now.toISOString())
      .limit(100);

    if ((breachedTimers ?? []).length > 0) {
      const timers = breachedTimers!;
      const nowIso = now.toISOString();
      const timerIds = timers.map((t) => t.id as string);

      // The previous version issued N×3 round trips per cron tick; we then
      // flattened it to 4 parallel writes. Both shapes leave a window where
      // a partial failure (e.g. tickets update fails after sla_timers has
      // already been stamped) produces an inconsistent dataset: timers say
      // "breached" while the parent ticket carries no breach timestamp. The
      // RPC defined in 00135 commits all four writes in one transaction.
      const { error: rpcError } = await this.supabase.admin.rpc(
        'mark_sla_breached_batch',
        { p_timer_ids: timerIds, p_now: nowIso },
      );
      if (rpcError) {
        // Don't crash the cron tick — log and let the next tick retry. The
        // RPC is idempotent (filters on breached=false / *_breached_at IS
        // NULL) so a re-run is safe.
        console.error('[sla] mark_sla_breached_batch failed', rpcError);
      }
    }

    // Mark tickets as "at risk" when within 80% of their SLA
    const { data: atRiskTimers } = await this.supabase.admin
      .from('sla_timers')
      .select('id, ticket_id, tenant_id, started_at, due_at, target_minutes')
      .eq('breached', false)
      .eq('paused', false)
      .is('completed_at', null)
      .is('stopped_at', null)
      .gt('due_at', now.toISOString())
      .limit(200);

    // Cross-tenant bulk-write fix (codex post-fix review 2026-05-08): the
    // prior shape did `.in('id', atRiskTicketIds)` with no tenant filter,
    // so a corrupt sla_timers.ticket_id (e.g. an id colliding across
    // tenants) could flip another tenant's tickets/work_orders to
    // sla_at_risk=true. Group by tenant_id (carried on each timer row) and
    // run one update per tenant. tickets.sla_at_risk and
    // work_orders.sla_at_risk are independent rows so this is also more
    // honest about the boundary.
    const atRiskByTenant = new Map<string, Set<string>>();
    for (const timer of atRiskTimers ?? []) {
      const started = new Date(timer.started_at).getTime();
      const due = new Date(timer.due_at).getTime();
      const elapsed = now.getTime() - started;
      const total = due - started;
      const percentUsed = total > 0 ? elapsed / total : 0;
      if (percentUsed >= 0.8) {
        const tenantId = timer.tenant_id as string;
        const set = atRiskByTenant.get(tenantId) ?? new Set<string>();
        set.add(timer.ticket_id as string);
        atRiskByTenant.set(tenantId, set);
      }
    }
    if (atRiskByTenant.size > 0) {
      // Step 1c.10c: ids may live in tickets (cases) or work_orders. Issue
      // both updates per tenant; each is a no-op for ids not in that table.
      await Promise.all(
        Array.from(atRiskByTenant.entries()).flatMap(([tenantId, ids]) => {
          const idArr = Array.from(ids);
          return [
            this.supabase.admin
              .from('tickets')
              .update({ sla_at_risk: true })
              .eq('tenant_id', tenantId)
              .in('id', idArr)
              .eq('sla_at_risk', false),
            this.supabase.admin
              .from('work_orders')
              .update({ sla_at_risk: true })
              .eq('tenant_id', tenantId)
              .in('id', idArr)
              .eq('sla_at_risk', false),
          ];
        }),
      );
    }

    // Threshold-crossing pass — fires notify/escalate actions.
    await this.processThresholds(now);
  }

  /**
   * Get SLA status for a specific ticket.
   *
   * Tenant filter is mandatory: supabase.admin bypasses RLS, and pre-fix
   * the controller had NO visibility check + this method filtered by
   * ticket_id alone. Any authenticated user could read any ticket's
   * timers (cross-tenant + cross-actor leak). Controller now calls
   * assertVisible() before invoking this; the .eq('tenant_id', …) here
   * is the defense-in-depth at the data layer.
   */
  async getTicketSlaStatus(ticketId: string, tenantId: string) {
    const { data, error } = await this.supabase.admin
      .from('sla_timers')
      .select('*')
      .eq('ticket_id', ticketId)
      .eq('tenant_id', tenantId)
      .order('timer_type');

    if (error) throw error;
    return data;
  }

  /**
   * Resolve an escalation-threshold target to either a `persons.id` or a `teams.id`.
   * Returns null for `manager_of_requester` when the requester has no manager — the
   * caller should record a `skipped_no_manager` crossing and move on.
   *
   * tenantId is required: all three reads (tickets/work_orders/persons) hit
   * supabase.admin which bypasses RLS. Without the tenant filter, a row whose
   * id collides across tenants — or a smuggled FK — would resolve to the
   * wrong-tenant requester / manager. Caller (fireThreshold) has the tenant
   * id from timer.tenant_id.
   */
  private async resolveTarget(
    threshold: EscalationThreshold,
    ticketId: string,
    tenantId: string,
  ): Promise<{ personId?: string; teamId?: string } | null> {
    if (threshold.target_type === 'user' && threshold.target_id) {
      return { personId: threshold.target_id };
    }
    if (threshold.target_type === 'team' && threshold.target_id) {
      return { teamId: threshold.target_id };
    }
    if (threshold.target_type === 'manager_of_requester') {
      // Step 1c.10c: id may live in tickets (case) or work_orders.
      let requesterId: string | null = null;
      const caseRes = await this.supabase.admin
        .from('tickets')
        .select('requester_person_id')
        .eq('id', ticketId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      requesterId = (caseRes.data?.requester_person_id as string | null) ?? null;
      if (!requesterId) {
        const woRes = await this.supabase.admin
          .from('work_orders')
          .select('requester_person_id')
          .eq('id', ticketId)
          .eq('tenant_id', tenantId)
          .maybeSingle();
        requesterId = (woRes.data?.requester_person_id as string | null) ?? null;
      }
      if (!requesterId) return null;
      const { data: requester } = await this.supabase.admin
        .from('persons')
        .select('manager_person_id')
        .eq('id', requesterId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      const managerId = requester?.manager_person_id as string | null;
      if (!managerId) return null;
      return { personId: managerId };
    }
    return null;
  }

  private async loadTicketForFire(ticketId: string, tenantId: string) {
    // Step 1c.10c: id may live in tickets (case) or work_orders. Try
    // tickets first, fall back to work_orders.
    //
    // tenantId required: supabase.admin bypasses RLS; without the filter
    // a colliding/smuggled id from another tenant would feed the wrong
    // ticket title, assignee, and requester into the notification + the
    // reassignment write. Caller (fireThreshold) passes timer.tenant_id.
    const cols = 'id, tenant_id, title, assigned_user_id, assigned_team_id, requester_person_id, watchers';
    const caseRes = await this.supabase.admin
      .from('tickets')
      .select(cols)
      .eq('id', ticketId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (caseRes.data) {
      return {
        ...(caseRes.data as {
          id: string;
          tenant_id: string;
          title: string;
          assigned_user_id: string | null;
          assigned_team_id: string | null;
          requester_person_id: string | null;
          watchers: string[] | null;
        }),
        // audit02 Slice B: the resolved entity kind drives v3's
        // p_entity_kind (case ⇒ public.tickets, work_order ⇒
        // public.work_orders — 00416:229-241).
        kind: 'case' as const,
      };
    }
    const woRes = await this.supabase.admin
      .from('work_orders')
      .select(cols)
      .eq('id', ticketId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (woRes.error) throw woRes.error;
    if (!woRes.data) {
      throw AppErrors.server('sla.target_missing', {
        detail: `SLA target ${ticketId} not found in tickets or work_orders`,
      });
    }
    return {
      ...(woRes.data as {
        id: string;
        tenant_id: string;
        title: string;
        assigned_user_id: string | null;
        assigned_team_id: string | null;
        requester_person_id: string | null;
        watchers: string[] | null;
      }),
      kind: 'work_order' as const,
    };
  }

  private async loadPolicyName(policyId: string, tenantId: string): Promise<string> {
    // tenantId required: cosmetic notification name, but defense-in-depth.
    // supabase.admin bypasses RLS — a foreign sla_policies row with a
    // colliding id would otherwise leak its name into another tenant's
    // notification subject/body.
    const { data } = await this.supabase.admin
      .from('sla_policies')
      .select('name')
      .eq('id', policyId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    return (data?.name as string) ?? 'SLA policy';
  }

  private buildNotificationCopy(args: {
    ticketId: string;
    ticketTitle: string;
    atPercent: number;
    timerType: TimerType;
    policyName: string;
    actionVerb: 'Notified' | 'Escalated to';
    targetName: string;
    dueAt: string;
  }) {
    // There's no ticket.number column yet; short-id is the pragmatic display stand-in.
    const shortId = args.ticketId.slice(0, 8);
    const subject = `[Ticket ${shortId}] SLA ${args.timerType} at ${args.atPercent}%`;
    const body = `Ticket "${args.ticketTitle}" has reached ${args.atPercent}% of its ${args.timerType} SLA (${args.policyName}). ${args.actionVerb} ${args.targetName}. Target: ${args.dueAt}.`;
    return { subject, body };
  }

  private async resolveTargetName(
    resolved: { personId?: string; teamId?: string },
    tenantId: string,
  ): Promise<string> {
    // tenantId required: cosmetic notification name, but defense-in-depth.
    // Without the filter a colliding id from another tenant would leak the
    // foreign person/team name into this tenant's notification copy.
    if (resolved.personId) {
      const { data } = await this.supabase.admin
        .from('persons')
        .select('first_name, last_name')
        .eq('id', resolved.personId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!data) return 'person';
      return `${(data.first_name as string) ?? ''} ${(data.last_name as string) ?? ''}`.trim() || 'person';
    }
    if (resolved.teamId) {
      const { data } = await this.supabase.admin
        .from('teams')
        .select('name')
        .eq('id', resolved.teamId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      return (data?.name as string) ?? 'team';
    }
    return 'target';
  }

  /**
   * Resolve a `users.id` (the value stored in tickets/work_orders
   * `assigned_user_id`) back to its `persons.id` (the value stored in the
   * `watchers` uuid[]). D-A02-1: tickets.watchers / work_orders.watchers
   * are uuid[] whose elements are persons.id (00011_tickets.sql:26 — "person
   * IDs"). The outgoing assignee that "now watches" after an SLA escalation
   * is `assigned_user_id`, a users.id. set_entity_assignment v3's watcher
   * validator is persons-scoped (00416:310-322 — public.persons predicate)
   * and rejects a users.id. Pre-fix `applyReassignment` appended the raw
   * users.id into the watcher array — a type-wrong write that silently
   * corrupted the watcher set and would now be rejected by v3.
   *
   * tenantId required: supabase.admin bypasses RLS. The reverse of the
   * existing person_id→users.id lookup below (line 779-784) and the
   * auth_uid→person map at 00416:553-557 — symmetric, tenant-scoped (F18).
   */
  private async resolvePersonIdForUser(
    userId: string,
    tenantId: string,
  ): Promise<string | null> {
    const { data } = await this.supabase.admin
      .from('users')
      .select('person_id')
      .eq('id', userId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    return (data?.person_id as string | null) ?? null;
  }

  /**
   * Reassign ticket based on resolved target. Returns true if an assignment
   * actually changed.
   * For user/manager target: set assigned_user_id, keep assigned_team_id;
   *   move previous user to watchers.
   * For team target: set assigned_team_id, null assigned_user_id; move
   *   previous user to watchers.
   *
   * audit02 Slice B (P0-2): the assignment + watchers write goes through the
   * canonical `set_entity_assignment` v3 RPC (00416), NOT a raw
   * tickets/work_orders UPDATE. v3 commits the row UPDATE +
   * command_operations idempotency (keyed on the deterministic
   * `sla:escalation:<timer>:<pct>:<type>` key) + a routing_decisions audit
   * row (fires because `reason` is non-null) + ticket_activities + a
   * `ticket_assigned` domain event, all in one transaction. The
   * `command_operations` gate also makes a re-fired cron tick a safe no-op
   * replay for the assignment (the crossing unique constraint still governs
   * crossing/notification dedup — see fireThreshold docstring + R-A02-2).
   */
  private async applyReassignment(
    ticket: {
      id: string;
      tenant_id: string;
      assigned_user_id: string | null;
      assigned_team_id: string | null;
      watchers: string[] | null;
    },
    resolved: { personId?: string; teamId?: string },
    kind: 'case' | 'work_order',
    timer: { id: string; timer_type: TimerType },
    threshold: EscalationThreshold,
    policyName: string,
  ): Promise<boolean> {
    // audit02 CR2 / D-A02-4: caller-side command_operations success-probe
    // BEFORE recomputing the mutable payload. The SLA escalation reuses
    // the STABLE key `sla:escalation:<timer>:<pct>:<type>` but builds
    // p_payload from MUTABLE state (watchers — v3 internally dedups/orders
    // so a fresh client-side `Array.from(new Set(...))` differs from the
    // stored set; assignment/reason can drift from an intervening manual
    // reassign). The poison path: tick-1's RPC commits a
    // command_operations success row, then writeCrossing (or any step
    // after the RPC, before the crossing) crashes → NO crossing row. A
    // later tick re-enters here, recomputes a DRIFTED payload → same key +
    // different hash → `command_operations.payload_mismatch` (00419:200) →
    // throw BEFORE writeCrossing → the escalation is permanently poisoned
    // and R-A02-2's no-permanent-suppression is broken.
    //
    // If a `success` row already exists under the stable key, the
    // canonical assignment write ALREADY committed (idempotently, by a
    // prior tick whose post-RPC step failed). Short-circuit WITHOUT
    // recomputing the mutable payload or re-calling the RPC — return
    // `true` ("assignment already done", which is equivalent to a fresh
    // successful applyReassignment for the purpose of the downstream
    // crossing gate in fireThreshold). This restores R-A02-2: the stuck
    // escalation finally records its crossing + fires side-effects exactly
    // once.
    //
    // M-1 (CR2 code-review): this method's boolean return is now
    // TRI-SOURCE — `true` means "an assignment delta was applied this
    // tick" OR "an idempotent no-op replay" OR (here) "a prior tick's
    // RPC already committed under this key". All three are correct
    // "assignment is durable, proceed to the crossing gate" signals for
    // fireThreshold; do NOT 'simplify' this back to a pure changed flag.
    //
    // M-2 (CR2 code-review): `in_progress` is deliberately NOT a
    // short-circuit signal — another tick mid-flight holds the key. The
    // RPC's advisory-lock + payload-hash gate is the authoritative
    // WRITE-side guard; this probe is purely the READ side. Convergence
    // is across TICKS, not within the racing tick: a tick that races a
    // concurrent in_progress op and recomputes a drifted payload may
    // still throw `payload_mismatch` ONCE — the next cron tick then
    // probes the now-committed `success` row and completes. Bounded,
    // self-healing in ≤1 tick; never permanent (pre-CR2 it was permanent
    // because no tick ever short-circuited).
    const stableKey = buildSlaEscalationIdempotencyKey(
      timer.id,
      threshold.at_percent,
      timer.timer_type,
    );
    const committed = await probeCommandOperationSuccess(
      this.supabase,
      ticket.tenant_id,
      stableKey,
    );
    if (committed) {
      return true;
    }

    const assignment: Record<string, unknown> = {};
    let changed = false;
    const newWatchers = new Set<string>((ticket.watchers as string[] | null) ?? []);

    // D-A02-1: the outgoing assignee (a users.id) must be resolved to its
    // persons.id before being added to the watcher set — watchers are
    // persons-scoped and v3 rejects a users.id.
    const addOutgoingAssigneeAsWatcher = async () => {
      if (!ticket.assigned_user_id) return;
      const outgoingPersonId = await this.resolvePersonIdForUser(
        ticket.assigned_user_id,
        ticket.tenant_id,
      );
      if (outgoingPersonId) newWatchers.add(outgoingPersonId);
    };

    if (resolved.teamId) {
      if (ticket.assigned_team_id !== resolved.teamId) {
        assignment.assigned_team_id = resolved.teamId;
        assignment.assigned_user_id = null;
        await addOutgoingAssigneeAsWatcher();
        changed = true;
      }
    } else if (resolved.personId) {
      // tickets.assigned_user_id references users(id). resolved.personId is a
      // persons id; look up the user row.
      //
      // HIGH severity tenant-scope: this user lookup feeds a WRITE
      // (assigned_user_id on the case/work_order). Without the tenant
      // filter, a person_id colliding across tenants would resolve to a
      // foreign-tenant users row and assign that foreign user to this
      // tenant's ticket — cross-tenant ticket reassignment via SLA
      // escalation. supabase.admin bypasses RLS so id alone is unsafe.
      const { data: user } = await this.supabase.admin
        .from('users')
        .select('id, person_id')
        .eq('person_id', resolved.personId)
        .eq('tenant_id', ticket.tenant_id)
        .maybeSingle();
      const newAssigneeUserId = (user?.id as string) ?? null;
      if (newAssigneeUserId && ticket.assigned_user_id !== newAssigneeUserId) {
        assignment.assigned_user_id = newAssigneeUserId;
        await addOutgoingAssigneeAsWatcher();
        changed = true;
      }
    }

    if (changed) {
      const idempotencyKey = stableKey;
      const { error } = await this.supabase.admin.rpc('set_entity_assignment', {
        p_entity_id: ticket.id,
        p_entity_kind: kind,
        p_tenant_id: ticket.tenant_id,
        // System-driven: the SLA cron is the actor. Null lets v3's
        // actor_person resolve fall through cleanly (00416:550-558).
        p_actor_user_id: null,
        p_idempotency_key: idempotencyKey,
        p_payload: {
          ...assignment,
          actor_person_id: null,
          reason: `SLA escalation: ${policyName} at ${threshold.at_percent}% of ${timer.timer_type}`,
          watchers: Array.from(newWatchers),
        },
      });
      if (error) throw mapRpcErrorToAppError(error);
    }
    return changed;
  }

  /**
   * Insert the crossing row and report whether THIS call won the insert.
   *
   * R-A02-2 (audit02 CR1): the `sla_threshold_crossings` UNIQUE
   * (sla_timer_id, at_percent, timer_type) constraint (00043:16) is the
   * idempotency gate for the non-idempotent escalation side-effects
   * (writeActivity / notification / emitEvent). The caller only fires
   * those side-effects when this returns `true` (the row was inserted by
   * this tick). A `23505` is swallowed — another overlapping cron tick
   * already recorded this crossing — and reported as `false` (lost the
   * race; the winner already fired the side-effects). Still NEVER throws
   * on 23505 (a lost race is the expected outcome, not an error). Any
   * other DB error still throws.
   */
  private async writeCrossing(row: {
    tenant_id: string;
    sla_timer_id: string;
    ticket_id: string;
    at_percent: number;
    timer_type: TimerType;
    action: RecordedAction;
    target_type: ThresholdTargetType;
    target_id: string | null;
    notification_id: string | null;
  }): Promise<boolean> {
    const { error } = await this.supabase.admin
      .from('sla_threshold_crossings')
      .insert(row);
    if (!error) return true;
    // Lost the race — another cron tick beat us to the crossing insert.
    // 23505 is the expected outcome under overlapping ticks, not an error.
    if ((error as { code?: string }).code === '23505') return false;
    throw error;
  }

  private async writeActivity(
    ticket: { id: string; tenant_id: string },
    threshold: EscalationThreshold,
    policyName: string,
  ) {
    await this.supabase.admin.from('ticket_activities').insert({
      tenant_id: ticket.tenant_id,
      ticket_id: ticket.id,
      activity_type: 'system_event',
      visibility: 'system',
      content: `SLA escalated — ${policyName} at ${threshold.at_percent}% of ${threshold.timer_type}`,
      metadata: {
        source: 'sla_escalation',
        at_percent: threshold.at_percent,
        timer_type: threshold.timer_type,
        target_type: threshold.target_type,
      },
    });
  }

  private async emitEvent(
    tenantId: string,
    ticketId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ) {
    await this.supabase.admin.from('domain_events').insert({
      tenant_id: tenantId,
      event_type: eventType,
      entity_type: 'ticket',
      entity_id: ticketId,
      payload,
    });
  }

  /**
   * Fire a single threshold for a single timer. Reassigns the ticket via
   * the canonical `set_entity_assignment` v3 RPC (00416) for `escalate`,
   * then claims the `sla_threshold_crossings` row and — only if it won the
   * claim — writes the SLA activity breadcrumb, sends the escalation
   * notification, backfills the crossing's `notification_id`, and emits the
   * domain event.
   *
   * Write order: reassign (v3 RPC) → writeCrossing (claim) →
   * [if won] writeActivity → notify → UPDATE crossing.notification_id →
   * emitEvent.
   *
   * Idempotency boundary (audit02 CR1 — R-A02-2 CLOSED):
   *
   *   - **Assignment + watchers + audit write** (routing_decisions /
   *     ticket_activities / ticket_assigned event inside v3) is idempotent
   *     in Postgres via v3's `command_operations` gate, keyed on the
   *     deterministic `sla:escalation:<timer>:<pct>:<type>` key. EVERY
   *     overlapping tick may call the RPC; a re-fired tick replays the
   *     cached result — no double assignment, no duplicate audit/event
   *     rows. NOTE: the RPC return CANNOT be used to detect a replay — the
   *     cached `command_operations.cached_result` is returned verbatim
   *     (00418:217-218) and carries `noop:false` on BOTH a fresh write
   *     (00418:789) and a cached replay; only the F17 no-op early-return
   *     path (00418:511-524) returns `noop:true`. So `applyReassignment`'s
   *     `changed` (computed pre-RPC from a stale ticket read) is NOT a
   *     replay signal and is NOT used to gate the side-effects.
   *
   *   - **Non-idempotent human-facing side-effects** (`writeActivity`,
   *     `notifications.send`, `emitEvent`) are gated on winning the
   *     `sla_threshold_crossings` UNIQUE (sla_timer_id, at_percent,
   *     timer_type) insert (00043:16). `writeCrossing` runs AFTER the RPC
   *     succeeds and returns `won`; only the tick that inserted the
   *     crossing fires the side-effects. A losing tick: assignment already
   *     idempotently applied, crossing already recorded by the winner,
   *     side-effects already fired by the winner → it correctly does
   *     nothing further. No double notification, no duplicate activity.
   *
   *   - **No-permanent-suppression invariant.** `writeCrossing` is called
   *     STRICTLY AFTER `applyReassignment` succeeds. If the RPC throws,
   *     `fireThreshold` throws BEFORE any crossing is written → a later
   *     tick retries cleanly (no crossing ⇒ not suppressed). The crossing
   *     is never written before the assignment is durable.
   *
   *   - **Best-effort post-crossing side-effects.** Once the crossing is
   *     won, the durable state (assignment + crossing) is committed. The
   *     activity / notification / event side-effects are best-effort: a
   *     failure there is caught + logged and does NOT throw out of
   *     `fireThreshold` — a thrown notify failure would trigger a retry
   *     that the now-recorded crossing would (correctly) suppress, leaking
   *     a "no notification ever sent, no retry possible" hole. Logging only,
   *     no rollback (nothing to roll back; the durable writes already
   *     committed). Matches the project's `console.error('[sla] …')` idiom.
   */
  private async fireThreshold(
    timer: SlaTimerRow,
    threshold: EscalationThreshold,
  ): Promise<void> {
    const ticket = await this.loadTicketForFire(timer.ticket_id, timer.tenant_id);
    const policyName = await this.loadPolicyName(timer.sla_policy_id, timer.tenant_id);
    const resolved = await this.resolveTarget(threshold, ticket.id, timer.tenant_id);

    // Skip path — claim a crossing so we don't retry forever. The
    // crossing-winner gates the (best-effort) skip event so two
    // overlapping ticks don't double-emit it.
    if (!resolved) {
      const wonSkip = await this.writeCrossing({
        tenant_id: ticket.tenant_id,
        sla_timer_id: timer.id,
        ticket_id: ticket.id,
        at_percent: threshold.at_percent,
        timer_type: timer.timer_type,
        action: 'skipped_no_manager',
        target_type: threshold.target_type,
        target_id: null,
        notification_id: null,
      });
      if (wonSkip) {
        await this.bestEffortSideEffect('skip-emitEvent', timer, () =>
          this.emitEvent(ticket.tenant_id, ticket.id, 'sla_threshold_crossed', {
            timer_type: timer.timer_type,
            at_percent: threshold.at_percent,
            action: 'skipped_no_manager',
            target_type: threshold.target_type,
          }),
        );
      }
      return;
    }

    const targetName = await this.resolveTargetName(resolved, timer.tenant_id);
    const { subject, body } = this.buildNotificationCopy({
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      atPercent: threshold.at_percent,
      timerType: timer.timer_type,
      policyName,
      actionVerb: threshold.action === 'escalate' ? 'Escalated to' : 'Notified',
      targetName,
      dueAt: timer.due_at,
    });

    // 1. Assignment write (idempotent via v3 command_operations). EVERY
    //    overlapping tick may call this; a replay is a safe no-op. The
    //    `reassigned` flag (computed pre-RPC inside applyReassignment from
    //    a stale ticket read) is NOT a replay signal — it only decides
    //    whether an actual assignment delta happened, which gates the SLA
    //    breadcrumb's semantics (escalate-that-changed-assignee). If the
    //    RPC throws, this throws BEFORE any crossing is written → a later
    //    tick retries cleanly (no-permanent-suppression invariant).
    let reassigned = false;
    if (threshold.action === 'escalate') {
      reassigned = await this.applyReassignment(
        ticket,
        resolved,
        ticket.kind,
        { id: timer.id, timer_type: timer.timer_type },
        threshold,
        policyName,
      );
    }

    // 2. Claim the crossing. STRICTLY AFTER the durable assignment write.
    //    The UNIQUE (sla_timer_id, at_percent, timer_type) constraint
    //    (00043:16) makes this the single idempotency gate for the
    //    non-idempotent human-facing side-effects below.
    const won = await this.writeCrossing({
      tenant_id: ticket.tenant_id,
      sla_timer_id: timer.id,
      ticket_id: ticket.id,
      at_percent: threshold.at_percent,
      timer_type: timer.timer_type,
      action: threshold.action,
      target_type: threshold.target_type,
      target_id: resolved.personId ?? resolved.teamId ?? null,
      // Backfilled by the winner after the notification is sent (below).
      notification_id: null,
    });

    // 3. Only the crossing-winner fires the non-idempotent side-effects.
    //    A losing tick: assignment already idempotently applied, crossing
    //    already recorded by the winner, side-effects already fired by the
    //    winner → nothing further to do. All side-effects are best-effort:
    //    the durable state (assignment + crossing) is committed, so a
    //    failure here must NOT throw (a thrown failure → retry → now
    //    suppressed by the crossing → permanent side-effect hole).
    if (!won) return;

    if (threshold.action === 'escalate' && reassigned) {
      await this.bestEffortSideEffect('writeActivity', timer, () =>
        this.writeActivity(ticket, threshold, policyName),
      );
    }

    const notifyArgs = {
      notification_type: 'sla_threshold_crossed',
      related_entity_type: 'ticket',
      related_entity_id: ticket.id,
      subject,
      body,
    };
    const firstNotificationId = await this.bestEffortSideEffect(
      'notify',
      timer,
      async () => {
        if (resolved.teamId) {
          const sent = await this.notifications.sendToTeam(resolved.teamId, notifyArgs);
          return ((sent?.[0] as { id?: string } | undefined)?.id) ?? null;
        }
        if (resolved.personId) {
          const sent = await this.notifications.send({
            ...notifyArgs,
            recipient_person_id: resolved.personId,
          });
          return ((sent?.[0] as { id?: string } | undefined)?.id) ?? null;
        }
        return null;
      },
    );

    // Backfill the winner's notification_id onto the crossing row it
    // claimed. notification_id is informational only (read by
    // listCrossingsForTicket for the ticket-detail escalations panel —
    // sla.service.ts:1315; no FK-driven logic), so a best-effort follow-up
    // UPDATE is sufficient and a miss leaves it null without affecting
    // dedup correctness.
    if (firstNotificationId) {
      await this.bestEffortSideEffect('crossing-notification-id', timer, async () => {
        await this.supabase.admin
          .from('sla_threshold_crossings')
          .update({ notification_id: firstNotificationId })
          .eq('tenant_id', ticket.tenant_id)
          .eq('sla_timer_id', timer.id)
          .eq('at_percent', threshold.at_percent)
          .eq('timer_type', timer.timer_type);
      });
    }

    await this.bestEffortSideEffect('emitEvent', timer, () =>
      this.emitEvent(ticket.tenant_id, ticket.id, 'sla_threshold_crossed', {
        timer_type: timer.timer_type,
        at_percent: threshold.at_percent,
        action: threshold.action,
        target_type: threshold.target_type,
        target_id: resolved.personId ?? resolved.teamId,
        reassigned,
      }),
    );
  }

  /**
   * Run a post-crossing side-effect best-effort: on failure log + swallow,
   * never rethrow. R-A02-2: once the crossing is won the durable state
   * (assignment + crossing) is already committed; a thrown side-effect
   * failure would trigger a cron retry that the recorded crossing would
   * (correctly) suppress — leaking a permanent "side-effect never ran, no
   * retry possible" hole. Logging-only is the right failure mode. Matches
   * the project's `console.error('[sla] …')` idiom (sla.service.ts:499);
   * the sla module is gated by `errors:check-app-errors` so no raw
   * `throw new Error` is introduced here.
   */
  private async bestEffortSideEffect<T>(
    label: string,
    timer: { id: string; tenant_id: string; ticket_id: string },
    fn: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      console.error(
        `[sla] post-crossing side-effect '${label}' failed (best-effort; durable state stands)`,
        {
          timer_id: timer.id,
          tenant_id: timer.tenant_id,
          ticket_id: timer.ticket_id,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return null;
    }
  }

  /**
   * Threshold pass — runs after breach + at-risk detection in the minute cron.
   * Bounded to 500 active timers per tick to protect the cron; overflow picks up next tick.
   */
  private async processThresholds(now: Date) {
    const { data: timers } = await this.supabase.admin
      .from('sla_timers')
      .select('id, tenant_id, ticket_id, sla_policy_id, timer_type, target_minutes, started_at, due_at, total_paused_minutes')
      .eq('breached', false)
      .eq('paused', false)
      .is('completed_at', null)
      .is('stopped_at', null)
      .order('due_at', { ascending: true })
      .limit(500);

    const timerRows = (timers ?? []) as SlaTimerRow[];
    if (timerRows.length === 0) return;

    // Load distinct policies used by this batch, grouped by tenant. Pre-fix
    // this issued a single .in('id', policyIds) across tenants — supabase.admin
    // bypasses RLS, so a smuggled cross-tenant sla_policy_id on a timer would
    // resolve to the foreign tenant's escalation_thresholds and fire the
    // wrong-tenant escalations. Defense-in-depth: tenant filter on the read.
    // Key the result map by `${policyId}|${tenantId}` so the lookup at the
    // call site can't accidentally hit a different tenant's policy.
    const policyIdsByTenant = new Map<string, Set<string>>();
    for (const t of timerRows) {
      let set = policyIdsByTenant.get(t.tenant_id);
      if (!set) {
        set = new Set<string>();
        policyIdsByTenant.set(t.tenant_id, set);
      }
      set.add(t.sla_policy_id);
    }
    const thresholdsByPolicy = new Map<string, EscalationThreshold[]>();
    for (const [tenantId, ids] of policyIdsByTenant) {
      const { data: policies } = await this.supabase.admin
        .from('sla_policies')
        .select('id, escalation_thresholds')
        .eq('tenant_id', tenantId)
        .in('id', Array.from(ids));
      for (const p of policies ?? []) {
        const raw = (p.escalation_thresholds as EscalationThreshold[] | null) ?? [];
        thresholdsByPolicy.set(`${p.id as string}|${tenantId}`, raw);
      }
    }

    // Load existing crossings for this batch in one query.
    const timerIds = timerRows.map((t) => t.id);
    const { data: crossings } = await this.supabase.admin
      .from('sla_threshold_crossings')
      .select('sla_timer_id, at_percent, timer_type')
      .in('sla_timer_id', timerIds);
    const firedKeys = new Set<string>(
      (crossings ?? []).map((c) =>
        crossingKey({
          sla_timer_id: c.sla_timer_id as string,
          at_percent: c.at_percent as number,
          timer_type: c.timer_type as TimerType,
        }),
      ),
    );

    for (const timer of timerRows) {
      try {
        const thresholds = thresholdsByPolicy.get(`${timer.sla_policy_id}|${timer.tenant_id}`) ?? [];
        if (thresholds.length === 0) continue;
        const percent = percentElapsed(timer, now);
        const applicable = selectApplicableThresholds({
          percent,
          timerType: timer.timer_type,
          timerId: timer.id,
          thresholds,
          firedKeys,
        });
        // Fire in ascending percent order so "80 notify" always precedes "100 escalate".
        applicable.sort((a, b) => a.at_percent - b.at_percent);
        for (const threshold of applicable) {
          await this.fireThreshold(timer, threshold);
          // Track in-memory so a single tick doesn't try to fire the same key twice
          // across iterations (e.g. across `both`-scoped thresholds).
          firedKeys.add(
            crossingKey({
              sla_timer_id: timer.id,
              at_percent: threshold.at_percent,
              timer_type: timer.timer_type,
            }),
          );
        }
      } catch (err) {
        await this.emitEvent(timer.tenant_id, timer.ticket_id, 'sla_threshold_fire_failed', {
          timer_id: timer.id,
          error: err instanceof Error ? err.message : String(err),
        });
        // Keep going — one bad ticket does not starve the batch.
      }
    }
  }

  /**
   * List threshold crossings for a ticket, ordered newest first, with the target's
   * resolved display name joined in. Intended for the ticket-detail escalations panel.
   *
   * tenantId required (defense-in-depth): controller gates with
   * assertVisible() before calling, but supabase.admin bypasses RLS — without
   * the tenant filter, three reads (sla_threshold_crossings + persons + teams
   * by id) would otherwise resolve cross-tenant rows on a smuggled or
   * colliding id.
   */
  async listCrossingsForTicket(ticketId: string, tenantId: string) {
    const { data: rows, error } = await this.supabase.admin
      .from('sla_threshold_crossings')
      .select('id, fired_at, timer_type, at_percent, action, target_type, target_id, notification_id')
      .eq('ticket_id', ticketId)
      .eq('tenant_id', tenantId)
      .order('fired_at', { ascending: false });
    if (error) throw error;

    // Resolve target display names in two batched lookups (persons + teams).
    const personIds = (rows ?? [])
      .filter((r) => r.target_type === 'user' || r.target_type === 'manager_of_requester')
      .map((r) => r.target_id)
      .filter((x): x is string => !!x);
    const teamIds = (rows ?? [])
      .filter((r) => r.target_type === 'team')
      .map((r) => r.target_id)
      .filter((x): x is string => !!x);

    const personNames = new Map<string, string>();
    if (personIds.length > 0) {
      const { data } = await this.supabase.admin
        .from('persons')
        .select('id, first_name, last_name')
        .eq('tenant_id', tenantId)
        .in('id', personIds);
      for (const p of data ?? []) {
        const name = `${(p.first_name as string) ?? ''} ${(p.last_name as string) ?? ''}`.trim() || 'person';
        personNames.set(p.id as string, name);
      }
    }
    const teamNames = new Map<string, string>();
    if (teamIds.length > 0) {
      const { data } = await this.supabase.admin
        .from('teams')
        .select('id, name')
        .eq('tenant_id', tenantId)
        .in('id', teamIds);
      for (const t of data ?? []) teamNames.set(t.id as string, (t.name as string) ?? 'team');
    }

    return (rows ?? []).map((r) => ({
      ...r,
      target_name: r.target_id
        ? (r.target_type === 'team' ? teamNames.get(r.target_id as string) : personNames.get(r.target_id as string)) ?? null
        : null,
    }));
  }
}
