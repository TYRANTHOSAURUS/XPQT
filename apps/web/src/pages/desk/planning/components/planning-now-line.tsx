import { useNow } from '@/lib/use-now';

// Planning-board "now" line. Cloned from `scheduler-now-line.tsx` rather
// than imported — the booking version mounts inside a room-keyed grid,
// and we want positional independence from that subsystem.

interface Props {
  dates: string[];
  dayStartHour: number;
  dayEndHour: number;
  laneLabelWidth: number;
}

export function PlanningNowLine({ dates, dayStartHour, dayEndHour, laneLabelWidth }: Props) {
  const nowMs = useNow(60_000);
  const now = new Date(nowMs);

  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const todayStr = `${yyyy}-${mm}-${dd}`;

  const dayIndex = dates.indexOf(todayStr);
  if (dayIndex < 0) return null;

  const minutesInDay = (now.getHours() - dayStartHour) * 60 + now.getMinutes();
  const minutesPerDay = (dayEndHour - dayStartHour) * 60;
  if (minutesInDay < 0 || minutesInDay > minutesPerDay) return null;

  const dayFraction = 1 / dates.length;
  const fractionWithinDay = minutesInDay / minutesPerDay;
  const leftCalc = `calc(${laneLabelWidth}px + (100% - ${laneLabelWidth}px) * ${(dayIndex + fractionWithinDay) * dayFraction})`;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-0 z-30 w-px"
      style={{
        left: leftCalc,
        background: 'rgb(249 115 22)', // tailwind orange-500 — "now" indicator per spec
        boxShadow: '0 0 0 1px rgb(249 115 22 / 0.2)',
        transition: 'left 1s var(--ease-smooth)',
      }}
    >
      <div
        className="absolute -top-1 h-2 w-2 -translate-x-1/2 rounded-full"
        style={{ background: 'rgb(249 115 22)' }}
      />
    </div>
  );
}
