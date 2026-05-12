import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { usePlanningDrag } from './use-planning-drag';

function makeCaptureEl(): HTMLElement {
  const el = document.createElement('div');
  // jsdom doesn't implement pointer capture; stub it so begin() doesn't
  // crash before reaching the swallow path we exercise.
  (el as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = () => {};
  (el as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture = () => {};
  return el;
}

function makePointerEvent(pointerId: number, overrides?: { clientX?: number; clientY?: number }): ReactPointerEvent {
  return {
    pointerId,
    clientX: overrides?.clientX ?? 0,
    clientY: overrides?.clientY ?? 0,
    stopPropagation: () => {},
    preventDefault: () => {},
  } as unknown as ReactPointerEvent;
}

function makeBeginArgs(captureEl: HTMLElement) {
  return {
    blockId: 'wo-1',
    source: 'lane' as const,
    grabOffsetPx: 0,
    cellSpan: 4,
    originLaneKey: 'lane-a',
    captureEl,
    originStartCell: 2,
  };
}

describe('usePlanningDrag — re-entrant begin guard', () => {
  it('ignores a second begin() with a different pointerId while the first gesture is active', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => usePlanningDrag({ totalColumns: 48, onComplete }));

    const captureA = makeCaptureEl();
    act(() => result.current.begin(makePointerEvent(1), makeBeginArgs(captureA)));
    expect(result.current.active?.blockId).toBe('wo-1');
    expect(result.current.active?.originLaneKey).toBe('lane-a');

    const captureB = makeCaptureEl();
    act(() =>
      result.current.begin(makePointerEvent(2), {
        ...makeBeginArgs(captureB),
        blockId: 'wo-2',
        originLaneKey: 'lane-b',
      }),
    );

    // First gesture still owns the context — second pointer is a no-op.
    expect(result.current.active?.blockId).toBe('wo-1');
    expect(result.current.active?.originLaneKey).toBe('lane-a');
  });

  it('allows a fresh begin() with a new pointerId after the previous gesture ended', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => usePlanningDrag({ totalColumns: 48, onComplete }));

    const captureA = makeCaptureEl();
    act(() => result.current.begin(makePointerEvent(1), makeBeginArgs(captureA)));
    act(() => result.current.cancel());
    expect(result.current.active).toBeNull();

    const captureB = makeCaptureEl();
    act(() =>
      result.current.begin(makePointerEvent(2), {
        ...makeBeginArgs(captureB),
        blockId: 'wo-2',
        originLaneKey: 'lane-b',
      }),
    );
    expect(result.current.active?.blockId).toBe('wo-2');
    expect(result.current.active?.originLaneKey).toBe('lane-b');
  });

  it('allows a begin() with the same pointerId as the active gesture (same-pointer re-arm)', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => usePlanningDrag({ totalColumns: 48, onComplete }));

    const captureA = makeCaptureEl();
    act(() => result.current.begin(makePointerEvent(1), makeBeginArgs(captureA)));

    const captureA2 = makeCaptureEl();
    act(() =>
      result.current.begin(makePointerEvent(1), {
        ...makeBeginArgs(captureA2),
        blockId: 'wo-3',
        originLaneKey: 'lane-c',
      }),
    );

    // Same pointer is permitted — guard only rejects a *different* pointerId.
    expect(result.current.active?.blockId).toBe('wo-3');
    expect(result.current.active?.originLaneKey).toBe('lane-c');
  });
});

describe('usePlanningDrag — pointercancel cleanup (C3)', () => {
  it('clears ctxRef on pointercancel so future begins succeed', () => {
    // Without onPointerCancel, iOS Safari interruptions (scroll takeover,
    // multi-touch escape, system events) leave ctxRef populated forever;
    // the re-entrant-begin guard then rejects every future gesture and
    // the board is permanently locked.
    const onComplete = vi.fn();
    const { result } = renderHook(() => usePlanningDrag({ totalColumns: 48, onComplete }));

    const captureA = makeCaptureEl();
    act(() => result.current.begin(makePointerEvent(1), makeBeginArgs(captureA)));
    expect(result.current.active?.blockId).toBe('wo-1');

    act(() => result.current.onPointerCancel(makePointerEvent(1)));
    expect(result.current.active).toBeNull();

    // A second begin() with a different pointerId should now succeed —
    // proving the cancel path actually cleared ctxRef.
    const captureB = makeCaptureEl();
    act(() =>
      result.current.begin(makePointerEvent(2), {
        ...makeBeginArgs(captureB),
        blockId: 'wo-2',
        originLaneKey: 'lane-b',
      }),
    );
    expect(result.current.active?.blockId).toBe('wo-2');
    expect(result.current.active?.originLaneKey).toBe('lane-b');
  });

  it('ignores pointercancel for a foreign pointerId (multi-touch noise)', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => usePlanningDrag({ totalColumns: 48, onComplete }));

    const captureA = makeCaptureEl();
    act(() => result.current.begin(makePointerEvent(1), makeBeginArgs(captureA)));

    // Some other pointer is cancelled — the active gesture must keep
    // running. (Second-finger-lifts case on iPad.)
    act(() => result.current.onPointerCancel(makePointerEvent(99)));
    expect(result.current.active?.blockId).toBe('wo-1');
  });
});

describe('usePlanningDrag — foreign-pointer gating (I1)', () => {
  it('onPointerMove ignores events from a different pointerId', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => usePlanningDrag({ totalColumns: 48, onComplete }));

    const captureA = makeCaptureEl();
    act(() => result.current.begin(makePointerEvent(1), makeBeginArgs(captureA)));
    const before = result.current.active;

    // Second finger on iPad: window listener fires for pointerId=2.
    // If the guard is missing, this would drive the active gesture with
    // the wrong coordinates.
    act(() => result.current.onPointerMove(makePointerEvent(2, { clientX: 999, clientY: 999 })));
    expect(result.current.active).toEqual(before);
  });

  it('onPointerUp ignores events from a different pointerId', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => usePlanningDrag({ totalColumns: 48, onComplete }));

    const captureA = makeCaptureEl();
    act(() => result.current.begin(makePointerEvent(1), makeBeginArgs(captureA)));

    act(() => result.current.onPointerUp(makePointerEvent(2)));
    // Active gesture must persist; onComplete must not have fired.
    expect(result.current.active?.blockId).toBe('wo-1');
    expect(onComplete).not.toHaveBeenCalled();
  });
});
