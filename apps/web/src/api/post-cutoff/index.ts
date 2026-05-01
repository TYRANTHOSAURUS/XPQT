import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

/**
 * Desk-side post-cutoff change workflow API client.
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md §7,§10.
 *
 * Backs the "Today's late changes" widget on /desk and the
 * per-vendor confirm-phoned action.
 */

export interface PostCutoffLine {
  line_id: string;
  order_id: string;
  catalog_item_id: string | null;
  catalog_item_name: string;
  quantity: number;
  dietary_notes: string | null;
  /** Free-text from the requester for non-dietary instructions
   *  (AV placement, setup notes, anything that's NOT food). */
  requester_notes: string | null;
  fulfillment_status: string | null;
  fulfillment_notes: string | null;
  locked_at: string | null;
  daglijst_id: string | null;
  service_window_start_at: string | null;
  requester_first_name: string | null;
  room_name: string;
}

export interface PostCutoffGroup {
  vendor_id: string | null;
  vendor_name: string;
  vendor_phone: string;
  line_count: number;
  lines: PostCutoffLine[];
}

export type ConfirmPhonedResult =
  | { status: 'confirmed';          confirmed_at: string }
  | { status: 'already_confirmed';  confirmed_at: string };

export const postCutoffKeys = {
  all: ['post-cutoff'] as const,
  list: () => [...postCutoffKeys.all, 'list'] as const,
} as const;

export function postCutoffListOptions() {
  return queryOptions({
    queryKey: postCutoffKeys.list(),
    queryFn: ({ signal }) => apiFetch<PostCutoffGroup[]>('/desk/post-cutoff-changes', { signal }),
    /* Widget refreshes whenever a desk operator confirms a line OR a
       new edit re-flags one. 60s polling is enough for the widget; the
       confirm action invalidates explicitly. */
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

export function usePostCutoffList() {
  return useQuery(postCutoffListOptions());
}

export interface ConfirmPhonedArgs {
  lineId: string;
}

export function useConfirmPhoned() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: ConfirmPhonedArgs): Promise<ConfirmPhonedResult> =>
      apiFetch<ConfirmPhonedResult>(
        `/desk/order-lines/${args.lineId}/confirm-phoned`,
        { method: 'POST', body: '{}' },
      ),
    onMutate: async (args) => {
      /* Optimistic remove: drop the line from whichever vendor card it
         belongs to so the operator sees instant feedback. Rollback on
         error. The settled invalidate below realigns with the truth. */
      await qc.cancelQueries({ queryKey: postCutoffKeys.list() });
      const prev = qc.getQueryData<PostCutoffGroup[]>(postCutoffKeys.list());
      if (prev) {
        qc.setQueryData<PostCutoffGroup[]>(
          postCutoffKeys.list(),
          prev
            .map((g) => ({
              ...g,
              lines: g.lines.filter((l) => l.line_id !== args.lineId),
              line_count: g.lines.filter((l) => l.line_id !== args.lineId).length,
            }))
            .filter((g) => g.line_count > 0),
        );
      }
      return { prev };
    },
    onError: (_err, _args, ctx) => {
      const prev = (ctx as { prev?: PostCutoffGroup[] } | undefined)?.prev;
      if (prev) qc.setQueryData(postCutoffKeys.list(), prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: postCutoffKeys.list() });
    },
  });
}
