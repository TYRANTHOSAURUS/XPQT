import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Checkbox } from '@/components/ui/checkbox';
import { toast, toastError, toastSuccess } from '@/lib/toast';
import { useBulkUpdateSpaces, type BulkUpdateResult } from '@/api/spaces';

interface Props {
  selectedIds: string[];
  onClear: () => void;
}

export function SpaceChildrenBulkBar({ selectedIds, onClear }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reservable, setReservable] = useState<boolean | null>(null);
  const bulk = useBulkUpdateSpaces();

  if (selectedIds.length === 0) return null;

  const hasChange = reservable !== null;

  const apply = async () => {
    if (!hasChange) return;
    const patch: { reservable?: boolean } = { reservable: reservable! };
    try {
      const res: BulkUpdateResult = await bulk.mutateAsync({ ids: selectedIds, patch });
      const okCount = res.results.filter((r) => r.ok).length;
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length === 0) {
        toastSuccess(`Updated ${okCount} space${okCount === 1 ? '' : 's'}`);
      } else {
        toast.warning(`Updated ${okCount} of ${res.results.length}`, {
          description: `${failed.length} failed: ${failed.map((f) => f.error).slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}`,
        });
      }
      setDialogOpen(false);
      onClear();
    } catch (err) {
      toastError("Couldn't apply bulk update", { error: err, retry: apply });
    }
  };

  return (
    <>
      <div className="sticky bottom-0 z-10 mt-2 flex items-center gap-3 rounded-md border bg-background px-3 py-2 shadow-sm">
        <span className="text-sm font-medium">{selectedIds.length} selected</span>
        <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>Bulk edit…</Button>
        <Button size="sm" variant="ghost" onClick={onClear}>Cancel</Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Bulk edit {selectedIds.length} spaces</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <Field orientation="horizontal">
              <Checkbox
                id="bulk-reservable"
                checked={reservable === true}
                onCheckedChange={(c) => setReservable(c === true ? true : c === false && reservable === true ? null : false)}
              />
              <FieldLabel htmlFor="bulk-reservable" className="font-normal">
                Reservable: set all to {reservable === null ? '…' : reservable ? 'Yes' : 'No'}
              </FieldLabel>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={apply} disabled={bulk.isPending || !hasChange}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
