import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { floorPlanKeys } from '@/api/floor-plans/keys';
import { toastUpdated } from '@/lib/toast';
import { withErrorHandling } from '@/lib/errors';
import { formatFullTimestamp } from '@/lib/format';
import type { PublishHistoryEntry } from '@/api/floor-plans/types';

type Props = { open: boolean; onOpenChange: (open: boolean) => void; floorSpaceId: string };

export function HistoryDialog({ open, onOpenChange, floorSpaceId }: Props) {
  const qc = useQueryClient();

  const history = useQuery({
    queryKey: floorPlanKeys.floorHistory(floorSpaceId),
    queryFn: () => apiFetch<PublishHistoryEntry[]>(`/floors/${floorSpaceId}/plan/history`),
    enabled: open,
  });

  const restore = useMutation({
    mutationFn: (historyId: string) =>
      apiFetch(`/floors/${floorSpaceId}/plan/history/${historyId}/restore`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: floorPlanKeys.floor(floorSpaceId) });
      toastUpdated('Floor plan restored');
      onOpenChange(false);
    },
    ...withErrorHandling({ actionTitle: "Couldn't restore the floor plan" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish history</DialogTitle>
        </DialogHeader>
        {history.isLoading && (
          <div className="text-sm text-muted-foreground">Loading…</div>
        )}
        <ul className="divide-y">
          {(history.data ?? []).map((h) => (
            <li key={h.id} className="flex items-center justify-between py-2 text-sm">
              <span className="tabular-nums">
                {formatFullTimestamp(h.published_at)} · {h.polygons.length} polygon
                {h.polygons.length === 1 ? '' : 's'}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => restore.mutate(h.id)}
                disabled={restore.isPending}
              >
                Restore
              </Button>
            </li>
          ))}
          {history.data && history.data.length === 0 && (
            <li className="py-4 text-sm text-muted-foreground">No history yet.</li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
