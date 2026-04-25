import { useEffect, useState } from 'react';

interface Props {
  dates: string[];
  dayStartHour: number;
  dayEndHour: number;
  /** px width of the leading room-name column. */
  rowLabelWidth: number;
}

/**
 * Vertical "now" line drawn over the grid. Updates every minute; absolute
 * positioning so it doesn't reflow the grid.
 *
 * Hides itself when "now" falls outside the visible window (e.g. operator
 * is paged forward to next week, or before today's dayStartHour).
 */
export function SchedulerNowLine({ dates, dayStartHour, dayEndHour, rowLabelWidth }: Props) {
  // Re-render every minute so the line glides forward smoothly.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  // Reference `tick` so eslint no-unused doesn't yell; the value itself
  // doesn't matter — its existence is what schedules the rerender.
  void tick;

  const now = new Date();
  const todayStr = (() => {
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  })();

  const dayIndex = dates.indexOf(todayStr);
  if (dayIndex < 0) return null;

  const minutesInDay = (now.getHours() - dayStartHour) * 60 + now.getMinutes();
  const minutesPerDay = (dayEndHour - dayStartHour) * 60;
  if (minutesInDay < 0 || minutesInDay > minutesPerDay) return null;

  // Each day occupies (1 / dates.length) of the post-label width.
  const dayFraction = 1 / dates.length;
  const fractionWithinDay = minutesInDay / minutesPerDay;
  // CSS: position from rowLabelWidth + (dayIndex + fractionWithinDay) * (100% - rowLabelWidth) / dates.length
  const leftCalc = `calc(${rowLabelWidth}px + (100% - ${rowLabelWidth}px) * ${(dayIndex + fractionWithinDay) * dayFraction})`;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-0 w-px z-30"
      style={{
        left: leftCalc,
        background: 'rgb(239 68 68)', // tailwind red-500 — matches the "now" convention
        boxShadow: '0 0 0 1px rgb(239 68 68 / 0.18)',
        transition: 'left 1s var(--ease-smooth)',
      }}
    >
      <div
        className="absolute -top-1 -translate-x-1/2 h-2 w-2 rounded-full"
        style={{ background: 'rgb(239 68 68)' }}
      />
    </div>
  );
}
