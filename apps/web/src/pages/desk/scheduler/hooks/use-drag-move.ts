import { useCallback, useRef, useState } from 'react';

/**
 * Pointer-driven drag-to-move on an existing event block. Translates the
 * whole block horizontally — start + end shift together by the same delta
 * cells. Pairs with `useDragResize` (which anchors one edge).
 */

export interface MoveState {
  reservationId: string;
  newStartCell: number;
  newEndCell: number;
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
      reservationId: string;
      startCell: number;
      endCell: number;
      rowEl: HTMLElement;
    }) => {
      e.stopPropagation();
      e.preventDefault();
      args.rowEl.setPointerCapture(e.pointerId);
      const pointerCell = cellFromClientX(args.rowEl, e.clientX);
      ctxRef.current = {
        reservationId: args.reservationId,
        initialStartCell: args.startCell,
        initialEndCell: args.endCell,
        pointerStartCell: pointerCell,
        rowEl: args.rowEl,
      };
      setActive({
        reservationId: args.reservationId,
        newStartCell: args.startCell,
        newEndCell: args.endCell,
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
      // Clamp to the total grid width.
      const newStart = Math.max(0, Math.min(totalColumns - 1 - span, ctx.initialStartCell + delta));
      const newEnd = newStart + span;
      setActive({
        reservationId: ctx.reservationId,
        newStartCell: newStart,
        newEndCell: newEnd,
      });
    },
    [cellFromClientX, totalColumns],
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
      // No-op if the user didn't actually move.
      if (newStart !== ctx.initialStartCell) {
        onComplete({
          reservationId: ctx.reservationId,
          newStartCell: newStart,
          newEndCell: newEnd,
        });
      }
      ctxRef.current = null;
      setActive(null);
    },
    [cellFromClientX, onComplete, totalColumns],
  );

  return { active, begin, onPointerMove, onPointerUp };
}
