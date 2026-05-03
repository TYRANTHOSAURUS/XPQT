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
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { useBookingDraft } from './use-booking-draft';
import { type BookingDraft, validateDraft } from './booking-draft';
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
import { useCreateBooking } from '@/api/room-booking';
import { useCreateInvitation } from '@/api/visitors';
import { buildBookingPayload } from '@/components/booking-composer/submit';
import { toastCreated, toastError } from '@/lib/toast';
import { useNavigate } from 'react-router-dom';
import { defaultTitle as defaultTitleFor } from './booking-draft';

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
  entrySource,
  callerPersonId,
  hostFirstName,
  initialDraft,
  onBooked,
}: BookingComposerModalProps) {
  const navigate = useNavigate();
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

  const createBooking = useCreateBooking();
  const createInvitation = useCreateInvitation();
  const validation = validateDraft(composer.draft, mode);
  const submitting = createBooking.isPending;

  const handleSubmit = async () => {
    if (validation) return;

    // Build a ComposerState-compatible adapter from the BookingDraft.
    // BookingDraft is intentionally field-compatible (see booking-draft.ts)
    // with ComposerState except: `description` → `notes`, `errors` absent,
    // `additionalSpaceIds` absent. Supply the gaps here.
    const adapter = {
      spaceId: composer.draft.spaceId!,
      additionalSpaceIds: [] as string[],
      startAt: composer.draft.startAt!,
      endAt: composer.draft.endAt!,
      attendeeCount: composer.draft.attendeeCount,
      attendeePersonIds: composer.draft.attendeePersonIds,
      requesterPersonId: composer.draft.requesterPersonId,
      hostPersonId: composer.draft.hostPersonId,
      costCenterId: composer.draft.costCenterId,
      recurrence: composer.draft.recurrence,
      services: composer.draft.services,
      visitors: composer.draft.visitors,
      templateId: composer.draft.templateId,
      // BookingDraft uses `description`; ComposerState calls the same
      // field `notes` — map it here.
      notes: composer.draft.description,
      errors: {} as Record<string, string>,
    };

    const payload = buildBookingPayload({
      state: adapter,
      mode,
      // /full-review C2 fix — was hardcoded 'desk-list' which mis-attributed
      // every portal booking. Use the caller's entry-source; default to
      // 'desk-list' only when the caller didn't supply one.
      entrySource: entrySource ?? 'desk-list',
      callerPersonId,
    });
    if (!payload) return;

    // Attach title + description from the draft. /full-review C1 fix —
    // when the user leaves the title blank, send the placeholder string
    // (the WYSIWYG contract from spec §53-69), so we never persist a
    // null title that renders as "Maple Room" elsewhere. Matches the
    // popover's behavior at quick-book-popover.tsx:130.
    const placeholderTitle = defaultTitleFor({
      hostFirstName,
      roomName: pickedRoom?.name ?? null,
    });
    const titled = {
      ...payload,
      title: composer.draft.title?.trim() || placeholderTitle,
      description: composer.draft.description || undefined,
    };

    try {
      const result = await createBooking.mutateAsync(titled);
      // Post-canonicalisation (00277): the booking IS the bundle.
      // `result.id` is the canonical booking id to pass to visitors.
      // `booking_bundle_id` was dropped from the Reservation type in
      // slice H3 (migration 00286); `reservation_id` was dropped from
      // CreateInvitationPayload in 00278:38.
      const bookingId = result.id;

      // /full-review C4 fix — visitors-flush is a bulk op. Run all
      // invites in parallel via Promise.allSettled, tally failures,
      // and surface a partial-success toast per CLAUDE.md
      // "Bulk operations use ... partialSuccess" rule. Per-visitor
      // toastError is gone — it interleaved with the success toast and
      // disappeared on close.
      let visitorFailures: { name: string; error: unknown }[] = [];
      let visitorTotal = 0;
      if (composer.draft.visitors.length > 0) {
        const buildingId = deriveBuildingId(spacesCache as Space[] | undefined, composer.draft.spaceId);
        const visitors = composer.draft.visitors;
        visitorTotal = visitors.length;
        const results = await Promise.allSettled(
          visitors.map((v) =>
            createInvitation.mutateAsync({
              first_name: v.first_name,
              last_name: v.last_name,
              email: v.email,
              phone: v.phone,
              company: v.company,
              visitor_type_id: v.visitor_type_id,
              expected_at: composer.draft.startAt!,
              expected_until: composer.draft.endAt ?? undefined,
              building_id: buildingId ?? '',
              meeting_room_id: composer.draft.spaceId ?? undefined,
              // Canonical link (00278:41).
              booking_id: bookingId,
            }),
          ),
        );
        visitorFailures = results
          .map((r, i) => (r.status === 'rejected'
            ? { name: visitors[i].first_name, error: r.reason }
            : null))
          .filter((x): x is { name: string; error: unknown } => x !== null);
      }

      // /full-review C5 fix — CLAUDE.md mandate: every entity-create
      // toast goes through `toastCreated(<entity>, { onView })`.
      // Partial-success on visitor flush is surfaced as a separate
      // warning toast (CLAUDE.md "partialSuccess" rule); the booking
      // itself is still a clean create.
      toastCreated('Booking', {
        onView: () => navigate(`/desk/bookings/${bookingId}`),
      });
      if (visitorFailures.length > 0) {
        const ok = visitorTotal - visitorFailures.length;
        toastError(
          `${ok} of ${visitorTotal} visitors invited — ${visitorFailures.length} failed`,
          {
            error: visitorFailures[0].error,
            retry: () => navigate(`/desk/bookings/${bookingId}`),
          },
        );
      }
      onOpenChange(false);
      onBooked?.(bookingId);
    } catch (err) {
      toastError("Couldn't book the room", {
        error: err,
        retry: () => void handleSubmit(),
      });
    }
  };

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
            'flex flex-col w-[880px] max-w-[calc(100vw-2rem)] gap-0 p-0',
            'h-auto rounded-none max-h-screen sm:rounded-xl sm:max-h-[min(85vh,680px)]',
            'overflow-hidden',
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
          <div className="flex flex-1 min-h-[480px] flex-col sm:flex-row">
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
          <footer className="flex items-center justify-end gap-2 border-t border-border/60 bg-background/85 px-5 py-3 backdrop-blur-md">
            {validation && (
              <span className="mr-auto text-xs text-amber-700 dark:text-amber-300">
                {validation}
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleSubmit()}
              disabled={Boolean(validation) || submitting}
              className="min-w-[6rem]"
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                  Booking…
                </>
              ) : (
                'Book'
              )}
            </Button>
          </footer>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
