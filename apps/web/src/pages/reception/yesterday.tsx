/**
 * /reception/yesterday — start-of-shift loose-ends reconciliation.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §7.7
 *
 * Aggregates three things from the last 24h:
 *   - Auto-checked-out visitors (count + drilldown to the actual list).
 *   - Unreturned passes (with mark-recovered / mark-lost actions).
 *   - Visitors whose invite email bounced (reception calls ahead).
 */
import { AlertTriangle, KeyRound, Mail } from 'lucide-react';
import {
  SettingsPageHeader,
  SettingsPageShell,
  SettingsSection,
} from '@/components/ui/settings-page';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useReceptionBuilding } from '@/components/desk/desk-building-context';
import {
  useMarkPassMissing,
  useMarkPassRecovered,
  useReceptionYesterday,
  type BouncedInviteRow,
  type ReceptionPass,
} from '@/api/visitors/reception';
import { toastError, toastSuccess } from '@/lib/toast';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';

export function ReceptionYesterdayPage() {
  const { buildingId, buildings, loading: buildingsLoading } = useReceptionBuilding();
  const { data, isLoading, isError } = useReceptionYesterday(buildingId);

  if (!buildingsLoading && buildings.length === 0) {
    return (
      <SettingsPageShell width="default">
        <SettingsPageHeader
          title="Yesterday's loose ends"
          description="No buildings are in your reception scope."
        />
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell width="default">
      <SettingsPageHeader
        title="Yesterday's loose ends"
        description="Auto-checked-out visitors, unreturned passes, and email bounces from the last 24 hours."
      />

      {isLoading && (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {isError && !isLoading && (
        <div role="alert" className="text-sm text-destructive">
          Couldn't load the loose ends. Try refreshing.
        </div>
      )}

      {data && (
        <div className="flex flex-col gap-6">
          <SettingsSection
            title={`Auto-checked-out (${data.auto_checked_out_count})`}
            description="Visitors swept out by the EOD job because reception didn't check them out."
            bordered
          >
            {data.auto_checked_out_count === 0 ? (
              <div className="text-sm text-muted-foreground">
                No auto-checkouts yesterday.
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                {data.auto_checked_out_count} visitor
                {data.auto_checked_out_count === 1 ? '' : 's'} were auto-checked
                out at midnight. Their checkout source was the system, so the
                actual departure time is unknown.
              </div>
            )}
          </SettingsSection>

          <SettingsSection
            title={`Unreturned passes (${data.unreturned_passes.length})`}
            description="Passes the system thinks are still in use 24+ hours after assignment."
            bordered
            density="tight"
          >
            {data.unreturned_passes.length === 0 ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">
                Nothing outstanding.
              </div>
            ) : (
              <div className="flex flex-col divide-y">
                {data.unreturned_passes.map((p) => (
                  <UnreturnedPassRow key={p.id} pass={p} />
                ))}
              </div>
            )}
          </SettingsSection>

          <SettingsSection
            title={`Email bounces (${data.bounced_emails.length})`}
            description="Visitors whose invite email bounced — call ahead before they arrive."
            bordered
            density="tight"
          >
            {data.bounced_emails.length === 0 ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">
                No bounces.
              </div>
            ) : (
              <div className="flex flex-col divide-y">
                {data.bounced_emails.map((b) => (
                  <BouncedRow key={b.visitor_id} row={b} />
                ))}
              </div>
            )}
          </SettingsSection>
        </div>
      )}
    </SettingsPageShell>
  );
}

function UnreturnedPassRow({ pass }: { pass: ReceptionPass }) {
  const { buildingId } = useReceptionBuilding();
  const recover = useMarkPassRecovered(buildingId);
  const missing = useMarkPassMissing(buildingId);

  const handleRecover = async () => {
    try {
      await recover.mutateAsync({ passId: pass.id });
      toastSuccess(`Pass #${pass.pass_number} recovered`);
    } catch (err) {
      toastError("Couldn't mark recovered", { error: err });
    }
  };
  const handleMissing = async () => {
    try {
      await missing.mutateAsync({
        passId: pass.id,
        reason: 'Marked lost from yesterday loose-ends review',
      });
      toastSuccess(`Pass #${pass.pass_number} marked lost`);
    } catch (err) {
      toastError("Couldn't mark lost", { error: err });
    }
  };

  const last = pass.last_assigned_at ? formatRelativeTime(pass.last_assigned_at) : null;
  const lastFull = pass.last_assigned_at ? formatFullTimestamp(pass.last_assigned_at) : null;

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <KeyRound className="size-4 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium tabular-nums">#{pass.pass_number}</div>
        <div className="text-xs text-muted-foreground">
          {last && (
            <span title={lastFull || undefined}>last assigned {last}</span>
          )}
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={handleRecover}
        disabled={recover.isPending || missing.isPending}
      >
        Mark recovered
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleMissing}
        disabled={recover.isPending || missing.isPending}
      >
        Mark lost
      </Button>
    </div>
  );
}

function BouncedRow({ row }: { row: BouncedInviteRow }) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Unknown';
  const when = formatRelativeTime(row.bounced_at);
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Mail className="size-4 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{name}</div>
        <div className="text-xs text-muted-foreground truncate">
          {row.email ?? 'No email'}
          {row.reason && (
            <>
              <span className="mx-1.5">·</span>
              {row.reason}
            </>
          )}
        </div>
      </div>
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
        <AlertTriangle className="size-3" aria-hidden />
        bounced {when}
      </span>
    </div>
  );
}
