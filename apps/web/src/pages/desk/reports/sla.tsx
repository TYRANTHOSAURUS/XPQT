import { useState } from 'react';
import { SectionCards, type SectionCardItem } from '@/components/section-cards';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { useSlaPerformance, useTicketsOverview } from '@/api/reports';
import { useTicketList, type TicketListResponse } from '@/api/tickets/queries';
import type { TicketDetail } from '@/api/tickets/types';
import { Link } from 'react-router-dom';
import { formatCount, formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import { ReportShell } from './_shell';

interface SlaResponse {
  total_completed: number;
  met: number;
  breached: number;
  met_percentage: number;
  period_days: number;
}

interface OverviewResponse {
  sla: { total_open: number; at_risk: number; breached: number; on_track: number };
}

export function SlaReport() {
  const [days, setDays] = useState('30');
  const { data: perf } = useSlaPerformance<SlaResponse>(parseInt(days, 10));
  const { data: overview } = useTicketsOverview<OverviewResponse>();
  const { data: tickets } = useTicketList<TicketDetail>({});

  const sla = overview?.sla;
  const list = (tickets as TicketListResponse<TicketDetail> | undefined)?.items ?? [];
  const atRiskList = list.filter((t) => t.sla_at_risk || t.sla_resolution_breached_at);

  const kpis: SectionCardItem[] = [
    {
      description: 'SLA met',
      title: perf ? `${perf.met_percentage}%` : '—',
      trend: {
        direction: perf && perf.met_percentage >= 90 ? 'up' : 'down',
        label: perf ? `${formatCount(perf.met)} met` : '—',
      },
      footerPrimary: 'On-time resolutions',
      footerSecondary: `Last ${days} days`,
    },
    {
      description: 'Total completed',
      title: formatCount(perf?.total_completed ?? 0),
      trend: { direction: 'up', label: 'completed' },
      footerPrimary: 'Tickets with SLA decided',
      footerSecondary: `Last ${days} days`,
    },
    {
      description: 'Breached',
      title: formatCount(perf?.breached ?? 0),
      trend: {
        direction: (perf?.breached ?? 0) > 0 ? 'down' : 'up',
        label: perf && perf.total_completed > 0 ? `${Math.round((perf.breached / perf.total_completed) * 100)}%` : '0%',
      },
      footerPrimary: 'SLA breaches in period',
      footerSecondary: 'Escalate or reassign',
    },
    {
      description: 'At risk now',
      title: formatCount(sla?.at_risk ?? 0),
      trend: { direction: (sla?.at_risk ?? 0) > 0 ? 'up' : 'down', label: 'open tickets' },
      footerPrimary: 'Approaching breach',
      footerSecondary: 'Prioritise these next',
    },
  ];

  return (
    <ReportShell
      title="SLA performance"
      description="Response and resolution SLA outcomes across the desk."
    >
      <div className="flex items-center justify-between px-4 lg:px-6">
        <div className="text-sm text-muted-foreground">
          Period:
        </div>
        <Select value={days} onValueChange={(v) => setDays(v ?? '30')}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <SectionCards items={kpis} />
      <div className="px-4 lg:px-6">
        <Card className="@container/card">
          <CardHeader>
            <CardTitle>Tickets at risk or breached</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>SLA state</TableHead>
                  <TableHead>Assignee</TableHead>
                  <TableHead className="text-right">Opened</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {atRiskList.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      Nothing at risk right now.
                    </TableCell>
                  </TableRow>
                ) : (
                  atRiskList.map((t) => {
                    const breached = Boolean(t.sla_resolution_breached_at);
                    const assignee = t.assigned_agent?.email ?? t.assigned_team?.name ?? t.assigned_vendor?.name ?? 'Unassigned';
                    return (
                      <TableRow key={t.id} className="hover:bg-muted/40">
                        <TableCell>
                          <Link to={`/desk/inbox?ticket=${t.id}`} className="font-medium hover:underline">
                            {t.title}
                          </Link>
                        </TableCell>
                        <TableCell className="capitalize">{t.priority}</TableCell>
                        <TableCell>
                          <Badge variant={breached ? 'destructive' : 'outline'} className="capitalize">
                            {breached ? 'Breached' : 'At risk'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{assignee}</TableCell>
                        <TableCell className="text-right text-muted-foreground tabular-nums">
                          <time dateTime={t.created_at} title={formatFullTimestamp(t.created_at)}>
                            {formatRelativeTime(t.created_at)}
                          </time>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </ReportShell>
  );
}
