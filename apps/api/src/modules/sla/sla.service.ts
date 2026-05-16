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
    //
    // audit-02 P0-2: this lookup is the SINGLE place SLA resolves whether
    // an id is a case or a work_order. The resolved `entity_kind` is
    // returned alongside the row so the escalation-reassign path can pass
    // the correct `p_entity_kind` to `set_entity_assignment` /
    // `update_entity_combined` (00327 / 00384) without a second
    // existence probe — entity-kind is resolved ONCE here, by the query
    // that already had to run.
    const cols = 'id, tenant_id, title, assigned_user_id, assigned_team_id, requester_person_id, watchers';
    const caseRes = await this.supabase.admin
      .from('tickets')
      .select(cols)
      .eq('id', ticketId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (caseRes.error) throw caseRes.error;
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
        entity_kind: 'case' as const,
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
      entity_kind: 'work_order' as const,
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
   * Reassign ticket based on resolved target. Returns true if an assignment
   * actually changed.
   *
   * For user/manager target: set assigned_user_id, keep assigned_team_id;
   * move previous assignee into watchers.
   * For team target: set assigned_team_id, null assigned_user_id; move
   * previous assignee into watchers.
   *
   * ── audit-02 P0-2 (2026-05-16) ──────────────────────────────────────
   * This path NO LONGER raw-UPDATEs via `updateTicketOrWorkOrder`. The
   * assignment write goes through the canonical `set_entity_assignment`
   * RPC (00327 v2) and the watchers (metadata) write through
   * `update_entity_combined` (00384 v6). Each RPC is independently
   * idempotent via `command_operations` keyed on a deterministic
   * per-crossing key — a re-fired cron tick for the SAME crossing
   * replays the cached result instead of re-applying. The RPCs emit the
   * `routing_decisions` audit row + `reassigned` ticket_activities row +
   * `ticket_assigned` domain event (assignment) and a `metadata_changed`
   * activity (watchers) — all the audit/event guarantees the raw write
   * silently skipped.
   *
   * `crossingIdemKey` is the stable per-crossing anchor built by the
   * caller from `sla:escalation:<timer_id>:<at_percent>` (a single timer
   * can cross 80% then 100%; each crossing is its own canonical event).
   */
  private async applyReassignment(
    ticket: {
      id: string;
      tenant_id: string;
      assigned_user_id: string | null;
      assigned_team_id: string | null;
      watchers: string[] | null;
      entity_kind: 'case' | 'work_order';
    },
    resolved: { personId?: string; teamId?: string },
    crossingIdemKey: string,
    reason: string,
  ): Promise<boolean> {
    const assignmentPayload: Record<string, unknown> = {
      reason,
      // System/cron actor — no person attribution. set_entity_assignment
      // (00327:291-299) falls back cleanly when both actor_person_id and
      // p_actor_user_id are null.
      actor_person_id: null,
    };
    let changed = false;

    // `watchers` is a persons.id[] column ("person IDs following this
    // ticket" — 00011_tickets.sql:26). The PREVIOUS assignee is
    // `ticket.assigned_user_id`, a users.id — NOT a person id. The legacy
    // raw write added the users.id directly, which the unvalidated UPDATE
    // silently accepted (a latent data bug: user IDs in a person-ID
    // column). `update_entity_combined` v6 (00384:633-645) validates the
    // watchers array against `persons`, so we must translate the outgoing
    // assignee's users.id → persons.id before adding it to watchers.
    let outgoingAssigneePersonId: string | null = null;

    if (resolved.teamId) {
      if (ticket.assigned_team_id !== resolved.teamId) {
        assignmentPayload.assigned_team_id = resolved.teamId;
        // set_entity_assignment treats an absent key as "no change"; pass
        // an explicit empty string so the RPC clears assigned_user_id
        // (00327:189 nullif('','')::uuid → NULL), matching the legacy
        // "team target nulls the user" behaviour.
        assignmentPayload.assigned_user_id = '';
        if (ticket.assigned_user_id) {
          outgoingAssigneePersonId = await this.resolveUserPersonId(
            ticket.assigned_user_id,
            ticket.tenant_id,
          );
        }
        changed = true;
      }
    } else if (resolved.personId) {
      // tickets.assigned_user_id references users(id). resolved.personId
      // is a persons id; look up the user row.
      //
      // HIGH severity tenant-scope: this user lookup feeds a WRITE
      // (assigned_user_id on the case/work_order). Without the tenant
      // filter, a person_id colliding across tenants would resolve to a
      // foreign-tenant users row and assign that foreign user to this
      // tenant's ticket — cross-tenant ticket reassignment via SLA
      // escalation. supabase.admin bypasses RLS so id alone is unsafe.
      // (set_entity_assignment also re-validates the assignee is
      // tenant-owned via validate_assignees_in_tenant — 00327:194 — so
      // this is defence-in-depth, not the sole gate.)
      const { data: user, error: userErr } = await this.supabase.admin
        .from('users')
        .select('id, person_id')
        .eq('person_id', resolved.personId)
        .eq('tenant_id', ticket.tenant_id)
        .maybeSingle();
      if (userErr) throw userErr;
      const newAssigneeUserId = (user?.id as string) ?? null;
      if (newAssigneeUserId && ticket.assigned_user_id !== newAssigneeUserId) {
        assignmentPayload.assigned_user_id = newAssigneeUserId;
        if (ticket.assigned_user_id) {
          outgoingAssigneePersonId = await this.resolveUserPersonId(
            ticket.assigned_user_id,
            ticket.tenant_id,
          );
        }
        changed = true;
      }
    }

    if (!changed) return false;

    // ── 1. Assignment via the canonical RPC (idempotent per crossing) ──
    const { error: assignErr } = await this.supabase.admin.rpc(
      'set_entity_assignment',
      {
        p_entity_id: ticket.id,
        p_entity_kind: ticket.entity_kind,
        p_tenant_id: ticket.tenant_id,
        p_actor_user_id: null,
        p_idempotency_key: crossingIdemKey,
        p_payload: assignmentPayload,
      },
    );
    if (assignErr) throw mapRpcErrorToAppError(assignErr);

    // ── 2. Watchers via update_entity_combined metadata (idempotent) ──
    // Only call when the watchers set actually changed (a no-op call is
    // wasteful and would still consume a command_operations row). The
    // outgoing assignee is added by persons.id; if it was already a
    // watcher or could not be resolved to a person, the set is unchanged
    // and the second RPC is skipped.
    if (
      outgoingAssigneePersonId &&
      !(ticket.watchers ?? []).includes(outgoingAssigneePersonId)
    ) {
      const newWatchers = Array.from(
        new Set<string>([
          ...((ticket.watchers as string[] | null) ?? []),
          outgoingAssigneePersonId,
        ]),
      );
      const { error: watchErr } = await this.supabase.admin.rpc(
        'update_entity_combined',
        {
          p_entity_kind: ticket.entity_kind,
          p_entity_id: ticket.id,
          p_tenant_id: ticket.tenant_id,
          p_actor_user_id: null,
          p_idempotency_key: `${crossingIdemKey}:watchers`,
          p_patches: { metadata: { watchers: newWatchers } },
        },
      );
      if (watchErr) throw mapRpcErrorToAppError(watchErr);
    }

    return changed;
  }

  /**
   * Resolve a users.id → its persons.id for this tenant. Used by the SLA
   * escalation path to translate the outgoing assignee (users.id) into a
   * watcher entry (persons.id — see applyReassignment). Tenant-scoped:
   * supabase.admin bypasses RLS, so a colliding users.id from another
   * tenant must not leak a foreign person into this tenant's watchers.
   */
  private async resolveUserPersonId(
    userId: string,
    tenantId: string,
  ): Promise<string | null> {
    const { data, error } = await this.supabase.admin
      .from('users')
      .select('person_id')
      .eq('id', userId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw error;
    return (data?.person_id as string | null) ?? null;
  }

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
  }) {
    const { error } = await this.supabase.admin
      .from('sla_threshold_crossings')
      .insert(row);
    // Ignore unique_violation (23505) — another cron tick beat us to it.
    if (error && (error as { code?: string }).code !== '23505') throw error;
  }

  // audit-02 P0-2 (2026-05-16): `writeActivity` was DELETED here. It
  // wrote a `system_event` "SLA escalated — <policy> at X% of <timer>"
  // ticket_activities row, called only from the escalate+reassigned
  // branch of `fireThreshold`. `set_entity_assignment` (00327 v2) now
  // writes the canonical `reassigned` ticket_activities row for the same
  // logical event (content = the SLA-escalation reason), so the old call
  // produced a DUPLICATE timeline entry. With its sole caller removed the
  // method was dead code; deleting it (rather than suppressing the
  // unused-symbol error) enforces the single-write-path contract
  // structurally — same precedent as docs/follow-ups/b2-followups.md:172.

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
   * Fire a single threshold for a single timer. Writes a crossing row (idempotency
   * anchor), sends notifications, and — for `escalate` — reassigns the ticket.
   * Swallows `23505` (unique_violation) so racing cron ticks are safe.
   *
   * Not atomic. Write order: reassign → activity → notify → crossing → event.
   * If the crossing insert fails after a notification has been sent, the next tick
   * will retry the whole path and may duplicate the notification. `applyReassignment`
   * is no-op on retry (already-matching state returns changed=false), so the activity
   * entry is not re-written. The duplication window is rare and the alternative
   * (distributed transactions across Supabase) is not justified at this scale.
   */
  private async fireThreshold(
    timer: SlaTimerRow,
    threshold: EscalationThreshold,
  ): Promise<void> {
    const ticket = await this.loadTicketForFire(timer.ticket_id, timer.tenant_id);
    const policyName = await this.loadPolicyName(timer.sla_policy_id, timer.tenant_id);
    const resolved = await this.resolveTarget(threshold, ticket.id, timer.tenant_id);

    // Skip path — record a crossing so we don't retry forever.
    if (!resolved) {
      await this.writeCrossing({
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
      await this.emitEvent(ticket.tenant_id, ticket.id, 'sla_threshold_crossed', {
        timer_type: timer.timer_type,
        at_percent: threshold.at_percent,
        action: 'skipped_no_manager',
        target_type: threshold.target_type,
      });
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

    let reassigned = false;
    if (threshold.action === 'escalate') {
      // audit-02 P0-2: deterministic per-crossing idempotency anchor. A
      // timer can cross 80% then 100%; `at_percent` makes each crossing
      // its own idempotent event, and a re-fired cron tick for the SAME
      // crossing replays the cached command_operations result instead of
      // re-applying the assignment.
      const crossingIdemKey = `sla:escalation:${timer.id}:${threshold.at_percent}`;
      // Non-null reason → set_entity_assignment writes the
      // routing_decisions audit row + `reassigned` ticket_activities row
      // + `ticket_assigned` domain event (00327:258-410). No prose leak:
      // this is an internal routing-audit string, not a user-facing
      // error message.
      const reason = `SLA escalation — ${threshold.at_percent}% threshold breached`;
      reassigned = await this.applyReassignment(
        ticket,
        resolved,
        crossingIdemKey,
        reason,
      );
      // NOTE: no `writeActivity` call here anymore. Pre-P0-2 this wrote a
      // second `system_event` "SLA escalated …" ticket_activities row.
      // `set_entity_assignment` now writes the canonical `reassigned`
      // activity row for the SAME logical event (with the SLA-escalation
      // reason as its content) — keeping the old call would produce a
      // duplicate timeline entry for one reassignment. `writeActivity`
      // is retained as a method (no other caller today) but is not
      // invoked on the escalate+reassigned path.
    }

    let firstNotificationId: string | null = null;
    const notifyArgs = {
      notification_type: 'sla_threshold_crossed',
      related_entity_type: 'ticket',
      related_entity_id: ticket.id,
      subject,
      body,
    };
    if (resolved.teamId) {
      const sent = await this.notifications.sendToTeam(resolved.teamId, notifyArgs);
      firstNotificationId = ((sent?.[0] as { id?: string } | undefined)?.id) ?? null;
    } else if (resolved.personId) {
      const sent = await this.notifications.send({ ...notifyArgs, recipient_person_id: resolved.personId });
      firstNotificationId = ((sent?.[0] as { id?: string } | undefined)?.id) ?? null;
    }

    await this.writeCrossing({
      tenant_id: ticket.tenant_id,
      sla_timer_id: timer.id,
      ticket_id: ticket.id,
      at_percent: threshold.at_percent,
      timer_type: timer.timer_type,
      action: threshold.action,
      target_type: threshold.target_type,
      target_id: resolved.personId ?? resolved.teamId ?? null,
      notification_id: firstNotificationId,
    });

    await this.emitEvent(ticket.tenant_id, ticket.id, 'sla_threshold_crossed', {
      timer_type: timer.timer_type,
      at_percent: threshold.at_percent,
      action: threshold.action,
      target_type: threshold.target_type,
      target_id: resolved.personId ?? resolved.teamId,
      reassigned,
    });
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
