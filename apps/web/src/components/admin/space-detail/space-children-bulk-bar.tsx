import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
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

  const apply = async () => {
    const patch: { reservable?: boolean } = {};
    if (reservable !== null) patch.reservable = reservable;
    if (Object.keys(patch).length === 0) {
      toast.error('Pick at least one change to apply');
      return;
    }
    try {
      const res: BulkUpdateResult = await bulk.mutateAsync({ ids: selectedIds, patch });
      const okCount = res.results.filter((r) => r.ok).length;
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length === 0) toast.success(`Updated ${okCount} spaces`);
      else toast.warning(`Updated ${okCount}; ${failed.length} failed: ${failed.map((f) => f.error).join(', ')}`);
      setDialogOpen(false);
      onClear();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bulk update failed');
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
            <Button onClick={apply} disabled={bulk.isPending}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
