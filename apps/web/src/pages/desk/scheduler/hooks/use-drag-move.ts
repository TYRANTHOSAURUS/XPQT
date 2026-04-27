import { useCallback, useRef, useState } from 'react';

/**
 * Pointer-driven drag-to-move on an existing event block.
 *
 * Two axes:
 *   - X axis: shifts start/end together by the same cell delta — same as
 *     a calendar drag.
 *   - Y axis: tracks which row the pointer is over so the operator can
 *     drop the event into a different lane (room). The originating row
 *     keeps pointer capture (otherwise pointermove events would stop the
 *     moment the cursor leaves), and we resolve the target row by walking
 *     up from `document.elementFromPoint(clientX, clientY)` to the
 *     nearest ancestor with `data-space-id`.
 *
 * `onComplete` receives both the new cell range AND the target space id,
 * which equals the original when the user kept the gesture inside one
 * row.
 */

export interface MoveState {
  reservationId: string;
  newStartCell: number;
  newEndCell: number;
  /** The row the cursor is currently over — may differ from origin. */
  targetSpaceId: string;
  /** The row the drag originated on. */
  originSpaceId: string;
}

export function useDragMove(opts: {
  columnsPerDay: number;
  numDays: number;
  onComplete: (state: MoveState) => void;
}) {
  const { columnsPerDay, numDays, onComplete } = opts;
  const totalColumns = columnsPerDay * numDays;

  const [active, setActive] = useState<MoveState | null>(null);
  const ctxRef = useRef<{
    reservationId: string;
    initialStartCell: number;
    initialEndCell: number;
    pointerStartCell: number;
    rowEl: HTMLElement;
    originSpaceId: string;
    targetSpaceId: string;
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

  /**
   * Resolve the row id under (clientX, clientY). PointerCapture pins
   * pointermove events to the originating row, but `elementFromPoint`
   * still works against the live DOM, so we use it to detect lane changes.
   * Falls back to the origin row when the cursor is outside the grid.
   */
  const targetSpaceFromPoint = useCallback(
    (clientX: number, clientY: number, fallback: string): string => {
      const el = document.elementFromPoint(clientX, clientY);
      if (!el) return fallback;
      const row = (el as Element).closest('[data-space-id]');
      const sid = row?.getAttribute('data-space-id');
      return sid ?? fallback;
    },
    [],
  );

  const begin = useCallback(
    (e: React.PointerEvent<HTMLElement>, args: {
      reservationId: string;
      startCell: number;
      endCell: number;
      rowEl: HTMLElement;
    }) => {
      e.stopPropagation();
      e.preventDefault();
      args.rowEl.setPointerCapture(e.pointerId);
      const pointerCell = cellFromClientX(args.rowEl, e.clientX);
      const originSpaceId =
        args.rowEl.closest('[data-space-id]')?.getAttribute('data-space-id') ?? '';
      ctxRef.current = {
        reservationId: args.reservationId,
        initialStartCell: args.startCell,
        initialEndCell: args.endCell,
        pointerStartCell: pointerCell,
        rowEl: args.rowEl,
        originSpaceId,
        targetSpaceId: originSpaceId,
      };
      setActive({
        reservationId: args.reservationId,
        newStartCell: args.startCell,
        newEndCell: args.endCell,
        originSpaceId,
        targetSpaceId: originSpaceId,
      });
    },
    [cellFromClientX],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      const cell = cellFromClientX(ctx.rowEl, e.clientX);
      const delta = cell - ctx.pointerStartCell;
      const span = ctx.initialEndCell - ctx.initialStartCell;
      const newStart = Math.max(0, Math.min(totalColumns - 1 - span, ctx.initialStartCell + delta));
      const newEnd = newStart + span;
      const targetSpaceId = targetSpaceFromPoint(e.clientX, e.clientY, ctx.originSpaceId);
      ctx.targetSpaceId = targetSpaceId;
      setActive({
        reservationId: ctx.reservationId,
        newStartCell: newStart,
        newEndCell: newEnd,
        originSpaceId: ctx.originSpaceId,
        targetSpaceId,
      });
    },
    [cellFromClientX, totalColumns, targetSpaceFromPoint],
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
      const delta = cell - ctx.pointerStartCell;
      const span = ctx.initialEndCell - ctx.initialStartCell;
      const newStart = Math.max(0, Math.min(totalColumns - 1 - span, ctx.initialStartCell + delta));
      const newEnd = newStart + span;
      const targetSpaceId = targetSpaceFromPoint(e.clientX, e.clientY, ctx.originSpaceId);
      const moved = newStart !== ctx.initialStartCell || targetSpaceId !== ctx.originSpaceId;
      if (moved) {
        onComplete({
          reservationId: ctx.reservationId,
          newStartCell: newStart,
          newEndCell: newEnd,
          originSpaceId: ctx.originSpaceId,
          targetSpaceId,
        });
      }
      ctxRef.current = null;
      setActive(null);
    },
    [cellFromClientX, onComplete, totalColumns, targetSpaceFromPoint],
  );

  return { active, begin, onPointerMove, onPointerUp };
}
