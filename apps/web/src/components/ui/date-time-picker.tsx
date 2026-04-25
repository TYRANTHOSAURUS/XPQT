import { useState } from 'react';
import { CalendarIcon, ClockIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface DateTimePickerProps {
  /** ISO date string `yyyy-mm-dd` (local). */
  date: string;
  /** `HH:mm` 24h. */
  time: string;
  onDateChange: (date: string) => void;
  onTimeChange: (time: string) => void;
  /** Step in seconds for the time input. Default 15-min slots. */
  timeStep?: number;
  /** Minimum date — defaults to today (cannot pick past). */
  minDate?: Date;
  className?: string;
  /** id to associate with the date trigger so the FieldLabel can target it. */
  id?: string;
  /** Optional second element layout — when provided, renders date-only here
   *  and the consumer controls the time input separately. Useful for cases
   *  where the time picker lives in a different cell of a grid. */
  variant?: 'combined' | 'date-only';
}

const MONTH_DAY_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  weekday: 'short',
});

function formatDateButton(iso: string): string {
  if (!iso) return 'Pick a date';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return 'Pick a date';
  return MONTH_DAY_FORMATTER.format(d);
}

function toIsoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Date + time picker for the booking criteria bar (and anywhere else that
 * needs "when" input). Replaces the native HTML5 type=date / type=time
 * pickers — those have inconsistent UX across browsers and don't honour
 * the app's design tokens.
 *
 * Date side: shadcn Calendar in a Popover (button shows formatted date).
 * Time side: text Input type=time with 15-min step (still the most reliable
 * 24h time entry; a custom dropdown would lose direct keyboard entry).
 */
export function DateTimePicker({
  date,
  time,
  onDateChange,
  onTimeChange,
  timeStep = 900,
  minDate,
  className,
  id,
  variant = 'combined',
}: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const selected = date ? new Date(`${date}T00:00:00`) : undefined;
  const today = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  })();
  const min = minDate ?? today;

  const onPick = (d: Date | undefined) => {
    if (!d) return;
    onDateChange(toIsoDate(d));
    setOpen(false);
  };

  return (
    <div
      className={cn(
        'grid gap-2',
        variant === 'combined' ? 'grid-cols-[1fr_120px]' : 'grid-cols-1',
        className,
      )}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              id={id}
              variant="outline"
              className="h-9 w-full justify-start gap-2 px-3 text-left font-normal"
            >
              <CalendarIcon className="size-3.5 text-muted-foreground" />
              <span className={cn('text-sm tabular-nums', !date && 'text-muted-foreground')}>
                {formatDateButton(date)}
              </span>
            </Button>
          }
        />
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={selected}
            onSelect={onPick}
            disabled={(d) => d < min}
            captionLayout="dropdown"
            autoFocus
          />
        </PopoverContent>
      </Popover>

      {variant === 'combined' && (
        <div className="relative">
          <ClockIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="time"
            value={time}
            onChange={(e) => onTimeChange(e.target.value)}
            step={timeStep}
            className="h-9 pl-8 text-sm tabular-nums"
            aria-label="Start time"
          />
        </div>
      )}
    </div>
  );
}
