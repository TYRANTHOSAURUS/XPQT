import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { withErrorHandling, handleMutationError, handleQueryError } from '@/lib/errors';
import { usePageQuery } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { floorPlanKeys, buildingKeys } from './keys';
import type { DraftResponse, PublishedFloorPlan, FloorAvailability } from './types';

export type FloorPlanIndexRow = {
  id: string;
  name: string;
  building_name: string;
  has_plan: boolean;
  last_published_at: string | null;
};

export function floorPlansAdminIndexOptions() {
  return queryOptions({
    queryKey: floorPlanKeys.adminIndex(),
    queryFn: async () => apiFetch<FloorPlanIndexRow[]>('/api/admin/floor-plans-index'),
    staleTime: 60_000,
  });
}

export function useAdminFloorPlansIndex() {
  return useQuery(floorPlansAdminIndexOptions());
}

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

// ---------------------------------------------------------------------------
// Availability (D.2)
// ---------------------------------------------------------------------------

export function floorAvailabilityOptions(floorSpaceId: string, start: string, end: string) {
  return queryOptions({
    queryKey: floorPlanKeys.floorAvailability(floorSpaceId, start, end),
    queryFn: async () =>
      apiFetch<FloorAvailability>(
        `/api/floors/${floorSpaceId}/plan/availability?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`,
      ),
    staleTime: 30_000,
  });
}

/**
 * Fetch per-polygon availability for a floor + time window.
 * Uses plain `useQuery` (not `usePageQuery`) per plan review I3.
 * Errors surface via `handleQueryError` from a sibling `useEffect`.
 */
export function useFloorAvailability(floorSpaceId: string, start: string, end: string) {
  const q = useQuery(floorAvailabilityOptions(floorSpaceId, start, end));
  useEffect(() => {
    if (q.error) handleQueryError(q.error, { callSite: 'mutation' });
  }, [q.error]);
  return q;
}

/**
 * Realtime subscription that invalidates the floor's availability cache
 * whenever `bookings` or `booking_slots` rows change.
 *
 * Both tables are in `supabase_realtime` since migration 00281.
 */
export function useFloorAvailabilityRealtime(floorSpaceId: string) {
  const qc = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!floorSpaceId) return;

    const scheduleInvalidate = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        qc.invalidateQueries({ queryKey: floorPlanKeys.floor(floorSpaceId) });
      }, 200);
    };

    const channel = supabase
      .channel(`floor-availability:${floorSpaceId}`)
      .on(
        'postgres_changes' as any,
        { event: '*', schema: 'public', table: 'bookings' },
        scheduleInvalidate,
      )
      .on(
        'postgres_changes' as any,
        { event: '*', schema: 'public', table: 'booking_slots' },
        scheduleInvalidate,
      )
      .subscribe();

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      void supabase.removeChannel(channel);
    };
  }, [floorSpaceId, qc]);
}

// ---------------------------------------------------------------------------
// Building floors query (D.4)
// ---------------------------------------------------------------------------

export type BuildingFloor = { id: string; name: string; code: string | null };

export function useBuildingFloors(buildingId: string) {
  return useQuery({
    queryKey: buildingKeys.floors(buildingId),
    queryFn: async () => apiFetch<BuildingFloor[]>(`/api/buildings/${buildingId}/floors`),
    staleTime: 5 * 60_000,
    enabled: !!buildingId,
  });
}
