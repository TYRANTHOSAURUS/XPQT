/**
 * Visitor detail panel rendered alongside the /desk/visitors list and as
 * the body of the full-route /desk/visitors/:id page.
 *
 * Mirrors the *primitives and feel* of `ticket-detail.tsx` — a quiet
 * top-bar (close / expand / kebab), a big title, and a stack of
 * `SidebarGroup` cards each holding `InlineProperty` rows. The previous
 * bespoke `Section` + `DetailRow` helpers were replaced so visitor and
 * ticket surfaces share one visual language: same card shape, same
 * label-above-value rhythm, same spacing tokens.
 *
 * Activity feed is intentionally limited to a deterministic timeline
 * derived from the visitor record (created → expected → arrived →
 * checked-out / no-show / cancelled). A real audit-events feed needs a
 * backend endpoint that doesn't exist yet — we'll fold it in once
 * `/visitors/:id/activity` ships and add it as a sibling to the
 * `TicketActivityFeed` rather than a special case here.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §2, §6, §7
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Building2,
  CalendarClock,
  ExternalLink,
  KeyRound,
  LogOut,
  Mail,
  Maximize2,
  MoreHorizontal,
  Phone,
  StickyNote,
  UserCheck,
  Users as UsersIcon,
  XCircle,
  XIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { SidebarGroup } from '@/components/ui/sidebar-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InlineProperty } from '@/components/desk/inline-property';
import { VisitorStatusBadge } from '@/components/visitors/visitor-status-badge';
import { useVisitorDetail, type VisitorDetail as VisitorDetailRow } from '@/api/visitors';
import {
  useMarkArrived,
  useMarkCheckedOut,
  useMarkNoShow,
} from '@/api/visitors/reception';
import { useSpaces } from '@/api/spaces';
import { usePerson, personFullName } from '@/api/persons';
import { useReservationDetail } from '@/api/room-booking';
import { CheckoutDialog } from '@/components/desk/visitor-checkout-dialog';
import { toastError, toastSuccess } from '@/lib/toast';
import {
  formatFullTimestamp,
  formatRelativeTime,
  formatTimeShort,
} from '@/lib/format';

interface VisitorDetailProps {
  visitorId: string;
  /** Building scope for the reception mutations. The page resolves this
   *  per-row when it knows the visitor's building. */
  buildingId: string | null;
  onClose: () => void;
  onAssignPass: () => void;
  /** Render an Expand button that opens /desk/visitors/:id. The split-view
   *  page wires this; the full-route page omits it (already expanded). */
  onExpand?: () => void;
}

export function VisitorDetail({
  visitorId,
  buildingId,
  onClose,
  onAssignPass,
  onExpand,
}: VisitorDetailProps) {
  const { data: visitor, isLoading, isError } = useVisitorDetail(visitorId);
  const { data: spaces } = useSpaces();
  const { data: primaryHost } = usePerson(visitor?.primary_host_person_id ?? null);

  const markArrived = useMarkArrived(buildingId);
  const markCheckedOut = useMarkCheckedOut(buildingId);
  const markNoShow = useMarkNoShow(buildingId);

  const [checkoutOpen, setCheckoutOpen] = useState(false);

  const buildingName = useMemo(() => {
    if (!visitor?.building_id) return null;
    return (spaces ?? []).find((s) => s.id === visitor.building_id)?.name ?? null;
  }, [spaces, visitor?.building_id]);

  const meetingRoomName = useMemo(() => {
    if (!visitor?.meeting_room_id) return null;
    return (spaces ?? []).find((s) => s.id === visitor.meeting_room_id)?.name ?? null;
  }, [spaces, visitor?.meeting_room_id]);

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <DetailToolbar onClose={onClose} onExpand={onExpand} />
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Spinner className="size-5" />
        </div>
      </div>
    );
  }

  if (isError || !visitor) {
    return (
      <div className="flex h-full flex-col">
        <DetailToolbar onClose={onClose} onExpand={onExpand} />
        <div className="px-6 py-8 text-sm text-muted-foreground">
          Couldn&rsquo;t load this visitor. Try refreshing.
        </div>
      </div>
    );
  }

  const visitorName =
    [visitor.first_name, visitor.last_name].filter(Boolean).join(' ').trim() ||
    'Unnamed visitor';
  const isExpected =
    visitor.status === 'expected' || visitor.status === 'pending_approval';
  const isOnSite = visitor.status === 'arrived' || visitor.status === 'in_meeting';

  const handleArrive = () => {
    markArrived.mutate(
      { visitorId: visitor.id },
      {
        onSuccess: () => toastSuccess(`${visitorName} marked arrived`),
        onError: (err) =>
          toastError("Couldn't mark arrived", { error: err, retry: handleArrive }),
      },
    );
  };

  // The detail panel's "Mark left" routes through the explicit
  // pass-return dialog so reception can record returned / lost / skip
  // in one place. Same dialog handles the no-pass case.
  const openCheckout = () => setCheckoutOpen(true);

  const handleNoShow = () => {
    markNoShow.mutate(
      { visitorId: visitor.id },
      {
        onSuccess: () => toastSuccess(`${visitorName} marked no-show`),
        onError: (err) =>
          toastError("Couldn't mark no-show", { error: err, retry: handleNoShow }),
      },
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* Quiet top-bar — matches ticket-detail.tsx. Close on the left,
       *  expand + kebab on the right. The kebab is reserved for one-off
       *  actions (currently empty for visitors; left wired so future
       *  cancel/resend/etc. can land here without re-shaping the bar). */}
      <DetailToolbar onClose={onClose} onExpand={onExpand} />

      <div className="flex-1 overflow-auto">
        {/* Hero: title + company + status pill. The id chip mirrors the
         *  ticket-detail "ref code" that sits above the title. */}
        <div className="px-6 pt-2 pb-4">
          <code
            data-chip
            className="font-mono text-[11px] text-muted-foreground tabular-nums mb-1 inline-block"
          >
            {visitor.id.slice(0, 8)}
          </code>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-2xl font-semibold leading-tight tracking-tight">
                {visitorName}
              </h1>
              {visitor.company && (
                <p className="mt-1 truncate text-sm text-muted-foreground">
                  {visitor.company}
                </p>
              )}
            </div>
            <VisitorStatusBadge status={visitor.status} className="mt-1.5" />
          </div>
        </div>

        {/* Action row — outline-secondary so it doesn't compete with the
         *  toolbar's primary `+ Invite`. Power users still have the
         *  right-click context menu for the same set. */}
        <div className="flex flex-wrap items-center gap-2 border-t border-b px-6 py-3 bg-muted/20">
          {isExpected && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={handleArrive}
                disabled={markArrived.isPending}
              >
                <UserCheck className="size-4" /> Mark arrived
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleNoShow}
                disabled={markNoShow.isPending}
              >
                <XCircle className="size-4" /> No-show
              </Button>
            </>
          )}
          {isOnSite && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={openCheckout}
                disabled={markCheckedOut.isPending}
              >
                <LogOut className="size-4" /> Mark left
              </Button>
              {!visitor.visitor_pass_id && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onAssignPass}
                  disabled={!buildingId}
                >
                  <KeyRound className="size-4" /> Assign pass
                </Button>
              )}
            </>
          )}
          {!isExpected && !isOnSite && (
            <span className="text-xs text-muted-foreground">No actions for this status.</span>
          )}
        </div>

        {/* Body: a stack of SidebarGroup cards mirroring ticket-detail's
         *  sidebar "Properties / SLA / Requester / Details" rhythm. Each
         *  card holds InlineProperty rows so visitor and ticket surfaces
         *  share the same label-above-value pattern. */}
        <div className="space-y-2 p-3">
          <SidebarGroup title="Times">
            <InlineProperty label="Expected">
              {visitor.expected_at ? (
                <ValueTime iso={visitor.expected_at} withRelative />
              ) : (
                <ValueMuted>Not set</ValueMuted>
              )}
            </InlineProperty>
            {visitor.expected_until && (
              <InlineProperty label="Expected until">
                <ValueTime iso={visitor.expected_until} />
              </InlineProperty>
            )}
            {visitor.arrived_at && (
              <InlineProperty label="Arrived">
                <ValueTime iso={visitor.arrived_at} withRelative />
              </InlineProperty>
            )}
            {visitor.checked_out_at && (
              <InlineProperty label="Checked out">
                <ValueTime iso={visitor.checked_out_at} withRelative />
              </InlineProperty>
            )}
          </SidebarGroup>

          <SidebarGroup title="Where">
            <InlineProperty label="Building" icon={<Building2 className="h-3 w-3" />}>
              {buildingName ? (
                <ValueText>{buildingName}</ValueText>
              ) : (
                <ValueMuted>Not anchored</ValueMuted>
              )}
            </InlineProperty>
            {meetingRoomName && !visitor.booking_id && (
              <InlineProperty label="Meeting room">
                <ValueText>{meetingRoomName}</ValueText>
              </InlineProperty>
            )}
          </SidebarGroup>

          {/* Linked booking — visible when the visitor was created from a
           *  booking-composer flow. Post-canonicalisation (2026-05-02)
           *  visitors carry a single canonical link via `booking_id`
           *  (the dropped `reservation_id` and `booking_bundle_id`
           *  were collapsed — 00278:38, 00278:41). */}
          <LinkedBookingSection
            bookingId={visitor.booking_id}
            spaces={spaces ?? []}
          />

          <SidebarGroup title="Hosts">
            <InlineProperty label="Primary host" icon={<UsersIcon className="h-3 w-3" />}>
              {visitor.primary_host_person_id ? (
                primaryHost ? (
                  <ValueText>
                    {personFullName(primaryHost) || primaryHost.email || '—'}
                  </ValueText>
                ) : (
                  <ValueMuted>—</ValueMuted>
                )
              ) : (
                <span className="text-sm italic text-muted-foreground">No host</span>
              )}
            </InlineProperty>
          </SidebarGroup>

          {(visitor.email || visitor.phone) && (
            <SidebarGroup title="Contact">
              {visitor.email && (
                <InlineProperty label="Email" icon={<Mail className="h-3 w-3" />}>
                  <a
                    href={`mailto:${visitor.email}`}
                    className="text-sm text-foreground underline underline-offset-2 hover:no-underline"
                  >
                    {visitor.email}
                  </a>
                </InlineProperty>
              )}
              {visitor.phone && (
                <InlineProperty label="Phone" icon={<Phone className="h-3 w-3" />}>
                  <a
                    href={`tel:${visitor.phone}`}
                    className="text-sm text-foreground underline underline-offset-2 hover:no-underline"
                  >
                    {visitor.phone}
                  </a>
                </InlineProperty>
              )}
            </SidebarGroup>
          )}

          <SidebarGroup title="Pass">
            <InlineProperty label="Status" icon={<KeyRound className="h-3 w-3" />}>
              {visitor.visitor_pass_id ? (
                <ValueText>Active pass assigned</ValueText>
              ) : (
                <ValueMuted>No pass assigned</ValueMuted>
              )}
            </InlineProperty>
          </SidebarGroup>

          {(visitor.notes_for_visitor || visitor.notes_for_reception) && (
            <SidebarGroup title="Notes">
              {visitor.notes_for_reception && (
                <InlineProperty label="For reception" icon={<StickyNote className="h-3 w-3" />}>
                  <span className="block whitespace-pre-wrap text-sm text-foreground">
                    {visitor.notes_for_reception}
                  </span>
                </InlineProperty>
              )}
              {visitor.notes_for_visitor && (
                <InlineProperty label="For the visitor">
                  <span className="block whitespace-pre-wrap text-sm text-muted-foreground">
                    {visitor.notes_for_visitor}
                  </span>
                </InlineProperty>
              )}
            </SidebarGroup>
          )}

          {/* Activity / timeline — derived from the visitor record itself.
           *  See file header for why this isn't a real audit feed yet. */}
          <SidebarGroup title="Activity">
            <VisitorTimeline visitor={visitor} />
          </SidebarGroup>
        </div>
      </div>

      {checkoutOpen && (
        <CheckoutDialog
          open
          onOpenChange={(open) => !open && setCheckoutOpen(false)}
          buildingId={buildingId}
          visitorId={visitor.id}
          visitorLabel={visitorName}
          hasPass={Boolean(visitor.visitor_pass_id)}
        />
      )}
    </div>
  );
}

/** Compact close + expand + kebab bar at the very top of the panel.
 *
 *  Two shapes — driven by whether `onExpand` is provided:
 *
 *  - **Split-view** (`onExpand` present): close `X` on the left, expand +
 *    kebab on the right. `X` means "close the side panel".
 *  - **Full-route** (`onExpand` absent): a labelled "Visitors" back button
 *    on the left, kebab on the right. `X` would have meant the same thing
 *    as in split-view — but reception doesn't discover that — so we swap
 *    to an explicit back affordance. */
function DetailToolbar({
  onClose,
  onExpand,
}: {
  onClose: () => void;
  onExpand?: () => void;
}) {
  const isFullRoute = !onExpand;
  return (
    <div className="flex shrink-0 items-center gap-1 px-3 py-2">
      {isFullRoute ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Back to visitors"
          title="Back to visitors"
          className="-ml-1 gap-1.5"
        >
          <ArrowLeft className="size-4" />
          Visitors
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onClose}
          aria-label="Close detail panel"
          title="Close"
        >
          <XIcon className="size-4" />
        </Button>
      )}
      <div className="flex-1" />
      {onExpand && (
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onExpand}
          aria-label="Open in full page"
          title="Open full view"
        >
          <Maximize2 className="size-4" />
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(props) => (
            <Button
              {...props}
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="More actions"
              title="More actions"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          )}
        />
        <DropdownMenuContent align="end" className="w-52">
          {onExpand && (
            <DropdownMenuItem onClick={onExpand}>Open in full page</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Linked-booking section.
 *
 *  Booking-composer-created visitors carry a single canonical link to
 *  the booking via `visitors.booking_id` (00278:41). Pre-rewrite this
 *  was a dual-link (`reservation_id` + `booking_bundle_id`); both
 *  collapsed into the single `booking_id`. We resolve the booking via
 *  `useReservationDetail` because `/reservations/:id` now accepts a
 *  booking id and returns the legacy projection (the booking IS the
 *  reservation under the projection).
 *
 *  Gated on `bookingId` being non-null so visitors that aren't linked
 *  to a booking don't pay the fetch cost. */
function LinkedBookingSection({
  bookingId,
  spaces,
}: {
  bookingId: string | null;
  spaces: Array<{ id: string; name: string }>;
}) {
  const { data: reservation } = useReservationDetail(bookingId ?? '');

  if (!bookingId) return null;

  if (reservation) {
    const roomName =
      spaces.find((s) => s.id === reservation.space_id)?.name ?? 'Booked room';
    return (
      <SidebarGroup title="Linked booking">
        <InlineProperty label="Room" icon={<Building2 className="h-3 w-3" />}>
          <Link
            to={`/desk/bookings/${reservation.id}`}
            className="inline-flex items-center gap-1 text-sm text-foreground underline underline-offset-2 hover:no-underline"
          >
            {roomName}
            <ExternalLink className="size-3" aria-hidden />
          </Link>
        </InlineProperty>
        <InlineProperty label="When" icon={<CalendarClock className="h-3 w-3" />}>
          <span className="text-sm tabular-nums">
            <ValueDateRange startIso={reservation.start_at} endIso={reservation.end_at} />
          </span>
        </InlineProperty>
      </SidebarGroup>
    );
  }

  // Linked but data is still loading — render a minimal stub so the
  // section doesn't disappear during the fetch.
  return (
    <SidebarGroup title="Linked booking">
      <InlineProperty label="Status">
        <ValueMuted>Loading booking…</ValueMuted>
      </InlineProperty>
    </SidebarGroup>
  );
}

/** Deterministic activity timeline derived from the visitor record.
 *
 *  Real audit-events feed is deferred until a backend endpoint exposes
 *  them — see file header. Showing nothing is worse than showing the
 *  three-or-four real timestamps we already have, so we ship this
 *  reduced timeline as a placeholder peer of `TicketActivityFeed`. */
function VisitorTimeline({ visitor }: { visitor: VisitorDetailRow }) {
  type Event = { id: string; label: string; iso: string };
  const events: Event[] = [];

  if (visitor.expected_at) {
    events.push({ id: 'expected', label: 'Expected', iso: visitor.expected_at });
  }
  if (visitor.arrived_at) {
    events.push({ id: 'arrived', label: 'Arrived', iso: visitor.arrived_at });
  }
  if (visitor.checked_out_at) {
    const label =
      visitor.checkout_source === 'auto'
        ? 'Auto-checked out'
        : visitor.status === 'no_show'
          ? 'Marked no-show'
          : 'Checked out';
    events.push({ id: 'checked_out', label, iso: visitor.checked_out_at });
  }

  if (events.length === 0) {
    return <ValueMuted>No activity recorded.</ValueMuted>;
  }

  return (
    <ol className="space-y-2.5">
      {events.map((evt) => (
        <li key={evt.id} className="flex items-start gap-2.5 text-sm">
          <span
            className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <span className="text-foreground/90">{evt.label}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              <time
                dateTime={evt.iso}
                title={formatFullTimestamp(evt.iso)}
                className="tabular-nums"
              >
                {formatRelativeTime(evt.iso)}
              </time>
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

// ─── Small value primitives shared across the Sidebar groups ───────────────

function ValueText({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-foreground">{children}</span>;
}

function ValueMuted({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-muted-foreground">{children}</span>;
}

function ValueTime({ iso, withRelative }: { iso: string; withRelative?: boolean }) {
  return (
    <time
      dateTime={iso}
      title={formatFullTimestamp(iso)}
      className="text-sm tabular-nums"
    >
      {formatTimeShort(iso)}
      {withRelative && (
        <span className="text-muted-foreground"> · {formatRelativeTime(iso)}</span>
      )}
    </time>
  );
}

function ValueDateRange({ startIso, endIso }: { startIso: string; endIso: string }) {
  // Render as "10:00 – 11:00" when same calendar day, otherwise show the
  // full timestamp on each end. formatFullTimestamp on hover via the
  // wrapper <time> elements gives the precise value either way.
  const startDate = new Date(startIso).toDateString();
  const endDate = new Date(endIso).toDateString();
  if (startDate === endDate) {
    return (
      <span>
        <time dateTime={startIso} title={formatFullTimestamp(startIso)}>
          {formatTimeShort(startIso)}
        </time>
        {' – '}
        <time dateTime={endIso} title={formatFullTimestamp(endIso)}>
          {formatTimeShort(endIso)}
        </time>
        <span className="text-muted-foreground"> · {formatRelativeTime(startIso)}</span>
      </span>
    );
  }
  return (
    <span>
      <time dateTime={startIso} title={formatFullTimestamp(startIso)}>
        {formatFullTimestamp(startIso)}
      </time>
      {' → '}
      <time dateTime={endIso} title={formatFullTimestamp(endIso)}>
        {formatTimeShort(endIso)}
      </time>
    </span>
  );
}
