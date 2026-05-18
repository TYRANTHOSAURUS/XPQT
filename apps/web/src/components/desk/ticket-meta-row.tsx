import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CornerDownRight, History, MapPin, Tag, User } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useWorkOrders, useWorkOrdersRollup } from '@/hooks/use-work-orders';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/format';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PriorityIcon } from '@/components/desk/ticket-row-cells';

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
  // Audit-02 P1-5 FE-rollup: progress is single-sourced from the PRIVILEGED
  // server rollup — NOT computed from the visibility-filtered child array
  // (that under-reports for a scoped operator who can't see every child).
  const { data: rollup, loading } = useWorkOrdersRollup(parentId);
  // The visible-list length is only needed to detect that children are
  // hidden from this actor (rollup.total > what they can see). The list
  // query/filter is UNCHANGED — P1-5 stays intact.
  const { data: visible, loading: loadingVisible } = useWorkOrders(parentId);

  if (loading || !rollup || rollup.total === 0) return null;

  const { done, total } = rollup;
  const ratio = total > 0 ? done / total : 0;
  // Audit-02 P1-5 FE-rollup (FOLD item-5): only trust the hidden-items
  // affordance once the (visibility-filtered) list query has ALSO settled.
  // While it's still pending `visible.length` is transiently 0 → the tooltip
  // + cursor-help would flicker on every mount/refetch even when nothing is
  // hidden. Treat still-loading as not-hidden until it settles.
  const hasHidden = !loadingVisible && visible.length < total;

  const ring = (
    <>
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
      <span className="tabular-nums">{done}/{total}</span>
    </>
  );

  if (!hasHidden) {
    return (
      <span className="inline-flex items-center gap-1.5 text-foreground/80">{ring}</span>
    );
  }

  // Subtle affordance ONLY when children are hidden from this actor.
  // Base UI Tooltip uses a `render` prop (not Radix `asChild`) — mirror the
  // existing reclassified-tooltip pattern in this file.
  return (
    <Tooltip>
      <TooltipTrigger
        className="inline-flex items-center gap-1.5 text-foreground/80 cursor-help bg-transparent border-0 p-0"
        render={(props) => <span {...props}>{ring}</span>}
      />
      <TooltipContent>Some sub-issues may be hidden by visibility rules.</TooltipContent>
    </Tooltip>
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

  items.push(
    <PriorityIcon key="priority" priority={priority} withLabel iconClassName="h-3.5 w-3.5" />,
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
              <span className="text-foreground/80">Reclassified {formatRelativeTime(reclassifiedAt)}</span>
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
