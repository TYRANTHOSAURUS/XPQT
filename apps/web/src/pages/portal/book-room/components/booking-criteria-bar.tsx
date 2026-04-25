import { useState } from 'react';
import { LayoutList, Map as MapIcon, Plus, X } from 'lucide-react';
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

// Curated must-have chips per spec §4.1. Server-side maps these to amenity ids.
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
 * Top-of-page criteria bar for the booking picker. Spec §4.1: When,
 * Attendees, Site, Must-have chips, and a List/Plan view toggle on the
 * trailing edge.
 *
 * Built with `FieldGroup` + `Field` per CLAUDE.md form composition rules.
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
      className="rounded-xl border bg-card/40 p-3 md:p-4"
    >
      <h2 id="picker-criteria-heading" className="sr-only">
        Booking criteria
      </h2>
      <FieldGroup className="gap-3 md:grid md:grid-cols-12 md:gap-3">
        {/* When (date + start + duration) */}
        <Field className="md:col-span-5">
          <FieldLabel htmlFor="picker-date">When</FieldLabel>
          <div className="grid grid-cols-[1.2fr_0.8fr_1fr] gap-2">
            <Input
              id="picker-date"
              type="date"
              value={state.date}
              onChange={(e) => onChange('date', e.target.value)}
              className="text-sm tabular-nums"
            />
            <Input
              id="picker-time"
              type="time"
              value={state.startTime}
              onChange={(e) => onChange('startTime', e.target.value)}
              step={900}
              className="text-sm tabular-nums"
              aria-label="Start time"
            />
            <Select
              value={String(state.durationMinutes)}
              onValueChange={(v) => onChange('durationMinutes', Number(v))}
            >
              <SelectTrigger id="picker-duration" aria-label="Duration">
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
            className="tabular-nums"
          />
        </Field>

        {/* Site */}
        <Field className="md:col-span-2">
          <FieldLabel htmlFor="picker-site">Site</FieldLabel>
          <Select
            value={state.siteId ?? 'any'}
            onValueChange={(v) => onChange('siteId', v === 'any' ? null : v)}
          >
            <SelectTrigger id="picker-site">
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
        </Field>

        {/* Must-have chips */}
        <Field className="md:col-span-3">
          <FieldLabel>Must have</FieldLabel>
          <div className="flex flex-wrap items-center gap-1.5">
            {AMENITY_CHIPS.filter((a) =>
              state.mustHaveAmenities.includes(a.id),
            ).map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => toggleAmenity(a.id)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border bg-secondary/60 px-2 py-1 text-xs',
                  'hover:bg-secondary transition-colors',
                )}
                style={{ transitionDuration: '120ms', transitionTimingFunction: 'var(--ease-snap)' }}
              >
                {a.label}
                <X className="size-3 opacity-70" />
              </button>
            ))}
            <AmenityAddPopover
              selected={state.mustHaveAmenities}
              onToggle={toggleAmenity}
            />
          </div>
        </Field>
      </FieldGroup>

      {/* View toggle row */}
      <div className="mt-3 flex items-center justify-end gap-1">
        <Toggle
          pressed={state.view === 'list'}
          onPressedChange={() => onChange('view', 'list')}
          size="sm"
          aria-label="List view"
        >
          <LayoutList className="size-3.5" />
          <span className="text-xs">List</span>
        </Toggle>
        <Toggle
          pressed={state.view === 'plan'}
          onPressedChange={() => onChange('view', 'plan')}
          size="sm"
          aria-label="Floor plan view"
        >
          <MapIcon className="size-3.5" />
          <span className="text-xs">Plan</span>
        </Toggle>
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
          <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs">
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
