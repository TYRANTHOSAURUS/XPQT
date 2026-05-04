import { useCallback, useRef, useState } from 'react';

/**
 * Pointer-driven drag-to-resize on an existing event block (extending the
 * leading or trailing edge). Pairs with `useDragMove` for whole-block
 * translation; the two are intentionally separate hooks because the
 * cell-snap math differs (resize anchors one edge; move translates both).
 *
 * Emits a live {newStartCell, newEndCell} during drag; the row component
 * paints a green / red border based on whether the path collides with any
 * other event on the same row.
 *
 * Phase 1.4 (slot-first scheduler): ResizeState carries both `bookingId`
 * AND `slotId`. The legacy single `reservationId` (= booking id) couldn't
 * disambiguate slots in a multi-room booking — using only the booking id
 * routed every resize through the booking's primary slot. The scheduler
 * PATCHes `/reservations/:bookingId/slots/:slotId`, so both ids are
 * needed in the completion payload.
 */

export type ResizeEdge = 'start' | 'end';

export interface ResizeState {
  bookingId: string;
  slotId: string;
  edge: ResizeEdge;
  newStartCell: number;
  newEndCell: number;
}

export function useDragResize(opts: {
  columnsPerDay: number;
  numDays: number;
  onComplete: (state: ResizeState) => void;
}) {
  const { columnsPerDay, numDays, onComplete } = opts;
  const totalColumns = columnsPerDay * numDays;

  const [active, setActive] = useState<ResizeState | null>(null);
  const ctxRef = useRef<{
    bookingId: string;
    slotId: string;
    edge: ResizeEdge;
    fixedStartCell: number;
    fixedEndCell: number;
    rowEl: HTMLElement;
  } | null>(null);

  const cellFromClientX = useCallback(
    (rowEl: HTMLElement, clientX: number): number => {
      const rect = rowEl.getBoundingClientRect();
      const x = clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      return Math.min(totalColumns - 1, Math.max(0, Math.floor(ratio * totalColumns)));
    },
    [totalColumns],
  );

  const begin = useCallback(
    (e: React.PointerEvent<HTMLElement>, args: {
      bookingId: string;
      slotId: string;
      edge: ResizeEdge;
      startCell: number;
      endCell: number;
      rowEl: HTMLElement;
    }) => {
      e.stopPropagation();
      e.preventDefault();
      args.rowEl.setPointerCapture(e.pointerId);
      ctxRef.current = {
        bookingId: args.bookingId,
        slotId: args.slotId,
        edge: args.edge,
        fixedStartCell: args.startCell,
        fixedEndCell: args.endCell,
        rowEl: args.rowEl,
      };
      setActive({
        bookingId: args.bookingId,
        slotId: args.slotId,
        edge: args.edge,
        newStartCell: args.startCell,
        newEndCell: args.endCell,
      });
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      const cell = cellFromClientX(ctx.rowEl, e.clientX);
      if (ctx.edge === 'start') {
        // Clamp to leave at least one cell of duration. Without -1 the user
        // could pull the start handle past the fixed end, producing a
        // start_at === end_at PATCH that the API rejects (400 "end must be
        // after start"). The grid would then snap the block back without
        // any visible explanation — looks like a broken drag.
        const newStart = Math.min(cell, ctx.fixedEndCell - 1);
        setActive({
          bookingId: ctx.bookingId,
          slotId: ctx.slotId,
          edge: 'start',
          newStartCell: newStart,
          newEndCell: ctx.fixedEndCell,
        });
      } else {
        const newEnd = Math.max(cell, ctx.fixedStartCell + 1);
        setActive({
          bookingId: ctx.bookingId,
          slotId: ctx.slotId,
          edge: 'end',
          newStartCell: ctx.fixedStartCell,
          newEndCell: newEnd,
        });
      }
    },
    [cellFromClientX],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      try {
        ctx.rowEl.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      const cell = cellFromClientX(ctx.rowEl, e.clientX);
      const next: ResizeState =
        ctx.edge === 'start'
          ? {
              bookingId: ctx.bookingId,
              slotId: ctx.slotId,
              edge: 'start',
              newStartCell: Math.min(cell, ctx.fixedEndCell),
              newEndCell: ctx.fixedEndCell,
            }
          : {
              bookingId: ctx.bookingId,
              slotId: ctx.slotId,
              edge: 'end',
              newStartCell: ctx.fixedStartCell,
              newEndCell: Math.max(cell, ctx.fixedStartCell),
            };
      // Skip the API round-trip if the user grabbed the handle but didn't
      // actually move it — otherwise every accidental click on a handle
      // fires a no-op PATCH.
      const moved =
        next.newStartCell !== ctx.fixedStartCell || next.newEndCell !== ctx.fixedEndCell;
      if (moved) onComplete(next);
      ctxRef.current = null;
      setActive(null);
    },
    [cellFromClientX, onComplete],
  );

  return { active, begin, onPointerMove, onPointerUp };
}
