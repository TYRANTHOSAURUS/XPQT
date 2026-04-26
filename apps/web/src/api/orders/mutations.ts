import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { bundleKeys } from '@/api/booking-bundles';
import { orderKeys } from './keys';
import type { ServiceLinePayload } from './types';

export interface StandaloneOrderPayload {
  delivery_space_id: string;
  requested_for_start_at: string;
  requested_for_end_at: string;
  cost_center_id?: string | null;
  lines: ServiceLinePayload[];
}

export function useCreateStandaloneOrder() {
  const qc = useQueryClient();
  return useMutation<{ id: string; bundle_id: string | null }, Error, StandaloneOrderPayload>({
    mutationFn: (payload) =>
      apiFetch('/orders/standalone', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: orderKeys.lists() });
      qc.invalidateQueries({ queryKey: bundleKeys.lists() });
    },
  });
}
