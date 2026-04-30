// apps/web/src/components/portal/portal-request-row.tsx
import { Link } from 'react-router-dom';
import { CalendarDays, FileText, ShoppingCart, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import {
  REQUEST_KIND_TILE,
  type PortalStatus,
  type RequestKind,
} from '@/lib/portal-status';
import { PortalStatusPill } from './portal-status-pill';

export type { RequestKind } from '@/lib/portal-status';

interface Props {
  href: string;
  kind: RequestKind;
  /** Optional human-readable reference (e.g. TKT-1234, RES-42). Rendered as a small mono chip above the title. */
  ref?: string | null;
  title: string;
  subtitle?: string | null;
  timestamp: string;
  assigneeName?: string | null;
  status: PortalStatus;
}

const KIND_ICON: Record<RequestKind, React.ComponentType<{ className?: string }>> = {
  ticket:  FileText,
  booking: CalendarDays,
  visitor: UserPlus,
  order:   ShoppingCart,
};

export function PortalRequestRow({ href, kind, ref, title, subtitle, timestamp, assigneeName, status }: Props) {
  const Icon = KIND_ICON[kind];
  return (
    <Link
      to={href}
      viewTransition
      // content-visibility skips off-screen rows on long lists. Cheap perf
      // win for /portal/requests when the user has a year of activity.
      className="group flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-accent/30 active:bg-accent/40 [content-visibility:auto] [contain-intrinsic-size:auto_56px]"
      style={{ transitionTimingFunction: 'var(--ease-portal)', transitionDuration: 'var(--dur-portal-press)' }}
    >
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', REQUEST_KIND_TILE[kind])}>
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          {ref && <span className="font-mono tabular-nums">{ref}</span>}
          {subtitle && <span className="truncate">{subtitle}</span>}
        </span>
      </span>
      <time className="hidden md:inline shrink-0 text-xs text-muted-foreground tabular-nums" dateTime={timestamp} title={formatFullTimestamp(timestamp)}>
        {formatRelativeTime(timestamp)}
      </time>
      {assigneeName && (
        <span className="hidden md:inline shrink-0 text-xs text-muted-foreground truncate max-w-[140px]">{assigneeName}</span>
      )}
      <PortalStatusPill status={status} size="sm" />
    </Link>
  );
}
