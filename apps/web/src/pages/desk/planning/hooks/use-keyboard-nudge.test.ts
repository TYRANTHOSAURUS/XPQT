import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import type { WorkOrderPlanningBlock, WorkOrderPlanningResponse } from '@prequest/shared';
import { useKeyboardNudge } from './use-keyboard-nudge';
import { workOrderPlanningKeys, type PlanningWindowFilters } from '@/api/work-order-planning';

const filters: PlanningWindowFilters = {
  from: '2026-05-12T00:00:00.000Z',
  to: '2026-05-13T00:00:00.000Z',
  status: ['in_progress'],
  teamId: null,
};

function makeBlock(): WorkOrderPlanningBlock {
  return {
    id: 'wo-1',
    module_number: 42,
    title: 'Sample',
    status_category: 'in_progress',
    priority: 'medium',
    planned_start_at: '2026-05-12T10:00:00.000Z',
    planned_duration_minutes: 60,
    sla_resolution_due_at: null,
    lane: { kind: 'user', id: 'u-1', label: 'Alex' },
    request_type: null,
    can_plan: true,
    plan_version: 1,
  };
}

function seedCache(qc: QueryClient): WorkOrderPlanningResponse {
  const seed: WorkOrderPlanningResponse = {
    planned: [makeBlock()],
    unscheduled: [],
    lanes: [{ kind: 'user', id: 'u-1', label: 'Alex' }],
  };
  qc.setQueryData(workOrderPlanningKeys.window(filters), seed);
  return seed;
}

describe('useKeyboardNudge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a single nudgeStart commits ONE call with the cumulative delta after debounce', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedCache(qc);
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useKeyboardNudge({ qc, filters, onCommit, debounceMs: 300 }),
    );

    act(() => result.current.nudgeStart(makeBlock(), 30));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [_block, nextStartIso, nextDuration] = onCommit.mock.calls[0];
    expect(nextStartIso).toBe('2026-05-12T10:30:00.000Z');
    expect(nextDuration).toBeNull();
  });

  it('a burst of 3 nudges collapses into ONE commit with cumulative delta', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedCache(qc);
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useKeyboardNudge({ qc, filters, onCommit, debounceMs: 300 }),
    );

    act(() => {
      result.current.nudgeStart(makeBlock(), -30);
      vi.advanceTimersByTime(100);
      result.current.nudgeStart(makeBlock(), -30);
      vi.advanceTimersByTime(100);
      result.current.nudgeStart(makeBlock(), -30);
    });
    expect(onCommit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [_block, nextStartIso] = onCommit.mock.calls[0];
    // Baseline 10:00 shifted by -90 minutes → 08:30.
    expect(nextStartIso).toBe('2026-05-12T08:30:00.000Z');
  });

  it('combined nudgeStart + nudgeDuration commits BOTH fields in one call', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedCache(qc);
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useKeyboardNudge({ qc, filters, onCommit, debounceMs: 300 }),
    );

    act(() => {
      result.current.nudgeStart(makeBlock(), 30);
      result.current.nudgeDuration(makeBlock(), -30);
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [_block, nextStartIso, nextDuration] = onCommit.mock.calls[0];
    expect(nextStartIso).toBe('2026-05-12T10:30:00.000Z');
    expect(nextDuration).toBe(30); // 60 - 30
  });

  it('flush() commits immediately and cancels the pending timer', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedCache(qc);
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useKeyboardNudge({ qc, filters, onCommit, debounceMs: 300 }),
    );

    act(() => result.current.nudgeStart(makeBlock(), 30));
    act(() => result.current.flush());
    expect(onCommit).toHaveBeenCalledTimes(1);

    // Advancing past the original debounce must NOT fire a second commit.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('optimistic cache patch lands on the planning window key during the burst', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedCache(qc);
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useKeyboardNudge({ qc, filters, onCommit, debounceMs: 300 }),
    );

    act(() => result.current.nudgeStart(makeBlock(), 30));
    const after = qc.getQueryData<WorkOrderPlanningResponse>(
      workOrderPlanningKeys.window(filters),
    );
    expect(after?.planned[0].planned_start_at).toBe('2026-05-12T10:30:00.000Z');
  });

  it('isBlocked=true silently drops nudges (drag-active fast-fail)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedCache(qc);
    const onCommit = vi.fn();
    const isBlocked = vi.fn(() => true);
    const { result } = renderHook(() =>
      useKeyboardNudge({ qc, filters, onCommit, isBlocked, debounceMs: 300 }),
    );

    act(() => result.current.nudgeStart(makeBlock(), 30));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onCommit).not.toHaveBeenCalled();
    expect(isBlocked).toHaveBeenCalled();
    // Cache untouched — the planning_start_at is still the baseline.
    const after = qc.getQueryData<WorkOrderPlanningResponse>(
      workOrderPlanningKeys.window(filters),
    );
    expect(after?.planned[0].planned_start_at).toBe('2026-05-12T10:00:00.000Z');
  });

  it('flush() with no pending nudge is a no-op (no spurious commit)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedCache(qc);
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useKeyboardNudge({ qc, filters, onCommit, debounceMs: 300 }),
    );

    act(() => result.current.flush());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('unmount with a pending burst flushes the PATCH (full-review C2 — no silent data loss)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedCache(qc);
    const onCommit = vi.fn();
    const { result, unmount } = renderHook(() =>
      useKeyboardNudge({ qc, filters, onCommit, debounceMs: 300 }),
    );

    // Start a burst — the optimistic patch lands, but the debounced
    // commit is still pending when the component unmounts (route change
    // / click-away within 300ms).
    act(() => result.current.nudgeStart(makeBlock(), 30));
    expect(onCommit).not.toHaveBeenCalled();

    // Unmount BEFORE the debounce fires. Pre-C2, the cleanup nulled
    // accumRef without calling onCommit → silent data loss.
    unmount();

    // The cleanup must have fired onCommit with the accumulated delta.
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [, nextStartIso, nextDuration] = onCommit.mock.calls[0];
    expect(nextStartIso).toBe('2026-05-12T10:30:00.000Z');
    expect(nextDuration).toBeNull();
  });

  it('unmount with NO pending burst is a no-op (no spurious commit)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedCache(qc);
    const onCommit = vi.fn();
    const { unmount } = renderHook(() =>
      useKeyboardNudge({ qc, filters, onCommit, debounceMs: 300 }),
    );
    unmount();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('duration floor at 15 min: a burst that would drive duration below 15 stops accumulating', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedCache(qc);
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useKeyboardNudge({ qc, filters, onCommit, debounceMs: 300 }),
    );

    // Baseline duration = 60. -30 → 30, -30 → 0 (clamped, not committed),
    // -30 → still clamped. Final commit should be at 30, not 0 or -30.
    act(() => {
      result.current.nudgeDuration(makeBlock(), -30);
      result.current.nudgeDuration(makeBlock(), -30);
      result.current.nudgeDuration(makeBlock(), -30);
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [, , nextDuration] = onCommit.mock.calls[0];
    expect(nextDuration).toBe(30);
  });
});
