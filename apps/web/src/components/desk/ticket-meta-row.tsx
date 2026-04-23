import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CornerDownRight, History, MapPin, Tag, User } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useWorkOrders } from '@/hooks/use-work-orders';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface TicketMetaRowProps {
  ticketId: string;
  ticketKind: 'case' | 'work_order';
  parentTicketId: string | null;
  priority: string;
  requestType?: { id: string; name: string; domain: string } | null;
  requester?: { first_name: string; last_name: string } | null;
  location?: { name: string } | null;
  reclassifiedAt?: string | null;
  reclassifiedReason?: string | null;
  className?: string;
  /**
   * When provided, the "Sub-issue of <parent>" link calls this instead of navigating.
   * Lets the desk TicketsPage swap the detail panel inline rather than going to an unrouted URL.
   */
  onOpenTicket?: (id: string) => void;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const DOMAIN_TONE: Record<string, string> = {
  it: 'bg-blue-500',
  hr: 'bg-pink-500',
  facilities: 'bg-emerald-500',
  finance: 'bg-amber-500',
  security: 'bg-red-500',
  legal: 'bg-violet-500',
  procurement: 'bg-orange-500',
};

const PRIORITY_TONE: Record<string, { dot: string; label: string }> = {
  critical: { dot: 'bg-red-500', label: 'Critical' },
  high: { dot: 'bg-orange-500', label: 'High' },
  medium: { dot: 'bg-blue-500', label: 'Medium' },
  low: { dot: 'bg-muted-foreground/40', label: 'Low' },
  urgent: { dot: 'bg-red-500', label: 'Urgent' },
};

function DomainDot({ domain }: { domain: string }) {
  const tone = DOMAIN_TONE[domain.toLowerCase()] ?? 'bg-muted-foreground/50';
  return <span className={cn('h-1.5 w-1.5 rounded-full', tone)} aria-hidden="true" />;
}

function useParentTitle(parentId: string | null) {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    if (!parentId) { setTitle(null); return; }
    let cancelled = false;
    apiFetch<{ id: string; title: string }>(`/tickets/${parentId}`)
      .then((row) => { if (!cancelled) setTitle(row.title); })
      .catch(() => { if (!cancelled) setTitle('parent case'); });
    return () => { cancelled = true; };
  }, [parentId]);
  return title;
}

function SubIssueProgress({ parentId }: { parentId: string }) {
  const { data, loading } = useWorkOrders(parentId);
  if (loading || data.length === 0) return null;
  const done = data.filter((r) => r.status_category === 'resolved' || r.status_category === 'closed').length;
  const ratio = done / data.length;
  return (
    <span className="inline-flex items-center gap-1.5 text-foreground/80">
      <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center">
        <svg viewBox="0 0 14 14" className="h-3.5 w-3.5">
          <circle cx="7" cy="7" r="5.5" fill="none" className="stroke-muted-foreground/30" strokeWidth="2" />
          {ratio > 0 && (
            <circle
              cx="7"
              cy="7"
              r="5.5"
              fill="none"
              className="stroke-blue-500"
              strokeWidth="2"
              strokeDasharray={`${ratio * 2 * Math.PI * 5.5} ${2 * Math.PI * 5.5}`}
              transform="rotate(-90 7 7)"
              strokeLinecap="round"
            />
          )}
        </svg>
      </span>
      <span className="tabular-nums">{done}/{data.length}</span>
    </span>
  );
}

export function TicketMetaRow({
  ticketId,
  ticketKind,
  parentTicketId,
  priority,
  requestType,
  requester,
  location,
  reclassifiedAt,
  reclassifiedReason,
  className,
  onOpenTicket,
}: TicketMetaRowProps) {
  const parentTitle = useParentTitle(parentTicketId);
  const items: React.ReactNode[] = [];

  if (ticketKind === 'work_order' && parentTicketId) {
    const parentLabel = (
      <>
        <CornerDownRight className="h-3 w-3 -scale-y-100" />
        <span>Sub-issue of</span>
        <span className="max-w-[320px] truncate font-medium text-foreground/90 group-hover:underline">
          {parentTitle ?? '…'}
        </span>
      </>
    );
    const parentClass = 'group inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground';
    items.push(
      onOpenTicket ? (
        <button
          key="parent"
          type="button"
          onClick={() => onOpenTicket(parentTicketId)}
          className={cn(parentClass, 'cursor-pointer bg-transparent p-0')}
        >
          {parentLabel}
        </button>
      ) : (
        <Link key="parent" to={`/desk/tickets/${parentTicketId}`} className={parentClass}>
          {parentLabel}
        </Link>
      ),
    );
  }

  const priorityCfg = PRIORITY_TONE[priority] ?? { dot: 'bg-muted-foreground/40', label: priority };
  items.push(
    <span key="priority" className="inline-flex items-center gap-1.5 text-muted-foreground">
      <span className={cn('h-1.5 w-1.5 rounded-full', priorityCfg.dot)} aria-hidden="true" />
      <span className="text-foreground/90">{priorityCfg.label}</span>
    </span>,
  );

  items.push(
    <span key="type" className="inline-flex items-center gap-1.5 text-muted-foreground">
      {requestType ? (
        <>
          <DomainDot domain={requestType.domain} />
          <span className="text-foreground/90">{requestType.name}</span>
          <span className="uppercase tracking-wide text-[10px] text-muted-foreground/70">
            {requestType.domain}
          </span>
        </>
      ) : (
        <>
          <Tag className="h-3 w-3" />
          <span className="italic">No type</span>
        </>
      )}
    </span>,
  );

  if (requester) {
    const name = `${requester.first_name} ${requester.last_name}`.trim();
    if (name) {
      items.push(
        <span key="requester" className="inline-flex items-center gap-1.5 text-muted-foreground">
          <User className="h-3 w-3" />
          <span className="text-foreground/90 truncate max-w-[160px]">{name}</span>
        </span>,
      );
    }
  }

  if (location?.name) {
    items.push(
      <span key="location" className="inline-flex items-center gap-1.5 text-muted-foreground">
        <MapPin className="h-3 w-3" />
        <span className="text-foreground/90 truncate max-w-[160px]">{location.name}</span>
      </span>,
    );
  }

  if (ticketKind === 'case') {
    items.push(
      <SubIssueProgress key="progress" parentId={ticketId} />,
    );
  }

  if (reclassifiedAt) {
    items.push(
      <Tooltip key="reclassified">
        <TooltipTrigger
          className="inline-flex items-center gap-1.5 text-muted-foreground cursor-help bg-transparent border-0 p-0"
          render={(props) => (
            <span {...props}>
              <History className="h-3 w-3" />
              <span className="text-foreground/80">Reclassified {formatRelative(reclassifiedAt)}</span>
            </span>
          )}
        />
        <TooltipContent className="max-w-xs">
          <p className="text-xs font-medium mb-1">Reason</p>
          <p className="text-xs">{reclassifiedReason || '(no reason)'}</p>
        </TooltipContent>
      </Tooltip>,
    );
  }

  if (items.length === 0) return null;

  return (
    <div
      className={cn(
        'mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground',
        className,
      )}
    >
      {items.map((item, index) => (
        <span key={index} className="inline-flex items-center gap-2">
          {index > 0 && <span className="text-muted-foreground/40">·</span>}
          {item}
        </span>
      ))}
    </div>
  );
}
