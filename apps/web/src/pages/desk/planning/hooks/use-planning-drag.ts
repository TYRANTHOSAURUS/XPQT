import { useCallback, useRef, useState } from 'react';

/**
 * Planning-board drag controller. Two flavours of gesture, one hook:
 *
 *   1. Move a placed block from one lane / slot to another. Origin lane
 *      is the lane the block was painted on; target lane is whatever
 *      `data-lane-key` ancestor the cursor is currently over.
 *   2. Drop an unscheduled block onto a lane. Origin lane is null; the
 *      block carries the rail's identity.
 *
 * Pointer events are captured on the originating element so `pointermove`
 * keeps firing once the cursor leaves the row (the booking scheduler does
 * the same — see `use-drag-move.ts`). Lane detection uses
 * `document.elementFromPoint` since `pointercapture` pins the event
 * target.
 *
 * I evaluated re-using the scheduler's `useDragMove`. It assumes a
 * `bookingId + slotId` identity model and a single-origin-row capture
 * pattern that doesn't extend to the rail case. Cheaper to build a small
 * planning-specific hook than to generalise the scheduler one.
 */

export interface PlanningDragState {
  blockId: string;
  /**
   * `'lane'` — drag-move from a placed lane block to a new slot / lane.
   * `'rail'` — drop from the unscheduled rail onto a lane.
   * `'resize'` — drag the right edge of a placed lane block to extend / shrink
   * its `planned_duration_minutes`. Origin lane is preserved; only `cellSpan`
   * + `newEndCell` move. `newStartCell` stays at the block's original start.
   */
  source: 'lane' | 'rail' | 'resize';
  /** Lane key the drag originated on. `null` for rail items. */
  originLaneKey: string | null;
  /** Lane key the cursor is currently over. `null` when not over a lane. */
  targetLaneKey: string | null;
  /** Block's cell span. Mutable when `source === 'resize'`; fixed otherwise. */
  cellSpan: number;
  /** New start cell inside the target lane. For `'resize'` this stays at
   *  the origin start cell. */
  newStartCell: number;
  /** New end cell inside the target lane. */
  newEndCell: number;
}

interface BeginArgs {
  blockId: string;
  source: 'lane' | 'rail' | 'resize';
  /** Pixel offset within the originating block where the drag started.
   *  Used to keep the block's grab point under the cursor. Ignored for
   *  `'resize'` (the right edge is the implicit anchor). */
  grabOffsetPx: number;
  /** Block's cell span (from current `planned_duration_minutes`). */
  cellSpan: number;
  /** Originating lane key (or null for rail items). */
  originLaneKey: string | null;
  /** Originating element — the block / card — captures the pointer so
   *  pointermove keeps firing as the cursor crosses lanes. */
  captureEl: HTMLElement;
  /** Originating start cell on the lane (for lane-source drags). 0 for rail. */
  originStartCell: number;
}

export function usePlanningDrag(opts: {
  totalColumns: number;
  /** Called once on a successful drop (cursor over a lane, position changed). */
  onComplete: (state: PlanningDragState) => void;
}) {
  const { totalColumns, onComplete } = opts;

  const [active, setActive] = useState<PlanningDragState | null>(null);

  const ctxRef = useRef<
    | (BeginArgs & {
        pointerId: number;
        currentTargetLaneKey: string | null;
        currentStartCell: number;
        currentEndCell: number;
        /**
         * The cellSpan at gesture begin. `cellSpan` on BeginArgs is also
         * mutated during the drag (resize only); this captures the
         * original so we can detect "did the span actually change" on
         * pointerUp without comparing against the post-mutation value.
         */
        originCellSpan: number;
      })
    | null
  >(null);

  const begin = useCallback(
    (e: React.PointerEvent, args: BeginArgs) => {
      e.stopPropagation();
      e.preventDefault();
      try {
        args.captureEl.setPointerCapture(e.pointerId);
      } catch {
        // some platforms don't allow capture on every element — that's
        // fine, the elementFromPoint fallback still works.
      }
      ctxRef.current = {
        ...args,
        pointerId: e.pointerId,
        currentTargetLaneKey: args.originLaneKey,
        currentStartCell: args.originStartCell,
        currentEndCell: args.originStartCell + args.cellSpan - 1,
        originCellSpan: args.cellSpan,
      };
      setActive({
        blockId: args.blockId,
        source: args.source,
        originLaneKey: args.originLaneKey,
        targetLaneKey: args.originLaneKey,
        cellSpan: args.cellSpan,
        newStartCell: args.originStartCell,
        newEndCell: args.originStartCell + args.cellSpan - 1,
      });
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      const { laneKey, cellAtCursor } = resolveLaneAtPoint(e.clientX, e.clientY, totalColumns, ctx.grabOffsetPx);

      let startCell: number;
      let endCell: number;
      let span: number;

      if (ctx.source === 'resize') {
        // Resize keeps the block anchored at its original start cell and
        // moves only the right edge. The cursor's cell becomes the new
        // end cell (inclusive); cellSpan recomputes to (end - start + 1).
        // Clamp to at least 1 cell wide so the block can never collapse.
        startCell = ctx.originStartCell;
        const maxEnd = totalColumns - 1;
        endCell = Math.max(startCell, Math.min(maxEnd, cellAtCursor));
        span = endCell - startCell + 1;
      } else {
        // Move / rail-drop: the cursor's cell becomes the new start cell,
        // the span is preserved.
        const maxStart = totalColumns - ctx.cellSpan;
        startCell = Math.max(0, Math.min(maxStart, cellAtCursor));
        endCell = startCell + ctx.cellSpan - 1;
        span = ctx.cellSpan;
      }

      ctx.currentTargetLaneKey = laneKey;
      ctx.currentStartCell = startCell;
      ctx.currentEndCell = endCell;
      ctx.cellSpan = span;
      setActive({
        blockId: ctx.blockId,
        source: ctx.source,
        originLaneKey: ctx.originLaneKey,
        targetLaneKey: ctx.source === 'resize' ? ctx.originLaneKey : laneKey,
        cellSpan: span,
        newStartCell: startCell,
        newEndCell: endCell,
      });
    },
    [totalColumns],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      try {
        ctx.captureEl.releasePointerCapture(ctx.pointerId);
      } catch {
        // ignore
      }
      // Compute the final state from a fresh hit-test (the user can lift
      // the pointer with the cursor still moving — `currentTargetLaneKey`
      // may be one event behind).
      const { laneKey, cellAtCursor } = resolveLaneAtPoint(e.clientX, e.clientY, totalColumns, ctx.grabOffsetPx);

      let startCell: number;
      let endCell: number;
      let span: number;
      let effectiveTargetLane: string | null;

      if (ctx.source === 'resize') {
        startCell = ctx.originStartCell;
        const maxEnd = totalColumns - 1;
        endCell = Math.max(startCell, Math.min(maxEnd, cellAtCursor));
        span = endCell - startCell + 1;
        // Resize is anchored to the origin lane. The cursor's lane is
        // irrelevant — even if it strays the block stays put.
        effectiveTargetLane = ctx.originLaneKey;
      } else {
        const maxStart = totalColumns - ctx.cellSpan;
        startCell = Math.max(0, Math.min(maxStart, cellAtCursor));
        endCell = startCell + ctx.cellSpan - 1;
        span = ctx.cellSpan;
        effectiveTargetLane = laneKey;
      }

      const movedOnSameLane =
        ctx.source !== 'resize' &&
        effectiveTargetLane !== null &&
        effectiveTargetLane === ctx.originLaneKey &&
        startCell !== ctx.originStartCell;
      const droppedOnAnotherLane =
        ctx.source !== 'resize' &&
        effectiveTargetLane !== null &&
        effectiveTargetLane !== ctx.originLaneKey;
      const droppedFromRail = ctx.source === 'rail' && effectiveTargetLane !== null;
      const resizedCommit = ctx.source === 'resize' && span !== ctx.originCellSpan;

      if (movedOnSameLane || droppedOnAnotherLane || droppedFromRail || resizedCommit) {
        onComplete({
          blockId: ctx.blockId,
          source: ctx.source,
          originLaneKey: ctx.originLaneKey,
          targetLaneKey: effectiveTargetLane,
          cellSpan: span,
          newStartCell: startCell,
          newEndCell: endCell,
        });
      }
      ctxRef.current = null;
      setActive(null);
    },
    [onComplete, totalColumns],
  );

  /** Programmatic cancel — e.g. user hit Escape mid-drag. */
  const cancel = useCallback(() => {
    if (ctxRef.current) {
      try {
        ctxRef.current.captureEl.releasePointerCapture(ctxRef.current.pointerId);
      } catch {
        // ignore
      }
    }
    ctxRef.current = null;
    setActive(null);
  }, []);

  return { active, begin, onPointerMove, onPointerUp, cancel };
}

/**
 * Resolve `(clientX, clientY)` to the lane key + cell index the cursor is
 * over. Walks the DOM from elementFromPoint up to the nearest
 * `[data-lane-key]` ancestor, then maps the cursor's X position inside
 * the lane's canvas column (the second grid track) to a cell index.
 * `grabOffsetPx` is subtracted so the block's grab point stays under
 * the cursor.
 */
function resolveLaneAtPoint(
  clientX: number,
  clientY: number,
  totalColumns: number,
  grabOffsetPx: number,
): { laneKey: string | null; cellAtCursor: number } {
  const el = typeof document !== 'undefined' ? document.elementFromPoint(clientX, clientY) : null;
  if (!el) return { laneKey: null, cellAtCursor: 0 };
  const lane = (el as Element).closest('[data-lane-key]');
  if (!lane) return { laneKey: null, cellAtCursor: 0 };
  const laneKey = lane.getAttribute('data-lane-key');

  // The canvas column inside the lane is the second grid track — read
  // the label width back from the inline `gridTemplateColumns` so we
  // can compute the canvas's bounding box without an extra DOM ref.
  let canvasRect: DOMRect | null = null;
  const laneEl = lane as HTMLElement;
  const styleCols = laneEl.style.gridTemplateColumns;
  const m = styleCols.match(/^(\d+)px/);
  if (m) {
    const labelWidth = Number(m[1]);
    const r = laneEl.getBoundingClientRect();
    canvasRect = new DOMRect(r.left + labelWidth, r.top, r.width - labelWidth, r.height);
  } else {
    canvasRect = laneEl.getBoundingClientRect();
  }

  const adjustedX = clientX - grabOffsetPx;
  const x = adjustedX - canvasRect.left;
  const ratio = Math.max(0, Math.min(1, x / Math.max(1, canvasRect.width)));
  const cell = Math.min(totalColumns - 1, Math.max(0, Math.floor(ratio * totalColumns)));
  return { laneKey, cellAtCursor: cell };
}
