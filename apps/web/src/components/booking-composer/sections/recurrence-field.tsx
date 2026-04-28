import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
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

const DEFAULT_RULE: RecurrenceRule = { frequency: 'weekly', interval: 1, count: 8 };

/**
 * Recurrence section of the BookingComposer. Collapsed by default with a
 * ghost "Repeat this booking…" trigger; expanded shows frequency +
 * interval + ends-mode toggle (After N occurrences / On date).
 *
 * Open/closed state is derived from `rule` — there is no local flag.
 * Clicking "Repeat this booking…" seeds defaults, clicking "Don't repeat"
 * clears the rule. base-ui's Collapsible animates panel height via its
 * `--collapsible-panel-height` var; the data-[starting/ending-style]
 * attributes drive the in/out states.
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
  const expanded = rule != null;
  // Snapshot the last live rule so the panel keeps rendering its actual
  // values during the close animation. Without this, clicking "Don't
  // repeat" flips `rule` to null and the panel reverts to DEFAULT_RULE
  // for the ~220ms collapse — codex caught this on review.
  // setState-during-render (sync, no flash on re-open).
  const [lastLive, setLastLive] = useState<RecurrenceRule>(rule ?? DEFAULT_RULE);
  if (rule && rule !== lastLive) setLastLive(rule);
  const r = rule ?? lastLive;
  // End mode: "after N occurrences" or "on a specific date". The
  // RecurrenceRule carries count OR until — surface as an explicit
  // toggle so the user picks intent rather than discovering precedence.
  const endMode: 'count' | 'until' = r.until ? 'until' : 'count';

  return (
    <Collapsible
      open={expanded}
      onOpenChange={(next) => {
        if (next && !rule) onChange({ ...DEFAULT_RULE });
        else if (!next) onChange(null);
      }}
    >
      {!expanded && (
        <Field>
          <FieldLabel>Recurrence</FieldLabel>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 self-start px-2 text-xs active:translate-y-px"
            onClick={() => onChange({ ...DEFAULT_RULE })}
          >
            Repeat this booking…
          </Button>
        </Field>
      )}
      <CollapsibleContent
        className="overflow-hidden h-[var(--collapsible-panel-height)] [transition:height_220ms_var(--ease-smooth)] data-[ending-style]:h-0 data-[starting-style]:h-0 focus-within:overflow-visible"
      >
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
            className="h-7 self-start px-2 text-xs text-muted-foreground active:translate-y-px"
            onClick={() => onChange(null)}
          >
            Don't repeat
          </Button>
        </FieldSet>
      </CollapsibleContent>
    </Collapsible>
  );
}
