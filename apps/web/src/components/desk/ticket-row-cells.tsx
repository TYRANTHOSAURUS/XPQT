import { AlertTriangle, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatRelativeTimeCompact } from '@/lib/format';

export interface Ticket {
  id: string;
  ticket_kind: 'case' | 'work_order';
  module_number: number;
  title: string;
  status_category: string;
  priority: string;
  requester?: { first_name: string; last_name: string };
  location?: { name: string };
  assigned_team?: { name: string };
  assigned_agent?: { email: string };
  sla_at_risk: boolean;
  sla_resolution_due_at: string | null;
  sla_resolution_breached_at: string | null;
  created_at: string;
  tags: string[];
}

export const statusConfig: Record<string, { label: string; dotColor: string }> = {
  new: { label: 'New', dotColor: 'bg-blue-500' },
  assigned: { label: 'Assigned', dotColor: 'bg-yellow-500' },
  in_progress: { label: 'In Progress', dotColor: 'bg-purple-500' },
  waiting: { label: 'Waiting', dotColor: 'bg-orange-500' },
  resolved: { label: 'Resolved', dotColor: 'bg-green-500' },
  closed: { label: 'Closed', dotColor: 'bg-gray-400' },
};

export const priorityConfig: Record<string, { label: string; color: string }> = {
  critical: { label: 'Critical', color: 'text-muted-foreground' },
  urgent: { label: 'Urgent', color: 'text-muted-foreground' },
  high: { label: 'High', color: 'text-muted-foreground' },
  medium: { label: 'Medium', color: 'text-muted-foreground' },
  low: { label: 'Low', color: 'text-muted-foreground' },
};

type PriorityKey = 'critical' | 'urgent' | 'high' | 'medium' | 'low';

/**
 * Urgent/critical priority — rendered as a filled rounded-red square with a
 * white exclamation, matching Linear's urgent marker. Built as a span rather
 * than a lucide icon because the installed lucide version lacks SquareAlert.
 */
function UrgentGlyph({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-[3px] bg-muted-foreground font-bold leading-none text-background',
        'h-4 w-4 text-[11px]',
        className,
      )}
      aria-hidden="true"
    >
      !
    </span>
  );
}

/**
 * Three-bar signal glyph. All bars render; inactive bars get a faded fill
 * of the same hue via opacity. Matches Linear's priority indicator where
 * you see the "empty slots" even when only the first bar is lit.
 */
function SignalGlyph({ level, className }: { level: 1 | 2 | 3; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn('h-4 w-4', className)}
      aria-hidden="true"
      fill="currentColor"
    >
      <rect x="1" y="10" width="3" height="5" rx="0.75" opacity={level >= 1 ? 1 : 0.3} />
      <rect x="6.5" y="6" width="3" height="9" rx="0.75" opacity={level >= 2 ? 1 : 0.3} />
      <rect x="12" y="2" width="3" height="13" rx="0.75" opacity={level >= 3 ? 1 : 0.3} />
    </svg>
  );
}

const PRIORITY_ICON_MAP: Record<
  PriorityKey,
  { kind: 'signal' | 'urgent'; level?: 1 | 2 | 3; color: string }
> = {
  critical: { kind: 'urgent', color: 'text-muted-foreground' },
  urgent: { kind: 'urgent', color: 'text-muted-foreground' },
  high: { kind: 'signal', level: 3, color: 'text-muted-foreground' },
  medium: { kind: 'signal', level: 2, color: 'text-muted-foreground' },
  low: { kind: 'signal', level: 1, color: 'text-muted-foreground' },
};

/**
 * Linear-style priority indicator. Three-bar signal for low/medium/high
 * (inactive bars shown faded), rounded-square "!" for critical/urgent.
 * Use `withLabel` in sidebars and selects; icon-only in dense rows.
 */
export function PriorityIcon({
  priority,
  withLabel = false,
  iconClassName,
  className,
}: {
  priority: string;
  withLabel?: boolean;
  iconClassName?: string;
  className?: string;
}) {
  const key = (priority in PRIORITY_ICON_MAP ? priority : 'medium') as PriorityKey;
  const entry = PRIORITY_ICON_MAP[key];
  const label = priorityConfig[priority]?.label ?? priority;

  let icon: React.ReactNode;
  if (entry.kind === 'urgent') {
    icon = <UrgentGlyph className={iconClassName} />;
  } else {
    icon = <SignalGlyph level={entry.level!} className={cn(entry.color, iconClassName)} />;
  }

  if (!withLabel) {
    return (
      <span
        aria-label={`Priority: ${label}`}
        title={label}
        className={cn('inline-flex items-center justify-center', className)}
      >
        {icon}
      </span>
    );
  }

  return (
    <span className={cn('inline-flex items-center gap-1.5', entry.color, className)}>
      {icon}
      <span className="text-sm">{label}</span>
    </span>
  );
}

export function SlaCell({ dueAt, breachedAt }: { dueAt: string | null; breachedAt: string | null }) {
  if (!dueAt) return <span className="text-muted-foreground">--</span>;
  if (breachedAt) {
    return (
      <span className="font-medium text-red-500 inline-flex items-center gap-1">
        <AlertTriangle className="h-3.5 w-3.5" /> Breached
      </span>
    );
  }
  const remaining = new Date(dueAt).getTime() - Date.now();
  if (remaining <= 0) {
    return (
      <span className="font-medium text-red-500 inline-flex items-center gap-1">
        <AlertTriangle className="h-3.5 w-3.5" /> Overdue
      </span>
    );
  }
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  const timeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  const urgencyClass =
    remaining < 3600000 ? 'text-red-500' : remaining < 7200000 ? 'text-yellow-500' : 'text-green-500';
  return (
    <span className={`font-medium inline-flex items-center gap-1 ${urgencyClass}`}>
      <Clock className="h-3.5 w-3.5" /> {timeStr}
    </span>
  );
}

/**
 * Re-exports the compact formatter from `lib/format.ts` under the legacy
 * name so all the existing call sites keep working. Prefer importing
 * `formatRelativeTimeCompact` directly in new code.
 */
export const timeAgo = formatRelativeTimeCompact;
