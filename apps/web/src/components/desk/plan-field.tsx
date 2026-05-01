import { useEffect, useState } from 'react';
import { CalendarClock, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { cn } from '@/lib/utils';

const TENANT_TIME_ZONE = 'Europe/Amsterdam';

interface PlanValue {
  startsAt: string | null;
  durationMinutes: number | null;
}

interface PlanFieldProps {
  value: PlanValue;
  onChange: (next: PlanValue) => void;
  disabled?: boolean;
  /** Optional reference instant for "vs deadline" delta. */
  dueAt?: string | null;
}

const DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: TENANT_TIME_ZONE,
});
const TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: TENANT_TIME_ZONE,
  timeZoneName: 'short',
});

const DURATION_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
  { label: '1 h', minutes: 60 },
  { label: '2 h', minutes: 120 },
  { label: '4 h', minutes: 240 },
  { label: '8 h', minutes: 480 },
];

function isoToZonedParts(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  // Render the instant in the tenant zone, then re-parse the parts.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TENANT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const lookup: Record<string, string> = {};
  for (const part of parts) lookup[part.type] = part.value;
  const date = `${lookup.year}-${lookup.month}-${lookup.day}`;
  const time = `${lookup.hour}:${lookup.minute}`;
  return { date, time };
}

/**
 * Compose a UTC instant from a date+time interpreted in the tenant zone.
 * Uses the offset of the *target* instant (handles CET/CEST DST flip).
 */
function combineToIso(date: string, time: string): string | null {
  if (!date || !time) return null;
  const naive = new Date(`${date}T${time}:00Z`); // pretend-UTC
  if (Number.isNaN(naive.getTime())) return null;
  const offsetMinutes = zoneOffsetMinutes(TENANT_TIME_ZONE, naive);
  return new Date(naive.getTime() - offsetMinutes * 60_000).toISOString();
}

function zoneOffsetMinutes(timeZone: string, instant: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
    hour12: false,
  });
  const offsetPart = fmt.formatToParts(instant).find((p) => p.type === 'timeZoneName');
  const match = offsetPart?.value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number.parseInt(match[2] ?? '0', 10);
  const mins = Number.parseInt(match[3] ?? '0', 10);
  return sign * (hours * 60 + mins);
}

function formatDurationShort(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatPlanSummary(iso: string | null, durationMinutes: number | null): string {
  if (!iso) return 'Not planned';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Not planned';
  const datePart = DATE_FORMATTER.format(d);
  const timePart = TIME_FORMATTER.format(d); // includes "CET"/"CEST"
  const base = `${datePart}, ${timePart}`;
  return durationMinutes ? `${base} · ${formatDurationShort(durationMinutes)}` : base;
}

interface DeltaInfo {
  text: string;
  tone: 'after' | 'before';
}

function computeDeadlineDelta(iso: string | null, dueAt: string | null | undefined): DeltaInfo | null {
  if (!iso || !dueAt) return null;
  const planMs = new Date(iso).getTime();
  const dueMs = new Date(dueAt).getTime();
  if (Number.isNaN(planMs) || Number.isNaN(dueMs)) return null;
  const diffMin = Math.round((planMs - dueMs) / 60_000);
  if (diffMin === 0) return { text: 'on deadline', tone: 'after' };
  const abs = Math.abs(diffMin);
  const human =
    abs >= 1440
      ? `${Math.round(abs / 1440)}d`
      : abs >= 60
        ? formatDurationShort(abs)
        : `${abs} min`;
  return diffMin > 0
    ? { text: `${human} after deadline`, tone: 'after' }
    : { text: `${human} before deadline`, tone: 'before' };
}

export function PlanField({ value, onChange, disabled, dueAt }: PlanFieldProps) {
  const [open, setOpen] = useState(false);
  const initial = isoToZonedParts(value.startsAt);
  const [draftDate, setDraftDate] = useState(initial.date);
  const [draftTime, setDraftTime] = useState(initial.time);
  const [draftDuration, setDraftDuration] = useState<number | null>(value.durationMinutes ?? null);
  const [draftDurationCustom, setDraftDurationCustom] = useState<string>(
    value.durationMinutes != null && !DURATION_PRESETS.some((p) => p.minutes === value.durationMinutes)
      ? String(value.durationMinutes)
      : '',
  );

  useEffect(() => {
    if (!open) {
      const parts = isoToZonedParts(value.startsAt);
      setDraftDate(parts.date);
      setDraftTime(parts.time);
      setDraftDuration(value.durationMinutes ?? null);
      setDraftDurationCustom(
        value.durationMinutes != null &&
          !DURATION_PRESETS.some((p) => p.minutes === value.durationMinutes)
          ? String(value.durationMinutes)
          : '',
      );
    }
  }, [open, value.startsAt, value.durationMinutes]);

  const summary = formatPlanSummary(value.startsAt, value.durationMinutes);
  const delta = computeDeadlineDelta(value.startsAt, dueAt);
  const hasValue = !!value.startsAt;

  const handleSave = () => {
    const iso = combineToIso(draftDate, draftTime);
    if (!iso) return;
    let duration = draftDuration;
    if (duration == null && draftDurationCustom.trim() !== '') {
      const parsed = Number.parseInt(draftDurationCustom, 10);
      if (Number.isFinite(parsed) && parsed > 0) duration = parsed;
    }
    onChange({ startsAt: iso, durationMinutes: duration });
    setOpen(false);
  };

  const handleClear = () => {
    onChange({ startsAt: null, durationMinutes: null });
    setOpen(false);
  };

  const pickPreset = (minutes: number) => {
    setDraftDuration(minutes);
    setDraftDurationCustom('');
  };

  const onCustomChange = (v: string) => {
    setDraftDurationCustom(v);
    const n = Number.parseInt(v, 10);
    setDraftDuration(Number.isFinite(n) && n > 0 ? n : null);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <Popover open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
          <PopoverTrigger
            disabled={disabled}
            className={cn(
              'flex-1 min-w-0 flex items-center gap-2 h-8 rounded-md border border-transparent px-2 text-left text-sm',
              'hover:bg-accent hover:border-border',
              'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
              disabled && 'cursor-not-allowed opacity-60 hover:bg-transparent hover:border-transparent',
              !hasValue && 'text-muted-foreground',
            )}
          >
            <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{summary}</span>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[320px] space-y-3 p-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">
                Planned start <span className="opacity-70">(Europe / Amsterdam)</span>
              </label>
              <DateTimePicker
                date={draftDate}
                time={draftTime}
                onDateChange={setDraftDate}
                onTimeChange={setDraftTime}
                // Allow backfill — operators sometimes log a plan that already
                // happened (e.g. "this was scheduled for last Tue, missed").
                minDate={new Date(0)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">
                Duration <span className="opacity-60">(optional)</span>
              </label>
              <div className="flex flex-wrap gap-1.5">
                {DURATION_PRESETS.map((preset) => {
                  const selected = draftDuration === preset.minutes && draftDurationCustom === '';
                  return (
                    <button
                      key={preset.minutes}
                      type="button"
                      onClick={() => pickPreset(preset.minutes)}
                      className={cn(
                        'h-7 rounded-md border px-2 text-xs transition-colors',
                        'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
                        selected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-background hover:bg-accent',
                      )}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
              <Input
                type="number"
                min={1}
                step={15}
                value={draftDurationCustom}
                onChange={(e) => onCustomChange(e.target.value)}
                placeholder="Custom (minutes)"
                className="h-8"
                aria-label="Custom duration in minutes"
              />
            </div>
            <div className="flex justify-between gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleClear}
                disabled={!hasValue && !draftDate && !draftTime}
              >
                Clear
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleSave}
                  disabled={!draftDate || !draftTime}
                >
                  Save
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
        {hasValue && !disabled && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={handleClear}
            title="Clear plan"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {delta && (
        <div
          className={cn(
            'flex items-center gap-1.5 px-2 text-xs font-medium',
            delta.tone === 'after' ? 'text-red-600' : 'text-muted-foreground',
          )}
        >
          <span
            className={cn(
              'inline-block h-1.5 w-1.5 rounded-full',
              delta.tone === 'after' ? 'bg-red-500' : 'bg-muted-foreground/50',
            )}
          />
          {delta.text}
        </div>
      )}
    </div>
  );
}
