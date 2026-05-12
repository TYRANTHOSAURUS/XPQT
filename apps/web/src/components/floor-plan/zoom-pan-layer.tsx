import { useRef, useState, useCallback, type ReactNode, type WheelEvent, type PointerEvent } from 'react';

type Props = {
  children: ReactNode;
  minScale?: number;
  maxScale?: number;
  /**
   * When `true`, only pan on middle-click (button 1) / right-click (button 2) /
   * space+left. Reserves left-click for child interactions (drawing tools, polygon
   * selection). Default for designer mode. The booking-surface view can opt out.
   */
  reserveLeftClickForChildren?: boolean;
};

/** Returns true when the user has requested reduced motion via OS/browser preference. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function ZoomPanLayer({
  children,
  minScale = 0.25,
  maxScale = 8,
  reserveLeftClickForChildren = true,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [{ scale, tx, ty }, setTransform] = useState({ scale: 1, tx: 0, ty: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number; pointerId: number } | null>(null);

  const handleWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
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
    // In designer mode, left-click (button 0) belongs to drawing tools — don't
    // capture it here. Pan via middle (1) or right (2) click, or any button on
    // touch (button === 0 but pointerType === 'mouse' is what we filter).
    if (reserveLeftClickForChildren && e.button === 0 && e.pointerType === 'mouse') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, tx, ty, pointerId: e.pointerId };
    setDragging(true);
    e.preventDefault();
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    setTransform((prev) => ({ ...prev, tx: drag.tx + dx, ty: drag.ty + dy }));
  };

  const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null;
      setDragging(false);
    }
  };

  // Block the default context menu so right-click drag-to-pan works cleanly.
  const handleContextMenu = (e: React.MouseEvent) => {
    if (reserveLeftClickForChildren) e.preventDefault();
  };

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onContextMenu={handleContextMenu}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        cursor: dragging ? 'grabbing' : 'default',
        touchAction: 'none',
      }}
    >
      <div
        style={{
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transformOrigin: '0 0',
          width: '100%',
          height: '100%',
        }}
      >
        {children}
      </div>
    </div>
  );
}
