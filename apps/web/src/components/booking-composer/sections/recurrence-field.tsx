import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NumberStepper } from '@/components/ui/number-stepper';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { RecurrenceRule } from '@/api/room-booking';
import { endOfDayIso } from '../helpers';

/**
 * Recurrence section of the BookingComposer. Collapsed by default with a
 * ghost "Repeat this booking…" trigger; expanded shows frequency +
 * interval + ends-mode toggle (After N occurrences / On date).
 *
 * Multi-room + recurrence is mutually exclusive — the parent composer's
 * `validateForSubmit` blocks submit when both are set, and
 * `AdditionalRoomsField` shows a soft note above its trigger so the
 * conflict is visible before the user adds another room.
 */
export function RecurrenceField({
  rule,
  onChange,
}: {
  rule: RecurrenceRule | null;
  onChange: (rule: RecurrenceRule | null) => void;
}) {
  const [expanded, setExpanded] = useState(rule != null);

  if (!expanded && !rule) {
    return (
      <Field>
        <FieldLabel>Recurrence</FieldLabel>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-9 self-start px-2 text-xs"
          onClick={() => {
            onChange({ frequency: 'weekly', interval: 1, count: 8 });
            setExpanded(true);
          }}
        >
          Repeat this booking…
        </Button>
      </Field>
    );
  }

  const r = rule ?? { frequency: 'weekly', interval: 1, count: 8 };
  // End mode: "after N occurrences" or "on a specific date". The
  // RecurrenceRule carries count OR until — surface as an explicit
  // toggle so the user picks intent rather than discovering precedence.
  const endMode: 'count' | 'until' = r.until ? 'until' : 'count';
  return (
    <FieldSet>
      <FieldLegend variant="label">Recurrence</FieldLegend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="composer-rec-freq">Frequency</FieldLabel>
          <Select
            value={r.frequency}
            onValueChange={(v) =>
              onChange({ ...r, frequency: v as RecurrenceRule['frequency'] })
            }
          >
            <SelectTrigger id="composer-rec-freq">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="composer-rec-interval">Every</FieldLabel>
          <NumberStepper
            id="composer-rec-interval"
            value={r.interval}
            onChange={(n) => onChange({ ...r, interval: Math.max(1, n) })}
            min={1}
            max={12}
            aria-label="Recurrence interval"
          />
        </Field>
      </div>
      <Field>
        <FieldLabel>Ends</FieldLabel>
        <div className="flex flex-col gap-2">
          <ToggleGroup
            value={[endMode]}
            onValueChange={(v) => {
              const next = v[0] as 'count' | 'until' | undefined;
              if (next === 'count') {
                onChange({ ...r, count: r.count ?? 8, until: undefined });
              } else if (next === 'until') {
                const d = new Date();
                d.setMonth(d.getMonth() + 3);
                onChange({
                  ...r,
                  count: undefined,
                  until: endOfDayIso(d.toISOString().slice(0, 10)),
                });
              }
            }}
            variant="default"
            className="w-fit"
          >
            <ToggleGroupItem value="count" className="h-8 px-3 text-xs">
              After
            </ToggleGroupItem>
            <ToggleGroupItem value="until" className="h-8 px-3 text-xs">
              On
            </ToggleGroupItem>
          </ToggleGroup>
          {/* Contextual control fades in via key change so the swap reads
              as one knob rotating, not two widgets blinking. */}
          <div
            key={endMode}
            className="duration-150 ease-[var(--ease-snap)] animate-in fade-in slide-in-from-left-1"
          >
            {endMode === 'count' ? (
              <NumberStepper
                value={r.count ?? 8}
                onChange={(n) => onChange({ ...r, count: Math.max(2, n) })}
                min={2}
                max={104}
                size="sm"
                aria-label="Number of occurrences"
                suffix={
                  r.frequency === 'daily'
                    ? 'days'
                    : r.frequency === 'weekly'
                      ? 'weeks'
                      : 'months'
                }
              />
            ) : (
              <Input
                type="date"
                value={(r.until ?? '').slice(0, 10)}
                onChange={(e) =>
                  onChange({
                    ...r,
                    until: e.target.value ? endOfDayIso(e.target.value) : undefined,
                  })
                }
                className="h-9 w-auto text-sm tabular-nums"
                aria-label="End date"
              />
            )}
          </div>
        </div>
      </Field>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 self-start px-2 text-xs text-muted-foreground"
        onClick={() => {
          onChange(null);
          setExpanded(false);
        }}
      >
        Don't repeat
      </Button>
    </FieldSet>
  );
}
