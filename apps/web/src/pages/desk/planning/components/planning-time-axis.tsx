import { memo, useMemo } from 'react';
import { cn } from '@/lib/utils';

// Adapted from `scheduler-time-axis.tsx` — the room-booking version is
// room-coupled (its parent grid expects rooms / `data-space-id`), so we
// inline a planning-shaped clone rather than import-and-pray. Visual
// tokens kept identical so the two grids feel like siblings.

interface Props {
  dates: string[];
  dayStartHour: number;
  dayEndHour: number;
  cellMinutes: number;
  laneLabelWidth?: number;
}

const TENANT_TIME_ZONE = 'Europe/Amsterdam';

const HOUR_LABEL_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  hour: 'numeric',
  hour12: false,
  timeZone: TENANT_TIME_ZONE,
});

export const PlanningTimeAxis = memo(function PlanningTimeAxis({
  dates,
  dayStartHour,
  dayEndHour,
  cellMinutes,
  laneLabelWidth = 240,
}: Props) {
  const hoursPerDay = dayEndHour - dayStartHour;
  const totalHours = hoursPerDay * dates.length;

  const ticks = useMemo(() => {
    const out: Array<{ key: string; leftPct: number; widthPct: number; hourLabel: string }> = [];
    for (let d = 0; d < dates.length; d++) {
      const dateStr = dates[d];
      for (let h = 0; h < hoursPerDay; h++) {
        const hour = dayStartHour + h;
        const date = new Date(`${dateStr}T00:00:00`);
        date.setHours(hour, 0, 0, 0);
        const hourLabel = HOUR_LABEL_FORMATTER.format(date);
        const idx = d * hoursPerDay + h;
        out.push({
          key: `${dateStr}-${h}`,
          leftPct: (idx / totalHours) * 100,
          widthPct: (1 / totalHours) * 100,
          hourLabel,
        });
      }
    }
    return out;
  }, [dates, dayStartHour, hoursPerDay, totalHours]);

  void cellMinutes; // currently uses one hour as the major tick; reserved for finer sub-grids.

  return (
    <div
      className="sticky top-0 z-20 grid h-9 border-b bg-background/95 backdrop-blur-sm"
      style={{ gridTemplateColumns: `${laneLabelWidth}px 1fr` }}
    >
      <div className="sticky left-0 z-10 flex items-end gap-1 border-r bg-background/95 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Lane
      </div>
      <div className="relative">
        {ticks.map((t) => (
          <div
            key={t.key}
            className={cn(
              'absolute top-0 bottom-0 flex flex-col justify-end overflow-hidden px-1 pb-1 text-[10px] tabular-nums text-muted-foreground',
              'border-l border-l-border/40',
            )}
            style={{ left: `${t.leftPct}%`, width: `${t.widthPct}%` }}
          >
            <div className="truncate">{t.hourLabel}</div>
          </div>
        ))}
      </div>
    </div>
  );
});
