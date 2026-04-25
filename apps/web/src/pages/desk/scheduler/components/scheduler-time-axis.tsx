import { memo, useMemo } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  dates: string[];
  dayStartHour: number;
  dayEndHour: number;
  cellMinutes: number;
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
 * The header row above the rooms grid. Renders one tick per hour
 * (deterministic, axis-only, so we use Intl directly per CLAUDE.md
 * "axis labels are deterministic and not user data").
 *
 * Memoised — re-renders only when the date range or hours change.
 */
export const SchedulerTimeAxis = memo(function SchedulerTimeAxis({
  dates,
  dayStartHour,
  dayEndHour,
  cellMinutes,
}: Props) {
  const hoursPerDay = dayEndHour - dayStartHour;
  const cellsPerHour = Math.max(1, 60 / cellMinutes);

  const today = useMemo(() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }, []);

  return (
    <div className="grid sticky top-0 z-20 bg-background/95 backdrop-blur-sm border-b" style={{
      gridTemplateColumns: `220px repeat(${dates.length * hoursPerDay}, minmax(48px, 1fr))`,
    }}>
      {/* Top-left: room column header spacer */}
      <div className="border-r border-b/0 px-3 py-2 text-xs font-medium text-muted-foreground sticky left-0 bg-background/95 z-10">
        Room
      </div>

      {dates.map((dateStr) => {
        const isToday = dateStr === today;
        const dayLabel = DAY_LABEL_FORMATTER.format(new Date(`${dateStr}T12:00:00`));
        return Array.from({ length: hoursPerDay }, (_, i) => {
          const hour = dayStartHour + i;
          const date = new Date(`${dateStr}T00:00:00`);
          date.setHours(hour, 0, 0, 0);
          const hourLabel = HOUR_LABEL_FORMATTER.format(date);
          return (
            <div
              key={`${dateStr}-${i}`}
              className={cn(
                'px-1 py-2 text-[10px] tabular-nums text-muted-foreground border-l',
                i === 0 && 'border-l-2 border-l-border',
                isToday && i === 0 && 'border-l-foreground/40',
              )}
              style={{ gridColumn: `span ${cellsPerHour}` }}
            >
              {i === 0 && (
                <div className={cn('text-[11px] font-medium', isToday ? 'text-foreground' : 'text-muted-foreground')}>
                  {dayLabel}
                </div>
              )}
              <div>{hourLabel}</div>
            </div>
          );
        });
      })}
    </div>
  );
});
