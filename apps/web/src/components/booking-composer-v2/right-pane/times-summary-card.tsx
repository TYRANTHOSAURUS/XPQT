import { Clock } from 'lucide-react';
import { formatTimeShort } from '@/lib/format';
import { SummaryCard } from './summary-card';

export interface TimesSummaryCardProps {
  startAt: string | null;
  endAt: string | null;
  /**
   * Focus the inline TimeRow on the left pane (modal wires this — there is
   * no `picker:time` view because times are edited inline).
   */
  onPick: () => void;
}

/**
 * Local weekday + short-date label ("Wed, May 7"). Lives here rather than
 * in `@/lib/format` because no other surface needs the weekday-without-year
 * variant; the shared `formatDayLabel` includes the year.
 */
const weekdayDateFormatter = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

function formatWeekdayDate(input: string): string {
  return weekdayDateFormatter.format(new Date(input));
}

/** Local YYYY-MM-DD key — used to detect "different calendar day" in the
 *  user's local timezone, not UTC. */
function localDayKey(input: string): string {
  const d = new Date(input);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isValidIso(input: string | null): input is string {
  if (input == null || input === '') return false;
  const ts = new Date(input).getTime();
  return Number.isFinite(ts);
}

/**
 * Summary-only domain card for the right pane's start/end time slot. Two
 * states:
 *
 * - **Empty** (`startAt` or `endAt` null/invalid): renders the empty CTA
 *   inviting the user to set a time. Clicking the card calls `onPick`,
 *   which the modal wires to a focus action on the inline TimeRow.
 * - **Filled** (both timestamps present + valid): renders a two-line
 *   summary — weekday + date on line 1, time range with en-dash on line 2.
 *   Cross-day bookings (rare) collapse to a single line that renders both
 *   ends fully ("Wed May 7, 10:00 PM – Thu May 8, 2:00 AM").
 *
 * Times are mandatory — no Remove action is exposed.
 */
export function TimesSummaryCard({ startAt, endAt, onPick }: TimesSummaryCardProps) {
  if (!isValidIso(startAt) || !isValidIso(endAt)) {
    return (
      <SummaryCard
        icon={Clock}
        title="When"
        emptyPrompt="Set start and end time"
        onChange={onPick}
      />
    );
  }

  const sameDay = localDayKey(startAt) === localDayKey(endAt);

  let summary: React.ReactNode;
  if (sameDay) {
    summary = (
      <div className="flex flex-col gap-0.5">
        <span className="text-sm text-foreground">{formatWeekdayDate(startAt)}</span>
        <span className="tabular-nums text-xs text-muted-foreground">
          {formatTimeShort(startAt)} – {formatTimeShort(endAt)}
        </span>
      </div>
    );
  } else {
    summary = (
      <span className="tabular-nums text-sm text-foreground">
        {formatWeekdayDate(startAt)}, {formatTimeShort(startAt)} – {formatWeekdayDate(endAt)},{' '}
        {formatTimeShort(endAt)}
      </span>
    );
  }

  return (
    <SummaryCard
      icon={Clock}
      title="When"
      emptyPrompt="Set start and end time"
      filled
      summary={summary}
      onChange={onPick}
    />
  );
}
