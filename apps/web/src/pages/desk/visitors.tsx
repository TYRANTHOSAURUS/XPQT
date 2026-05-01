/**
 * /desk/visitors — service desk focused lens.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §7.9
 * Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md slice 9 task 9.3
 *
 * NOT a duplicate of `/reception/*`. The desk's view is narrow:
 *   1. Contractor visitors with active service tickets (catalog of work).
 *   2. Visitors stuck in `pending_approval` (so desk can chase the approver).
 *   3. Today's escalations: host-not-acknowledged > 5min, unreturned passes.
 *
 * Permission: `visitors.reception` (same as reception). The backend
 * uses visibility-bypass via `visitor_visibility_ids` so a scoped agent
 * only sees their authorized set.
 */
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  SettingsPageHeader,
  SettingsPageShell,
  SettingsSection,
} from '@/components/ui/settings-page';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AlertTriangle, Clock, Inbox, KeySquare } from 'lucide-react';
import {
  useDeskLens,
  type DeskLensRow,
  type UnreturnedPassRow,
} from '@/api/visitors/admin';
import { formatFullTimestamp, formatRelativeTime } from '@/lib/format';
import { visitorStatusLabel, type VisitorStatus } from '@/api/visitors';

export function DeskVisitorsPage() {
  const { data, isLoading, isError } = useDeskLens();

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        title="Visitors"
        description="Visitors tied to active service tickets, pending approvals, and today's escalations."
      />
      <p className="-mt-2 text-sm text-muted-foreground">
        Reception's full workspace lives at{' '}
        <Link to="/reception/today" className="underline">
          /reception
        </Link>
        .
      </p>

      {isLoading && (
        <div className="text-sm text-muted-foreground">Loading…</div>
      )}

      {isError && (
        <SettingsSection title="Couldn't load" description="Refresh to retry.">
          <div className="py-2 text-sm text-muted-foreground">
            The desk lens didn't load. Refresh the page to retry.
          </div>
        </SettingsSection>
      )}

      {data && (
        <>
          <ContractorsSection rows={data.contractors} />
          <PendingApprovalSection rows={data.pending_approval} />
          <EscalationsSection
            ackDelayed={data.escalations.host_not_acknowledged}
            unreturnedPasses={data.escalations.unreturned_passes}
          />
        </>
      )}
    </SettingsPageShell>
  );
}

function ContractorsSection({ rows }: { rows: DeskLensRow[] }) {
  return (
    <SettingsSection
      title={`Contractor visitors (${rows.length})`}
      description="Contractors arriving today. If a service ticket exists for the same bundle, the link is shown so the desk can prep the work."
    >
      <>
        {rows.length === 0 ? (
          <EmptyRow icon={Inbox} text="No contractor visits today." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Visitor</TableHead>
                <TableHead className="w-[180px]">Host</TableHead>
                <TableHead className="w-[160px]">Expected</TableHead>
                <TableHead className="w-[120px]">Status</TableHead>
                <TableHead className="w-[160px]">Linked work</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">
                    <Link
                      to={`/portal/visitors/expected`}
                      className="hover:underline underline-offset-2"
                    >
                      {row.first_name} {row.last_name ?? ''}
                    </Link>
                    {row.company && (
                      <div className="text-xs text-muted-foreground">
                        {row.company}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.primary_host_name ?? '—'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground tabular-nums">
                    {row.expected_at ? (
                      <time
                        dateTime={row.expected_at}
                        title={formatFullTimestamp(row.expected_at)}
                      >
                        {formatRelativeTime(row.expected_at)}
                      </time>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {visitorStatusLabel(row.status as VisitorStatus)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.booking_bundle_id ? (
                      <Link
                        to={`/desk/bookings/${row.booking_bundle_id}`}
                        className="underline underline-offset-2 hover:text-foreground"
                      >
                        Bundle
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </>
    </SettingsSection>
  );
}

function PendingApprovalSection({ rows }: { rows: DeskLensRow[] }) {
  return (
    <SettingsSection
      title={`Pending approval (${rows.length})`}
      description="Visitors waiting on an approver. Chase the approver or escalate via Approvals."
    >
      <>
        {rows.length === 0 ? (
          <EmptyRow icon={Inbox} text="No pending approvals." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Visitor</TableHead>
                <TableHead className="w-[180px]">Type</TableHead>
                <TableHead className="w-[180px]">Host</TableHead>
                <TableHead className="w-[160px]">Expected</TableHead>
                <TableHead className="w-[140px] text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">
                    {row.first_name} {row.last_name ?? ''}
                    {row.company && (
                      <div className="text-xs text-muted-foreground">
                        {row.company}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.visitor_type_name ?? '—'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.primary_host_name ?? '—'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground tabular-nums">
                    {row.expected_at ? (
                      <time
                        dateTime={row.expected_at}
                        title={formatFullTimestamp(row.expected_at)}
                      >
                        {formatRelativeTime(row.expected_at)}
                      </time>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      to="/desk/approvals"
                      className={cn(
                        buttonVariants({ variant: 'ghost', size: 'sm' }),
                      )}
                    >
                      Open
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </>
    </SettingsSection>
  );
}

function EscalationsSection({
  ackDelayed,
  unreturnedPasses,
}: {
  ackDelayed: DeskLensRow[];
  unreturnedPasses: UnreturnedPassRow[];
}) {
  const hasAny = ackDelayed.length > 0 || unreturnedPasses.length > 0;
  const total = ackDelayed.length + unreturnedPasses.length;

  return (
    <SettingsSection
      title={`Today's escalations (${total})`}
      description="Visitors arrived without their host acknowledging, and passes that haven't been returned. Reception handles these inline; the desk's view is read-only."
    >
      <div className="flex flex-col gap-6">
        {!hasAny && (
          <EmptyRow
            icon={AlertTriangle}
            text="No escalations today."
          />
        )}

        {ackDelayed.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Clock className="size-3.5 text-muted-foreground" />
              Host not acknowledged ({ackDelayed.length})
            </h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Visitor</TableHead>
                  <TableHead className="w-[180px]">Host</TableHead>
                  <TableHead className="w-[160px]">Arrived</TableHead>
                  <TableHead className="w-[160px]">Waiting</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ackDelayed.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">
                      {row.first_name} {row.last_name ?? ''}
                      {row.company && (
                        <div className="text-xs text-muted-foreground">
                          {row.company}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.primary_host_name ?? '—'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground tabular-nums">
                      {row.arrived_at ? (
                        <time
                          dateTime={row.arrived_at}
                          title={formatFullTimestamp(row.arrived_at)}
                        >
                          {formatRelativeTime(row.arrived_at)}
                        </time>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {row.seconds_since_arrival != null
                        ? formatDuration(row.seconds_since_arrival)
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {unreturnedPasses.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <KeySquare className="size-3.5 text-muted-foreground" />
              Unreturned passes ({unreturnedPasses.length})
            </h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px]">Pass</TableHead>
                  <TableHead className="w-[180px]">Last assigned</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unreturnedPasses.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">
                      {p.pass_number}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground tabular-nums">
                      {p.last_assigned_at ? (
                        <time
                          dateTime={p.last_assigned_at}
                          title={formatFullTimestamp(p.last_assigned_at)}
                        >
                          {formatRelativeTime(p.last_assigned_at)}
                        </time>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {p.notes ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

function EmptyRow({
  icon: Icon,
  text,
}: {
  icon: typeof Inbox;
  text: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground">
      <Icon className="size-8 opacity-40" />
      <p className="text-sm">{text}</p>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
