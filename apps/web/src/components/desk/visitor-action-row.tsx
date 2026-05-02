/**
 * Visitor "action row" — large-text, low-density, with the primary
 * action button rendered inline. Used by the desk's loose-ends fallback
 * view (yesterday's tile inside /desk/visitors), the detail panel, and
 * the walk-up search overlay where reception needs to hit "Mark
 * arrived" without going through a context menu.
 *
 * For dense list/table rows mirroring /desk/tickets, see
 * `visitor-list-row.tsx` and the inline table-row component in the
 * page itself.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §7.3
 *
 * Action set is determined by the row's status:
 *   - expected            → Mark arrived (with backdated dropdown)
 *   - arrived             → Assign pass (if no pass) | Mark left
 *   - in_meeting          → Mark left
 *   - checked_out         → (no actions; row is shown for visibility only)
 *
 * "Mark arrived" hosts a small split button: clicking the main button
 * arrives now; clicking the chevron opens a popover with a HH:mm input
 * to backdate.
 */
import { memo, useState } from 'react';
import { ChevronDown, Clock, KeyRound, LogOut, UserCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  formatPrimaryHost,
  formatReceptionRowName,
  type ReceptionVisitorRow as RowT,
} from '@/api/visitors/reception';
import { VisitorStatusBadge } from '@/components/visitors/visitor-status-badge';
import { formatTimeShort, formatFullTimestamp } from '@/lib/format';

/** Convert HH:mm + today's date → ISO string. Returns undefined if invalid. */
function localTimeToIso(hhmm: string): string | undefined {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return undefined;
  const [hh, mi] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(hh, mi, 0, 0);
  return d.toISOString();
}

interface ReceptionVisitorRowProps {
  row: RowT;
  onCheckIn: (arrivedAt?: string) => void;
  onCheckOut: () => void;
  onAssignPass: () => void;
  onNoShow?: () => void;
  /** Disable buttons while a mutation is pending for this row. */
  busy?: boolean;
}

function ReceptionVisitorRowImpl({
  row,
  onCheckIn,
  onCheckOut,
  onAssignPass,
  onNoShow,
  busy,
}: ReceptionVisitorRowProps) {
  const host = formatPrimaryHost(row);
  const time = row.expected_at ? formatTimeShort(row.expected_at) : null;
  const ts = row.expected_at ?? row.arrived_at ?? null;
  const fullTs = ts ? formatFullTimestamp(ts) : null;

  return (
    <div className="flex items-center gap-4 px-4 py-3 hover:bg-muted/30 transition-colors duration-150 [transition-timing-function:var(--ease-snap)]">
      {time && (
        <time
          dateTime={ts ?? undefined}
          title={fullTs ?? undefined}
          className="text-base font-medium tabular-nums w-16 shrink-0 text-muted-foreground"
        >
          {time}
        </time>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium truncate">
          {formatReceptionRowName(row)}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {host ? <>Host: {host}</> : <span className="italic">No host on record</span>}
          {row.pass_number && (
            <>
              <span className="mx-1.5">·</span>
              <span className="inline-flex items-center gap-1">
                <KeyRound className="size-3" aria-hidden /> #{row.pass_number}
              </span>
            </>
          )}
        </div>
      </div>
      <VisitorStatusBadge status={row.status} />
      <RowActions
        row={row}
        busy={busy}
        onCheckIn={onCheckIn}
        onCheckOut={onCheckOut}
        onAssignPass={onAssignPass}
        onNoShow={onNoShow}
      />
    </div>
  );
}

/** Memoised — the today-view polls every 15s. Without this each parent
 *  refetch re-renders every visitor row even when its data didn't change.
 *  Callbacks are recreated on each parent render so a default shallow
 *  compare wouldn't help; we compare row identity + busy state explicitly. */
export const VisitorActionRow = memo(
  ReceptionVisitorRowImpl,
  (prev, next) => prev.row === next.row && prev.busy === next.busy,
);

/** Legacy alias — historical callers (and a few tests if they ever land)
 *  still expect `ReceptionVisitorRow`. Re-export the new name as the same
 *  symbol so the import surface stays stable while we migrate. */
export const ReceptionVisitorRow = VisitorActionRow;

function RowActions({
  row,
  busy,
  onCheckIn,
  onCheckOut,
  onAssignPass,
  onNoShow,
}: ReceptionVisitorRowProps) {
  if (row.status === 'expected' || row.status === 'pending_approval') {
    return (
      <div className="flex items-center gap-1.5 shrink-0">
        <CheckInSplitButton onCheckIn={onCheckIn} disabled={busy} />
        {onNoShow && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onNoShow}
            disabled={busy}
            aria-label="Mark no-show"
          >
            <X className="size-4" aria-hidden />
            No-show
          </Button>
        )}
      </div>
    );
  }
  if (row.status === 'arrived' || row.status === 'in_meeting') {
    return (
      <div className="flex items-center gap-1.5 shrink-0">
        {!row.pass_number && (
          <Button
            variant="outline"
            size="sm"
            onClick={onAssignPass}
            disabled={busy}
          >
            <KeyRound className="size-4" aria-hidden />
            Assign pass
          </Button>
        )}
        <Button variant="default" size="sm" onClick={onCheckOut} disabled={busy}>
          <LogOut className="size-4" aria-hidden />
          Mark left
        </Button>
      </div>
    );
  }
  // checked_out / no_show / cancelled — no inline actions.
  return null;
}

/** "Mark arrived" with a chevron-dropdown to backdate. */
function CheckInSplitButton({
  onCheckIn,
  disabled,
}: {
  onCheckIn: (arrivedAt?: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState(() => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });

  return (
    <div className="inline-flex">
      <Button
        variant="default"
        size="sm"
        className="rounded-r-none"
        onClick={() => onCheckIn()}
        disabled={disabled}
      >
        <UserCheck className="size-4" aria-hidden />
        Mark arrived
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="default"
              size="sm"
              className="rounded-l-none border-l border-primary-foreground/20 px-1.5"
              disabled={disabled}
              aria-label="Backdate arrival"
            />
          }
        >
          <ChevronDown className="size-4" aria-hidden />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64">
          <div className="flex flex-col gap-3">
            <div className="text-sm font-medium">Backdate arrival</div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="checkin-time" className="text-xs text-muted-foreground">
                Actually arrived at
              </label>
              <Input
                id="checkin-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                step={60}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  onCheckIn(localTimeToIso(time));
                  setOpen(false);
                }}
              >
                <Clock className="size-4" aria-hidden />
                Use this time
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
