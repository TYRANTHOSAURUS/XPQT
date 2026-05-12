import { useNow } from '@/lib/use-now';

// Past-slot striping that overlays the lane row from window-start through
// `now()`. Replaces the booking-scheduler's setup/teardown buffer concept
// with a simpler "the past is dimmer" affordance — operators should drag
// new blocks to the future, but backfill is allowed (per Slice A).
//
// Adapted from `scheduler-buffer-shading.tsx` — same CSS-only pattern,
// but the band stretches from cell 0 to "now" rather than a per-block
// buffer.

interface Props {
  /** First cell in the visible window. Always 0; passed for clarity. */
  windowStartIso: string;
  windowEndIso: string;
  totalColumns: number;
}

export function LaneBufferShading({ windowStartIso, windowEndIso, totalColumns }: Props) {
  // Tick on a minute boundary so the striping creeps forward smoothly
  // (otherwise the past-stripe edge would lag until something else
  // forced a row re-render).
  useNow(60_000);

  const startMs = new Date(windowStartIso).getTime();
  const endMs = new Date(windowEndIso).getTime();
  const nowMs = Date.now();

  // Outside the window entirely — render nothing.
  if (nowMs <= startMs) return null;

  // After the window — every cell is past; shade the whole lane.
  const clampedNow = Math.min(nowMs, endMs);
  const fraction = (clampedNow - startMs) / (endMs - startMs);
  const widthPct = Math.max(0, Math.min(1, fraction)) * 100;

  // Cheap diagonal stripe pattern. `bg-muted/40` matches the booking
  // scheduler's buffer tint, but striped instead of solid so live blocks
  // remain readable on top.
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute top-0 bottom-0 left-0"
      style={{
        width: `${widthPct}%`,
        backgroundImage:
          'repeating-linear-gradient(135deg, rgba(127,127,127,0.10) 0 6px, transparent 6px 12px)',
      }}
    />
  );
  void totalColumns;
}
