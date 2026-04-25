import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { RankedRoom } from '@/api/room-booking';

interface Props {
  /** Day-block summary returned by /reservations/picker for this room. */
  blocks: RankedRoom['day_blocks'];
  /** ISO start of the requested slot (the highlighted window). */
  requestedStartIso: string;
  /** ISO end of the requested slot. */
  requestedEndIso: string;
  /**
   * Day window covered by the strip. Defaults to 8:00 → 18:00 (20 fifteen-min
   * blocks per hour, 40 total). Use the room's calendar for tenant-specific
   * hours once we wire it through.
   */
  startHour?: number;
  endHour?: number;
  /** Compact rendering for dense list views. */
  compact?: boolean;
}

interface Cell {
  startMs: number;
  endMs: number;
  status: 'free' | 'closed' | 'busy' | 'pending' | 'requested' | 'yours';
  isRequested: boolean;
}

const BLOCK_MINUTES = 30;

/**
 * Day-availability strip — half-hour cells from `startHour` to `endHour`.
 * The user's requested slot is outlined with an accent ring; busy / pending
 * cells use distinct hues so a quick glance reads "what part of the day is
 * already claimed". Hour ticks below the strip make this glance trivial.
 */
export function MiniTimelineStrip({
  blocks,
  requestedStartIso,
  requestedEndIso,
  startHour = 8,
  endHour = 18,
  compact = false,
}: Props) {
  const cells = useMemo<Cell[]>(() => {
    const reqStart = new Date(requestedStartIso).getTime();
    const reqEnd = new Date(requestedEndIso).getTime();
    if (!Number.isFinite(reqStart) || !Number.isFinite(reqEnd)) return [];

    const dayAnchor = new Date(reqStart);
    dayAnchor.setHours(startHour, 0, 0, 0);

    const totalMinutes = (endHour - startHour) * 60;
    const blockCount = Math.floor(totalMinutes / BLOCK_MINUTES);
    const out: Cell[] = [];

    for (let i = 0; i < blockCount; i++) {
      const cellStart = dayAnchor.getTime() + i * BLOCK_MINUTES * 60_000;
      const cellEnd = cellStart + BLOCK_MINUTES * 60_000;

      let status: Cell['status'] = 'free';
      let isYours = false;
      for (const b of blocks ?? []) {
        const bs = new Date(b.start).getTime();
        const be = new Date(b.end).getTime();
        if (cellEnd > bs && cellStart < be) {
          status = b.status === 'requested' ? 'pending' : b.status;
          isYours = isYours || Boolean(b.is_yours);
          break;
        }
      }
      if (isYours) status = 'yours';

      const isRequested = cellEnd > reqStart && cellStart < reqEnd;
      out.push({ startMs: cellStart, endMs: cellEnd, status, isRequested });
    }
    return out;
  }, [blocks, requestedStartIso, requestedEndIso, startHour, endHour]);

  if (cells.length === 0) {
    return <div className="h-3.5 rounded-md bg-muted/30" aria-hidden />;
  }

  // Tick at every other hour so the row stays uncluttered.
  const tickHours: number[] = [];
  for (let h = startHour; h <= endHour; h += 2) tickHours.push(h);

  return (
    <div className={cn('space-y-1.5', compact && 'space-y-1')} aria-label="Day availability" role="img">
      <div
        className={cn('grid gap-[2px] rounded-md p-[2px]', compact ? 'h-3' : 'h-4', 'bg-muted/40')}
        style={{ gridTemplateColumns: `repeat(${cells.length}, 1fr)` }}
      >
        {cells.map((c, i) => (
          <span
            key={i}
            className={cn(
              'rounded-[2px]',
              CELL_STYLES[c.status],
              c.isRequested && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
            )}
            title={`${formatHourMin(c.startMs)} — ${labelFor(c.status)}`}
          />
        ))}
      </div>
      <div className="relative h-3 text-[10px] tabular-nums text-muted-foreground/70">
        {tickHours.map((h, i) => {
          const left = ((h - startHour) / (endHour - startHour)) * 100;
          return (
            <span
              key={h}
              className="absolute -translate-x-1/2"
              style={{ left: `${left}%` }}
            >
              {i === 0 || i === tickHours.length - 1
                ? `${pad(h)}:00`
                : pad(h)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function formatHourMin(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function labelFor(s: Cell['status']): string {
  switch (s) {
    case 'free': return 'Free';
    case 'busy': return 'Busy';
    case 'pending': return 'Pending';
    case 'requested': return 'Requested';
    case 'yours': return 'Yours';
    case 'closed': return 'Closed';
  }
}

const CELL_STYLES: Record<Cell['status'], string> = {
  // Subtle, paper-friendly palette. Free is barely-there green, busy is
  // a muted graphite, the user's own bookings stand out in blue.
  free: 'bg-emerald-400/55 dark:bg-emerald-400/45',
  closed: 'bg-muted/50',
  busy: 'bg-foreground/25 dark:bg-foreground/30',
  pending: 'bg-amber-400/65 dark:bg-amber-400/50',
  requested: 'bg-amber-400/65 dark:bg-amber-400/50',
  yours: 'bg-sky-500/70 dark:bg-sky-400/65',
};
