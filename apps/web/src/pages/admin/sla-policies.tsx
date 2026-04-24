import { Link } from 'react-router-dom';
import { Plus, Timer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  useBusinessHoursCalendars,
  useSlaPolicies,
  type EscalationThreshold,
  type SlaPolicy,
} from '@/api/sla-policies';

const PAUSE_REASON_LABELS: Record<string, string> = {
  requester: 'Requester',
  vendor: 'Vendor',
  scheduled_work: 'Scheduled work',
};

function formatHours(mins: number | null | undefined): string | null {
  if (mins === null || mins === undefined) return null;
  if (mins < 60) return `${mins}m`;
  const h = mins / 60;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

export function SlaPoliciesPage() {
  const { data, isLoading } = useSlaPolicies();
  const { data: calendars } = useBusinessHoursCalendars();

  const calendarName = (id: string | null) =>
    !id ? 'Always on' : calendars?.find((c) => c.id === id)?.name ?? '—';

  const isEmpty = !isLoading && (data?.length ?? 0) === 0;

  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        backTo="/admin"
        title="SLA policies"
        description="Response and resolution targets, pause conditions, and escalation thresholds."
        actions={
          <Link
            to="/admin/sla-policies/new"
            className={cn(buttonVariants({ variant: 'default' }), 'gap-1.5')}
          >
            <Plus className="size-4" />
            New policy
          </Link>
        }
      />

      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {!isLoading && data && data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Policy</TableHead>
              <TableHead className="w-[150px]">Targets</TableHead>
              <TableHead className="w-[260px]">Pauses</TableHead>
              <TableHead className="w-[200px]">Escalations</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((policy: SlaPolicy) => (
              <TableRow key={policy.id}>
                <TableCell className="align-top py-3">
                  <PolicyCell
                    policy={policy}
                    calendarName={calendarName(policy.business_hours_calendar_id)}
                  />
                </TableCell>
                <TableCell className="align-top py-3">
                  <TargetsCell
                    response={policy.response_time_minutes}
                    resolution={policy.resolution_time_minutes}
                  />
                </TableCell>
                <TableCell className="align-top py-3">
                  <PausesCell reasons={policy.pause_on_waiting_reasons ?? []} />
                </TableCell>
                <TableCell className="align-top py-3">
                  <EscalationsCell thresholds={policy.escalation_thresholds ?? []} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {isEmpty && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Timer className="size-10 text-muted-foreground" />
          <div className="text-sm font-medium">No SLA policies yet</div>
          <p className="max-w-sm text-sm text-muted-foreground">
            Create a policy to define how fast tickets must be responded to and resolved.
            Request types attach to a policy to inherit its targets.
          </p>
          <Link
            to="/admin/sla-policies/new"
            className={cn(buttonVariants({ variant: 'default' }), 'gap-1.5')}
          >
            <Plus className="size-4" />
            New policy
          </Link>
        </div>
      )}
    </SettingsPageShell>
  );
}

function PolicyCell({
  policy,
  calendarName,
}: {
  policy: SlaPolicy;
  calendarName: string;
}) {
  return (
    <div className="flex items-start gap-2.5 min-w-0">
      <span
        aria-hidden
        className={cn(
          'mt-[7px] size-1.5 shrink-0 rounded-full',
          policy.active ? 'bg-emerald-500' : 'bg-muted-foreground/30',
        )}
        title={policy.active ? 'Active' : 'Disabled'}
      />
      <div className="flex flex-col min-w-0">
        <Link
          to={`/admin/sla-policies/${policy.id}`}
          className="font-medium hover:underline underline-offset-2 truncate"
        >
          {policy.name}
        </Link>
        <span className="text-xs text-muted-foreground truncate">{calendarName}</span>
      </div>
    </div>
  );
}

function TargetsCell({
  response,
  resolution,
}: {
  response: number | null;
  resolution: number | null;
}) {
  const r = formatHours(response);
  const f = formatHours(resolution);
  if (!r && !f) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col gap-0.5 text-sm tabular-nums">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-muted-foreground">Response</span>
        <span className={cn(!r && 'text-muted-foreground')}>{r ?? '—'}</span>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-muted-foreground">Resolution</span>
        <span className={cn(!f && 'text-muted-foreground')}>{f ?? '—'}</span>
      </div>
    </div>
  );
}

function PausesCell({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) {
    return <span className="text-sm text-muted-foreground">Never</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {reasons.map((reason) => (
        <Badge key={reason} variant="secondary" className="font-normal">
          {PAUSE_REASON_LABELS[reason] ?? reason}
        </Badge>
      ))}
    </div>
  );
}

function EscalationsCell({ thresholds }: { thresholds: EscalationThreshold[] }) {
  if (thresholds.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const sorted = [...thresholds].sort((a, b) => a.at_percent - b.at_percent);
  return (
    <div className="flex flex-wrap gap-1">
      {sorted.map((t, i) => (
        <Badge
          key={`${t.at_percent}-${t.timer_type}-${i}`}
          variant="secondary"
          className="font-normal tabular-nums"
        >
          {t.at_percent}%
        </Badge>
      ))}
    </div>
  );
}
