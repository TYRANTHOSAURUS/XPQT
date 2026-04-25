import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, ChevronRight, Inbox } from 'lucide-react';
import {
  SettingsPageShell,
  SettingsPageHeader,
} from '@/components/ui/settings-page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { useOperatorReservations } from '@/api/room-booking';
import type { ReservationStatus } from '@/api/room-booking';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';

type Scope = 'upcoming' | 'past' | 'cancelled' | 'pending_approval' | 'all';

const SCOPES: { value: Scope; label: string }[] = [
  { value: 'pending_approval', label: 'Pending approval' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'past', label: 'Past' },
  { value: 'cancelled', label: 'Cancelled / released' },
  { value: 'all', label: 'All' },
];

/**
 * /desk/bookings — operator list view of every reservation in the tenant.
 * Visible to anyone with rooms.read_all or rooms.admin. The desk scheduler
 * (`/desk/scheduler`) is the calendar-grid sibling; this is the table-list
 * version operators reach for when they want to triage a queue (e.g.
 * "what's pending approval right now?").
 */
export function DeskBookingsPage() {
  const [scope, setScope] = useState<Scope>('pending_approval');

  const { data, isLoading, error } = useOperatorReservations({ scope, limit: 100 });

  const items = data?.items ?? [];

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/desk"
        title="Bookings"
        description="Every reservation in this workspace. Use the desk scheduler for a calendar view."
        actions={
          <Link to="/desk/scheduler">
            <Button variant="outline" size="sm" className="gap-1.5">
              <CalendarDays className="size-3.5" />
              Open scheduler
            </Button>
          </Link>
        }
      />

      <FieldGroup className="md:grid md:grid-cols-12 md:gap-3">
        <Field className="md:col-span-3">
          <FieldLabel htmlFor="bookings-scope">Show</FieldLabel>
          <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
            <SelectTrigger id="bookings-scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCOPES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <p className="font-medium text-destructive">Failed to load bookings</p>
          <p className="text-muted-foreground mt-1">
            {error instanceof Error ? error.message : 'Unknown error'}
          </p>
          <p className="text-muted-foreground mt-2 text-xs">
            This page requires the <code className="chip">rooms.read_all</code> or
            <code className="chip"> rooms.admin</code> permission.
          </p>
        </div>
      ) : isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : items.length === 0 ? (
        <EmptyState scope={scope} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Room</TableHead>
                <TableHead>Requester</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Created</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((r) => (
                <BookingRow key={r.id} item={r} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SettingsPageShell>
  );
}

function BookingRow({ item }: {
  item: {
    id: string;
    space_name?: string | null;
    space_id: string;
    requester_first_name?: string | null;
    requester_last_name?: string | null;
    requester_person_id: string;
    start_at: string;
    end_at: string;
    status: ReservationStatus;
    created_at: string;
    attendee_count: number | null;
  };
}) {
  const requesterName = useMemo(() => {
    const first = item.requester_first_name?.trim();
    const last = item.requester_last_name?.trim();
    if (first || last) return [first, last].filter(Boolean).join(' ');
    return 'Unknown requester';
  }, [item.requester_first_name, item.requester_last_name]);

  const when = useMemo(() => {
    const start = new Date(item.start_at);
    const end = new Date(item.end_at);
    const sameDay = start.toDateString() === end.toDateString();
    const dateLabel = formatFullTimestamp(item.start_at).split(',').slice(0, 2).join(',');
    const timeRange = sameDay
      ? `${formatTimeOnly(item.start_at)}–${formatTimeOnly(item.end_at)}`
      : `${formatTimeOnly(item.start_at)} → ${formatFullTimestamp(item.end_at)}`;
    return { dateLabel, timeRange };
  }, [item.start_at, item.end_at]);

  return (
    <TableRow>
      <TableCell>
        <Link
          to={`/portal/me/bookings/${item.id}`}
          className="font-medium hover:underline"
        >
          {item.space_name ?? 'Unknown room'}
        </Link>
        {typeof item.attendee_count === 'number' && (
          <div className="text-xs text-muted-foreground">
            {item.attendee_count} {item.attendee_count === 1 ? 'attendee' : 'attendees'}
          </div>
        )}
      </TableCell>
      <TableCell>
        <span className="text-sm">{requesterName}</span>
      </TableCell>
      <TableCell>
        <div className="text-sm tabular-nums">{when.dateLabel}</div>
        <div className="text-xs text-muted-foreground tabular-nums">{when.timeRange}</div>
      </TableCell>
      <TableCell>
        <StatusPill status={item.status} />
      </TableCell>
      <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
        <time dateTime={item.created_at} title={formatFullTimestamp(item.created_at)}>
          {formatRelativeTime(item.created_at)}
        </time>
      </TableCell>
      <TableCell>
        <Link
          to={`/portal/me/bookings/${item.id}`}
          aria-label="Open booking"
          className="inline-flex h-8 items-center justify-center rounded-md px-2 hover:bg-accent"
        >
          <ChevronRight className="size-4 text-muted-foreground" />
        </Link>
      </TableCell>
    </TableRow>
  );
}

function StatusPill({ status }: { status: ReservationStatus }) {
  const color = {
    draft: 'outline',
    pending_approval: 'secondary',
    confirmed: 'default',
    checked_in: 'default',
    released: 'outline',
    cancelled: 'outline',
    completed: 'outline',
  }[status] as 'outline' | 'secondary' | 'default';

  const label =
    status === 'pending_approval' ? 'Awaiting approval' :
    status === 'checked_in' ? 'Checked in' :
    status.charAt(0).toUpperCase() + status.slice(1);

  return <Badge variant={color}>{label}</Badge>;
}

function EmptyState({ scope }: { scope: Scope }) {
  const message =
    scope === 'pending_approval'
      ? 'No bookings awaiting approval right now.'
      : scope === 'upcoming'
        ? 'No upcoming bookings.'
        : scope === 'past'
          ? 'No past bookings.'
          : scope === 'cancelled'
            ? 'No cancelled or released bookings.'
            : 'No bookings yet.';
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <Inbox className="size-9 text-muted-foreground/50" />
      <p className="font-medium text-muted-foreground">{message}</p>
      <p className="text-xs text-muted-foreground">
        Switch the filter above to see a different slice.
      </p>
    </div>
  );
}

function formatTimeOnly(iso: string): string {
  const d = new Date(iso);
  // Stable, locale-agnostic 24h time. Other timestamps go through @/lib/format.
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
