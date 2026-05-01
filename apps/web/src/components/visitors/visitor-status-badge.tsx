/**
 * Shared visitor-status badge.
 *
 * Replaces three duplicated STATUS_TONE maps that lived in expected.tsx,
 * visitor-row.tsx, and elsewhere. Pass status; get a tonally-correct pill
 * with the right label and an aria-label that includes the status verb.
 *
 * Note: pass-status (available / reserved / in_use / lost / retired) is a
 * different enum and lives in passes.tsx — not consolidated here because
 * the underlying types diverge.
 */
import { cn } from '@/lib/utils';
import { visitorStatusLabel, type VisitorStatus } from '@/api/visitors';

const STATUS_TONE: Record<VisitorStatus, string> = {
  pending_approval:
    'bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
  expected: 'bg-blue-100 text-blue-900 dark:bg-blue-950/40 dark:text-blue-200',
  arrived:
    'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200',
  in_meeting:
    'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200',
  checked_out: 'bg-muted text-muted-foreground',
  no_show: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground',
};

interface VisitorStatusBadgeProps {
  status: VisitorStatus;
  /** Extra classes (e.g. text size, alignment). Tone classes always win. */
  className?: string;
}

export function VisitorStatusBadge({ status, className }: VisitorStatusBadgeProps) {
  const label = visitorStatusLabel(status);
  return (
    <span
      aria-label={`Status: ${label}`}
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums',
        STATUS_TONE[status],
        className,
      )}
    >
      {label}
    </span>
  );
}
