import { memo, useMemo } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  dates: string[];
  dayStartHour: number;
  dayEndHour: number;
  cellMinutes: number;
  rowLabelWidth?: number;
}

const HOUR_LABEL_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
});

const DAY_LABEL_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

/**
 * Header row above the rooms grid. Mirrors the row's outer layout exactly
 * (`{rowLabelWidth}px 1fr`) and positions the hour ticks via absolute
 * percentage offsets inside the time area — the same math the rows use to
 * paint event blocks. This guarantees pixel-perfect alignment between the
 * axis and the row contents at any container width and any view mode.
 *
 * Day-view: a row of hour labels.
 * Week-view: same row, with each day's first hour cell carrying the day
 * label so the operator can scan day boundaries quickly.
 */
export const SchedulerTimeAxis = memo(function SchedulerTimeAxis({
  dates,
  dayStartHour,
  dayEndHour,
  cellMinutes,
  rowLabelWidth = 220,
}: Props) {
  const hoursPerDay = dayEndHour - dayStartHour;
  const cellsPerHour = Math.max(1, 60 / cellMinutes);
  const totalHours = hoursPerDay * dates.length;
  const totalCells = totalHours * cellsPerHour;

  const today = useMemo(() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }, []);

  const ticks = useMemo(() => {
    const out: Array<{
      key: string;
      leftPct: number;
      widthPct: number;
      hourLabel: string;
      dayLabel: string | null;
      isDayBoundary: boolean;
      isToday: boolean;
    }> = [];
    for (let d = 0; d < dates.length; d++) {
      const dateStr = dates[d];
      const isToday = dateStr === today;
      const dayLabel = DAY_LABEL_FORMATTER.format(new Date(`${dateStr}T12:00:00`));
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
          dayLabel: h === 0 ? dayLabel : null,
          isDayBoundary: h === 0,
          isToday,
        });
      }
    }
    return out;
  }, [dates, dayStartHour, hoursPerDay, today, totalHours]);

  const showDayLabel = dates.length > 1;
  const headerHeight = showDayLabel ? 'h-12' : 'h-9';

  return (
    <div
      className={cn(
        'sticky top-0 z-20 grid border-b bg-background/95 backdrop-blur-sm',
        headerHeight,
      )}
      style={{ gridTemplateColumns: `${rowLabelWidth}px 1fr` }}
    >
      {/* Top-left: room column header */}
      <div className="sticky left-0 z-10 flex items-end gap-1 border-r bg-background/95 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Rooms
        <span className="text-muted-foreground/60 normal-case">·</span>
        <span className="tabular-nums normal-case text-muted-foreground/60">
          {totalCells} slots
        </span>
      </div>

      {/* Time area — absolutely-positioned hour ticks, mirrors row math */}
      <div className="relative">
        {ticks.map((t) => (
          <div
            key={t.key}
            className={cn(
              'absolute top-0 bottom-0 flex flex-col justify-end overflow-hidden px-1 pb-1 text-[10px] tabular-nums text-muted-foreground',
              t.isDayBoundary && 'border-l',
              t.isDayBoundary && t.isToday && 'border-l-foreground/40',
              !t.isDayBoundary && 'border-l border-l-border/40',
            )}
            style={{
              left: `${t.leftPct}%`,
              width: `${t.widthPct}%`,
            }}
          >
            {showDayLabel && t.dayLabel && (
              <div
                className={cn(
                  'truncate text-[11px] font-medium',
                  t.isToday ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {t.dayLabel}
              </div>
            )}
            <div className="truncate">{t.hourLabel}</div>
          </div>
        ))}
      </div>
    </div>
  );
});
