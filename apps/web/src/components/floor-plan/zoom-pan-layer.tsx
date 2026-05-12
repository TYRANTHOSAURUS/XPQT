import { useRef, useState, useCallback, type ReactNode, type WheelEvent, type PointerEvent } from 'react';

type Props = { children: ReactNode; minScale?: number; maxScale?: number };

/** Returns true when the user has requested reduced motion via OS/browser preference. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function ZoomPanLayer({ children, minScale = 0.25, maxScale = 8 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [{ scale, tx, ty }, setTransform] = useState({ scale: 1, tx: 0, ty: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const handleWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    // Reduced-motion: skip the smooth ramp (delta multiplier) and jump directly to a fixed step.
    const delta = prefersReducedMotion() ? (e.deltaY < 0 ? 0.15 : -0.15) : -e.deltaY * 0.0012;
    setTransform((prev) => {
      const next = Math.min(maxScale, Math.max(minScale, prev.scale * (1 + delta)));
      const ratio = next / prev.scale;
      return {
        scale: next,
        tx: cx - (cx - prev.tx) * ratio,
        ty: cy - (cy - prev.ty) * ratio,
      };
    });
  }, [minScale, maxScale]);

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, tx, ty };
    setDragging(true);
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    // Snapshot the ref BEFORE setTransform; the updater closure can be deferred
    // and the ref may be cleared by handlePointerUp before the updater runs.
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    setTransform((prev) => ({ ...prev, tx: drag.tx + dx, ty: drag.ty + dy }));
  };

  const handlePointerUp = () => { dragRef.current = null; setDragging(false); };

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{ width: '100%', height: '100%', overflow: 'hidden', cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
    >
      <div style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})`, transformOrigin: '0 0', width: '100%', height: '100%' }}>
        {children}
      </div>
    </div>
  );
}
