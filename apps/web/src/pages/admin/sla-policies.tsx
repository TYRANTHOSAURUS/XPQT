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
  type SlaPolicy,
} from '@/api/sla-policies';

function formatMinutes(mins: number | null): string {
  if (mins === null || mins === undefined) return '—';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function SlaPoliciesPage() {
  const { data, isLoading } = useSlaPolicies();
  const { data: calendars } = useBusinessHoursCalendars();

  const calendarName = (id: string | null) =>
    !id ? 'Always on' : calendars?.find((c) => c.id === id)?.name ?? '—';

  const isEmpty = !isLoading && (data?.length ?? 0) === 0;

  return (
    <SettingsPageShell>
      <SettingsPageHeader
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
              <TableHead>Name</TableHead>
              <TableHead className="w-[110px]">Response</TableHead>
              <TableHead className="w-[110px]">Resolution</TableHead>
              <TableHead>Calendar</TableHead>
              <TableHead className="w-[100px]">Escalations</TableHead>
              <TableHead className="w-[80px]">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((policy: SlaPolicy) => (
              <TableRow key={policy.id}>
                <TableCell className="font-medium">
                  <Link
                    to={`/admin/sla-policies/${policy.id}`}
                    className="hover:underline underline-offset-2"
                  >
                    {policy.name}
                  </Link>
                </TableCell>
                <TableCell>{formatMinutes(policy.response_time_minutes)}</TableCell>
                <TableCell>{formatMinutes(policy.resolution_time_minutes)}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {calendarName(policy.business_hours_calendar_id)}
                </TableCell>
                <TableCell>
                  {(policy.escalation_thresholds?.length ?? 0) > 0 ? (
                    <Badge variant="secondary">{policy.escalation_thresholds!.length}</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={policy.active ? 'default' : 'secondary'}>
                    {policy.active ? 'active' : 'disabled'}
                  </Badge>
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
