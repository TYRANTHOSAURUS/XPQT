import { useEffect, useMemo, useState } from 'react';
import {
  Popover,
  PopoverContent,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useMealWindows } from '@/api/meal-windows';
import {
  defaultTitle,
  draftFromComposerSeed,
  type BookingDraft,
} from './booking-draft';
import {
  getSuggestions,
  type SuggestionRoomFacts,
} from './contextual-suggestions';

const DURATION_CHIPS: Array<{ value: string; label: string; minutes: number }> = [
  { value: '30', label: '30m', minutes: 30 },
  { value: '60', label: '1h', minutes: 60 },
  { value: '120', label: '2h', minutes: 120 },
  { value: 'custom', label: 'Custom', minutes: 0 },
];

export interface QuickBookPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The DOM element the popover anchors to (e.g. the scheduler tile).
   *  null is supported for tests; the popover then renders at the
   *  default anchor position. */
  anchorEl: HTMLElement | null;
  room: SuggestionRoomFacts;
  startAtIso: string;
  endAtIso: string;
  hostFirstName: string | null;
  /** Called when the user clicks Book. */
  onBook: (draft: BookingDraft) => void | Promise<void>;
  /** Called when the user clicks Advanced or hits ⌘↵. The draft is
   *  passed so the modal can resume mid-edit. */
  onAdvanced: (draft: BookingDraft) => void;
}

/**
 * The 30-second create surface. Anchored to a scheduler tile click.
 * Two fields (title + duration) and a footer (Book + Advanced). When
 * the picked time spans a meal window or the room has a catering
 * vendor / needs-pre-reg wing, surfaces a single muted hint pointing
 * the user to the full composer.
 *
 * Spec: docs/superpowers/specs/2026-05-02-create-booking-modal-redesign.md §Quick-book popover.
 *
 * Note: This component uses `@base-ui/react/popover` which does not have
 * a `PopoverAnchor` with `virtualRef`. Positional anchoring to `anchorEl`
 * is a runtime concern (handled at call site via CSS / portal positioning);
 * the popover renders correctly via the controlled `open` prop.
 */
export function QuickBookPopover({
  open,
  onOpenChange,
  anchorEl: _anchorEl,
  room,
  startAtIso,
  endAtIso,
  hostFirstName,
  onBook,
  onAdvanced,
}: QuickBookPopoverProps) {
  const initialMinutes = useMemo(() => {
    const s = new Date(startAtIso).getTime();
    const e = new Date(endAtIso).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 60;
    return Math.round((e - s) / 60_000);
  }, [startAtIso, endAtIso]);

  const initialChip = useMemo(() => {
    const match = DURATION_CHIPS.find((c) => c.minutes === initialMinutes);
    return match ? match.value : 'custom';
  }, [initialMinutes]);

  const [title, setTitle] = useState('');
  const [chip, setChip] = useState<string>(initialChip);

  // Reset when the popover re-opens for a new tile.
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setChip(initialChip);
  }, [open, initialChip]);

  const placeholder = defaultTitle({
    hostFirstName,
    roomName: room.name,
  });

  const effectiveStart = startAtIso;
  const effectiveEnd = useMemo(() => {
    const chipDef = DURATION_CHIPS.find((c) => c.value === chip);
    if (!chipDef || chipDef.value === 'custom') return endAtIso;
    return new Date(
      new Date(startAtIso).getTime() + chipDef.minutes * 60_000,
    ).toISOString();
  }, [chip, startAtIso, endAtIso]);

  const buildDraft = (): BookingDraft =>
    draftFromComposerSeed({
      title: title || placeholder,
      spaceId: room.space_id,
      startAt: effectiveStart,
      endAt: effectiveEnd,
    });

  const { data: mealWindows } = useMealWindows();
  const suggestions = useMemo(
    () => getSuggestions(buildDraft(), room, mealWindows ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, effectiveStart, effectiveEnd, mealWindows],
  );

  const cateringHint = suggestions.find((s) => s.target === 'catering');
  const visitorsHint = suggestions.find((s) => s.target === 'visitors');
  const hint = cateringHint
    ? 'Need catering? Open full composer →'
    : visitorsHint
      ? 'Visitors? Open full composer →'
      : null;

  const handleBook = () => {
    void onBook(buildDraft());
  };
  const handleAdvanced = () => {
    onAdvanced(buildDraft());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleAdvanced();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      handleBook();
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverContent
        // 360×~220 per spec.
        side="bottom"
        align="start"
        className="w-[360px] gap-3 p-3"
        onKeyDown={onKeyDown}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="qbp-title" className="sr-only">
              Title
            </FieldLabel>
            <Input
              id="qbp-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={placeholder}
              className="h-9 text-sm font-medium"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="qbp-duration" className="text-xs text-muted-foreground">
              Duration
            </FieldLabel>
            <ToggleGroup
              id="qbp-duration"
              value={[chip]}
              onValueChange={(v: string[]) => {
                const next = v[0];
                if (next) setChip(next);
              }}
              variant="outline"
              className="h-8 w-full justify-start"
            >
              {DURATION_CHIPS.map((c) => (
                <ToggleGroupItem
                  key={c.value}
                  value={c.value}
                  className="h-8 px-3 text-xs tabular-nums"
                >
                  {c.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          {hint && (
            <FieldDescription className="text-[12px]">{hint}</FieldDescription>
          )}
        </FieldGroup>
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={handleAdvanced}
          >
            Advanced ↗
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleBook}
            className="min-w-[5rem]"
          >
            Book
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
