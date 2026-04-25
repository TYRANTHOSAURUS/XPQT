import { useEffect } from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  useRoomBookingRuleImpactPreview,
  type ImpactPreviewResult,
} from '@/api/room-booking-rules';
import { formatCount, formatRelativeTime, formatFullTimestamp } from '@/lib/format';

interface RuleImpactPreviewCardProps {
  ruleId: string;
}

/**
 * Auto-runs once on mount, then re-runs on demand. Shows the headline counts
 * (affected / denied / approval-required), plus a sample of 5–10 affected
 * bookings so admins can spot-check before publishing changes.
 *
 * Backed by `POST /room-booking-rules/:id/impact-preview`.
 */
export function RuleImpactPreviewCard({ ruleId }: RuleImpactPreviewCardProps) {
  const preview = useRoomBookingRuleImpactPreview();
  const result = preview.data ?? null;

  // Auto-run on mount.
  useEffect(() => {
    preview.mutate(ruleId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleId]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          Replays the last 30 days of bookings as if this rule were active.
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => preview.mutate(ruleId)}
          disabled={preview.isPending}
        >
          <RefreshCw className={cn('size-3.5', preview.isPending && 'animate-spin')} />
          {preview.isPending ? 'Running…' : 'Re-run'}
        </Button>
      </div>

      {preview.isError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle className="mr-1.5 inline size-3.5" />
          {preview.error.message || 'Impact preview failed.'}
        </div>
      )}

      {result && <ImpactNumbers result={result} />}
      {result && result.sample_affected_bookings.length > 0 && <SampleList result={result} />}
    </div>
  );
}

function ImpactNumbers({ result }: { result: ImpactPreviewResult }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Metric label="Affected" value={result.affected_count} tone="neutral" />
      <Metric label="Denied" value={result.denied_count} tone="red" />
      <Metric label="Approval" value={result.approval_required_count} tone="amber" />
      <Metric label="Warned" value={result.warned_count} tone="yellow" />
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'neutral' | 'red' | 'amber' | 'yellow';
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-0.5 text-2xl font-semibold tabular-nums',
          tone === 'red' && 'text-red-600 dark:text-red-400',
          tone === 'amber' && 'text-amber-600 dark:text-amber-400',
          tone === 'yellow' && 'text-yellow-600 dark:text-yellow-400',
        )}
      >
        {formatCount(value)}
      </div>
    </div>
  );
}

function SampleList({ result }: { result: ImpactPreviewResult }) {
  return (
    <div className="flex flex-col rounded-md border bg-card overflow-hidden">
      <div className="border-b px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Sample affected bookings
      </div>
      <ul className="flex flex-col divide-y">
        {result.sample_affected_bookings.map((b) => (
          <li
            key={b.reservation_id}
            className="flex items-center justify-between gap-3 px-3 py-2"
          >
            <div className="flex flex-col min-w-0">
              <span className="truncate text-sm">
                <code className="chip text-xs">{b.reservation_id.slice(0, 8)}…</code>
              </span>
              <span className="truncate text-xs text-muted-foreground">
                <time dateTime={b.start_at} title={formatFullTimestamp(b.start_at)}>
                  {formatRelativeTime(b.start_at)}
                </time>
              </span>
            </div>
            <Badge
              variant="outline"
              className={cn(
                'h-5 px-1.5 text-[10px]',
                b.effect === 'deny' &&
                  'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300',
                b.effect === 'require_approval' &&
                  'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
                b.effect === 'warn' &&
                  'border-yellow-200 bg-yellow-50 text-yellow-800 dark:border-yellow-500/30 dark:bg-yellow-500/10 dark:text-yellow-300',
              )}
            >
              {b.effect}
            </Badge>
          </li>
        ))}
      </ul>
      {result.truncated && (
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          Showing 10 of {formatCount(result.affected_count)} affected bookings.
        </div>
      )}
    </div>
  );
}
