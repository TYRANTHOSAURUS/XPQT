/**
 * BookingSheet — mobile bottom-sheet for booking a room from the floor plan.
 *
 * Uses shadcn Sheet (side="bottom"). All inputs use Field primitives per
 * CLAUDE.md form composition rules. Mutation reuses useCreateBooking from
 * apps/web/src/api/room-booking/mutations.ts.
 *
 * D.5 — /portal/book/floor mobile booking surface.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { toastCreated, toastError, toastRemoved } from '@/lib/toast';
import { useCreateBooking, useCancelBooking, useRestoreBooking } from '@/api/room-booking';
import type { PublishedFloorPlan } from '@/api/floor-plans/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TimePill = 'now' | 'in30m' | 'thisPM' | 'custom';

interface BookingSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaceId: string | null;
  plan: PublishedFloorPlan | null;
  requesterPersonId: string;
  /**
   * When the tapped polygon is the caller's own booking (state='mine' on the
   * availability row), the page passes the booking id here. The sheet switches
   * to "your booking" mode with Cancel + Manage CTAs instead of the create
   * pill row.
   */
  existingBookingId?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundToNearest15(date: Date): Date {
  const ms = 15 * 60 * 1000;
  return new Date(Math.round(date.getTime() / ms) * ms);
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

/** Format a Date to a datetime-local input value (YYYY-MM-DDTHH:mm) */
function toDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pillWindow(pill: Exclude<TimePill, 'custom'>): { start: Date; end: Date } {
  const now = roundToNearest15(new Date());
  if (pill === 'now') {
    return { start: now, end: addMinutes(now, 60) };
  }
  if (pill === 'in30m') {
    return { start: addMinutes(now, 30), end: addMinutes(now, 90) };
  }
  // thisPM: 14:00–17:00 today (or now if already PM)
  const pmStart = new Date(now);
  if (now.getHours() >= 14) {
    pmStart.setTime(now.getTime());
  } else {
    pmStart.setHours(14, 0, 0, 0);
  }
  return { start: pmStart, end: new Date(pmStart.getTime() + 3 * 60 * 60 * 1000) };
}

const _timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
const _dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

function formatWindow(start: Date, end: Date): string {
  const today = new Date();
  const sameDay = _dayFmt.format(start) === _dayFmt.format(today);
  if (sameDay) return `${_timeFmt.format(start)} – ${_timeFmt.format(end)}`;
  return `${_dayFmt.format(start)} ${_timeFmt.format(start)} – ${_timeFmt.format(end)}`;
}

// ---------------------------------------------------------------------------
// Amenity icon mapping (simple emoji fallback — real icon set can be wired later)
// ---------------------------------------------------------------------------

const AMENITY_LABELS: Record<string, string> = {
  projector: 'Projector',
  whiteboard: 'Whiteboard',
  video_conferencing: 'Video conf.',
  phone: 'Phone',
  wheelchair: 'Accessible',
  natural_light: 'Natural light',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BookingSheet({
  open,
  onOpenChange,
  spaceId,
  plan,
  requesterPersonId,
  existingBookingId,
}: BookingSheetProps) {
  const navigate = useNavigate();
  const createBooking = useCreateBooking();
  const cancelBooking = useCancelBooking();
  const restoreBooking = useRestoreBooking();

  const space = plan?.spaces.find((s) => s.id === spaceId) ?? null;
  const inCancelMode = existingBookingId != null;

  // ---------------------------------------------------------------------------
  // Time pill state
  // ---------------------------------------------------------------------------
  const [activePill, setActivePill] = useState<TimePill>('now');

  const defaultNow = roundToNearest15(new Date());
  const [customStart, setCustomStart] = useState(() => toDateTimeLocal(defaultNow));
  const [customEnd, setCustomEnd] = useState(() =>
    toDateTimeLocal(addMinutes(defaultNow, 60)),
  );

  function resolvedWindow(): { start: string; end: string } {
    if (activePill === 'custom') {
      return { start: new Date(customStart).toISOString(), end: new Date(customEnd).toISOString() };
    }
    const w = pillWindow(activePill);
    return { start: w.start.toISOString(), end: w.end.toISOString() };
  }

  function displayWindow(): string {
    if (activePill === 'custom') {
      return formatWindow(new Date(customStart), new Date(customEnd));
    }
    const w = pillWindow(activePill);
    return formatWindow(w.start, w.end);
  }

  // ---------------------------------------------------------------------------
  // When the sheet opens, snap the "now" pill to the current time
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Cancel an existing booking (state='mine' tap path)
  // ---------------------------------------------------------------------------
  function handleCancel() {
    if (!existingBookingId) return;
    const id = existingBookingId;
    cancelBooking.mutate(
      { id, scope: 'this' },
      {
        onSuccess: () => {
          onOpenChange(false);
          toastRemoved('Booking', {
            verb: 'cancelled',
            onUndo: () => restoreBooking.mutate(id),
          });
        },
        onError: (err: unknown) => {
          toastError("Couldn't cancel booking", { error: err as Error });
        },
      },
    );
  }

  function handleManage() {
    if (!existingBookingId) return;
    onOpenChange(false);
    navigate(`/portal/me/bookings/${existingBookingId}`);
  }

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------
  function handleBook() {
    if (!spaceId || !requesterPersonId) return;
    const { start, end } = resolvedWindow();
    const requestId = crypto.randomUUID();
    createBooking.mutate(
      {
        payload: {
          space_id: spaceId,
          requester_person_id: requesterPersonId,
          host_person_id: requesterPersonId,
          start_at: start,
          end_at: end,
          source: 'portal',
        },
        requestId,
      },
      {
        onSuccess: (reservation) => {
          onOpenChange(false);
          toastCreated('Booking', {
            onView: () => navigate(`/portal/me/bookings/${reservation.id}`),
          });
        },
        onError: (err: unknown) => {
          // 409 conflict — someone else booked first
          const isConflict =
            err instanceof Error && (err as { status?: number }).status === 409;
          if (isConflict) {
            toastError("Already booked — pick a different time", {});
          } else {
            toastError(`Couldn't book ${space?.name ?? 'that room'}`, { error: err as Error });
          }
        },
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl px-0 pb-[env(safe-area-inset-bottom,0px)] max-h-[90dvh] overflow-y-auto"
      >
        {/* Grabber */}
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-muted-foreground/30 mt-1" />

        <div className="px-4 pb-6">
          <SheetHeader className="mb-4 text-left">
            <SheetTitle className="text-xl font-semibold leading-snug">
              {space?.name ?? 'Room'}
            </SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">
              {space
                ? [
                    space.capacity != null ? `${space.capacity} people` : null,
                    space.type,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : 'Loading…'}
            </SheetDescription>
          </SheetHeader>

          {/* Amenity row */}
          {space && space.amenities.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-1.5">
              {space.amenities.slice(0, 6).map((a) => (
                <span
                  key={a}
                  className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {AMENITY_LABELS[a] ?? a}
                </span>
              ))}
            </div>
          )}

          {/* Cancel-mode panel — taps on the caller's own booking. */}
          {inCancelMode ? (
            <div className="space-y-3">
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                This room is currently booked by you. Cancel to free it for
                others, or open the booking to manage attendees and services.
              </div>
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={handleManage}
                  disabled={cancelBooking.isPending}
                >
                  Manage booking
                </Button>
                <Button
                  variant="destructive"
                  className="w-full"
                  onClick={handleCancel}
                  disabled={cancelBooking.isPending}
                >
                  {cancelBooking.isPending ? 'Cancelling…' : 'Cancel booking'}
                </Button>
              </div>
            </div>
          ) : (
          <>
          {/* Time pill row */}
          <div className="mb-3 flex gap-2">
            {(
              [
                { id: 'now' as const, label: 'Now' },
                { id: 'in30m' as const, label: 'In 30 min' },
                { id: 'thisPM' as const, label: 'This PM' },
                { id: 'custom' as const, label: 'Custom' },
              ] as const
            ).map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setActivePill(id)}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                  activePill === id
                    ? 'bg-foreground text-background'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Custom date+time pickers */}
          {activePill === 'custom' && (
            <FieldGroup className="mb-3">
              <Field>
                <FieldLabel htmlFor="booking-sheet-start">From</FieldLabel>
                <Input
                  id="booking-sheet-start"
                  type="datetime-local"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="booking-sheet-end">To</FieldLabel>
                <Input
                  id="booking-sheet-end"
                  type="datetime-local"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                />
              </Field>
            </FieldGroup>
          )}

          {/* Selected window readout */}
          <p className="mb-4 tabular-nums text-sm text-muted-foreground">
            {displayWindow()}
          </p>

          {/* CTA */}
          <Button
            className="w-full"
            onClick={handleBook}
            disabled={createBooking.isPending || !spaceId}
          >
            {createBooking.isPending
              ? 'Booking…'
              : `Book ${space?.name ?? 'room'}`}
          </Button>
          </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
