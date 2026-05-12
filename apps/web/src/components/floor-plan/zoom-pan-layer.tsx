import { useRef, useState, useCallback, type ReactNode, type WheelEvent, type PointerEvent } from 'react';

type Props = { children: ReactNode; minScale?: number; maxScale?: number };

/** Returns true when the user has requested reduced motion via OS/browser preference. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function ZoomPanLayer({ children, minScale = 0.25, maxScale = 8 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [{ scale, tx, ty }, setTransform] = useState({ scale: 1, tx: 0, ty: 0 });
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
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setTransform((prev) => ({
      ...prev,
      tx: dragRef.current!.tx + (e.clientX - dragRef.current!.x),
      ty: dragRef.current!.ty + (e.clientY - dragRef.current!.y),
    }));
  };

  const handlePointerUp = () => { dragRef.current = null; };

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{ width: '100%', height: '100%', overflow: 'hidden', cursor: dragRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}
    >
      <div style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})`, transformOrigin: '0 0', width: '100%', height: '100%' }}>
        {children}
      </div>
    </div>
  );
}
