import { useCallback, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { toastError, toastUpdated } from '@/lib/toast';
import { useAuth } from '@/providers/auth-provider';
import { useEditBooking, type Reservation, type RuleOutcome, type SchedulerRoom } from '@/api/room-booking';
import { usePerson } from '@/api/persons';
import { formatDayLabel } from '@/lib/format';
import { useSchedulerWindow } from './hooks/use-scheduler-window';
import { useSchedulerData } from './hooks/use-scheduler-data';
import { useSchedulerAdjacentPrefetch } from './hooks/use-adjacent-prefetch';
import { useRealtimeScheduler } from './hooks/use-realtime-scheduler';
import { useDragCreate } from './hooks/use-drag-create';
import { useDragResize, type ResizeState } from './hooks/use-drag-resize';
import { useDragMove, type MoveState } from './hooks/use-drag-move';
import { SchedulerToolbar } from './components/scheduler-toolbar';
import { SchedulerGrid } from './components/scheduler-grid';
import { SchedulerCreatePopover } from './components/scheduler-create-popover';
import { SchedulerEventPopover } from './components/scheduler-event-popover';
import { SchedulerOverrideDialog } from './components/scheduler-override-dialog';
import { SchedulerMultiRoomToggle } from './components/scheduler-multi-room-toggle';
import type { CellOutcomeMap } from './components/scheduler-grid-cell';

/**
 * `/desk/scheduler` — full-bleed calendar canvas. Per CLAUDE.md "true
 * app-within-the-admin" exception, this page does NOT wrap in
 * `SettingsPageShell`; it manages its own minimal top bar and fills the
 * viewport like the workflow editor.
 *
 * Architecture:
 *   - `useSchedulerWindow` owns the date / view-mode / filter state.
 *   - `useSchedulerData` joins picker (rooms) + window (reservations) into
 *     a single render-ready shape.
 *   - `useRealtimeScheduler` keeps the cache fresh.
 *   - Drag interactions are three independent pointer hooks; the page
 *     wires them to the grid + the create / event / override dialogs.
 */
export function DeskSchedulerPage() {
  const { person } = useAuth();
  const requesterPersonId = person?.id ?? '';

  const win = useSchedulerWindow();

  // Resolve display name for "Booking for: <person>" so the create / override
  // popovers can say "For Sarah Lee." instead of "For yourself."
  const bookFor = usePerson(win.state.bookForPersonId);
  const bookForName = bookFor.data
    ? `${bookFor.data.first_name ?? ''} ${bookFor.data.last_name ?? ''}`.trim() ||
      bookFor.data.email ||
      null
    : null;
  const data = useSchedulerData({
    startAtIso: win.startAtIso,
    endAtIso: win.endAtIso,
    buildingId: win.state.buildingId,
    floorId: win.state.floorId,
    bookForPersonId: win.state.bookForPersonId,
    roomTypeFilter: win.state.roomTypeFilter,
    amenities: win.state.amenities,
    search: win.state.search,
  });

  // Realtime — debounced cache invalidation when reservations change on
  // any visible space.
  useRealtimeScheduler(data.spaceIds, data.spaceIds.length > 0);

  // Idle-time prefetch of the previous / next view windows so the toolbar's
  // prev / next buttons paint instantly from cache. Disabled until the
  // current window has resolved — there's no point burning concurrent
  // bandwidth before the visible page is on screen.
  useSchedulerAdjacentPrefetch({
    enabled: !data.isLoading,
    prevInput: {
      start_at: win.adjacentWindows.prev.startAtIso,
      end_at: win.adjacentWindows.prev.endAtIso,
      attendee_count: 1,
      building_id: win.state.buildingId,
      floor_id: win.state.floorId,
      must_have_amenities:
        win.state.amenities.length > 0 ? win.state.amenities : undefined,
      requester_id: win.state.bookForPersonId,
    },
    nextInput: {
      start_at: win.adjacentWindows.next.startAtIso,
      end_at: win.adjacentWindows.next.endAtIso,
      attendee_count: 1,
      building_id: win.state.buildingId,
      floor_id: win.state.floorId,
      must_have_amenities:
        win.state.amenities.length > 0 ? win.state.amenities : undefined,
      requester_id: win.state.bookForPersonId,
    },
  });

  const totalColumns = win.columnsPerDay * win.dates.length;

  // Per-room cell outcomes when "Booking for: <person>" is set.
  // The picker's per-room rule_outcome already gives us the *room-level*
  // outcome; we expand that to "the whole row's reservable cells share
  // this outcome" for v1. A future iteration can do per-cell dry-runs
  // for time-window-specific rules (e.g. "no bookings before 9 AM").
  const cellOutcomesByRoom = useMemo<Map<string, CellOutcomeMap>>(() => {
    const out = new Map<string, CellOutcomeMap>();
    if (!win.state.bookForPersonId) return out;
    for (const room of data.rooms) {
      const eff = room.rule_outcome.effect;
      if (eff === 'allow' || eff === 'allow_override') continue;
      const map: CellOutcomeMap = {};
      // Apply to every column of every visible day; the row paints them
      // as a single layered backgroundImage so the cost is constant.
      for (let c = 0; c < totalColumns; c++) {
        if (eff === 'deny') map[c] = 'deny';
        else if (eff === 'require_approval') map[c] = 'require_approval';
        else if (eff === 'warn') map[c] = 'warn';
      }
      out.set(room.space_id, map);
    }
    return out;
  }, [data.rooms, win.state.bookForPersonId, totalColumns]);

  // Multi-room shift-click selection — Map<space_id, Set<cell>>.
  const [multiSel, setMultiSel] = useState<Map<string, Set<number>>>(new Map());

  const onCellShiftClick = useCallback((cell: number, spaceId: string) => {
    setMultiSel((prev) => {
      const next = new Map(prev);
      const cur = new Set(next.get(spaceId) ?? new Set<number>());
      if (cur.has(cell)) cur.delete(cell);
      else cur.add(cell);
      if (cur.size === 0) next.delete(spaceId);
      else next.set(spaceId, cur);
      return next;
    });
  }, []);

  // Hover state lives in a ref, not React state — pointer-move fires
  // 60+ times per second, and routing each event through `setState`
  // re-rendered the whole page (the parent holds the virtualised grid)
  // every time. Future per-cell tooltips can read the ref via a
  // useSyncExternalStore subscription instead of triggering a top-level
  // re-render.
  const hoverCellRef = useRef<{ cell: number; spaceId: string } | null>(null);
  const onCellHover = useCallback((cell: number, spaceId: string) => {
    hoverCellRef.current = { cell, spaceId };
  }, []);

  // Helpers: cell-index ↔ ISO timestamp inside the visible window.
  // Cell→ISO is delegated to the window hook so DST-changeover weeks
  // (where one day is 23 or 25 hours) don't smear the missing/extra
  // hour evenly across every cell. windowStartMs/windowEndMs/msPerCell
  // stay around for collision math against existing reservations,
  // where uniform cell width is fine because we're comparing two cell
  // indices on the same row.
  const windowStartMs = useMemo(() => new Date(win.startAtIso).getTime(), [win.startAtIso]);
  const windowEndMs = useMemo(() => new Date(win.endAtIso).getTime(), [win.endAtIso]);
  const msPerCell = useMemo(
    () => (windowEndMs - windowStartMs) / totalColumns,
    [windowStartMs, windowEndMs, totalColumns],
  );
  const cellToIso = win.cellToIso;

  // ── Drag-create ────────────────────────────────────────────────────
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createPayload, setCreatePayload] = useState<{
    room: SchedulerRoom;
    startAtIso: string;
    endAtIso: string;
  } | null>(null);

  const dragCreate = useDragCreate({
    columnsPerDay: win.columnsPerDay,
    numDays: win.dates.length,
    onComplete: (range) => {
      const room = data.rooms.find((r) => r.space_id === range.spaceId);
      if (!room) return;
      // Deny → open override dialog (rules say no, but the operator may
      // have rooms.override_rules — the API gates the actual write).
      const eff = win.state.bookForPersonId ? room.rule_outcome.effect : 'allow';
      const startAtIso = cellToIso(range.startCell);
      const endAtIso = cellToIso(range.endCell + 1); // exclusive end
      if (eff === 'deny') {
        setOverrideRoom(room);
        setOverridePayload({ startAtIso, endAtIso });
        setOverrideOpen(true);
      } else {
        setCreatePayload({ room, startAtIso, endAtIso });
        setCreateDialogOpen(true);
      }
    },
  });
  // Source of truth for the live drag-create preview is the hook's
  // `active` state. No mirror state needed.
  const pendingCreate = dragCreate.active;

  const onCellPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, spaceId: string) => {
      // Shift-click is delegated to the row's onClick (pointerDown alone
      // shouldn't paint a drag rectangle on a multi-select gesture).
      if (e.shiftKey) return;
      dragCreate.onPointerDown(e, spaceId);
    },
    [dragCreate],
  );

  // ── Drag-resize / move ────────────────────────────────────────────
  const editBooking = useEditBooking();

  const persistEdit = useCallback(
    async (
      reservationId: string,
      newStartIso: string,
      newEndIso: string,
      newSpaceId?: string,
    ) => {
      try {
        await editBooking.mutateAsync({
          id: reservationId,
          patch: {
            start_at: newStartIso,
            end_at: newEndIso,
            ...(newSpaceId ? { space_id: newSpaceId } : null),
          },
        });
        toastUpdated('Booking');
      } catch (e) {
        toastError("Couldn't update booking", {
          error: e,
          retry: () => persistEdit(reservationId, newStartIso, newEndIso, newSpaceId),
        });
      }
    },
    [editBooking],
  );

  const dragResize = useDragResize({
    columnsPerDay: win.columnsPerDay,
    numDays: win.dates.length,
    onComplete: (state) => {
      void persistEdit(
        state.reservationId,
        cellToIso(state.newStartCell),
        cellToIso(state.newEndCell + 1),
      );
    },
  });

  const dragMove = useDragMove({
    columnsPerDay: win.columnsPerDay,
    numDays: win.dates.length,
    onComplete: (state) => {
      // Cross-row drop: pass the new space id when the user landed in a
      // different lane than the one the reservation started in. The
      // backend's `editOne` already accepts `space_id` in the patch and
      // re-runs the conflict guard against the destination room.
      const switchedRow =
        state.targetSpaceId && state.targetSpaceId !== state.originSpaceId;
      void persistEdit(
        state.reservationId,
        cellToIso(state.newStartCell),
        cellToIso(state.newEndCell + 1),
        switchedRow ? state.targetSpaceId : undefined,
      );
    },
  });

  // Detect collisions for the active drag — used to paint green / red on
  // the dragged block. We loop the row's reservations and compare.
  const activeDragSpaceId = (dragResize.active || dragMove.active)
    ? findSpaceForReservation(
        (dragResize.active ?? dragMove.active!)!.reservationId,
        data.reservationsBySpaceId,
      )
    : null;

  const computeCollision = useCallback(
    (spaceId: string | null, reservationId: string, newStart: number, newEnd: number) => {
      if (!spaceId) return false;
      const list = data.reservationsBySpaceId.get(spaceId) ?? [];
      for (const r of list) {
        if (r.id === reservationId) continue;
        const start = Math.round((new Date(r.effective_start_at).getTime() - windowStartMs) / msPerCell);
        const end = Math.round((new Date(r.effective_end_at).getTime() - windowStartMs) / msPerCell);
        if (newStart < end && newEnd + 1 > start) return true;
      }
      return false;
    },
    [data.reservationsBySpaceId, windowStartMs, msPerCell],
  );

  const pendingResize: (ResizeState & { spaceId: string; collide: boolean }) | null =
    dragResize.active && activeDragSpaceId
      ? {
          ...dragResize.active,
          spaceId: activeDragSpaceId,
          collide: computeCollision(
            activeDragSpaceId,
            dragResize.active.reservationId,
            dragResize.active.newStartCell,
            dragResize.active.newEndCell,
          ),
        }
      : null;

  // Cross-row drag-move: the preview block paints in the TARGET row (the
  // lane the cursor is hovering over) rather than the origin. Collision is
  // also checked against the target's reservations so the block goes red
  // when the operator is about to drop onto an existing booking.
  const pendingMove:
    | (MoveState & { spaceId: string; collide: boolean; isGhost: boolean })
    | null =
    dragMove.active && activeDragSpaceId
      ? {
          ...dragMove.active,
          spaceId: dragMove.active.targetSpaceId || activeDragSpaceId,
          isGhost:
            !!dragMove.active.targetSpaceId &&
            dragMove.active.targetSpaceId !== activeDragSpaceId,
          collide: computeCollision(
            dragMove.active.targetSpaceId || activeDragSpaceId,
            dragMove.active.reservationId,
            dragMove.active.newStartCell,
            dragMove.active.newEndCell,
          ),
        }
      : null;

  // Cell-level pointer routing for the row. PointerMove + Up are forwarded
  // to whichever drag is active.
  const onCellPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragCreate.onPointerMove(e);
      if (dragResize.active) dragResize.onPointerMove(e);
      if (dragMove.active) dragMove.onPointerMove(e);
    },
    [dragCreate, dragResize, dragMove],
  );

  const onCellPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragCreate.onPointerUp(e);
      if (dragResize.active) dragResize.onPointerUp(e);
      if (dragMove.active) dragMove.onPointerUp(e);
    },
    [dragCreate, dragResize, dragMove],
  );

  // ── Event-block click → details dialog ────────────────────────────
  const [eventDialogOpen, setEventDialogOpen] = useState(false);
  const [activeReservation, setActiveReservation] = useState<Reservation | null>(null);

  const onEventClick = useCallback((r: Reservation) => {
    setActiveReservation(r);
    setEventDialogOpen(true);
  }, []);

  const activeReservationRoomName = useMemo(() => {
    if (!activeReservation) return null;
    return data.rooms.find((r) => r.space_id === activeReservation.space_id)?.name ?? null;
  }, [activeReservation, data.rooms]);

  // ── Override-rules flow ───────────────────────────────────────────
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideRoom, setOverrideRoom] = useState<SchedulerRoom | null>(null);
  const [overridePayload, setOverridePayload] = useState<{ startAtIso: string; endAtIso: string } | null>(null);

  // Stabilised drag-event start handlers — the SchedulerGridRow is memo'd
  // so passing fresh inline closures every render makes the memo useless
  // and re-renders all visible rows on every state tick. useCallback with
  // primitive deps keeps the row's prop refs equal across normal renders.
  const onEventResizeStart = useCallback(
    (
      e: React.PointerEvent<HTMLElement>,
      r: Reservation,
      edge: 'start' | 'end',
      startCell: number,
      endCell: number,
      rowEl: HTMLElement,
    ) => {
      dragResize.begin(e, { reservationId: r.id, edge, startCell, endCell, rowEl });
    },
    [dragResize],
  );

  const onEventMoveStart = useCallback(
    (
      e: React.PointerEvent<HTMLElement>,
      r: Reservation,
      startCell: number,
      endCell: number,
      rowEl: HTMLElement,
    ) => {
      dragMove.begin(e, { reservationId: r.id, startCell, endCell, rowEl });
    },
    [dragMove],
  );

  const onCellClickWhenDenied = useCallback(
    (cell: number, _outcome: RuleOutcome, room: SchedulerRoom) => {
      const start = cellToIso(cell);
      // 2 cells = ~1 hour at 30-min granularity.
      const end = cellToIso(Math.min(cell + 2, totalColumns));
      setOverrideRoom(room);
      setOverridePayload({ startAtIso: start, endAtIso: end });
      setOverrideOpen(true);
    },
    [cellToIso, totalColumns],
  );

  // ── Multi-room ────────────────────────────────────────────────────
  const selectedSpaceIds = useMemo(() => Array.from(multiSel.keys()), [multiSel]);

  // ── Header label ───────────────────────────────────────────────────
  const headerLabel = useMemo(() => {
    if (win.state.viewMode === 'day') {
      return formatDayLabel(`${win.dates[0]}T12:00:00`);
    }
    const first = formatDayLabel(`${win.dates[0]}T12:00:00`, 'range');
    const last = formatDayLabel(`${win.dates[win.dates.length - 1]}T12:00:00`, 'range');
    return `${first} – ${last}`;
  }, [win.dates, win.state.viewMode]);

  return (
    <div className="flex h-[calc(100vh-3.5rem)] w-full flex-col">
      {/* Minimal top bar — feature title + back link, per the
          "true app-within-the-admin" exception in CLAUDE.md. */}
      <div className="flex items-center justify-between px-4 py-2 border-b">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/desk"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" /> Service Desk
          </Link>
          <div className="h-4 w-px bg-border" />
          <h1 className="text-sm font-semibold tracking-tight">Room scheduler</h1>
          <span className="text-xs text-muted-foreground">
            {data.isFetching ? 'Updating…' : `${data.rooms.length} rooms`}
          </span>
        </div>
      </div>

      <SchedulerToolbar
        state={win.state}
        update={win.update}
        onPrev={() => win.navigate(-1)}
        onNext={() => win.navigate(1)}
        onToday={win.goToToday}
        visibleDateLabel={headerLabel}
      />

      {data.isError ? (
        <div className="flex flex-1 items-center justify-center text-sm text-destructive">
          {data.error instanceof Error ? data.error.message : 'Scheduler failed to load'}
        </div>
      ) : data.isLoading ? (
        <SchedulerSkeleton />
      ) : data.rooms.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="text-sm font-medium">No rooms match the current filters.</div>
          <div className="max-w-sm text-xs text-muted-foreground">
            Try clearing the building / floor / type filters above, or widen
            the search term.
          </div>
        </div>
      ) : (
        <SchedulerGrid
          rooms={data.rooms}
          reservationsBySpaceId={data.reservationsBySpaceId}
          windowStartIso={win.startAtIso}
          windowEndIso={win.endAtIso}
          totalColumns={totalColumns}
          dates={win.dates}
          dayStartHour={win.state.dayStartHour}
          dayEndHour={win.state.dayEndHour}
          cellMinutes={win.state.cellMinutes}
          cellOutcomesByRoom={cellOutcomesByRoom}
          selectedCellsByRoom={multiSel}
          pendingCreate={pendingCreate}
          pendingResize={pendingResize}
          pendingMove={pendingMove}
          onCellPointerDown={onCellPointerDown}
          onCellPointerMove={onCellPointerMove}
          onCellPointerUp={onCellPointerUp}
          onCellShiftClick={onCellShiftClick}
          onCellHover={onCellHover}
          onEventClick={onEventClick}
          onEventResizeStart={onEventResizeStart}
          onEventMoveStart={onEventMoveStart}
          onCellClickWhenDenied={onCellClickWhenDenied}
        />
      )}

      <SchedulerCreatePopover
        open={createDialogOpen}
        onOpenChange={(o) => {
          setCreateDialogOpen(o);
          if (!o) setCreatePayload(null);
        }}
        room={createPayload?.room ?? null}
        startAtIso={createPayload?.startAtIso ?? ''}
        endAtIso={createPayload?.endAtIso ?? ''}
        currentUserPersonId={requesterPersonId}
        toolbarBookForPersonId={win.state.bookForPersonId}
      />

      <SchedulerEventPopover
        open={eventDialogOpen}
        onOpenChange={setEventDialogOpen}
        reservation={activeReservation}
        roomName={activeReservationRoomName}
      />

      <SchedulerOverrideDialog
        open={overrideOpen}
        onOpenChange={(o) => {
          setOverrideOpen(o);
          if (!o) setOverrideRoom(null);
        }}
        room={overrideRoom}
        startAtIso={overridePayload?.startAtIso ?? ''}
        endAtIso={overridePayload?.endAtIso ?? ''}
        requesterPersonId={win.state.bookForPersonId ?? requesterPersonId}
        bookForName={bookForName}
        denialMessage={overrideRoom?.rule_outcome.denial_message ?? null}
      />

      <SchedulerMultiRoomToggle
        selectedSpaceIds={selectedSpaceIds}
        onClear={() => setMultiSel(new Map())}
        onBookAll={() => {
          // 501 today; the toggle's button is disabled with a tooltip.
        }}
      />
    </div>
  );
}

/**
 * Linear scan to find which room a reservation belongs to. Cheap because
 * the visible reservation set is bounded by the window query (default
 * cap 2000 rows).
 */
function findSpaceForReservation(
  reservationId: string,
  index: Map<string, Reservation[]>,
): string | null {
  for (const [spaceId, list] of index) {
    for (const r of list) {
      if (r.id === reservationId) return spaceId;
    }
  }
  return null;
}

/**
 * Skeleton placeholder for the grid while the picker + window queries
 * resolve. Mirrors the row layout (room column + time area) so the swap
 * to real content is visually stable — no layout shift.
 */
function SchedulerSkeleton() {
  return (
    <div className="flex-1 overflow-hidden">
      <div className="border-b">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="grid border-b"
            style={{ gridTemplateColumns: '220px 1fr', height: 48 }}
          >
            <div className="flex flex-col justify-center gap-1 border-r px-3">
              <div className="h-3 w-32 animate-pulse rounded bg-muted/70" />
              <div className="h-2 w-20 animate-pulse rounded bg-muted/40" />
            </div>
            <div className="relative">
              {i % 2 === 0 && (
                <div
                  className="absolute top-2 bottom-2 animate-pulse rounded bg-muted/60"
                  style={{ left: '12%', width: '20%' }}
                />
              )}
              {i % 3 === 0 && (
                <div
                  className="absolute top-2 bottom-2 animate-pulse rounded bg-muted/40"
                  style={{ left: '50%', width: '15%' }}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
