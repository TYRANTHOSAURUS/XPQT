// apps/web/src/components/portal/portal-request-row.tsx
import { Link } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import {
  REQUEST_KIND_TILE,
  STATUS_TONE_CLASSES,
  type PortalStatus,
  type RequestKind,
} from '@/lib/portal-status';

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
  ticket:  Icons.FileText,
  booking: Icons.CalendarDays,
  visitor: Icons.UserPlus,
  order:   Icons.ShoppingCart,
};

export function PortalRequestRow({ href, kind, ref, title, subtitle, timestamp, assigneeName, status }: Props) {
  const Icon = KIND_ICON[kind];
  return (
    <Link
      to={href}
      viewTransition
      className="group flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-accent/30 active:bg-accent/40"
      style={{ transitionTimingFunction: 'var(--ease-portal)', transitionDuration: 'var(--dur-portal-press)' }}
    >
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', REQUEST_KIND_TILE[kind])}>
        <Icon className="size-4" />
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
      <span
        className={cn(
          'shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium tabular-nums',
          // Crossfade tone changes — when polling flips a ticket from
          // "Submitted" → "Assigned" the pill glides instead of snapping.
          'transition-colors duration-200',
          STATUS_TONE_CLASSES[status.tone],
        )}
        style={{ transitionTimingFunction: 'var(--ease-portal)' }}
      >
        {status.label}
      </span>
    </Link>
  );
}
