import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { WorkOrderPlanningResponse } from '@prequest/shared';
import { runOptimisticWithRollback } from './commit-with-rollback';
import { workOrderPlanningKeys, type PlanningWindowFilters } from '@/api/work-order-planning';

function seedSnapshot(): WorkOrderPlanningResponse {
  return {
    planned: [
      {
        id: 'wo-1',
        module_number: 42,
        title: 'Original planned block',
        status_category: 'in_progress',
        priority: 'medium',
        planned_start_at: '2026-05-12T09:00:00.000Z',
        planned_duration_minutes: 60,
        sla_resolution_due_at: null,
        lane: { kind: 'user', id: 'u-1', label: 'Alex' },
        request_type: null,
        can_plan: true,
      },
    ],
    unscheduled: [],
  };
}

const filters: PlanningWindowFilters = {
  from: '2026-05-12T00:00:00.000Z',
  to: '2026-05-12T23:59:59.999Z',
  status: ['in_progress'],
  teamId: null,
};

describe('runOptimisticWithRollback', () => {
  it('restores the snapshot BEFORE onError fires on PATCH failure', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = workOrderPlanningKeys.window(filters);
    const snapshot = seedSnapshot();
    qc.setQueryData(key, snapshot);

    // Capture the cache value at the exact moment onError fires. This is
    // the assertion that closes the regression window: if the helper
    // restores AFTER toastError runs, the operator sees the wrong value
    // for one paint. We capture-by-reading-the-cache inside onError.
    let cacheAtErrorTime: WorkOrderPlanningResponse | undefined;
    const onError = vi.fn((_err: unknown) => {
      cacheAtErrorTime = qc.getQueryData<WorkOrderPlanningResponse>(key);
    });

    const onSettled = vi.fn();

    await runOptimisticWithRollback<WorkOrderPlanningResponse>({
      qc,
      key,
      mutator: (prev) => ({
        ...prev,
        planned: prev.planned.map((b) =>
          b.id === 'wo-1' ? { ...b, planned_start_at: '2026-05-12T14:00:00.000Z' } : b,
        ),
      }),
      mutationFn: () => Promise.reject(new Error('500')),
      onError,
      onSettled,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(cacheAtErrorTime).toEqual(snapshot);
    expect(onSettled).toHaveBeenCalledTimes(1);
    // And the final cache state is the original snapshot, not the patched one.
    expect(qc.getQueryData(key)).toEqual(snapshot);
  });

  it('does NOT restore on success (the server is truth, post-invalidate refetches)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = workOrderPlanningKeys.window(filters);
    const snapshot = seedSnapshot();
    qc.setQueryData(key, snapshot);

    const onError = vi.fn();
    const onSettled = vi.fn();

    await runOptimisticWithRollback<WorkOrderPlanningResponse>({
      qc,
      key,
      mutator: (prev) => ({
        ...prev,
        planned: prev.planned.map((b) =>
          b.id === 'wo-1' ? { ...b, planned_duration_minutes: 120 } : b,
        ),
      }),
      mutationFn: () => Promise.resolve({ ok: true }),
      onError,
      onSettled,
    });

    expect(onError).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    const after = qc.getQueryData<WorkOrderPlanningResponse>(key);
    expect(after?.planned[0].planned_duration_minutes).toBe(120);
  });

  it('restores against the captured key even if a different window was patched concurrently', async () => {
    // Simulates the "filter changed mid-drag" race: while the PATCH is in
    // flight, the operator changes the team filter, which causes the page
    // to read against a different cache key. The helper must restore the
    // ORIGINAL key (captured at gesture start), not whatever the page is
    // looking at now.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const keyAtGestureStart = workOrderPlanningKeys.window(filters);
    const newFiltersAfterFilterChange: PlanningWindowFilters = {
      ...filters,
      teamId: 'team-other',
    };
    const keyAfterFilterChange = workOrderPlanningKeys.window(newFiltersAfterFilterChange);

    const snapshotForOriginal = seedSnapshot();
    qc.setQueryData(keyAtGestureStart, snapshotForOriginal);

    // Mid-flight: a fresh window resolves under the new filter key.
    const unrelatedSnapshot: WorkOrderPlanningResponse = {
      planned: [],
      unscheduled: [],
    };

    const onError = vi.fn();

    await runOptimisticWithRollback<WorkOrderPlanningResponse>({
      qc,
      key: keyAtGestureStart,
      mutator: (prev) => ({
        ...prev,
        planned: prev.planned.map((b) =>
          b.id === 'wo-1' ? { ...b, planned_start_at: '2026-05-12T16:00:00.000Z' } : b,
        ),
      }),
      mutationFn: async () => {
        // Filter shifts mid-flight; the page would now read a different key.
        qc.setQueryData(keyAfterFilterChange, unrelatedSnapshot);
        throw new Error('500');
      },
      onError,
      onSettled: () => {},
    });

    expect(onError).toHaveBeenCalledTimes(1);
    // Original key is restored.
    expect(qc.getQueryData(keyAtGestureStart)).toEqual(snapshotForOriginal);
    // The unrelated key is untouched.
    expect(qc.getQueryData(keyAfterFilterChange)).toEqual(unrelatedSnapshot);
  });
});
