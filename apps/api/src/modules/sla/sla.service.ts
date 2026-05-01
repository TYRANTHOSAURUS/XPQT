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
    const { data: caseHit } = await q1.select('id').maybeSingle();
    if (caseHit) return;

    let q2 = this.supabase.admin.from('work_orders').update(patch).eq('id', id);
    if (tenantId) q2 = q2.eq('tenant_id', tenantId);
    // Step 1c.10c: detect "id in neither" rather than silently succeeding —
    // hides stale timer/crossing references otherwise. Use .select('id') so
    // we can count affected rows.
    const { data: woHit, error } = await q2.select('id').maybeSingle();
    if (error) throw error;
    if (!woHit) {
      throw new Error(
        `updateTicketOrWorkOrder: id ${id} not found in tickets or work_orders`,
      );
    }
  }

  /**
   * Start SLA timers when a ticket is created.
   * Called by the ticket service after ticket creation.
   */
  async startTimers(ticketId: string, tenantId: string, slaPolicyId: string) {
    const { data: policy, error: policyError } = await this.supabase.admin
      .from('sla_policies')
      .select('*')
      .eq('id', slaPolicyId)
      .single();

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
      });
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
      });
    }

    if (timers.length > 0) {
      await this.supabase.admin.from('sla_timers').insert(timers);
    }
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
    });
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

    await this.updateTicketOrWorkOrder(ticketId, updates);
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
    });

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
      .select('id, ticket_id, started_at, due_at, target_minutes')
      .eq('breached', false)
      .eq('paused', false)
      .is('completed_at', null)
      .is('stopped_at', null)
      .gt('due_at', now.toISOString())
      .limit(200);

    const atRiskTicketIds: string[] = [];
    for (const timer of atRiskTimers ?? []) {
      const started = new Date(timer.started_at).getTime();
      const due = new Date(timer.due_at).getTime();
      const elapsed = now.getTime() - started;
      const total = due - started;
      const percentUsed = total > 0 ? elapsed / total : 0;
      if (percentUsed >= 0.8) atRiskTicketIds.push(timer.ticket_id as string);
    }
    if (atRiskTicketIds.length > 0) {
      // Step 1c.10c: ids may live in tickets (cases) or work_orders. Issue
      // both updates; each is a no-op for ids not in that table.
      await Promise.all([
        this.supabase.admin
          .from('tickets')
          .update({ sla_at_risk: true })
          .in('id', atRiskTicketIds)
          .eq('sla_at_risk', false),
        this.supabase.admin
          .from('work_orders')
          .update({ sla_at_risk: true })
          .in('id', atRiskTicketIds)
          .eq('sla_at_risk', false),
      ]);
    }

    // Threshold-crossing pass — fires notify/escalate actions.
    await this.processThresholds(now);
  }

  /**
   * Get SLA status for a specific ticket.
   */
  async getTicketSlaStatus(ticketId: string) {
    const { data, error } = await this.supabase.admin
      .from('sla_timers')
      .select('*')
      .eq('ticket_id', ticketId)
      .order('timer_type');

    if (error) throw error;
    return data;
  }

  /**
   * Resolve an escalation-threshold target to either a `persons.id` or a `teams.id`.
   * Returns null for `manager_of_requester` when the requester has no manager — the
   * caller should record a `skipped_no_manager` crossing and move on.
   */
  private async resolveTarget(
    threshold: EscalationThreshold,
    ticketId: string,
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
        .maybeSingle();
      requesterId = (caseRes.data?.requester_person_id as string | null) ?? null;
      if (!requesterId) {
        const woRes = await this.supabase.admin
          .from('work_orders')
          .select('requester_person_id')
          .eq('id', ticketId)
          .maybeSingle();
        requesterId = (woRes.data?.requester_person_id as string | null) ?? null;
      }
      if (!requesterId) return null;
      const { data: requester } = await this.supabase.admin
        .from('persons')
        .select('manager_person_id')
        .eq('id', requesterId)
        .single();
      const managerId = requester?.manager_person_id as string | null;
      if (!managerId) return null;
      return { personId: managerId };
    }
    return null;
  }

  private async loadTicketForFire(ticketId: string) {
    // Step 1c.10c: id may live in tickets (case) or work_orders. Try
    // tickets first, fall back to work_orders.
    const cols = 'id, tenant_id, title, assigned_user_id, assigned_team_id, requester_person_id, watchers';
    const caseRes = await this.supabase.admin
      .from('tickets')
      .select(cols)
      .eq('id', ticketId)
      .maybeSingle();
    if (caseRes.data) {
      return caseRes.data as {
        id: string;
        tenant_id: string;
        title: string;
        assigned_user_id: string | null;
        assigned_team_id: string | null;
        requester_person_id: string | null;
        watchers: string[] | null;
      };
    }
    const woRes = await this.supabase.admin
      .from('work_orders')
      .select(cols)
      .eq('id', ticketId)
      .single();
    if (woRes.error) throw woRes.error;
    return woRes.data as {
      id: string;
      tenant_id: string;
      title: string;
      assigned_user_id: string | null;
      assigned_team_id: string | null;
      requester_person_id: string | null;
      watchers: string[] | null;
    };
  }

  private async loadPolicyName(policyId: string): Promise<string> {
    const { data } = await this.supabase.admin
      .from('sla_policies')
      .select('name')
      .eq('id', policyId)
      .single();
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

  private async resolveTargetName(resolved: { personId?: string; teamId?: string }): Promise<string> {
    if (resolved.personId) {
      const { data } = await this.supabase.admin
        .from('persons')
        .select('first_name, last_name')
        .eq('id', resolved.personId)
        .single();
      if (!data) return 'person';
      return `${(data.first_name as string) ?? ''} ${(data.last_name as string) ?? ''}`.trim() || 'person';
    }
    if (resolved.teamId) {
      const { data } = await this.supabase.admin
        .from('teams')
        .select('name')
        .eq('id', resolved.teamId)
        .single();
      return (data?.name as string) ?? 'team';
    }
    return 'target';
  }

  /**
   * Reassign ticket based on resolved target. Returns true if an assignment actually changed.
   * For user/manager target: set assigned_user_id, keep assigned_team_id; move previous user to watchers.
   * For team target: set assigned_team_id, null assigned_user_id; move previous user to watchers.
   */
  private async applyReassignment(
    ticket: { id: string; tenant_id: string; assigned_user_id: string | null; assigned_team_id: string | null; watchers: string[] | null },
    resolved: { personId?: string; teamId?: string },
  ): Promise<boolean> {
    const updates: Record<string, unknown> = {};
    let changed = false;
    const newWatchers = new Set<string>((ticket.watchers as string[] | null) ?? []);

    if (resolved.teamId) {
      if (ticket.assigned_team_id !== resolved.teamId) {
        updates.assigned_team_id = resolved.teamId;
        updates.assigned_user_id = null;
        if (ticket.assigned_user_id) newWatchers.add(ticket.assigned_user_id);
        changed = true;
      }
    } else if (resolved.personId) {
      // tickets.assigned_user_id references users(id). resolved.personId is a persons id;
      // look up the user row.
      const { data: user } = await this.supabase.admin
        .from('users')
        .select('id, person_id')
        .eq('person_id', resolved.personId)
        .single();
      const newAssigneeUserId = (user?.id as string) ?? null;
      if (newAssigneeUserId && ticket.assigned_user_id !== newAssigneeUserId) {
        updates.assigned_user_id = newAssigneeUserId;
        if (ticket.assigned_user_id) newWatchers.add(ticket.assigned_user_id);
        changed = true;
      }
    }

    if (changed) {
      updates.watchers = Array.from(newWatchers);
      // Step 1c.10c: route to tickets (case) or work_orders.
      await this.updateTicketOrWorkOrder(ticket.id, updates);
    }
    return changed;
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
    const ticket = await this.loadTicketForFire(timer.ticket_id);
    const policyName = await this.loadPolicyName(timer.sla_policy_id);
    const resolved = await this.resolveTarget(threshold, ticket.id);

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

    const targetName = await this.resolveTargetName(resolved);
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
      reassigned = await this.applyReassignment(ticket, resolved);
      if (reassigned) {
        await this.writeActivity(ticket, threshold, policyName);
      }
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

    // Load distinct policies used by this batch in one query.
    const policyIds = Array.from(new Set(timerRows.map((t) => t.sla_policy_id)));
    const { data: policies } = await this.supabase.admin
      .from('sla_policies')
      .select('id, escalation_thresholds')
      .in('id', policyIds);
    const thresholdsByPolicy = new Map<string, EscalationThreshold[]>();
    for (const p of policies ?? []) {
      const raw = (p.escalation_thresholds as EscalationThreshold[] | null) ?? [];
      thresholdsByPolicy.set(p.id as string, raw);
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
        const thresholds = thresholdsByPolicy.get(timer.sla_policy_id) ?? [];
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
   */
  async listCrossingsForTicket(ticketId: string) {
    const { data: rows, error } = await this.supabase.admin
      .from('sla_threshold_crossings')
      .select('id, fired_at, timer_type, at_percent, action, target_type, target_id, notification_id')
      .eq('ticket_id', ticketId)
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
