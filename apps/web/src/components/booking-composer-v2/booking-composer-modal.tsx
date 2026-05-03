import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPortal,
  DialogOverlay,
} from '@/components/ui/dialog';
import { useBookingDraft } from './use-booking-draft';
import { type BookingDraft } from './booking-draft';
import type { ComposerMode, ComposerEntrySource } from '../booking-composer/state';
import { cn } from '@/lib/utils';
import { TitleInput } from './left-pane/title-input';
import { TimeRow } from './left-pane/time-row';
import { RepeatRow } from './left-pane/repeat-row';
import { DescriptionRow } from './left-pane/description-row';
import { HostRow } from './left-pane/host-row';
import { VisitorsRow } from './left-pane/visitors-row';
import { spacesListOptions, type Space } from '@/api/spaces';
import { deriveBuildingId } from './derive-building-id';
import { useMealWindows } from '@/api/meal-windows';
import { AddinStack } from './right-pane/addin-stack';
import { RoomCard } from './right-pane/room-card';
import { CateringCard } from './right-pane/catering-card';
import { AvCard } from './right-pane/av-card';
import { getSuggestions, type SuggestionRoomFacts } from './contextual-suggestions';

export interface BookingComposerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: ComposerMode;
  entrySource?: ComposerEntrySource;
  callerPersonId: string;
  hostFirstName: string | null;
  /** Optional seed for the draft. The popover→modal escalation passes
   *  the popover's draft here. */
  initialDraft?: BookingDraft;
  /** Called after a successful booking lands. Wired in Phase 6. */
  onBooked?: (reservationId: string) => void;
}

/**
 * The redesigned full composer. Two-pane Dialog (880×680, max-h-[85vh]).
 * Phase 3 ships the shell only — the panes are wired in Phases 4 + 5.
 *
 * Spec: docs/superpowers/specs/2026-05-02-create-booking-modal-redesign.md.
 */
export function BookingComposerModal({
  open,
  onOpenChange,
  mode,
  callerPersonId,
  hostFirstName,
  initialDraft,
}: BookingComposerModalProps) {
  const composer = useBookingDraft({
    seed: initialDraft
      ? { ...initialDraft }
      : { hostPersonId: callerPersonId, requesterPersonId: callerPersonId },
  });

  const { data: spacesCache } = useQuery(spacesListOptions());

  const pickedRoom = useMemo(() => {
    if (!composer.draft.spaceId || !spacesCache) return null;
    const s = (spacesCache as Space[]).find((sp) => sp.id === composer.draft.spaceId);
    return s
      ? { space_id: s.id, name: s.name, capacity: s.capacity ?? null }
      : null;
  }, [composer.draft.spaceId, spacesCache]);

  const roomFacts: SuggestionRoomFacts | null = pickedRoom
    ? {
        space_id: pickedRoom.space_id,
        name: pickedRoom.name,
        // Phase 5 ships with these signals OFF — the API contract for
        // surfacing them on Space is a follow-up. The suggestion engine
        // is shape-stable; flipping these on later just lights up
        // the chips.
        has_av_equipment: false,
        has_catering_vendor: false,
        needs_visitor_pre_registration: false,
      }
    : null;

  const { data: mealWindows } = useMealWindows();
  const suggestions = useMemo(
    () => getSuggestions(composer.draft, roomFacts, mealWindows ?? []),
    [composer.draft, roomFacts, mealWindows],
  );

  // Re-seed on open so cancelled sessions don't leak state.
  useEffect(() => {
    if (open) {
      composer.reset(
        initialDraft
          ? { ...initialDraft }
          : { hostPersonId: callerPersonId, requesterPersonId: callerPersonId },
      );
    }
    // intentionally only on open edge
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay
          className={cn(
            // Spec: backdrop fades over 240ms ease-smooth (slower than modal).
            'data-open:duration-[240ms] data-closed:duration-[240ms]',
            'data-open:ease-[var(--ease-smooth)] data-closed:ease-[var(--ease-smooth)]',
          )}
        />
        <DialogContent
          disablePortal
          showCloseButton={false}
          className={cn(
            'w-[880px] max-w-[calc(100vw-2rem)] gap-0 p-0',
            'h-auto max-h-[min(85vh,680px)]',
            'rounded-xl overflow-hidden',
            'data-open:duration-[380ms] data-open:ease-[var(--ease-spring)]',
            'data-open:zoom-in-[0.96]',
          )}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>New booking</DialogTitle>
            <DialogDescription>
              Configure a room booking. Title, time, and add-ins.
            </DialogDescription>
          </DialogHeader>
          <div className="flex h-full min-h-[480px] flex-col sm:flex-row">
            {/* Left pane — 520px on desktop. */}
            <div
              data-testid="booking-composer-left-pane"
              className="flex flex-1 flex-col gap-4 overflow-y-auto p-5 sm:w-[520px] sm:flex-none"
            >
              <TitleInput
                value={composer.draft.title}
                onChange={composer.setTitle}
                hostFirstName={hostFirstName}
                roomName={pickedRoom?.name ?? null}
              />
              <TimeRow
                startAt={composer.draft.startAt}
                endAt={composer.draft.endAt}
                onChange={composer.setTime}
              />
              <RepeatRow
                rule={composer.draft.recurrence}
                onChange={composer.setRepeat}
              />
              <DescriptionRow
                value={composer.draft.description}
                onChange={composer.setDescription}
              />
              <HostRow
                mode={mode}
                requesterPersonId={composer.draft.requesterPersonId}
                onRequesterChange={composer.setRequester}
                hostPersonId={composer.draft.hostPersonId}
                onHostChange={composer.setHost}
              />
              <VisitorsRow
                visitors={composer.draft.visitors}
                bookingDefaults={{
                  expected_at: composer.draft.startAt ?? undefined,
                  expected_until: composer.draft.endAt ?? undefined,
                  building_id:
                    deriveBuildingId(spacesCache as Space[] | undefined, composer.draft.spaceId) || undefined,
                  meeting_room_id: composer.draft.spaceId ?? undefined,
                }}
                disabled={!composer.draft.spaceId || !composer.draft.startAt}
                disabledReason={
                  !composer.draft.spaceId
                    ? 'Pick a room first — visitors are anchored to a building.'
                    : !composer.draft.startAt
                      ? 'Pick a start time first.'
                      : undefined
                }
                onAdd={composer.addVisitor}
                onUpdate={composer.updateVisitor}
                onRemove={composer.removeVisitor}
              />
            </div>
            {/* Right pane — 360px on desktop, hairline border. */}
            <aside
              data-testid="booking-composer-right-pane"
              className={cn(
                'm-2 flex flex-col gap-2 overflow-y-auto rounded-md border border-border/60 p-3',
                'sm:w-[360px] sm:flex-none',
              )}
            >
              <AddinStack>
                {({ expanded, setExpanded }) => (
                  <>
                    <RoomCard
                      spaceId={composer.draft.spaceId}
                      roomName={pickedRoom?.name ?? null}
                      capacity={pickedRoom?.capacity ?? null}
                      attendeeCount={composer.draft.attendeeCount}
                      expanded={expanded === 'room'}
                      onToggle={(o) => setExpanded(o ? 'room' : null)}
                      onChange={composer.setRoom}
                    />
                    <CateringCard
                      spaceId={composer.draft.spaceId}
                      startAt={composer.draft.startAt}
                      endAt={composer.draft.endAt}
                      attendeeCount={composer.draft.attendeeCount}
                      selections={composer.draft.services}
                      onSelectionsChange={composer.setServices}
                      expanded={expanded === 'catering'}
                      onToggle={(o) => setExpanded(o ? 'catering' : null)}
                      suggested={suggestions.some((s) => s.target === 'catering')}
                      suggestionReason={
                        suggestions.find((s) => s.target === 'catering')?.reason
                      }
                    />
                    <AvCard
                      spaceId={composer.draft.spaceId}
                      startAt={composer.draft.startAt}
                      endAt={composer.draft.endAt}
                      attendeeCount={composer.draft.attendeeCount}
                      selections={composer.draft.services}
                      onSelectionsChange={composer.setServices}
                      expanded={expanded === 'av_equipment'}
                      onToggle={(o) => setExpanded(o ? 'av_equipment' : null)}
                      suggested={suggestions.some((s) => s.target === 'av_equipment')}
                      suggestionReason={
                        suggestions.find((s) => s.target === 'av_equipment')?.reason
                      }
                    />
                  </>
                )}
              </AddinStack>
            </aside>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
