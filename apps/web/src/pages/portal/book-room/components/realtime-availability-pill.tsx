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
 * Toolbar that sits between the criteria card and the result list. Reads
 * as one decisive line: live state · result count · sort. Avoids the
 * heavy emerald pill of the old design — this is information, not a CTA.
 */
export function RealtimeAvailabilityPill({
  matchCount,
  isLive,
  isFetching,
  sort,
  onSortChange,
}: Props) {
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-y py-2.5">
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <span aria-hidden className="relative inline-flex">
          <span
            className={cn(
              'inline-block size-1.5 rounded-full',
              isLive ? 'bg-emerald-500' : 'bg-muted-foreground/40',
            )}
          />
          {isLive && (
            <span className="absolute inset-0 inline-block animate-ping rounded-full bg-emerald-500/60" />
          )}
        </span>
        <span className="tabular-nums">
          <span className="font-medium text-foreground">
            {formatCount(matchCount)}
          </span>{' '}
          {matchCount === 1 ? 'room' : 'rooms'} match
        </span>
        {isFetching && (
          <span className="text-muted-foreground/60">· refreshing</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[12px] text-muted-foreground">Sort by</span>
        <Select
          value={sort}
          onValueChange={(v) => onSortChange(v as NonNullable<PickerInput['sort']>)}
        >
          <SelectTrigger className="h-8 px-2.5 text-[12px]">
            <SelectValue>{SORT_LABELS[sort]}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
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
