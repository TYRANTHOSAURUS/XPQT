/**
 * /reception/passes — pass-pool inventory for the current building.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §7.6
 *
 * Sections per status (Available / Reserved / In use / Lost). Each row
 * gets an action appropriate for its state:
 *   - Available  → "Reserve" (small picker), or implicit assignment
 *                  via the today-view "Assign pass" affordance.
 *   - Reserved   → "Cancel reservation".
 *   - In use     → (read-only; visitor checkout returns the pass).
 *   - Lost       → "Mark recovered".
 */
import { useMemo } from 'react';
import { KeyRound } from 'lucide-react';
import {
  SettingsPageHeader,
  SettingsPageShell,
  SettingsSection,
} from '@/components/ui/settings-page';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useReceptionBuilding } from '@/components/reception/reception-building-context';
import {
  useMarkPassRecovered,
  useReceptionPasses,
  useReturnPass,
  type ReceptionPass,
  type ReceptionPassStatus,
} from '@/api/visitors/reception';
import { toastError, toastSuccess } from '@/lib/toast';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import { cn } from '@/lib/utils';

const STATUS_ORDER: ReceptionPassStatus[] = [
  'available',
  'reserved',
  'in_use',
  'lost',
];
const STATUS_TITLE: Record<ReceptionPassStatus, string> = {
  available: 'Available',
  reserved: 'Reserved',
  in_use: 'In use',
  lost: 'Lost',
  retired: 'Retired',
};
const STATUS_TONE: Record<ReceptionPassStatus, string> = {
  available:
    'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200',
  reserved: 'bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
  in_use: 'bg-blue-100 text-blue-900 dark:bg-blue-950/40 dark:text-blue-200',
  lost: 'bg-rose-100 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200',
  retired: 'bg-muted text-muted-foreground',
};

export function ReceptionPassesPage() {
  const { buildingId, buildings, loading: buildingsLoading } = useReceptionBuilding();
  const { data, isLoading, isError } = useReceptionPasses(buildingId);

  const buckets = useMemo(() => {
    const groups: Record<ReceptionPassStatus, ReceptionPass[]> = {
      available: [],
      reserved: [],
      in_use: [],
      lost: [],
      retired: [],
    };
    for (const p of data ?? []) groups[p.status].push(p);
    return groups;
  }, [data]);

  const total = (data ?? []).length;

  if (!buildingsLoading && buildings.length === 0) {
    return (
      <SettingsPageShell width="default">
        <SettingsPageHeader
          title="Passes"
          description="No buildings are in your reception scope."
        />
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell width="default">
      <SettingsPageHeader
        title="Passes"
        description="Pass pool for this building. Assign from the Today view; reconcile here."
      />

      {isLoading && (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {isError && !isLoading && (
        <div role="alert" className="text-sm text-destructive">
          Couldn't load the pass pool. Try refreshing.
        </div>
      )}

      {!isLoading && !isError && total === 0 && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <KeyRound className="size-10 text-muted-foreground" aria-hidden />
          <div>
            <h2 className="text-base font-medium">No passes configured</h2>
            <p className="text-sm text-muted-foreground">
              An admin must set up the pass pool for this building before
              reception can hand any out.
            </p>
          </div>
        </div>
      )}

      {!isLoading && !isError && total > 0 && (
        <div className="flex flex-col gap-6">
          {STATUS_ORDER.map((status) => (
            <SettingsSection
              key={status}
              title={`${STATUS_TITLE[status]} (${buckets[status].length})`}
              bordered
              density="tight"
            >
              {buckets[status].length === 0 ? (
                <div className="px-4 py-3 text-sm text-muted-foreground">
                  None.
                </div>
              ) : (
                <div className="flex flex-col divide-y">
                  {buckets[status].map((pass) => (
                    <PassRow key={pass.id} pass={pass} />
                  ))}
                </div>
              )}
            </SettingsSection>
          ))}
        </div>
      )}
    </SettingsPageShell>
  );
}

interface PassRowProps {
  pass: ReceptionPass;
}

function PassRow({ pass }: PassRowProps) {
  const { buildingId } = useReceptionBuilding();
  const recover = useMarkPassRecovered(buildingId);
  const returnPass = useReturnPass(buildingId);

  const handleRecover = async () => {
    try {
      await recover.mutateAsync({ passId: pass.id });
      toastSuccess(`Pass #${pass.pass_number} recovered`);
    } catch (err) {
      toastError("Couldn't mark recovered", { error: err, retry: handleRecover });
    }
  };

  const handleReturn = async () => {
    try {
      await returnPass.mutateAsync({ passId: pass.id });
      toastSuccess(`Pass #${pass.pass_number} returned`);
    } catch (err) {
      toastError("Couldn't return the pass", { error: err, retry: handleReturn });
    }
  };

  const lastAssigned = pass.last_assigned_at
    ? formatRelativeTime(pass.last_assigned_at)
    : null;

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <KeyRound className="size-4 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium tabular-nums">#{pass.pass_number}</div>
        <div className="text-xs text-muted-foreground">
          {pass.pass_type}
          {lastAssigned && (
            <>
              <span className="mx-1.5">·</span>
              <span title={formatFullTimestamp(pass.last_assigned_at) || undefined}>
                last assigned {lastAssigned}
              </span>
            </>
          )}
          {pass.notes && (
            <>
              <span className="mx-1.5">·</span>
              {pass.notes}
            </>
          )}
        </div>
      </div>
      <span
        className={cn(
          'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
          STATUS_TONE[pass.status],
        )}
      >
        {STATUS_TITLE[pass.status]}
      </span>
      {pass.status === 'lost' && (
        <Button
          variant="outline"
          size="sm"
          onClick={handleRecover}
          disabled={recover.isPending}
        >
          Mark recovered
        </Button>
      )}
      {pass.status === 'in_use' && (
        <Button
          variant="outline"
          size="sm"
          onClick={handleReturn}
          disabled={returnPass.isPending}
        >
          Return to pool
        </Button>
      )}
    </div>
  );
}
