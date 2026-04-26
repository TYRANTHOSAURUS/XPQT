// apps/web/src/components/portal/portal-request-row.tsx
import { Link } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';

export type RequestKind = 'ticket' | 'booking' | 'visitor' | 'order';

interface Props {
  href: string;
  kind: RequestKind;
  /** Optional human-readable reference (e.g. TKT-1234, RES-42). Rendered as a small mono chip above the title. */
  ref?: string | null;
  title: string;
  subtitle?: string | null;
  timestamp: string;
  assigneeName?: string | null;
  status: { label: string; tone: 'inprog' | 'waiting' | 'scheduled' | 'done' | 'breached' };
}

const KIND_STYLES: Record<RequestKind, { Icon: React.ComponentType<{ className?: string }>; tile: string }> = {
  ticket:  { Icon: Icons.FileText,     tile: 'bg-blue-500/15 text-blue-500' },
  booking: { Icon: Icons.CalendarDays, tile: 'bg-purple-500/15 text-purple-500' },
  visitor: { Icon: Icons.UserPlus,     tile: 'bg-pink-500/15 text-pink-500' },
  order:   { Icon: Icons.ShoppingCart, tile: 'bg-emerald-500/15 text-emerald-500' },
};

const STATUS_STYLES: Record<Props['status']['tone'], string> = {
  inprog:    'bg-emerald-500/15 text-emerald-500',
  waiting:   'bg-yellow-500/15 text-yellow-500',
  scheduled: 'bg-purple-500/15 text-purple-500',
  done:      'bg-muted text-muted-foreground',
  breached:  'bg-red-500/15 text-red-500',
};

export function PortalRequestRow({ href, kind, ref, title, subtitle, timestamp, assigneeName, status }: Props) {
  const { Icon, tile } = KIND_STYLES[kind];
  return (
    <Link
      to={href}
      className="flex items-center gap-4 border-b px-4 py-3.5 transition-colors hover:bg-accent/30 last:border-b-0"
    >
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', tile)}>
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
      <span className={cn('shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium tabular-nums', STATUS_STYLES[status.tone])}>
        {status.label}
      </span>
    </Link>
  );
}
