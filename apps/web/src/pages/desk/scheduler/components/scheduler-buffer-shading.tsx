interface Props {
  /** Cell index where the buffer starts (inclusive). */
  startCell: number;
  /** Cell index where the buffer ends (exclusive). */
  endCell: number;
  totalColumns: number;
}

/**
 * Lighter shading rendered behind the meeting block over its setup /
 * teardown buffer windows. Spec §4.4: "Buffer windows shaded lighter
 * than the meeting itself."
 *
 * Pure visual — no interactivity. Rendered at the row layer (sibling of
 * `SchedulerEventBlock`) so the shaded band sits *behind* the block but
 * *ahead* of the empty-cell hover layer.
 */
export function SchedulerBufferShading({ startCell, endCell, totalColumns }: Props) {
  if (endCell <= startCell || endCell <= 0 || startCell >= totalColumns) return null;
  const left = (startCell / totalColumns) * 100;
  const width = ((endCell - startCell) / totalColumns) * 100;
  return (
    <div
      aria-hidden
      className="absolute top-1 bottom-1 rounded-md bg-muted/40 pointer-events-none"
      style={{ left: `${left}%`, width: `${width}%` }}
    />
  );
}
