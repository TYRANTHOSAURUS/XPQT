import { useMemo, useState } from 'react';
import { Calendar, CheckCircle2, AlertTriangle, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import {
  SettingsPageShell,
  SettingsPageHeader,
} from '@/components/ui/settings-page';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatRelativeTime, formatFullTimestamp, formatCount } from '@/lib/format';
import {
  useCalendarSyncHealth,
  useCalendarSyncConflicts,
  useResolveConflict,
  type ConflictRow,
  type ResolveConflictBody,
  type SyncHealthRoom,
} from '@/api/calendar-sync';

/**
 * /admin/calendar-sync
 *
 * Per spec §4.8 — sync-health page + conflicts inbox. Width=wide because
 * the per-room status table benefits from horizontal room without falling
 * into "dashboard" territory.
 */
export function AdminCalendarSyncPage() {
  const { data: health, isLoading: healthLoading } = useCalendarSyncHealth();
  const { data: conflicts, isLoading: conflictsLoading } = useCalendarSyncConflicts('open');

  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        backTo="/admin"
        title="Calendar sync"
        description="Per-room sync status with Microsoft Outlook, plus an inbox for the rare cases that need a human decision."
      />

      <CountersStrip
        loading={healthLoading}
        counters={health?.counters}
      />

      <RoomsTable
        loading={healthLoading}
        rooms={health?.rooms ?? []}
      />

      <ConflictsInbox
        loading={conflictsLoading}
        conflicts={conflicts ?? []}
      />
    </SettingsPageShell>
  );
}

// ─── Counters strip ─────────────────────────────────────────────────────

function CountersStrip({
  loading,
  counters,
}: {
  loading: boolean;
  counters: { intercepted_30d: number; accepted_30d: number; denied_30d: number; unresolved_open: number } | undefined;
}) {
  const items = useMemo(
    () => [
      { label: 'Intercepted (30d)', value: counters?.intercepted_30d ?? 0 },
      { label: 'Accepted (30d)', value: counters?.accepted_30d ?? 0, accent: 'positive' as const },
      { label: 'Denied (30d)', value: counters?.denied_30d ?? 0, accent: 'warning' as const },
      { label: 'Unresolved', value: counters?.unresolved_open ?? 0, accent: counters?.unresolved_open ? ('destructive' as const) : ('positive' as const) },
    ],
    [counters],
  );

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-lg border bg-card px-4 py-3 flex flex-col gap-1"
        >
          <div className="text-xs text-muted-foreground uppercase tracking-wide">{item.label}</div>
          <div
            className={
              item.accent === 'destructive'
                ? 'text-2xl font-semibold text-destructive tabular-nums'
                : item.accent === 'warning'
                  ? 'text-2xl font-semibold text-amber-600 dark:text-amber-400 tabular-nums'
                  : item.accent === 'positive'
                    ? 'text-2xl font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums'
                    : 'text-2xl font-semibold tabular-nums'
            }
          >
            {loading ? '—' : formatCount(item.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Rooms table ────────────────────────────────────────────────────────

function RoomsTable({ loading, rooms }: { loading: boolean; rooms: SyncHealthRoom[] }) {
  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading rooms…</div>;
  }
  if (rooms.length === 0) {
    return (
      <div className="rounded-lg border bg-card px-6 py-12 flex flex-col items-center gap-3 text-center">
        <Calendar className="size-6 text-muted-foreground" />
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium">No reservable rooms yet</h2>
          <p className="text-sm text-muted-foreground max-w-sm">
            Once you mark a room as reservable in <span className="font-medium">Locations</span>,
            its calendar sync status will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Room</TableHead>
            <TableHead className="w-[120px]">Mode</TableHead>
            <TableHead className="w-[180px]">Mailbox</TableHead>
            <TableHead className="w-[160px]">Webhook</TableHead>
            <TableHead className="w-[160px]">Last full sync</TableHead>
            <TableHead className="w-[120px]">Open issues</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rooms.map((room) => (
            <TableRow key={room.space_id}>
              <TableCell className="font-medium">{room.space_name}</TableCell>
              <TableCell>
                <Badge variant={room.calendar_sync_mode === 'pattern_a' ? 'default' : 'secondary'}>
                  {room.calendar_sync_mode === 'pattern_a' ? 'Pattern A' : 'Pattern B'}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {room.external_calendar_id ? (
                  <span className="font-mono text-xs">{room.external_calendar_id}</span>
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell className="text-sm">
                {room.external_calendar_subscription_expires_at ? (
                  isExpiringSoon(room.external_calendar_subscription_expires_at) ? (
                    <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="size-3.5" />
                      <time
                        dateTime={room.external_calendar_subscription_expires_at}
                        title={formatFullTimestamp(room.external_calendar_subscription_expires_at)}
                      >
                        {formatRelativeTime(room.external_calendar_subscription_expires_at)}
                      </time>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="size-3.5" />
                      <time
                        dateTime={room.external_calendar_subscription_expires_at}
                        title={formatFullTimestamp(room.external_calendar_subscription_expires_at)}
                      >
                        {formatRelativeTime(room.external_calendar_subscription_expires_at)}
                      </time>
                    </span>
                  )
                ) : room.calendar_sync_mode === 'pattern_a' ? (
                  <span className="text-amber-600 dark:text-amber-400">Not subscribed</span>
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {room.external_calendar_last_full_sync_at ? (
                  <time
                    dateTime={room.external_calendar_last_full_sync_at}
                    title={formatFullTimestamp(room.external_calendar_last_full_sync_at)}
                  >
                    {formatRelativeTime(room.external_calendar_last_full_sync_at)}
                  </time>
                ) : (
                  'Never'
                )}
              </TableCell>
              <TableCell>
                {room.open_conflicts > 0 ? (
                  <Badge variant="destructive">{room.open_conflicts}</Badge>
                ) : (
                  <Badge variant="secondary">0</Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function isExpiringSoon(iso: string): boolean {
  const ms = new Date(iso).getTime() - Date.now();
  return ms > 0 && ms < 6 * 60 * 60 * 1000; // < 6 hours
}

// ─── Conflicts inbox ────────────────────────────────────────────────────

const CONFLICT_LABEL: Record<ConflictRow['conflict_type'], string> = {
  etag_mismatch: 'ETag mismatch',
  recurrence_drift: 'Recurrence drift',
  orphan_external: 'Orphan in Outlook',
  orphan_internal: 'Orphan in Prequest',
  webhook_miss_recovered: 'Webhook miss (recovered)',
};

function ConflictsInbox({ loading, conflicts }: { loading: boolean; conflicts: ConflictRow[] }) {
  const [resolving, setResolving] = useState<ConflictRow | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-medium">Conflicts inbox</h2>
        <p className="text-xs text-muted-foreground">
          {conflicts.length === 0 ? 'Nothing to do — sync is healthy.' : `${conflicts.length} open`}
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Loading…
        </div>
      ) : conflicts.length === 0 ? (
        <div className="rounded-lg border bg-card px-6 py-10 flex flex-col items-center gap-2 text-center">
          <CheckCircle2 className="size-6 text-emerald-500" />
          <div className="text-sm text-muted-foreground">All clear.</div>
        </div>
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[160px]">Detected</TableHead>
                <TableHead>Room</TableHead>
                <TableHead className="w-[200px]">Type</TableHead>
                <TableHead className="w-[120px] text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {conflicts.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="text-sm text-muted-foreground">
                    <time dateTime={c.detected_at} title={formatFullTimestamp(c.detected_at)}>
                      {formatRelativeTime(c.detected_at)}
                    </time>
                  </TableCell>
                  <TableCell className="font-medium">{c.space_name ?? c.space_id}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{CONFLICT_LABEL[c.conflict_type]}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => setResolving(c)}>
                      Resolve
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ResolveDialog
        conflict={resolving}
        onClose={() => setResolving(null)}
      />
    </div>
  );
}

function ResolveDialog({
  conflict,
  onClose,
}: {
  conflict: ConflictRow | null;
  onClose: () => void;
}) {
  const resolve = useResolveConflict();
  const [action, setAction] = useState<ResolveConflictBody['action']>('keep_internal');
  const [note, setNote] = useState('');

  const onSubmit = async () => {
    if (!conflict) return;
    try {
      await resolve.mutateAsync({ id: conflict.id, body: { action, note: note || undefined } });
      toast.success('Conflict resolved');
      onClose();
      setNote('');
      setAction('keep_internal');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Resolve failed');
    }
  };

  return (
    <Dialog open={Boolean(conflict)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve conflict</DialogTitle>
          <DialogDescription>
            {conflict
              ? `${CONFLICT_LABEL[conflict.conflict_type]} on ${conflict.space_name ?? conflict.space_id}`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="resolve-action">What should we do?</FieldLabel>
            <Select value={action} onValueChange={(v) => setAction(v as ResolveConflictBody['action'])}>
              <SelectTrigger id="resolve-action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="keep_internal">Keep Prequest, cancel in Outlook</SelectItem>
                <SelectItem value="keep_external">Adopt Outlook, cancel in Prequest</SelectItem>
                <SelectItem value="recreate">Re-run intercept (recreate from external)</SelectItem>
                <SelectItem value="wont_fix">Leave as-is (won't fix)</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>
              Choose how Prequest and Outlook should agree on this slot.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="resolve-note">Note (optional)</FieldLabel>
            <Textarea
              id="resolve-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why this resolution? Shown in audit log."
            />
          </Field>
          {conflict?.external_event_id && (
            <Field>
              <FieldLabel>External event id</FieldLabel>
              <code className="chip text-xs font-mono break-all">{conflict.external_event_id}</code>
            </Field>
          )}
        </FieldGroup>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={resolve.isPending}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={resolve.isPending} className="gap-1.5">
            {resolve.isPending ? <Spinner className="size-3.5" /> : <ExternalLink className="size-3.5" />}
            Resolve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
