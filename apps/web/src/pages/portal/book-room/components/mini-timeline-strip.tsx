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
   * Day window covered by the strip. Defaults to 8:00 → 18:00 (16 half-hour
   * blocks) per the spec mockup. Use the room's calendar for tenant-specific
   * hours once we wire it through.
   */
  startHour?: number;
  endHour?: number;
}

interface Cell {
  startMs: number;
  endMs: number;
  status: 'free' | 'closed' | 'busy' | 'pending' | 'requested' | 'yours';
  /** True if this cell overlaps the user's requested slot. */
  isRequested: boolean;
}

const BLOCK_MINUTES = 30;

/**
 * 16-block mini day strip per spec §4.1. Each block is a half-hour;
 * cell colour signals availability, the user's requested slot is outlined.
 *
 * Mockup at .superpowers/brainstorm/.../portal-picker.html shows:
 *   - greyed cells outside business hours
 *   - emerald cells for free
 *   - blue cells for the user's existing bookings
 *   - amber/purple/etc for busy / pending
 *   - 2px outline around the cells matching the user's requested slot
 */
export function MiniTimelineStrip({
  blocks,
  requestedStartIso,
  requestedEndIso,
  startHour = 8,
  endHour = 18,
}: Props) {
  const cells = useMemo<Cell[]>(() => {
    const reqStart = new Date(requestedStartIso).getTime();
    const reqEnd = new Date(requestedEndIso).getTime();
    if (!Number.isFinite(reqStart) || !Number.isFinite(reqEnd)) return [];

    // Anchor the strip to the requested day's startHour. This keeps the
    // strip stable even if the tenant has DST transitions or odd offsets.
    const dayAnchor = new Date(reqStart);
    dayAnchor.setHours(startHour, 0, 0, 0);

    const totalMinutes = (endHour - startHour) * 60;
    const blockCount = Math.floor(totalMinutes / BLOCK_MINUTES);
    const out: Cell[] = [];

    for (let i = 0; i < blockCount; i++) {
      const cellStart = dayAnchor.getTime() + i * BLOCK_MINUTES * 60_000;
      const cellEnd = cellStart + BLOCK_MINUTES * 60_000;

      // The day_blocks payload from the picker is the source of truth for
      // busy/pending cells. If a cell intersects any block we adopt that
      // block's status; otherwise the cell is free (within business hours)
      // or closed (we don't currently get business-hours back, so this
      // simplification just calls everything outside `blocks` "free").
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
    return <div className="h-3.5 rounded-sm bg-muted/40" aria-hidden />;
  }

  return (
    <div className="space-y-1" aria-label="Day availability strip" role="img">
      <div
        className="grid h-3.5 gap-px"
        style={{ gridTemplateColumns: `repeat(${cells.length}, 1fr)` }}
      >
        {cells.map((c, i) => (
          <span
            key={i}
            className={cn(
              'rounded-[2px] transition-[background-color] duration-150',
              CELL_STYLES[c.status],
              c.isRequested && 'outline outline-2 outline-offset-1 outline-primary',
            )}
            style={{ transitionTimingFunction: 'var(--ease-snap)' }}
          />
        ))}
      </div>
      <div className="flex justify-between text-[9px] tabular-nums text-muted-foreground/70">
        {[startHour, Math.round((startHour + endHour) / 2), endHour].map((h, idx) => (
          <span key={idx}>{h}:00</span>
        ))}
      </div>
    </div>
  );
}

const CELL_STYLES: Record<Cell['status'], string> = {
  free: 'bg-emerald-500/70',
  closed: 'bg-muted/40',
  busy: 'bg-foreground/15',
  pending: 'bg-amber-500/60',
  requested: 'bg-amber-500/60',
  yours: 'bg-blue-500/70',
};
