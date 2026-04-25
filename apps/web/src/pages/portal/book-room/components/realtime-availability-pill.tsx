import { cn } from '@/lib/utils';
import { formatCount } from '@/lib/format';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { PickerInput } from '@/api/room-booking';

interface Props {
  matchCount: number;
  isLive: boolean;
  isFetching: boolean;
  sort: NonNullable<PickerInput['sort']>;
  onSortChange: (next: NonNullable<PickerInput['sort']>) => void;
}

const SORT_LABELS: Record<NonNullable<PickerInput['sort']>, string> = {
  best_match: 'Best match',
  closest: 'Closest to you',
  smallest_fit: 'Smallest fit',
  most_underused: 'Most underused',
};

/**
 * The "Live · 12 rooms · ranked for you" status pill that sits between the
 * criteria bar and the result list. Per spec §4.1 the dot pulses while the
 * realtime channel is live; we additionally show a subtle ring while the
 * picker query is mid-fetch so refreshes feel responsive.
 */
export function RealtimeAvailabilityPill({
  matchCount,
  isLive,
  isFetching,
  sort,
  onSortChange,
}: Props) {
  return (
    <div
      className={cn(
        'mt-4 flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-1.5',
        'transition-colors',
      )}
      style={{ transitionDuration: '200ms', transitionTimingFunction: 'var(--ease-smooth)' }}
    >
      <span
        aria-hidden
        className={cn(
          'inline-block size-1.5 rounded-full bg-emerald-500',
          isLive && 'animate-pulse',
        )}
      />
      <span className="text-[11px] text-muted-foreground tabular-nums">
        {isLive ? 'Live · ' : 'Idle · '}
        <span className="text-foreground font-medium">
          {formatCount(matchCount)} {matchCount === 1 ? 'room' : 'rooms'}
        </span>
        {' · ranked for you'}
        {isFetching && (
          <span className="ml-2 text-muted-foreground/70">refreshing…</span>
        )}
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground">Sort</span>
        <Select value={sort} onValueChange={(v) => onSortChange(v as NonNullable<PickerInput['sort']>)}>
          <SelectTrigger className="h-7 px-2 text-[11px]">
            <SelectValue>{SORT_LABELS[sort]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(SORT_LABELS).map(([k, label]) => (
              <SelectItem key={k} value={k} className="text-xs">
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
