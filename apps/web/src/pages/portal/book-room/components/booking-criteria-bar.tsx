import { useState } from 'react';
import { LayoutList, Map as MapIcon, Plus, X, Users as UsersIcon, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
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

const DURATION_OPTIONS = [
  { mins: 15, label: '15 min' },
  { mins: 30, label: '30 min' },
  { mins: 45, label: '45 min' },
  { mins: 60, label: '1 hour' },
  { mins: 90, label: '1.5 hours' },
  { mins: 120, label: '2 hours' },
  { mins: 180, label: '3 hours' },
] as const;

/**
 * Booking criteria card. Single white surface with generous breathing room
 * — when, attendees, site live as a row of pill-anchored fields with the
 * view toggle on the trailing edge. Built on `FieldGroup` + `Field` per
 * CLAUDE.md form composition rules.
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

      <FieldGroup className="gap-4 md:grid md:grid-cols-12 md:items-end md:gap-4">
        {/* When (date + time + duration) */}
        <Field className="md:col-span-6">
          <FieldLabel htmlFor="picker-date">When</FieldLabel>
          <div className="grid grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)] gap-2.5">
            <DateTimePicker
              id="picker-date"
              date={state.date}
              time={state.startTime}
              onDateChange={(d) => onChange('date', d)}
              onTimeChange={(t) => onChange('startTime', t)}
            />
            <Select
              value={String(state.durationMinutes)}
              onValueChange={(v) => onChange('durationMinutes', Number(v))}
            >
              <SelectTrigger id="picker-duration" aria-label="Duration" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DURATION_OPTIONS.map((opt) => (
                  <SelectItem key={opt.mins} value={String(opt.mins)}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Field>

        {/* Attendees */}
        <Field className="md:col-span-2">
          <FieldLabel htmlFor="picker-attendees">Attendees</FieldLabel>
          <div className="relative">
            <UsersIcon
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="picker-attendees"
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              value={state.attendeeCount}
              onChange={(e) =>
                onChange('attendeeCount', Math.max(1, Number(e.target.value || 1)))
              }
              className="h-9 pl-8 tabular-nums"
            />
          </div>
        </Field>

        {/* Site */}
        <Field className="md:col-span-4">
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
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
        <span className="text-[12px] font-medium text-muted-foreground">
          Must have
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {AMENITY_CHIPS.filter((a) => state.mustHaveAmenities.includes(a.id)).map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => toggleAmenity(a.id)}
              className={cn(
                'group/chip inline-flex h-7 items-center gap-1 rounded-full border bg-foreground/5 px-2.5 text-xs',
                'transition-colors hover:bg-foreground/10',
              )}
              style={{ transitionDuration: '120ms', transitionTimingFunction: 'var(--ease-snap)' }}
            >
              {a.label}
              <X className="size-3 opacity-50 group-hover/chip:opacity-90" />
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
            <LayoutList className="size-3.5" />
            <span className="text-xs">List</span>
          </Toggle>
          <Toggle
            pressed={state.view === 'plan'}
            onPressedChange={() => onChange('view', 'plan')}
            size="sm"
            aria-label="Floor plan view"
            className="h-7 gap-1 px-2.5"
          >
            <MapIcon className="size-3.5" />
            <span className="text-xs">Plan</span>
          </Toggle>
        </div>
      </div>
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
            <Plus className="size-3" /> Add
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
