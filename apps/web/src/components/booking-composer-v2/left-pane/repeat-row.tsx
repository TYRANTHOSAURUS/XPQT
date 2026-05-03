import { useState } from 'react';
import { Field, FieldLabel } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { RecurrenceField } from '@/components/booking-composer/sections/recurrence-field';
import type { RecurrenceRule } from '@/api/room-booking';
import { cn } from '@/lib/utils';

export interface RepeatRowProps {
  rule: RecurrenceRule | null;
  onChange: (rule: RecurrenceRule | null) => void;
}

const UNTIL_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

/**
 * Compact recurrence chooser. Collapsed by default; opens a popover with
 * the existing `RecurrenceField` inside. When set, the row reads
 * `"Weekly on Wednesdays, until Jun 30"` in `text-foreground` instead of
 * muted (per spec).
 */
export function RepeatRow({ rule, onChange }: RepeatRowProps) {
  const [open, setOpen] = useState(false);

  const summary = rule ? summarizeRule(rule) : "Doesn't repeat";

  return (
    <Field>
      <FieldLabel className="sr-only">Repeat</FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                'h-8 justify-start px-2 text-xs font-normal',
                rule ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {summary}
              <span className="ml-1 text-muted-foreground">▾</span>
            </Button>
          }
        />
        <PopoverContent align="start" side="bottom" className="w-[360px] p-3">
          <RecurrenceField rule={rule} onChange={onChange} />
        </PopoverContent>
      </Popover>
    </Field>
  );
}

function summarizeRule(r: RecurrenceRule): string {
  const freq =
    r.frequency === 'daily'
      ? 'Daily'
      : r.frequency === 'weekly'
        ? 'Weekly'
        : 'Monthly';
  const interval = r.interval && r.interval > 1 ? ` every ${r.interval}` : '';
  const until = r.until
    ? `, until ${UNTIL_FORMAT.format(new Date(r.until))}`
    : r.count
      ? `, ${r.count} times`
      : '';
  return `${freq}${interval}${until}`;
}
