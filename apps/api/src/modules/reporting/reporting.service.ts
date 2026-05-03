import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

export interface BookingReportParams {
  from: string;
  to: string;
  buildingId: string | null;
  tz: string;
}

@Injectable()
export class ReportingService {
  constructor(private readonly supabase: SupabaseService) {}

  async getTicketOverview() {
    const tenant = TenantContext.current();

    // Count by status category
    const { data: byStatus } = await this.supabase.admin
      .from('tickets')
      .select('status_category')
      .eq('tenant_id', tenant.id)
      .is('parent_ticket_id', null); // top-level only

    const statusCounts: Record<string, number> = {};
    for (const t of byStatus ?? []) {
      statusCounts[t.status_category] = (statusCounts[t.status_category] ?? 0) + 1;
    }

    // Count by priority
    const { data: byPriority } = await this.supabase.admin
      .from('tickets')
      .select('priority')
      .eq('tenant_id', tenant.id)
      .is('parent_ticket_id', null);

    const priorityCounts: Record<string, number> = {};
    for (const t of byPriority ?? []) {
      priorityCounts[t.priority] = (priorityCounts[t.priority] ?? 0) + 1;
    }

    // SLA metrics
    const { data: slaData } = await this.supabase.admin
      .from('tickets')
      .select('sla_at_risk, sla_resolution_breached_at')
      .eq('tenant_id', tenant.id)
      .is('parent_ticket_id', null)
      .in('status_category', ['new', 'assigned', 'in_progress', 'waiting']);

    const totalOpen = slaData?.length ?? 0;
    const atRisk = slaData?.filter((t) => t.sla_at_risk).length ?? 0;
    const breached = slaData?.filter((t) => t.sla_resolution_breached_at).length ?? 0;

    return {
      by_status: statusCounts,
      by_priority: priorityCounts,
      sla: {
        total_open: totalOpen,
        at_risk: atRisk,
        breached,
        on_track: totalOpen - atRisk - breached,
      },
    };
  }

  async getTicketVolume(days = 30) {
    const tenant = TenantContext.current();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data: created } = await this.supabase.admin
      .from('tickets')
      .select('created_at')
      .eq('tenant_id', tenant.id)
      .is('parent_ticket_id', null)
      .gte('created_at', since);

    const { data: resolved } = await this.supabase.admin
      .from('tickets')
      .select('resolved_at')
      .eq('tenant_id', tenant.id)
      .is('parent_ticket_id', null)
      .gte('resolved_at', since)
      .not('resolved_at', 'is', null);

    // Group by day
    const createdByDay = this.groupByDay(created ?? [], 'created_at');
    const resolvedByDay = this.groupByDay(resolved ?? [], 'resolved_at');

    return { created_by_day: createdByDay, resolved_by_day: resolvedByDay, period_days: days };
  }

  async getSlaPerformance(days = 30) {
    const tenant = TenantContext.current();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data: timers } = await this.supabase.admin
      .from('sla_timers')
      .select('timer_type, breached, completed_at')
      .eq('tenant_id', tenant.id)
      .gte('started_at', since);

    const completed = timers?.filter((t) => t.completed_at) ?? [];
    const totalCompleted = completed.length;
    const breachedCount = completed.filter((t) => t.breached).length;
    const metCount = totalCompleted - breachedCount;

    return {
      total_completed: totalCompleted,
      met: metCount,
      breached: breachedCount,
      met_percentage: totalCompleted > 0 ? Math.round((metCount / totalCompleted) * 100) : 100,
      period_days: days,
    };
  }

  async getByTeam() {
    const tenant = TenantContext.current();
    const { data } = await this.supabase.admin
      .from('tickets')
      .select('assigned_team_id, status_category, sla_at_risk')
      .eq('tenant_id', tenant.id)
      .is('parent_ticket_id', null)
      .in('status_category', ['new', 'assigned', 'in_progress', 'waiting']);

    const teams: Record<string, { open: number; at_risk: number }> = {};
    for (const t of data ?? []) {
      const teamId = t.assigned_team_id ?? 'unassigned';
      if (!teams[teamId]) teams[teamId] = { open: 0, at_risk: 0 };
      teams[teamId].open++;
      if (t.sla_at_risk) teams[teamId].at_risk++;
    }

    return teams;
  }

  async getByLocation() {
    const tenant = TenantContext.current();
    const { data } = await this.supabase.admin
      .from('tickets')
      .select('location_id, status_category')
      .eq('tenant_id', tenant.id)
      .is('parent_ticket_id', null)
      .not('location_id', 'is', null)
      .in('status_category', ['new', 'assigned', 'in_progress', 'waiting']);

    const locations: Record<string, number> = {};
    for (const t of data ?? []) {
      const locId = t.location_id ?? 'unknown';
      locations[locId] = (locations[locId] ?? 0) + 1;
    }

    return locations;
  }

  private groupByDay(records: Array<Record<string, unknown>>, dateField: string): Record<string, number> {
    const groups: Record<string, number> = {};
    for (const r of records) {
      const date = (r[dateField] as string).substring(0, 10); // YYYY-MM-DD
      groups[date] = (groups[date] ?? 0) + 1;
    }
    return groups;
  }

  // Bookings overview reports — back online against the canonical
  // `bookings` + `booking_slots` schema (00277). RPCs were dropped in
  // 00279 during the booking-canonicalization rewrite and rebuilt in
  // 00289 as a faithful retarget of the originals (00155 + 00156).
  // Spec: docs/superpowers/specs/2026-04-27-bookings-overview-report-design.md
  async getBookingsOverview(params: BookingReportParams) {
    return this.callBookingReport('room_booking_report_overview', params);
  }

  async getBookingsUtilization(params: BookingReportParams) {
    return this.callBookingReport('room_booking_utilization_report', params);
  }

  async getBookingsNoShows(params: BookingReportParams) {
    return this.callBookingReport('room_booking_no_shows_report', params);
  }

  async getBookingsServices(params: BookingReportParams) {
    return this.callBookingReport('room_booking_services_report', params);
  }

  async getBookingsDemand(params: BookingReportParams) {
    return this.callBookingReport('room_booking_demand_report', params);
  }

  private async callBookingReport(rpc: string, params: BookingReportParams) {
    // Validate inputs first — cheaper than a roundtrip and gives admins
    // a clear shape error instead of a Postgres SQLSTATE.
    const fromDate = this.parseDate(params.from, 'from');
    const toDate = this.parseDate(params.to, 'to');
    if (fromDate > toDate) {
      throw new BadRequestException('from must be on or before to');
    }
    const days = Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000);
    if (days > 365) {
      throw new BadRequestException('window too large (max 365 days)');
    }
    const tz = this.validateTimezone(params.tz);

    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin.rpc(rpc, {
      p_tenant_id: tenant.id,
      p_from: params.from,
      p_to: params.to,
      p_building_id: params.buildingId,
      p_tz: tz,
    });
    if (error) {
      // Preserve the underlying message so frontend toasts surface a
      // useful diagnostic (e.g. "from > to" raised by the RPC's own
      // validation if the API layer somehow lets it through).
      throw new BadRequestException(error.message);
    }
    return data;
  }

  private parseDate(value: string, label: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException(`${label} must be a YYYY-MM-DD date`);
    }
    const d = new Date(value + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException(`${label} is not a valid date`);
    }
    return d;
  }

  private validateTimezone(tz: string): string {
    // IANA tz validation via Intl. Falls back to UTC on unknown zones rather
    // than failing — better UX for clients on older browsers / weird locales.
    try {
      // eslint-disable-next-line no-new
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    } catch {
      return 'UTC';
    }
  }
}
