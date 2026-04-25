import { SectionCards, type SectionCardItem } from '@/components/section-cards';
import { ChartAreaInteractive, type TicketVolumePoint } from '@/components/chart-area-interactive';
import { DataTable } from '@/components/data-table';
import { useTicketsOverview, useSlaPerformance, useTicketsVolume } from '@/api/reports';
import { useTicketList, type TicketListResponse } from '@/api/tickets/queries';
import type { TicketDetail } from '@/api/tickets/types';
import { formatCount } from '@/lib/format';

interface OverviewResponse {
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
  sla: { total_open: number; at_risk: number; breached: number; on_track: number };
}

interface SlaPerformanceResponse {
  total_completed: number;
  met: number;
  breached: number;
  met_percentage: number;
  period_days: number;
}

function toSeries(volume: { created_by_day: Record<string, number>; resolved_by_day: Record<string, number> } | undefined): TicketVolumePoint[] {
  if (!volume) return [];
  const dates = new Set<string>([
    ...Object.keys(volume.created_by_day),
    ...Object.keys(volume.resolved_by_day),
  ]);
  return Array.from(dates)
    .sort()
    .map((date) => ({
      date,
      created: volume.created_by_day[date] ?? 0,
      resolved: volume.resolved_by_day[date] ?? 0,
    }));
}

function toTableRow(t: TicketDetail) {
  const statusLabel =
    t.status_category === 'resolved' || t.status_category === 'closed'
      ? 'Done'
      : t.status_category === 'in_progress'
        ? 'In Process'
        : t.status_category === 'waiting'
          ? 'Waiting'
          : 'Pending';
  const reviewer =
    t.assigned_agent?.email ??
    t.assigned_team?.name ??
    t.assigned_vendor?.name ??
    'Assign reviewer';
  return {
    id: t.id,
    header: t.title,
    type: t.request_type?.name ?? '—',
    status: statusLabel,
    target: t.priority,
    limit: t.sla_at_risk ? 'at risk' : t.sla_resolution_breached_at ? 'breached' : 'on track',
    reviewer,
  };
}

export function OverviewReport() {
  const { data: overview } = useTicketsOverview<OverviewResponse>();
  const { data: slaPerf } = useSlaPerformance<SlaPerformanceResponse>(30);
  const { data: volume } = useTicketsVolume(90);
  const { data: tickets } = useTicketList<TicketDetail>({ page: 1 });

  const sla = overview?.sla;
  const kpis: SectionCardItem[] = [
    {
      description: 'Total open',
      title: formatCount(sla?.total_open ?? 0),
      trend: { direction: 'up', label: `${formatCount(sla?.on_track ?? 0)} on track` },
      footerPrimary: 'Active tickets across desk',
      footerSecondary: 'All statuses except resolved',
    },
    {
      description: 'At risk',
      title: formatCount(sla?.at_risk ?? 0),
      trend: {
        direction: (sla?.at_risk ?? 0) > 0 ? 'up' : 'down',
        label: `${formatCount(sla?.at_risk ?? 0)}`,
      },
      footerPrimary: 'Approaching SLA breach',
      footerSecondary: 'Prioritise these next',
    },
    {
      description: 'Breached',
      title: formatCount(sla?.breached ?? 0),
      trend: {
        direction: (sla?.breached ?? 0) > 0 ? 'down' : 'up',
        label: `${formatCount(sla?.breached ?? 0)}`,
      },
      footerPrimary: 'SLA already breached',
      footerSecondary: 'Escalate or reassign',
    },
    {
      description: 'SLA met (30d)',
      title: slaPerf ? `${slaPerf.met_percentage}%` : '—',
      trend: {
        direction: slaPerf && slaPerf.met_percentage >= 90 ? 'up' : 'down',
        label: slaPerf ? `${formatCount(slaPerf.met)}/${formatCount(slaPerf.total_completed)}` : '—',
      },
      footerPrimary: 'On-time resolution rate',
      footerSecondary: 'Last 30 days',
    },
  ];

  const series = toSeries(volume);
  const ticketList = (tickets as TicketListResponse<TicketDetail> | undefined)?.items ?? [];
  const tableData = ticketList.map(toTableRow);

  return (
    <div className="@container/main flex flex-1 flex-col gap-2">
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <SectionCards items={kpis} />
        <div className="px-4 lg:px-6">
          <ChartAreaInteractive data={series} />
        </div>
        <DataTable data={tableData} />
      </div>
    </div>
  );
}
