import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CornerDownRight } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useWorkOrders } from '@/hooks/use-work-orders';
import { cn } from '@/lib/utils';

interface TicketMetaRowProps {
  ticketId: string;
  ticketKind: 'case' | 'work_order';
  parentTicketId: string | null;
  requestType?: { id: string; name: string; domain: string } | null;
  className?: string;
  /**
   * When provided, the "Sub-issue of <parent>" link calls this instead of navigating.
   * Lets the desk TicketsPage swap the detail panel inline rather than going to an unrouted URL.
   */
  onOpenTicket?: (id: string) => void;
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
  return (
    <span className="inline-flex items-center gap-1 text-foreground/80">
      <span className="relative inline-flex h-3 w-3 items-center justify-center">
        <svg viewBox="0 0 12 12" className="h-3 w-3">
          <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
          <circle
            cx="6"
            cy="6"
            r="5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray={`${(done / data.length) * 31.4} 31.4`}
            strokeDashoffset="0"
            transform="rotate(-90 6 6)"
            strokeLinecap="round"
          />
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
  requestType,
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

  if (requestType) {
    items.push(
      <span key="type" className="inline-flex items-center gap-1.5 text-muted-foreground">
        <DomainDot domain={requestType.domain} />
        <span className="text-foreground/90">{requestType.name}</span>
        <span className="uppercase tracking-wide text-[10px] text-muted-foreground/70">
          {requestType.domain}
        </span>
      </span>,
    );
  }

  if (ticketKind === 'case') {
    items.push(
      <SubIssueProgress key="progress" parentId={ticketId} />,
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
