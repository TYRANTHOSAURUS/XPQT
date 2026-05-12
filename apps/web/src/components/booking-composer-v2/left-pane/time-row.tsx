import { useId, useMemo, useState } from 'react';
import { Calendar } from '@/components/ui/calendar';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
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
  /**
   * /full-review v4 I1 — inline error slot. Modal pipes the
   * time-class validation message here (end ≤ start, date in past)
   * so the offending row paints `<FieldError>` directly under its
   * controls. Footer banner is the catch-all surface; this is the
   * source-precise one CLAUDE.md form-composition rule asks for.
   */
  error?: string;
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

/** Compare two ISO timestamps by HH:MM-of-local-day for slot `aria-selected`. */
function isSameLocalSlot(a: string | null, b: string): boolean {
  if (!a) return false;
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return false;
  return (
    da.getHours() === db.getHours() &&
    da.getMinutes() === db.getMinutes() &&
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** Short timezone abbreviation (e.g. "CET", "PST", "GMT+2") from the
 *  resolved Intl format. Falls back to an empty string if the runtime
 *  doesn't expose `timeZoneName` on the parts. */
function shortTimezone(): string {
  try {
    const fmt = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      timeZoneName: 'short',
    });
    const parts = fmt.formatToParts(new Date());
    const tz = parts.find((p) => p.type === 'timeZoneName');
    return tz?.value ?? '';
  } catch {
    return '';
  }
}

/**
 * From/To controls for the left pane. Robin-style inline-visible
 * dropdown quad:
 *
 *   [date▾] [time▾] → [date▾] [time▾] · TZ
 *
 * Each segment is its own popover trigger:
 *  - Date dropdown opens a `<Calendar>`
 *  - Time dropdown opens a 15-minute slot list
 *  - The timezone label is passive (short tz name)
 *
 * The legacy combined calendar+slot "Advanced" picker was dropped
 * 2026-05-04 — the four inline dropdowns are sufficient and the icon
 * cluttered the row.
 *
 * Conflict-strike (red strike on conflicting slots) is wired in Phase 6
 * when the conflict-check API is integrated; in this task we render
 * slots without conflict markers.
 */
export function TimeRow({ startAt, endAt, onChange, error }: TimeRowProps) {
  const tzLabel = useMemo(() => shortTimezone(), []);
  // /full-review v4 codex remediation — CLAUDE.md form rule requires
  // every FieldLabel to carry an htmlFor that pairs with a control id.
  // The row has four controls (date × time × start × end); the label
  // points at the leftmost (start date) since that's the natural
  // reading-order anchor and the data-focus-target attribute already
  // routes the summary card's "Change" action there.
  const startDateId = useId();

  const startDate = useMemo(
    () => (startAt ? new Date(startAt) : new Date()),
    [startAt],
  );
  const endDate = useMemo(
    () => (endAt ? new Date(endAt) : startDate),
    [endAt, startDate],
  );

  /** Apply a calendar-day pick to the start side, preserving the current
   *  time-of-day and the start↔end duration. */
  const onPickStartDay = (date: Date | undefined) => {
    if (!date) return;
    const next = new Date(date);
    const src = startAt ? new Date(startAt) : new Date();
    next.setHours(src.getHours(), src.getMinutes(), 0, 0);
    const dur =
      startAt && endAt
        ? new Date(endAt).getTime() - new Date(startAt).getTime()
        : 60 * 60_000;
    onChange(next.toISOString(), new Date(next.getTime() + dur).toISOString());
  };

  /** Apply a calendar-day pick to the end side, preserving end's
   *  time-of-day. Start is unchanged. */
  const onPickEndDay = (date: Date | undefined) => {
    if (!date) return;
    const next = new Date(date);
    const src = endAt ? new Date(endAt) : new Date();
    next.setHours(src.getHours(), src.getMinutes(), 0, 0);
    onChange(startAt, next.toISOString());
  };

  /** Apply a 15-minute slot pick to the start side. Pushes end forward to
   *  preserve duration (or +1h fallback when end was null). */
  const onPickStartSlot = (iso: string) => {
    let newEnd = endAt;
    if (startAt && endAt) {
      const dur = new Date(endAt).getTime() - new Date(startAt).getTime();
      newEnd = new Date(
        new Date(iso).getTime() + Math.max(15 * 60_000, dur),
      ).toISOString();
    } else {
      newEnd = new Date(new Date(iso).getTime() + 60 * 60_000).toISOString();
    }
    onChange(iso, newEnd);
  };

  /** Apply a 15-minute slot pick to the end side. Start is unchanged. */
  const onPickEndSlot = (iso: string) => {
    onChange(startAt, iso);
  };

  return (
    <Field data-invalid={error ? 'true' : undefined}>
      <FieldLabel htmlFor={startDateId} className="text-xs text-muted-foreground">
        When
      </FieldLabel>
      <div className="flex flex-wrap items-center gap-1.5">
        <DatePopover
          side="start"
          value={startAt}
          dateContext={startDate}
          onPick={onPickStartDay}
          focusTarget="time-row"
          invalid={Boolean(error)}
          id={startDateId}
        />
        <TimePopover
          side="start"
          value={startAt}
          dateContext={startDate}
          onPick={onPickStartSlot}
          invalid={Boolean(error)}
        />
        <span className="px-1 text-xs text-muted-foreground" aria-hidden>
          →
        </span>
        <DatePopover
          side="end"
          value={endAt}
          dateContext={endDate}
          onPick={onPickEndDay}
          invalid={Boolean(error)}
        />
        <TimePopover
          side="end"
          value={endAt}
          dateContext={endDate}
          onPick={onPickEndSlot}
          invalid={Boolean(error)}
        />
        {tzLabel ? (
          <span
            className="ml-1 text-xs text-muted-foreground tabular-nums"
            aria-label={`Timezone ${tzLabel}`}
          >
            {tzLabel}
          </span>
        ) : null}
      </div>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

interface DatePopoverProps {
  side: 'start' | 'end';
  value: string | null;
  dateContext: Date;
  onPick: (date: Date | undefined) => void;
  /** Optional `data-focus-target` attribute. The right-pane Times summary
   *  card's "Change" action focuses `[data-focus-target="time-row"]` to
   *  jump back here from the summary view. */
  focusTarget?: string;
  invalid?: boolean;
  /** Optional id — set on the start-side trigger so the wrapping
   *  `FieldLabel htmlFor=...` points at a real control (CLAUDE.md
   *  form-composition rule). */
  id?: string;
}

function DatePopover({
  side,
  value,
  dateContext,
  onPick,
  focusTarget,
  invalid,
  id,
}: DatePopoverProps) {
  const [open, setOpen] = useState(false);
  const label = formatDay(value);
  const sideLabel = side === 'start' ? 'Start date' : 'End date';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              'h-7 justify-start gap-1 px-2 text-xs font-normal',
              invalid && 'border-destructive text-destructive hover:bg-destructive/5',
            )}
            aria-label={`${sideLabel}: ${label}`}
            aria-invalid={invalid || undefined}
            data-focus-target={focusTarget}
            id={id}
          />
        }
      >
        <span>{label}</span>
        <span className="text-muted-foreground" aria-hidden>
          ▾
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={dateContext}
          onSelect={(date) => {
            onPick(date);
            if (date) setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

interface TimePopoverProps {
  side: 'start' | 'end';
  value: string | null;
  dateContext: Date;
  onPick: (iso: string) => void;
  invalid?: boolean;
}

function TimePopover({ side, value, dateContext, onPick, invalid }: TimePopoverProps) {
  const [open, setOpen] = useState(false);
  const label = formatTime(value);
  const sideLabel = side === 'start' ? 'Start time' : 'End time';
  const listboxId = useId();
  const slots = useMemo(() => generateSlotsForDay(dateContext), [dateContext]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              'h-7 justify-start gap-1 px-2 text-xs font-normal tabular-nums',
              invalid && 'border-destructive text-destructive hover:bg-destructive/5',
            )}
            aria-label={`${sideLabel}: ${label}`}
            aria-invalid={invalid || undefined}
            aria-controls={open ? listboxId : undefined}
          />
        }
      >
        <span>{label}</span>
        <span className="text-muted-foreground" aria-hidden>
          ▾
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        className="w-auto p-1.5"
      >
        <div
          id={listboxId}
          className="flex max-h-[280px] w-[140px] flex-col gap-0.5 overflow-y-auto pr-1"
          role="listbox"
          aria-label={`${sideLabel} slots`}
        >
          {slots.map((iso) => {
            const selected = isSameLocalSlot(value, iso);
            return (
              <button
                key={iso}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onPick(iso);
                  setOpen(false);
                }}
                className={cn(
                  'flex h-7 w-full items-center justify-start rounded-md px-2',
                  'font-mono text-[12px] tabular-nums text-foreground/80',
                  'transition-colors hover:bg-accent/50 hover:text-foreground',
                  '[transition-duration:100ms] [transition-timing-function:var(--ease-snap)]',
                  selected && 'bg-accent text-foreground',
                )}
              >
                {TIME_FORMAT.format(new Date(iso))}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

