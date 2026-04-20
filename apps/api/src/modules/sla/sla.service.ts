import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { BusinessHoursService, BusinessHoursCalendar } from './business-hours.service';
import { NotificationService } from '../notification/notification.service';
import { TicketVisibilityService } from '../ticket/ticket-visibility.service';
import type {
  EscalationThreshold,
  SlaTimerRow,
  TimerType,
  ThresholdTargetType,
  RecordedAction,
} from './sla-threshold.types';

@Injectable()
export class SlaService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly businessHours: BusinessHoursService,
    private readonly notifications: NotificationService,
    private readonly visibility: TicketVisibilityService,
  ) {}

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

      await this.supabase.admin
        .from('tickets')
        .update({ sla_response_due_at: responseDue.toISOString() })
        .eq('id', ticketId);
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

      await this.supabase.admin
        .from('tickets')
        .update({ sla_resolution_due_at: resolutionDue.toISOString() })
        .eq('id', ticketId);
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
      .is('completed_at', null);

    await this.supabase.admin
      .from('tickets')
      .update({ sla_paused: true, sla_paused_at: now.toISOString() })
      .eq('id', ticketId);
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
      .is('completed_at', null);

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
      .is('completed_at', null);

    const updates: Record<string, unknown> = { sla_paused: false, sla_paused_at: null };
    for (const t of activeTimers ?? []) {
      if (t.timer_type === 'response') updates.sla_response_due_at = t.due_at;
      if (t.timer_type === 'resolution') updates.sla_resolution_due_at = t.due_at;
    }

    await this.supabase.admin.from('tickets').update(updates).eq('id', ticketId);
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
      .is('completed_at', null);

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
    await this.supabase.admin
      .from('tickets')
      .update({
        sla_response_due_at: null,
        sla_resolution_due_at: null,
        sla_response_breached_at: null,
        sla_resolution_breached_at: null,
        sla_at_risk: false,
        sla_paused: false,
        sla_paused_at: null,
      })
      .eq('id', ticketId);

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
      .lt('due_at', now.toISOString())
      .limit(100);

    for (const timer of breachedTimers ?? []) {
      // Mark timer as breached
      await this.supabase.admin
        .from('sla_timers')
        .update({ breached: true, breached_at: now.toISOString() })
        .eq('id', timer.id);

      // Update ticket computed fields
      const field = timer.timer_type === 'response'
        ? 'sla_response_breached_at'
        : 'sla_resolution_breached_at';

      await this.supabase.admin
        .from('tickets')
        .update({ [field]: now.toISOString() })
        .eq('id', timer.ticket_id);

      // Log domain event
      await this.supabase.admin.from('domain_events').insert({
        tenant_id: timer.tenant_id,
        event_type: `sla_${timer.timer_type}_breached`,
        entity_type: 'ticket',
        entity_id: timer.ticket_id,
        payload: { timer_type: timer.timer_type, due_at: timer.due_at },
      });
    }

    // Mark tickets as "at risk" when within 80% of their SLA
    const { data: atRiskTimers } = await this.supabase.admin
      .from('sla_timers')
      .select('id, ticket_id, started_at, due_at, target_minutes')
      .eq('breached', false)
      .eq('paused', false)
      .is('completed_at', null)
      .gt('due_at', now.toISOString())
      .limit(200);

    for (const timer of atRiskTimers ?? []) {
      const started = new Date(timer.started_at).getTime();
      const due = new Date(timer.due_at).getTime();
      const elapsed = now.getTime() - started;
      const total = due - started;
      const percentUsed = total > 0 ? elapsed / total : 0;

      if (percentUsed >= 0.8) {
        await this.supabase.admin
          .from('tickets')
          .update({ sla_at_risk: true })
          .eq('id', timer.ticket_id)
          .eq('sla_at_risk', false); // only update if not already flagged
      }
    }
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
      const { data: ticket } = await this.supabase.admin
        .from('tickets')
        .select('requester_person_id')
        .eq('id', ticketId)
        .single();
      const requesterId = ticket?.requester_person_id as string | null;
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
    const { data, error } = await this.supabase.admin
      .from('tickets')
      .select('id, tenant_id, title, assigned_user_id, assigned_team_id, requester_person_id, watchers')
      .eq('id', ticketId)
      .single();
    if (error) throw error;
    return data as {
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
      await this.supabase.admin.from('tickets').update(updates).eq('id', ticket.id);
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
}
