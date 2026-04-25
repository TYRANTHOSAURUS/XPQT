import { useCallback, useRef, useState } from 'react';

/**
 * Pointer-driven drag-to-create on an empty cell. Maps client X → cell
 * index by reading the row element's bounding rect; emits {start, end}
 * cell indices that the row component renders as a pending highlight.
 *
 * Release fires `onComplete` with the resolved {space_id, startCell,
 * endCell} which the page maps to ISO timestamps and feeds into the
 * create-popover.
 *
 * Why hand-rolled (not @dnd-kit): the gesture isn't draggable items into
 * targets — it's painting a range over a static grid. dnd-kit would
 * fight us on hit-testing and add bundle weight; native pointer events
 * are 30 lines.
 */

export interface DragCreateRange {
  spaceId: string;
  startCell: number;
  endCell: number; // inclusive
  rowEl: HTMLElement;
}

export function useDragCreate(opts: {
  columnsPerDay: number;
  numDays: number;
  onComplete: (range: DragCreateRange) => void;
}) {
  const { columnsPerDay, numDays, onComplete } = opts;
  const totalColumns = columnsPerDay * numDays;

  const [active, setActive] = useState<DragCreateRange | null>(null);
  const startRef = useRef<{ spaceId: string; startCell: number; rowEl: HTMLElement } | null>(null);

  const cellFromClientX = useCallback(
    (rowEl: HTMLElement, clientX: number): number => {
      const rect = rowEl.getBoundingClientRect();
      const x = clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      // Floor — pointer in the middle of a cell still resolves to that cell.
      return Math.min(totalColumns - 1, Math.max(0, Math.floor(ratio * totalColumns)));
    },
    [totalColumns],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, spaceId: string) => {
      // Only respond to primary button + non-modifier (avoid hijacking
      // shift-click for multi-select, ctrl-click for ctx menus, etc).
      if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey) return;
      const rowEl = e.currentTarget;
      rowEl.setPointerCapture(e.pointerId);
      const startCell = cellFromClientX(rowEl, e.clientX);
      startRef.current = { spaceId, startCell, rowEl };
      setActive({ spaceId, startCell, endCell: startCell, rowEl });
    },
    [cellFromClientX],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const ref = startRef.current;
      if (!ref) return;
      const cell = cellFromClientX(ref.rowEl, e.clientX);
      const startCell = Math.min(ref.startCell, cell);
      const endCell = Math.max(ref.startCell, cell);
      setActive({ spaceId: ref.spaceId, startCell, endCell, rowEl: ref.rowEl });
    },
    [cellFromClientX],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const ref = startRef.current;
      if (!ref) return;
      try {
        ref.rowEl.releasePointerCapture(e.pointerId);
      } catch {
        // ignore — pointer may already be released
      }
      const cell = cellFromClientX(ref.rowEl, e.clientX);
      const startCell = Math.min(ref.startCell, cell);
      const endCell = Math.max(ref.startCell, cell);
      // Single-cell click is treated as a 1-cell range (typical 30 min slot).
      if (endCell >= startCell) {
        onComplete({ spaceId: ref.spaceId, startCell, endCell, rowEl: ref.rowEl });
      }
      startRef.current = null;
      setActive(null);
    },
    [cellFromClientX, onComplete],
  );

  return { active, onPointerDown, onPointerMove, onPointerUp };
}
