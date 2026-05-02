/**
 * Inline dialog: pick an available pass + assign to a visitor.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §7.6
 *
 * Lists `available` and (matching) `reserved` passes for the building.
 * One-tap to assign; reserved-for-this-visitor is highlighted with a
 * "Use reserved pass" affordance per spec §7.6.
 */
import { useState } from 'react';
import { CheckCircle, KeyRound } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  useAssignPass,
  useReceptionPasses,
  type ReceptionPass,
} from '@/api/visitors/reception';
import { toastError, toastSuccess } from '@/lib/toast';

interface AssignPassDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buildingId: string | null;
  visitorId: string;
  visitorLabel: string;
}

export function AssignPassDialog({
  open,
  onOpenChange,
  buildingId,
  visitorId,
  visitorLabel,
}: AssignPassDialogProps) {
  const { data, isLoading } = useReceptionPasses(buildingId);
  const assign = useAssignPass(buildingId);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const passes: ReceptionPass[] = (data ?? []).filter(
    (p) =>
      p.status === 'available' ||
      (p.status === 'reserved' && p.reserved_for_visitor_id === visitorId),
  );

  const handleAssign = async (passId: string) => {
    setPendingId(passId);
    try {
      await assign.mutateAsync({ passId, visitorId });
      toastSuccess('Pass assigned');
      onOpenChange(false);
    } catch (err) {
      toastError("Couldn't assign the pass", { error: err });
    } finally {
      setPendingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Assign a pass</DialogTitle>
          <DialogDescription>
            Pick an available pass to give to {visitorLabel}.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : passes.length === 0 ? (
          <div className="rounded-md border bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
            No available passes at this building.
          </div>
        ) : (
          <ul className="flex max-h-72 flex-col divide-y overflow-y-auto rounded-md border">
            {passes.map((pass) => {
              const isReservedForThis =
                pass.status === 'reserved' &&
                pass.reserved_for_visitor_id === visitorId;
              return (
                <li
                  key={pass.id}
                  className="flex items-center gap-3 px-3 py-2.5"
                >
                  <KeyRound className="size-4 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">#{pass.pass_number}</div>
                    <div className="text-xs text-muted-foreground">
                      {pass.pass_type}
                      {isReservedForThis && (
                        <span className="ml-1.5 inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                          <CheckCircle className="size-3" aria-hidden /> Reserved for
                          this visitor
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={isReservedForThis ? 'default' : 'outline'}
                    onClick={() => handleAssign(pass.id)}
                    disabled={pendingId !== null}
                  >
                    {pendingId === pass.id
                      ? 'Assigning…'
                      : isReservedForThis
                      ? 'Use reserved pass'
                      : 'Assign'}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
