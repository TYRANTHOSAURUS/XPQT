import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { FieldGroup } from '@/components/ui/field';
import { ArrowLeft, Loader2, X } from 'lucide-react';
import { PersonPicker } from '@/components/person-picker';
import { useBookingDraft } from './use-booking-draft';
import { type BookingDraft, validateDraft } from './booking-draft';
import type { ComposerMode, ComposerEntrySource } from '../booking-composer/state';
import { useIsMobile } from '@/hooks/use-mobile';
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
import { RightPanel, type RightPanelView } from './right-pane/right-panel';
import { SummaryView } from './right-pane/summary-view';
import { TimesSummaryCard } from './right-pane/times-summary-card';
import { RoomSummaryCard } from './right-pane/room-summary-card';
import { CateringSummaryCard } from './right-pane/catering-summary-card';
import { AvSummaryCard } from './right-pane/av-summary-card';
import { RoomPickerInline } from '../booking-composer/sections/room-picker-inline';
import { ServicePickerBody } from '../booking-composer/service-picker-sheet';
import { getSuggestions, type SuggestionRoomFacts } from './contextual-suggestions';
import { useCreateBooking } from '@/api/room-booking';
import { useBulkCreateInvitations, type CreateInvitationPayload } from '@/api/visitors';
import { buildBookingPayload } from '@/components/booking-composer/submit';
import { toast, toastCreated, toastError } from '@/lib/toast';
import { useNavigate } from 'react-router-dom';
import { defaultTitle as defaultTitleFor } from './booking-draft';

/**
 * Build the partial-success toast description from N visitor failures.
 * Avoids the prior bug where only the first failure's error was shown
 * (post-/full-review v2): names every failed visitor so the operator
 * knows who needs re-inviting.
 */
function describeVisitorFailures(
  failures: { name: string; error: unknown }[],
): string {
  if (failures.length === 1) return `${failures[0].name} couldn't be invited.`;
  if (failures.length <= 3) {
    const names = failures.map((f) => f.name).join(', ');
    return `Couldn't invite ${names}.`;
  }
  const head = failures.slice(0, 2).map((f) => f.name).join(', ');
  return `Couldn't invite ${head} and ${failures.length - 2} others.`;
}

const PICKER_TITLES = {
  'picker:room': 'Pick a room',
  'picker:catering': 'Add catering',
  'picker:av': 'Add AV equipment',
} satisfies Record<Exclude<RightPanelView, 'summary'>, string>;

export interface BookingComposerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: ComposerMode;
  /**
   * /full-review v2 fix — required (was optional with silent 'desk-list'
   * fallback). Caller MUST disambiguate the entry surface so portal /
   * desk / scheduler bookings land with the correct `source` on the
   * backend. Compile-time guard beats runtime mis-attribution.
   */
  entrySource: ComposerEntrySource;
  callerPersonId: string;
  hostFirstName: string | null;
  /** Optional seed for the draft. The popover→modal escalation passes
   *  the popover's draft here. */
  initialDraft?: BookingDraft;
  /** Called after a successful booking lands. Wired in Phase 6. */
  onBooked?: (reservationId: string) => void;
}

/**
 * The redesigned full composer. Two layouts:
 *
 * - **Desktop (md+, ≥ 768px)** — Two-pane Dialog. Left pane = form rows
 *   (title / time / repeat / description / host / visitors). Right pane
 *   = `<RightPanel>` summary↔picker state machine, fixed 384px column.
 * - **Mobile (< 768px)** — Single-column Dialog at viewport size. The
 *   right-pane content collapses into a flat "Add-ons" section below the
 *   form fields; tapping a summary card swaps the whole content area to
 *   the picker (replacing form + add-ons, footer stays sticky). Back
 *   button on the picker returns to summary. Pattern matches the rest of
 *   the app's mobile design — no off-screen sidebar that buries the
 *   primary action.
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
  const isMobile = useIsMobile();
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
  // Narrow deps to fields getSuggestions actually inspects (startAt,
  // endAt, visitors.length on the draft, plus the room facts and meal
  // windows). Keeps unrelated mutations like `attendeeCount` typing or
  // title edits from re-running the suggestion engine on every keystroke.
  const suggestions = useMemo(
    () => getSuggestions(composer.draft, roomFacts, mealWindows ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- composer.draft narrowed by design
    [
      composer.draft.startAt,
      composer.draft.endAt,
      composer.draft.visitors.length,
      roomFacts,
      mealWindows,
    ],
  );

  // Right-pane view-state machine. The `<RightPanel>` slides between the
  // summary and per-domain pickers on desktop. On mobile, the same
  // panelView drives a screen-swap inside the modal body.
  const [panelView, setPanelView] = useState<RightPanelView>('summary');

  // Re-seed on open so cancelled sessions don't leak state.
  useEffect(() => {
    if (open) {
      composer.reset(
        initialDraft
          ? { ...initialDraft }
          : { hostPersonId: callerPersonId, requesterPersonId: callerPersonId },
      );
      // Always start on the summary view; cancel→reopen shouldn't strand
      // the user in a picker that no longer matches the seeded draft.
      setPanelView('summary');
    }
    // intentionally only on open edge
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const createBooking = useCreateBooking();
  // /full-review v4 C1+C2 fix — bulk hook (one useMutation instance for
  // the whole visitor flush, single invalidation on settled, internal
  // concurrency cap of 5). Replaces the prior pattern of calling
  // useCreateInvitation once per visitor inside Promise.allSettled,
  // which (a) shared mutation state across N calls and (b) fired N
  // parallel `invalidateQueries(visitorKeys.all)` from N onSuccess
  // handlers for a 30-visitor flush.
  const createInvitations = useBulkCreateInvitations();
  const validation = validateDraft(composer.draft, mode);
  const submitting = createBooking.isPending;

  // Wrapped in useCallback so the retry callback we hand to toastError
  // closes over a stable reference. The prior plain-arrow recreated on
  // every render, meaning any toast that survived a re-render carried
  // a stale closure on its retry button.
  const handleSubmit = useCallback(async () => {
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
      // every portal booking. Caller's entry-source threaded through;
      // prop is now required (no fallback) so future callers fail at
      // compile time, not silently in audit logs.
      entrySource,
      callerPersonId,
    });
    if (!payload) return;

    // Attach title + description from the draft. /full-review C1 fix —
    // when the user leaves the title blank, send the placeholder string
    // (WYSIWYG title contract), so we never persist a null title that
    // renders as "Maple Room" elsewhere.
    //
    // /full-review v2 fix — guard against the spaces-cache race: if the
    // user picked a room but spacesCache is still loading on submit,
    // pickedRoom is null and the placeholder loses the room name.
    // Refuse to submit until the cache is resolved (validateDraft already
    // gates spaceId presence; this gates room-name lookup).
    if (composer.draft.spaceId && !pickedRoom) {
      // Pattern E (deferred): booking-composer error UX renders alternatives
      // inline + tracks per-attempt requestId. Migrate when ConflictModal v2 ships.
      toastError("Couldn't book the room", {
        description: 'Room details still loading — try again in a moment.',
      });
      return;
    }
    const placeholderTitle = defaultTitleFor({
      hostFirstName,
      roomName: pickedRoom?.name ?? null,
    });
    const titled = {
      ...payload,
      title: composer.draft.title?.trim() || placeholderTitle,
      description: composer.draft.description || undefined,
    };

    // B.0.E.3 — generate the X-Client-Request-Id ONCE per submit attempt
    // so React Query retries reuse it and the backend's
    // `attach_operations.cached_result` row hits on the second attempt
    // (user gets back the original booking; no double-create). Two
    // successive clicks of Submit get fresh ids, which is correct: each
    // click is a new logical attempt.
    const requestId = crypto.randomUUID();
    try {
      const result = await createBooking.mutateAsync({ payload: titled, requestId });
      // Post-canonicalisation (00277): the booking IS the bundle.
      // `result.id` is the canonical booking id to pass to visitors.
      // `booking_bundle_id` was dropped from the Reservation type in
      // slice H3 (migration 00286); `reservation_id` was dropped from
      // CreateInvitationPayload in 00278:38.
      const bookingId = result.id;

      // /full-review C4 fix — visitors-flush is a bulk op. Run all
      // invites through the bulk hook, which chunks to 5-concurrent
      // and emits a single invalidation on settled, then tally failures
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
        const payloads: CreateInvitationPayload[] = visitors.map((v) => ({
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
        }));
        const { failures } = await createInvitations.mutateAsync(payloads);
        visitorFailures = failures.map((f) => ({
          name: visitors[f.index].first_name,
          error: f.error,
        }));
      }

      // /full-review v2 fix — replace the dual-toast (green
      // toastCreated + red toastError) with a SINGLE toast whose
      // severity matches the actual outcome:
      //   - clean create  → toastCreated('Booking', { onView })
      //   - partial fail  → toast.warning('Booking created — N of M
      //                     visitors failed', { onView })
      // Two parallel toasts of opposite color stacked newest-on-top
      // is the exact "interleaved" UX the prior commit claimed to
      // fix. Also guards `bookingId` against a 200-without-id
      // backend regression (mirrors the popover at line 187-191).
      const onView = bookingId
        ? () => navigate(`/desk/bookings/${bookingId}`)
        : undefined;
      if (visitorFailures.length === 0) {
        toastCreated('Booking', { onView });
      } else {
        const ok = visitorTotal - visitorFailures.length;
        toast.warning(
          `Booking created — ${ok} of ${visitorTotal} visitors invited, ${visitorFailures.length} failed`,
          {
            description: describeVisitorFailures(visitorFailures),
            ...(onView ? { action: { label: 'View', onClick: onView } } : {}),
          },
        );
      }
      onOpenChange(false);
      onBooked?.(bookingId);
    } catch (err) {
      // Pattern E (deferred): booking-composer error UX renders alternatives
      // inline + tracks per-attempt requestId. Migrate when ConflictModal v2 ships.
      toastError("Couldn't book the room", {
        error: err,
        retry: () => void handleSubmit(),
      });
    }
  }, [
    validation,
    composer.draft,
    mode,
    entrySource,
    callerPersonId,
    hostFirstName,
    pickedRoom,
    spacesCache,
    createBooking,
    createInvitations,
    navigate,
    onBooked,
    onOpenChange,
  ]);

  // ─── Shared layout fragments ─────────────────────────────────────────
  // Both desktop and mobile render the same form fields and summary
  // cards; only the surrounding scroll containers differ. Extract them
  // here so JSX duplication doesn't drift between layouts.

  const formNode = (
    <FieldGroup>
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
        // /full-review v4 I1 — route time-class validation back to the
        // TimeRow inline. End-before-start and date-in-past now block at
        // the client; the legacy footer banner stays as a catch-all but
        // the user sees the exact field highlighted at the source.
        error={validation?.field === 'time' ? validation.message : undefined}
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
    </FieldGroup>
  );

  const summaryNode = (
    <SummaryView
      times={
        <TimesSummaryCard
          startAt={composer.draft.startAt}
          endAt={composer.draft.endAt}
          onPick={() => {
            // No `picker:time` view — times are edited inline on the
            // form. Focus the From-side TimeRow button (data-focus-target
            // attribute set in time-row.tsx); fall back to scrollIntoView
            // so a missing target still nudges the eye.
            const target = document.querySelector<HTMLElement>(
              '[data-focus-target="time-row"]',
            );
            if (target) {
              target.focus();
              target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
          }}
        />
      }
      room={
        <RoomSummaryCard
          spaceId={composer.draft.spaceId}
          roomName={pickedRoom?.name ?? null}
          capacity={pickedRoom?.capacity ?? null}
          // Conflict-check API is not yet wired into v2;
          // pass null so no Available/Unavailable pill renders.
          available={null}
          onPick={() => setPanelView('picker:room')}
          onRemove={() => composer.setRoom(null)}
        />
      }
      catering={
        <CateringSummaryCard
          selections={composer.draft.services}
          attendeeCount={composer.draft.attendeeCount}
          onPick={() => setPanelView('picker:catering')}
          onClearAll={() =>
            composer.setServices(
              composer.draft.services.filter(
                (s) => s.service_type !== 'catering',
              ),
            )
          }
          suggested={suggestions.some((s) => s.target === 'catering')}
          suggestionReason={
            suggestions.find((s) => s.target === 'catering')?.reason
          }
        />
      }
      av={
        <AvSummaryCard
          selections={composer.draft.services}
          attendeeCount={composer.draft.attendeeCount}
          onPick={() => setPanelView('picker:av')}
          onClearAll={() =>
            composer.setServices(
              composer.draft.services.filter(
                (s) => s.service_type !== 'av_equipment',
              ),
            )
          }
          suggested={suggestions.some((s) => s.target === 'av_equipment')}
          suggestionReason={
            suggestions.find((s) => s.target === 'av_equipment')?.reason
          }
        />
      }
    />
  );

  const pickerSlots = {
    room: (
      <div className="p-3">
        <RoomPickerInline
          value={composer.draft.spaceId}
          attendeeCount={composer.draft.attendeeCount}
          excludeIds={[]}
          onChange={(id) => {
            composer.setRoom(id);
            // Single-select picker: pop back to summary on selection —
            // there's nothing else to do here.
            setPanelView('summary');
          }}
        />
      </div>
    ),
    catering: (
      <ServicePickerBody
        deliverySpaceId={composer.draft.spaceId}
        onDate={composer.draft.startAt}
        attendeeCount={composer.draft.attendeeCount}
        bookingStartAt={composer.draft.startAt}
        bookingEndAt={composer.draft.endAt}
        selections={composer.draft.services}
        onSelectionsChange={composer.setServices}
        initialServiceType="catering"
        // Multi-select cart — body has no "Done" callback; the user
        // clicks Back when finished. Keep the body's own padding in
        // line with the summary cards via px-3.
        className="px-3 pb-3"
      />
    ),
    av: (
      <ServicePickerBody
        deliverySpaceId={composer.draft.spaceId}
        onDate={composer.draft.startAt}
        attendeeCount={composer.draft.attendeeCount}
        bookingStartAt={composer.draft.startAt}
        bookingEndAt={composer.draft.endAt}
        selections={composer.draft.services}
        onSelectionsChange={composer.setServices}
        initialServiceType="av_equipment"
        className="px-3 pb-3"
      />
    ),
  } as const;

  // Mobile-only: resolve picker kind + title from panelView.
  const mobilePickerKind: 'room' | 'catering' | 'av' | null =
    panelView === 'picker:room'
      ? 'room'
      : panelView === 'picker:catering'
        ? 'catering'
        : panelView === 'picker:av'
          ? 'av'
          : null;
  const mobilePickerTitle =
    panelView === 'summary' ? '' : PICKER_TITLES[panelView];

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
            'flex flex-col gap-0 p-0',
            // Mobile baseline (< 768px) — fill the viewport. Matches
            // useIsMobile()'s breakpoint so JS-detected layout and
            // CSS-detected sizing agree on every width.
            'w-screen h-screen max-w-none max-h-none rounded-none',
            // Desktop (≥ 768px / md:) — sized modal. Was `sm:` (640px)
            // before; the gap between sm and useIsMobile's 768px left
            // 640-767 in an ambiguous "mobile useIsMobile but desktop
            // CSS" zone that produced the mobile layout bug.
            'md:w-[min(calc(100vw-6rem),1600px)] md:h-[min(calc(100vh-6rem),960px)]',
            'md:max-w-none md:max-h-none md:rounded-xl',
            'overflow-hidden',
            'data-open:duration-[380ms] data-open:ease-[var(--ease-spring)]',
            'data-closed:duration-[200ms] data-closed:ease-[var(--ease-swift-out)]',
            'data-open:zoom-in-[0.96]',
          )}
        >
          {/* Header chrome — quiet by design. The bold body title
              ("Thomas's Meeting Room 1.10 booking") is the hierarchical
              anchor; this row carries the requester chip + close. */}
          <DialogHeader className="flex-row items-center justify-between gap-3 space-y-0 border-b border-border/60 px-4 py-2">
            <DialogTitle className="sr-only">New booking</DialogTitle>
            <DialogDescription className="sr-only">
              Configure a room booking. Title, time, and add-ins.
            </DialogDescription>
            {mode === 'operator' ? (
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-xs text-muted-foreground">Requester:</span>
                <PersonPicker
                  value={composer.draft.requesterPersonId}
                  onChange={(id) => composer.setRequester(id || null)}
                  excludeId={null}
                  placeholder="someone…"
                  clearLabel={null}
                  triggerClassName="h-8 gap-2 rounded-md border border-border/60 bg-background px-2.5 text-sm font-normal hover:bg-muted/50"
                />
              </div>
            ) : (
              <span aria-hidden />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={() => onOpenChange(false)}
              aria-label="Close"
            >
              <X className="size-4" aria-hidden />
            </Button>
          </DialogHeader>

          {isMobile ? (
            /* ─── Mobile layout (< 768px) ───────────────────────────
               Single-column flow. The form + add-ons scroll together
               as one stream when panelView==='summary'. Tapping a
               summary card swaps the whole content area to the picker;
               Back returns to summary. Footer stays sticky throughout.
               This replaces the prior stacked-pane layout where the
               right-pane content kept auto-height and pushed the
               footer below the fold.
               ───────────────────────────────────────────────────────*/
            <div className="flex min-h-0 flex-1 flex-col">
              {panelView === 'summary' ? (
                <div
                  data-testid="booking-composer-mobile-content"
                  className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4"
                >
                  {/* Hidden test hook so the desktop test selectors
                      (booking-composer-left-pane / -right-pane) still
                      resolve when matchMedia stubs to desktop=false.
                      Keeps mobile-only test coverage additive, not
                      breaking. */}
                  <div data-testid="booking-composer-left-pane" className="contents">
                    {formNode}
                  </div>
                  <section
                    data-testid="booking-composer-right-pane"
                    aria-label="Room and services"
                    className="mt-6 border-t border-border/60 pt-4"
                  >
                    <h2 className="mb-2 px-1 text-sm font-medium text-foreground">
                      Add-ons
                    </h2>
                    {summaryNode}
                  </section>
                </div>
              ) : (
                <div
                  data-testid="booking-composer-mobile-picker"
                  className="flex min-h-0 flex-1 flex-col"
                >
                  <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2.5">
                    <button
                      type="button"
                      onClick={() => setPanelView('summary')}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm',
                        'text-muted-foreground transition-colors hover:text-foreground',
                      )}
                      aria-label="Back to booking details"
                    >
                      <ArrowLeft className="size-4" aria-hidden />
                      <span>Back</span>
                    </button>
                    <h3 className="text-sm font-medium text-foreground">
                      {mobilePickerTitle}
                    </h3>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    {mobilePickerKind ? pickerSlots[mobilePickerKind] : null}
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* ─── Desktop layout (≥ 768px) ──────────────────────────
               Two panes side-by-side. Right pane is now a labelled
               <section> (was <aside>), since it carries the picker /
               summary cards — primary form controls, not tangential
               content. The `<RightPanel>` itself handles the
               summary↔picker slide with `inert` on the hidden slot
               (C3 closure — focusable buttons inside aria-hidden
               regions used to be reachable by Tab).
               ───────────────────────────────────────────────────────*/
            <div className="flex min-h-0 flex-1 flex-row">
              <div
                data-testid="booking-composer-left-pane"
                className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5"
              >
                {formNode}
              </div>
              <section
                data-testid="booking-composer-right-pane"
                aria-label="Room and services"
                className="flex min-h-0 w-[384px] flex-none flex-col overflow-hidden border-l border-border/60 bg-muted/30"
              >
                <RightPanel
                  view={panelView}
                  onViewChange={setPanelView}
                  pickerTitles={{
                    room: 'Pick a room',
                    catering: 'Add catering',
                    av: 'Add AV equipment',
                  }}
                  summary={summaryNode}
                  picker={pickerSlots}
                />
              </section>
            </div>
          )}

          <footer className="flex items-center justify-end gap-2 border-t border-border/60 bg-background/85 px-5 py-3 backdrop-blur-md">
            {validation && (
              <span
                role="status"
                aria-live="polite"
                className="mr-auto text-xs text-amber-700 dark:text-amber-300"
              >
                {validation.message}
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
