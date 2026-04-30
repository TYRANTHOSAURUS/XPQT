import { useState } from 'react';
import { LayoutList, Map as MapIcon, MapPin, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { NumberStepper } from '@/components/ui/number-stepper';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Toggle } from '@/components/ui/toggle';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { QuickPickChips } from '@/components/ui/quick-pick-chips';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { PickerState } from '../hooks/use-picker-state';

interface SiteOption {
  id: string;
  name: string;
}

interface Props {
  state: PickerState;
  onChange: <K extends keyof PickerState>(key: K, value: PickerState[K]) => void;
  /** Eligible sites (typically derived from the user's authorized_locations of type=site/building). */
  sites: SiteOption[];
}

const AMENITY_CHIPS = [
  { id: 'whiteboard', label: 'Whiteboard' },
  { id: 'video', label: 'Video' },
  { id: 'phone_conf', label: 'Phone conf' },
  { id: 'projector', label: 'Projector' },
  { id: 'wheelchair', label: 'Wheelchair' },
] as const;

/** Headline durations — surfaced as quick-select chips. Anything else is one
 *  click away in the More popover. Covers ~85% of bookings in observed data. */
const QUICK_DURATIONS = [30, 60, 90, 120] as const;
const MORE_DURATIONS = [15, 45, 180, 240, 480] as const;

const DURATION_QUICK_OPTS = QUICK_DURATIONS.map((m) => ({ value: m, label: formatDuration(m) }));
const DURATION_MORE_OPTS = MORE_DURATIONS.map((m) => ({ value: m, label: formatDuration(m) }));

/**
 * Booking criteria card. Single white surface — `When` (date + time) and
 * `Duration` (segmented chips with overflow popover) live as a tight pair on
 * the left, attendees + site sit on the right. Replaces the old 12-column
 * grid (which left attendees occupying a too-wide column with a chunky
 * spinner-decorated number input) and the duration `<Select>` (which was
 * three clicks for the most common value in the list).
 */
export function BookingCriteriaBar({ state, onChange, sites }: Props) {
  const toggleAmenity = (id: string) => {
    const next = state.mustHaveAmenities.includes(id)
      ? state.mustHaveAmenities.filter((a) => a !== id)
      : [...state.mustHaveAmenities, id];
    onChange('mustHaveAmenities', next);
  };

  return (
    <section
      aria-labelledby="picker-criteria-heading"
      className="rounded-2xl border bg-card p-4 sm:p-5"
    >
      <h2 id="picker-criteria-heading" className="sr-only">
        Booking criteria
      </h2>

      <FieldGroup className="gap-4 md:flex-row md:flex-wrap md:items-end md:gap-4">
        {/* When (date + time) */}
        <Field className="md:min-w-[260px] md:flex-[2_1_260px]">
          <FieldLabel htmlFor="picker-date">When</FieldLabel>
          <DateTimePicker
            id="picker-date"
            date={state.date}
            time={state.startTime}
            onDateChange={(d) => onChange('date', d)}
            onTimeChange={(t) => onChange('startTime', t)}
          />
        </Field>

        {/* Duration — quick chips with overflow popover */}
        <Field className="md:flex-[3_1_300px]">
          <FieldLabel htmlFor="picker-duration">Duration</FieldLabel>
          <QuickPickChips
            id="picker-duration"
            ariaLabel="Duration"
            value={state.durationMinutes}
            options={DURATION_QUICK_OPTS}
            more={DURATION_MORE_OPTS}
            onChange={(v) => onChange('durationMinutes', v)}
          />
        </Field>

        {/* Attendees — compact stepper */}
        <Field className="md:w-auto md:flex-none">
          <FieldLabel htmlFor="picker-attendees">Attendees</FieldLabel>
          <NumberStepper
            id="picker-attendees"
            aria-label="Attendees"
            value={state.attendeeCount}
            onChange={(v) => onChange('attendeeCount', v)}
            min={1}
            max={500}
            size="sm"
            className="h-9 w-[120px]"
          />
        </Field>

        {/* Site */}
        <Field className="md:min-w-[180px] md:flex-[1_1_180px]">
          <FieldLabel htmlFor="picker-site">Site</FieldLabel>
          <div className="relative">
            <MapPin
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Select
              value={state.siteId ?? 'any'}
              onValueChange={(v) => onChange('siteId', v === 'any' ? null : v)}
            >
              <SelectTrigger id="picker-site" className="h-9 pl-8">
                <SelectValue placeholder="Any site" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any site</SelectItem>
                {sites.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Field>
      </FieldGroup>

      {/* Must-have row + view toggle */}
      <fieldset className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
        <legend className="sr-only">Required amenities</legend>
        <span aria-hidden className="text-[12px] font-medium text-muted-foreground">
          Must have
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {AMENITY_CHIPS.filter((a) => state.mustHaveAmenities.includes(a.id)).map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => toggleAmenity(a.id)}
              aria-label={`Remove ${a.label} requirement`}
              className={cn(
                'group/chip inline-flex h-7 items-center gap-1 rounded-full border bg-foreground/5 px-2.5 text-xs',
                'transition-colors hover:bg-foreground/10',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              )}
              style={{ transitionDuration: '120ms', transitionTimingFunction: 'var(--ease-snap)' }}
            >
              {a.label}
              <X className="size-3 opacity-50 group-hover/chip:opacity-90" aria-hidden />
            </button>
          ))}
          <AmenityAddPopover selected={state.mustHaveAmenities} onToggle={toggleAmenity} />
        </div>

        <div className="ml-auto flex items-center gap-1 rounded-md border bg-card p-0.5">
          <Toggle
            pressed={state.view === 'list'}
            onPressedChange={() => onChange('view', 'list')}
            size="sm"
            aria-label="List view"
            className="h-7 gap-1 px-2.5"
          >
            <LayoutList className="size-3.5" aria-hidden />
            <span className="text-xs">List</span>
          </Toggle>
          <Toggle
            pressed={state.view === 'plan'}
            onPressedChange={() => onChange('view', 'plan')}
            size="sm"
            aria-label="Floor plan view"
            className="h-7 gap-1 px-2.5"
          >
            <MapIcon className="size-3.5" aria-hidden />
            <span className="text-xs">Plan</span>
          </Toggle>
        </div>
      </fieldset>
    </section>
  );
}

function AmenityAddPopover({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const remaining = AMENITY_CHIPS.filter((a) => !selected.includes(a.id));
  if (remaining.length === 0) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 rounded-full border-dashed px-2.5 text-xs"
          >
            <Plus className="size-3" aria-hidden /> Add
          </Button>
        }
      />
      <PopoverContent className="w-44 gap-1 p-1.5">
        {remaining.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => {
              onToggle(a.id);
              setOpen(false);
            }}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-accent"
          >
            {a.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
