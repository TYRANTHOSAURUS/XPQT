import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useFloorPlanPublished, usePublishDraft } from '../../api/floor-plans/hooks';
import { computePublishDiff } from './lib/diff';
import { toastUpdated } from '../../lib/toast';
import type { DraftResponse } from '../../api/floor-plans/types';

type Props = { open: boolean; onOpenChange: (open: boolean) => void; floorSpaceId: string; draft: DraftResponse };

const LARGE_REMOVAL_THRESHOLD = 5;

export function PublishDialog({ open, onOpenChange, floorSpaceId, draft }: Props) {
  const published = useFloorPlanPublished(floorSpaceId);
  const publish = usePublishDraft(floorSpaceId);
  const diff = computePublishDiff(draft.polygons, draft.image_url, published.data ?? null);
  const isLargeRemoval = diff.removed.length >= LARGE_REMOVAL_THRESHOLD;
  const [typedConfirm, setTypedConfirm] = useState('');
  const requiredConfirm = `remove ${diff.removed.length}`;
  const canPublish = !isLargeRemoval || typedConfirm === requiredConfirm;

  const noChanges =
    !diff.imageChanged && diff.added.length === 0 && diff.modified.length === 0 && diff.removed.length === 0;

  const handlePublish = async () => {
    await publish.mutateAsync();
    toastUpdated('Floor plan');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish floor plan</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {noChanges && <p className="text-muted-foreground">No changes to publish.</p>}
          {diff.imageChanged && <p className="text-amber-700">Background image changed.</p>}
          {diff.added.length > 0 && (
            <p>
              <strong className="text-emerald-700">{diff.added.length}</strong> polygon(s) added.
            </p>
          )}
          {diff.modified.length > 0 && (
            <p>
              <strong className="text-blue-700">{diff.modified.length}</strong> polygon(s) modified.
            </p>
          )}
          {diff.removed.length > 0 && (
            <div>
              <p>
                <strong className={isLargeRemoval ? 'text-red-700' : 'text-amber-700'}>
                  {diff.removed.length}
                </strong>{' '}
                polygon(s) removed{isLargeRemoval ? ' — large removal' : ''}:
              </p>
              <ul className="ml-4 list-disc text-muted-foreground">
                {diff.removed.slice(0, 10).map((r) => (
                  <li key={r.space_id}>{r.name}</li>
                ))}
                {diff.removed.length > 10 && (
                  <li>… and {diff.removed.length - 10} more</li>
                )}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                Removing a polygon doesn't cancel existing bookings; they remain in list views. A snapshot is saved — you can restore it from the publish history.
              </p>
              {isLargeRemoval && (
                <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3">
                  <p className="text-xs text-red-900">
                    To confirm, type{' '}
                    <code className="chip font-mono">{requiredConfirm}</code> below:
                  </p>
                  <Input
                    value={typedConfirm}
                    onChange={(e) => setTypedConfirm(e.target.value)}
                    placeholder={requiredConfirm}
                    className="mt-2"
                  />
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handlePublish}
            disabled={publish.isPending || noChanges || !canPublish}
          >
            Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
