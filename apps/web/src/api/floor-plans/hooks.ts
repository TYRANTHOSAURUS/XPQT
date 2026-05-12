import { useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { withErrorHandling, handleMutationError } from '@/lib/errors';
import { usePageQuery } from '@/lib/errors';
import { floorPlanKeys } from './keys';
import type { DraftResponse, PublishedFloorPlan } from './types';

export function floorPlanPublishedOptions(floorSpaceId: string) {
  return queryOptions({
    queryKey: floorPlanKeys.floorPublished(floorSpaceId),
    queryFn: async () => apiFetch<PublishedFloorPlan | null>(`/api/floors/${floorSpaceId}/plan`),
    staleTime: 5 * 60_000,
  });
}

export function useFloorPlanPublished(floorSpaceId: string) {
  return usePageQuery(floorPlanPublishedOptions(floorSpaceId));
}

export function useFloorPlanDraft(floorSpaceId: string) {
  return usePageQuery(queryOptions({
    queryKey: floorPlanKeys.floorDraft(floorSpaceId),
    queryFn: async () => apiFetch<DraftResponse>(`/api/floors/${floorSpaceId}/plan/draft`),
    staleTime: 0,
  }));
}

/** Update draft with optimistic locking. Pass the last seen updated_at as `ifMatch`. */
export function useUpdateDraft(floorSpaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ patch, ifMatch }: { patch: Partial<DraftResponse>; ifMatch: string }) =>
      apiFetch<DraftResponse>(`/api/floors/${floorSpaceId}/plan/draft`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
        headers: { 'If-Match': ifMatch },
      }),
    onMutate: async ({ patch }) => {
      await qc.cancelQueries({ queryKey: floorPlanKeys.floorDraft(floorSpaceId) });
      const previous = qc.getQueryData<DraftResponse>(floorPlanKeys.floorDraft(floorSpaceId));
      if (previous) {
        qc.setQueryData<DraftResponse>(floorPlanKeys.floorDraft(floorSpaceId), {
          ...previous, ...patch,
        });
      }
      return { previous };
    },
    onSuccess: (data) => {
      // Sync server's authoritative updated_at into cache
      qc.setQueryData<DraftResponse>(floorPlanKeys.floorDraft(floorSpaceId), data);
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(floorPlanKeys.floorDraft(floorSpaceId), ctx.previous);
      handleMutationError(error, { actionTitle: "Couldn't save floor plan changes" });
    },
  });
}

export function useDiscardDraft(floorSpaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => apiFetch(`/api/floors/${floorSpaceId}/plan/draft`, { method: 'DELETE' }),
    onSuccess: () => qc.removeQueries({ queryKey: floorPlanKeys.floorDraft(floorSpaceId) }),
    ...withErrorHandling({ actionTitle: "Couldn't discard the draft" }),
  });
}

export function usePublishDraft(floorSpaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiFetch<{ history_id: string }>(`/api/floors/${floorSpaceId}/plan/draft/publish`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: floorPlanKeys.floor(floorSpaceId) });
    },
    ...withErrorHandling({ actionTitle: "Couldn't publish the floor plan" }),
  });
}
