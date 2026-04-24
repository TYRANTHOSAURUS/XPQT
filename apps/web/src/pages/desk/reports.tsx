import { useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { TableEmpty, TableLoading } from '@/components/table-states';
import { useTicketsOverview, useSlaPerformance, useTicketsByTeam } from '@/api/reports';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Inbox,
} from 'lucide-react';

/* ---------- API response types ---------- */

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

type ByTeamResponse = Record<string, { open: number; at_risk: number }>;

/* ---------- Config maps ---------- */

const statusColors: Record<string, string> = {
  new: 'bg-blue-500',
  assigned: 'bg-yellow-500',
  in_progress: 'bg-purple-500',
  waiting: 'bg-orange-500',
  resolved: 'bg-green-500',
  closed: 'bg-zinc-500',
};

const statusLabels: Record<string, string> = {
  new: 'New',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  waiting: 'Waiting',
  resolved: 'Resolved',
  closed: 'Closed',
};

const priorityColors: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-blue-500',
  low: 'bg-zinc-400',
};

const priorityLabels: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/* ---------- Helpers ---------- */

function StatCard({
  title,
  value,
  icon,
  accent,
}: {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  accent?: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 pt-1 pb-1">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${accent ?? 'bg-muted'}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="text-2xl font-semibold tracking-tight">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function BarSegment({
  label,
  count,
  total,
  color,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-sm text-muted-foreground">{label}</span>
      <div className="flex-1 h-6 rounded-md bg-muted/40 overflow-hidden">
        <div
          className={`h-full rounded-md transition-all ${color}`}
          style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%` }}
        />
      </div>
      <span className="w-16 shrink-0 text-right text-sm font-medium tabular-nums">
        {count} <span className="text-muted-foreground">({pct}%)</span>
      </span>
    </div>
  );
}

/* ---------- Main page ---------- */

export function ReportsPage() {
  const [days, setDays] = useState('30');
  const daysNum = parseInt(days, 10);

  const { data: overview, isPending: overviewLoading } = useTicketsOverview<OverviewResponse>();
  const { data: slaPerf, isPending: slaLoading } = useSlaPerformance<SlaPerformanceResponse>(daysNum);
  const { data: byTeam, isPending: teamsLoading } = useTicketsByTeam<ByTeamResponse>();

  const sla = overview?.sla;
  const byStatus = overview?.by_status ?? {};
  const byPriority = overview?.by_priority ?? {};

  const statusTotal = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const priorityTotal = Object.values(byPriority).reduce((a, b) => a + b, 0);

  const teamEntries = Object.entries(byTeam ?? {});

  const isLoading = overviewLoading || slaLoading || teamsLoading;

  if (isLoading && !overview) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Loading reports...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
          <p className="text-muted-foreground mt-1">Service desk performance overview</p>
        </div>
        <Select value={days} onValueChange={(v) => setDays(v ?? '30')}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Open"
          value={sla?.total_open ?? 0}
          icon={<Inbox className="h-5 w-5 text-blue-400" />}
          accent="bg-blue-500/10"
        />
        <StatCard
          title="At Risk"
          value={sla?.at_risk ?? 0}
          icon={<Clock className="h-5 w-5 text-yellow-400" />}
          accent="bg-yellow-500/10"
        />
        <StatCard
          title="Breached"
          value={sla?.breached ?? 0}
          icon={<AlertTriangle className="h-5 w-5 text-red-400" />}
          accent="bg-red-500/10"
        />
        <StatCard
          title="SLA Met %"
          value={slaPerf ? `${slaPerf.met_percentage}%` : '--'}
          icon={<CheckCircle2 className="h-5 w-5 text-green-400" />}
          accent="bg-green-500/10"
        />
      </div>

      {/* Tickets by Status */}
      <Card>
        <CardHeader>
          <CardTitle>Tickets by Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {Object.keys(statusColors).map((key) => {
            const count = byStatus[key] ?? 0;
            return (
              <BarSegment
                key={key}
                label={statusLabels[key] ?? key}
                count={count}
                total={statusTotal}
                color={statusColors[key]}
              />
            );
          })}
          {statusTotal === 0 && (
            <p className="text-sm text-muted-foreground py-2">No ticket data available.</p>
          )}
        </CardContent>
      </Card>

      {/* Tickets by Priority */}
      <Card>
        <CardHeader>
          <CardTitle>Tickets by Priority</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {Object.keys(priorityColors).map((key) => {
            const count = byPriority[key] ?? 0;
            return (
              <BarSegment
                key={key}
                label={priorityLabels[key] ?? key}
                count={count}
                total={priorityTotal}
                color={priorityColors[key]}
              />
            );
          })}
          {priorityTotal === 0 && (
            <p className="text-sm text-muted-foreground py-2">No ticket data available.</p>
          )}
        </CardContent>
      </Card>

      {/* SLA Performance */}
      <Card>
        <CardHeader>
          <CardTitle>SLA Performance ({daysNum}d)</CardTitle>
        </CardHeader>
        <CardContent>
          {slaPerf && slaPerf.total_completed > 0 ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {slaPerf.met} met / {slaPerf.breached} breached of {slaPerf.total_completed} completed
                </span>
                <span className="font-medium">{slaPerf.met_percentage}% met</span>
              </div>
              <div className="h-3 w-full rounded-full bg-red-500/20 overflow-hidden">
                <div
                  className="h-full rounded-full bg-green-500 transition-all"
                  style={{ width: `${slaPerf.met_percentage}%` }}
                />
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-green-500" /> Met
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-500/60" /> Breached
                </span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-2">No completed SLA timers in this period.</p>
          )}
        </CardContent>
      </Card>

      {/* Tickets by Team */}
      <Card>
        <CardHeader>
          <CardTitle>Tickets by Team</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Team</TableHead>
                <TableHead className="w-[120px] text-right">Open</TableHead>
                <TableHead className="w-[120px] text-right">At Risk</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teamsLoading && teamEntries.length === 0 && <TableLoading cols={3} />}
              {!teamsLoading && teamEntries.length === 0 && (
                <TableEmpty cols={3} message="No open tickets assigned to teams." />
              )}
              {teamEntries.map(([teamId, stats]) => (
                <TableRow key={teamId}>
                  <TableCell className="font-medium">
                    {teamId === 'unassigned' ? (
                      <span className="text-muted-foreground italic">Unassigned</span>
                    ) : (
                      teamId
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{stats.open}</TableCell>
                  <TableCell className="text-right">
                    {stats.at_risk > 0 ? (
                      <Badge variant="destructive" className="tabular-nums">
                        {stats.at_risk}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground tabular-nums">0</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
