import { useMemo, useState } from 'react';
import { Map as MapIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { formatCount } from '@/lib/format';
import type { RankedRoom } from '@/api/room-booking';

interface Props {
  rooms: RankedRoom[];
  showRestricted?: boolean;
  onBook: (room: RankedRoom) => void;
}

/**
 * Per-floor SVG render of room polygons coloured by availability. Spec §4.10:
 *   - Green = available + matches criteria
 *   - Amber = warning / capacity tight
 *   - Purple = needs approval
 *   - Hatched / dimmed = unavailable
 *   - Hidden = denied (employee never sees these)
 *
 * Polygon data comes from `spaces.floor_plan_polygon` (jsonb) and the floor's
 * own `floor_plans` row. Today the picker doesn't return these — TODO when
 * the backend wires the polygon payload through, lift it via a parallel
 * query keyed on the visible floor ids and merge here.
 *
 * For now we render a friendly empty-state SVG with a TODO note so the toggle
 * is still present and the layout doesn't shift.
 */
export function FloorPlanPicker({ rooms, showRestricted, onBook }: Props) {
  const visible = useMemo(
    () =>
      rooms.filter(
        (r) => showRestricted || r.rule_outcome?.effect !== 'deny',
      ),
    [rooms, showRestricted],
  );

  return (
    <section
      aria-label="Floor plan picker"
      className="mt-3 rounded-lg border bg-card"
    >
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <MapIcon className="size-3.5" /> Floor plan
        </h3>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {formatCount(visible.length)} {visible.length === 1 ? 'room' : 'rooms'} on plan
        </span>
      </div>

      <div className="relative aspect-[16/9] w-full overflow-hidden rounded-b-lg bg-muted/20">
        <svg
          viewBox="0 0 800 450"
          xmlns="http://www.w3.org/2000/svg"
          className="absolute inset-0 size-full"
          role="img"
          aria-label="Floor plan with rooms"
        >
          {/* Background grid as visual scaffolding until polygon data is wired. */}
          <defs>
            <pattern id="floor-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeOpacity="0.06" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="800" height="450" fill="url(#floor-grid)" />

          {visible.map((room, idx) => (
            <RoomMarker
              key={room.space_id}
              room={room}
              x={60 + (idx % 4) * 180}
              y={50 + Math.floor(idx / 4) * 110}
              onBook={() => onBook(room)}
            />
          ))}
        </svg>
        {visible.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-center">
            <div className="space-y-1 px-6">
              <p className="text-sm text-muted-foreground">No rooms on plan for this floor.</p>
              <p className="text-[11px] text-muted-foreground/70">
                {/* TODO(phase-D follow-up): wire `spaces.floor_plan_polygon` payload through
                    the picker so each room renders as its real polygon. */}
                Floor-plan polygons aren't wired yet — listing falls back to fixed positions.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function RoomMarker({
  room,
  x,
  y,
  onBook,
}: {
  room: RankedRoom;
  x: number;
  y: number;
  onBook: () => void;
}) {
  const [open, setOpen] = useState(false);
  const effect = room.rule_outcome?.effect ?? 'allow';
  const fill = MARKER_FILL[effect];
  const stroke = MARKER_STROKE[effect];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <g
            tabIndex={0}
            role="button"
            aria-label={`${room.name} — ${effect}`}
            className="cursor-pointer outline-none"
          >
            <rect
              x={x}
              y={y}
              width={150}
              height={80}
              rx={6}
              fill={fill}
              stroke={stroke}
              strokeWidth={1.5}
              className={cn('transition-opacity', effect === 'deny' && 'opacity-40')}
              style={{ transitionDuration: '120ms', transitionTimingFunction: 'var(--ease-snap)' }}
            />
            <text
              x={x + 8}
              y={y + 22}
              fontSize="13"
              fontWeight="600"
              className="fill-foreground"
            >
              {room.name.length > 16 ? `${room.name.slice(0, 14)}…` : room.name}
            </text>
            <text
              x={x + 8}
              y={y + 42}
              fontSize="10"
              className="fill-muted-foreground tabular-nums"
            >
              {room.capacity ?? '—'} cap
            </text>
            <text
              x={x + 8}
              y={y + 60}
              fontSize="9"
              className="fill-muted-foreground"
            >
              {room.amenities.slice(0, 2).join(' · ')}
            </text>
          </g>
        }
      />
      <PopoverContent side="top" className="w-64">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h4 className="text-sm font-semibold">{room.name}</h4>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {room.capacity ?? '—'} cap
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {[...room.amenities, ...room.ranking_reasons].join(' · ')}
          </p>
          {room.rule_outcome?.denial_message && (
            <p className="rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-800 dark:text-amber-300">
              {room.rule_outcome.denial_message}
            </p>
          )}
          <Button
            size="sm"
            className="w-full"
            disabled={effect === 'deny'}
            onClick={() => {
              setOpen(false);
              onBook();
            }}
          >
            {effect === 'require_approval' ? 'Request' : 'Book'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const MARKER_FILL: Record<string, string> = {
  allow: 'rgba(16,185,129,0.15)',
  warn: 'rgba(245,158,11,0.15)',
  require_approval: 'rgba(168,85,247,0.15)',
  allow_override: 'rgba(168,85,247,0.10)',
  deny: 'rgba(239,68,68,0.10)',
};
const MARKER_STROKE: Record<string, string> = {
  allow: 'rgba(16,185,129,0.55)',
  warn: 'rgba(245,158,11,0.55)',
  require_approval: 'rgba(168,85,247,0.55)',
  allow_override: 'rgba(168,85,247,0.40)',
  deny: 'rgba(239,68,68,0.45)',
};
