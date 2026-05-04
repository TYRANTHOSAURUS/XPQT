import { useMemo, useState } from 'react';
import { Calendar } from '@/components/ui/calendar';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface TimeRowProps {
  startAt: string | null;
  endAt: string | null;
  onChange: (startAt: string | null, endAt: string | null) => void;
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

/** Generate 15-minute slots for a single day, returned as ISO strings. */
function generateSlotsForDay(localDay: Date): string[] {
  const slots: string[] = [];
  const base = new Date(localDay);
  base.setHours(0, 0, 0, 0);
  for (let i = 0; i < 96; i++) {
    const d = new Date(base.getTime() + i * 15 * 60_000);
    slots.push(d.toISOString());
  }
  return slots;
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return TIME_FORMAT.format(d);
}

function formatDay(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return DAY_FORMAT.format(d);
}

/**
 * From/To controls for the left pane. Each is a button styled like
 * `Wed, May 7 · 2:00 PM`; click → popover with calendar (left) + 15-min
 * slot list (right). Slots are rendered in `font-mono tabular-nums` per
 * spec polish micros.
 *
 * Conflict-strike (red strike on conflicting slots) is wired in Phase 6
 * when the conflict-check API is integrated; in this task we render
 * slots without conflict markers.
 */
export function TimeRow({ startAt, endAt, onChange }: TimeRowProps) {
  const [openSide, setOpenSide] = useState<'start' | 'end' | null>(null);

  const startDate = useMemo(
    () => (startAt ? new Date(startAt) : new Date()),
    [startAt],
  );
  const endDate = useMemo(
    () => (endAt ? new Date(endAt) : startDate),
    [endAt, startDate],
  );

  const dayForPopover = openSide === 'end' ? endDate : startDate;
  const slots = useMemo(() => generateSlotsForDay(dayForPopover), [dayForPopover]);

  const onPickStartSlot = (iso: string) => {
    let newEnd = endAt;
    if (startAt && endAt) {
      const dur = new Date(endAt).getTime() - new Date(startAt).getTime();
      newEnd = new Date(new Date(iso).getTime() + Math.max(15 * 60_000, dur)).toISOString();
    } else {
      newEnd = new Date(new Date(iso).getTime() + 60 * 60_000).toISOString();
    }
    onChange(iso, newEnd);
    setOpenSide(null);
  };

  const onPickEndSlot = (iso: string) => {
    onChange(startAt, iso);
    setOpenSide(null);
  };

  const onPickDay = (date: Date | undefined) => {
    if (!date) return;
    if (openSide === 'start') {
      const next = new Date(date);
      const src = startAt ? new Date(startAt) : new Date();
      next.setHours(src.getHours(), src.getMinutes(), 0, 0);
      const dur =
        startAt && endAt
          ? new Date(endAt).getTime() - new Date(startAt).getTime()
          : 60 * 60_000;
      onChange(next.toISOString(), new Date(next.getTime() + dur).toISOString());
    } else if (openSide === 'end') {
      const next = new Date(date);
      const src = endAt ? new Date(endAt) : new Date();
      next.setHours(src.getHours(), src.getMinutes(), 0, 0);
      onChange(startAt, next.toISOString());
    }
  };

  return (
    <Field>
      <FieldLabel className="text-xs text-muted-foreground">When</FieldLabel>
      <div className="flex items-center gap-2">
        <TimeButton
          label={`${formatDay(startAt)} · ${formatTime(startAt)}`}
          open={openSide === 'start'}
          onOpenChange={(o) => setOpenSide(o ? 'start' : null)}
          calendarSelected={startDate}
          onCalendarSelect={onPickDay}
          slots={slots}
          onPickSlot={onPickStartSlot}
          focusTarget="time-row"
        />
        <span className="text-xs text-muted-foreground">→</span>
        <TimeButton
          label={`${formatDay(endAt)} · ${formatTime(endAt)}`}
          open={openSide === 'end'}
          onOpenChange={(o) => setOpenSide(o ? 'end' : null)}
          calendarSelected={endDate}
          onCalendarSelect={onPickDay}
          slots={slots}
          onPickSlot={onPickEndSlot}
        />
      </div>
    </Field>
  );
}

interface TimeButtonProps {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  calendarSelected: Date;
  onCalendarSelect: (date: Date | undefined) => void;
  slots: string[];
  onPickSlot: (iso: string) => void;
  /**
   * Optional `data-focus-target` attribute. The right-pane Times summary
   * card's "Change" action focuses `[data-focus-target="time-row"]` to
   * jump back here from the summary view.
   */
  focusTarget?: string;
}

function TimeButton({
  label,
  open,
  onOpenChange,
  calendarSelected,
  onCalendarSelect,
  slots,
  onPickSlot,
  focusTarget,
}: TimeButtonProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 justify-start gap-1.5 px-3 font-normal tabular-nums"
            data-focus-target={focusTarget}
          />
        }
      >
        {label}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        className="flex w-auto gap-3 p-3"
      >
        <Calendar
          mode="single"
          selected={calendarSelected}
          onSelect={onCalendarSelect}
        />
        <div
          className="flex max-h-[280px] w-[140px] flex-col gap-0.5 overflow-y-auto pr-1"
          role="listbox"
          aria-label="Time slots"
        >
          {slots.map((iso) => (
            <button
              key={iso}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => onPickSlot(iso)}
              className={cn(
                'flex h-7 w-full items-center justify-start rounded-md px-2',
                'font-mono text-[12px] tabular-nums text-foreground/80',
                'transition-colors hover:bg-accent/50 hover:text-foreground',
                '[transition-duration:100ms] [transition-timing-function:var(--ease-snap)]',
              )}
            >
              {TIME_FORMAT.format(new Date(iso))}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
