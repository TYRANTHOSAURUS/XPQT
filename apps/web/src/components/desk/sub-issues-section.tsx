import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Clock, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { PersonAvatar } from '@/components/person-avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useWorkOrders, useWorkOrdersRollup, WorkOrderRow } from '@/hooks/use-work-orders';
import { cn } from '@/lib/utils';
import { PriorityIcon } from '@/components/desk/ticket-row-cells';

interface AssigneeOption {
  id: string;
  label: string;
}
interface UserOption {
  id: string;
  email: string;
  person?: { first_name?: string; last_name?: string } | null;
}

interface SubIssuesSectionProps {
  parentId: string;
  onAddClick: () => void;
  refreshNonce?: number;
  teams: AssigneeOption[];
  users: UserOption[];
  vendors: AssigneeOption[];
  /**
   * Invoked when a sub-issue row is clicked. If provided, used instead of router navigation —
   * lets parents that manage ticket selection via state (e.g. the desk TicketsPage panel)
   * open the row inline rather than navigate to a URL that may not be routed.
   */
  onOpenTicket?: (id: string) => void;
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  new: 'outline',
  assigned: 'secondary',
  in_progress: 'default',
  waiting: 'secondary',
  resolved: 'secondary',
  closed: 'outline',
};

function assigneeLabel(
  row: WorkOrderRow,
  teams: AssigneeOption[],
  users: UserOption[],
  vendors: AssigneeOption[],
): { label: string; person?: { first_name?: string; last_name?: string } | null } {
  if (row.assigned_vendor_id) {
    const v = vendors.find((x) => x.id === row.assigned_vendor_id);
    return { label: v?.label ?? 'Vendor' };
  }
  if (row.assigned_user_id) {
    const u = users.find((x) => x.id === row.assigned_user_id);
    if (!u) return { label: 'User' };
    const name = u.person
      ? `${u.person.first_name ?? ''} ${u.person.last_name ?? ''}`.trim() || u.email
      : u.email;
    return { label: name, person: u.person ?? null };
  }
  if (row.assigned_team_id) {
    const t = teams.find((x) => x.id === row.assigned_team_id);
    return { label: t?.label ?? 'Team' };
  }
  return { label: 'Unassigned' };
}

function SlaChip({ row }: { row: WorkOrderRow }) {
  if (!row.sla_id) return <span className="text-xs text-muted-foreground/60">No SLA</span>;
  if (row.sla_resolution_breached_at) {
    return (
      <span className="text-xs text-red-500 inline-flex items-center gap-1">
        <AlertTriangle className="h-3 w-3" /> Breached
      </span>
    );
  }
  if (!row.sla_resolution_due_at) return <span className="text-xs text-muted-foreground/60">—</span>;

  const remaining = new Date(row.sla_resolution_due_at).getTime() - Date.now();
  if (remaining <= 0) {
    return (
      <span className="text-xs text-red-500 inline-flex items-center gap-1">
        <AlertTriangle className="h-3 w-3" /> Overdue
      </span>
    );
  }
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  const label = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  const tone =
    remaining < 3600000 ? 'text-red-500'
    : remaining < 7200000 ? 'text-yellow-500'
    : 'text-muted-foreground';
  return (
    <span className={cn('text-xs inline-flex items-center gap-1', tone)}>
      <Clock className="h-3 w-3" /> {label}
    </span>
  );
}

export function SubIssuesSection({
  parentId,
  onAddClick,
  refreshNonce = 0,
  teams,
  users,
  vendors,
  onOpenTicket,
}: SubIssuesSectionProps) {
  const navigate = useNavigate();
  const openRow = (id: string) => {
    if (onOpenTicket) onOpenTicket(id);
    else navigate(`/desk/tickets/${id}`);
  };
  const { data, loading, error, refetch } = useWorkOrders(parentId);
  // Audit-02 P1-5 FE-rollup: the header count is the PRIVILEGED total —
  // NOT `data.length` (the visibility-filtered list under-reports for a
  // scoped operator). The child LIST below still renders the filtered
  // `data` UNCHANGED — P1-5 stays intact.
  const { data: rollup } = useWorkOrdersRollup(parentId);
  const total = rollup?.total ?? 0;
  // Audit-02 P1-5 FE-rollup (FOLD item-5): only trust the hidden-items
  // tooltip once the (visibility-filtered) list query has ALSO settled.
  // While `loading`, `data.length` is transiently 0 → the header tooltip +
  // cursor-help would flicker on every mount/refetch even when nothing is
  // hidden. Treat still-loading as not-hidden until it settles.
  const hasHidden = !loading && total > 0 && data.length < total;
  const [lastNonce, setLastNonce] = useState(refreshNonce);
  if (refreshNonce !== lastNonce) {
    setLastNonce(refreshNonce);
    refetch();
  }

  // Base UI Tooltip uses a `render` prop (not Radix `asChild`) — mirror the
  // pattern used elsewhere (ticket-meta-row reclassified tooltip).
  const headerCount =
    total > 0 ? (
      hasHidden ? (
        <Tooltip>
          <TooltipTrigger
            className="text-xs text-muted-foreground tabular-nums cursor-help bg-transparent border-0 p-0"
            render={(props) => <span {...props}>{total}</span>}
          />
          <TooltipContent>Some sub-issues may be hidden by visibility rules.</TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-xs text-muted-foreground tabular-nums">{total}</span>
      )
    ) : null;

  return (
    <section className="mt-10">
      <header className="flex items-center gap-3 mb-3">
        <span className="text-sm font-medium">Sub-issues</span>
        {headerCount}
        <Button
          variant="ghost"
          size="icon"
          onClick={onAddClick}
          className="ml-auto h-6 w-6 text-muted-foreground"
          aria-label="Add sub-issue"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </header>

      {loading && data.length === 0 && !error && (
        <ul className="divide-y rounded-md border" aria-busy="true" aria-label="Loading sub-issues">
          {Array.from({ length: 3 }).map((_, i) => (
            <li key={i} className="flex items-center gap-3 px-3 py-2">
              <Skeleton className="h-2 w-2 rounded-full" />
              <Skeleton className={cn('h-3 flex-1', i === 0 ? 'max-w-[60%]' : i === 1 ? 'max-w-[75%]' : 'max-w-[45%]')} />
              <span className="flex items-center gap-1.5">
                <Skeleton className="size-4 rounded-full" />
                <Skeleton className="h-3 w-20" />
              </span>
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-5 w-16 rounded-md" />
            </li>
          ))}
        </ul>
      )}

      {error && !loading && (
        <div className="text-sm text-destructive flex items-center gap-2 py-2">
          <span>Failed to load sub-issues.</span>
          <Button size="sm" variant="ghost" onClick={refetch}>Retry</Button>
        </div>
      )}

      {!loading && !error && data.length === 0 && total === 0 && (
        <p className="text-sm text-muted-foreground/60 py-2">No sub-issues yet</p>
      )}

      {/*
        Audit-02 P1-5 FE-rollup: the parent is readable (we got a rollup) and
        it HAS children (total > 0), but none are individually visible to
        this scoped operator. Show a muted notice — the header still surfaces
        the true privileged total + the hidden-items tooltip.
      */}
      {!loading && !error && data.length === 0 && total > 0 && (
        <p className="text-sm text-muted-foreground/60 py-2">No visible sub-issues</p>
      )}

      {!error && data.length > 0 && (
        <ul className="divide-y rounded-md border">
          {data.map((row) => {
            const { label: assignee, person } = assigneeLabel(row, teams, users, vendors);
            return (
              <li
                key={row.id}
                className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer"
                onClick={() => openRow(row.id)}
              >
                <PriorityIcon priority={row.priority} iconClassName="h-3.5 w-3.5" className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm">{row.title}</span>
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  {person && <PersonAvatar size="sm" className="size-4" person={person} />}
                  <span className="max-w-[120px] truncate">{assignee}</span>
                </span>
                <span className="w-20 shrink-0 text-right">
                  <SlaChip row={row} />
                </span>
                <Badge variant={STATUS_VARIANT[row.status_category] ?? 'outline'} className="shrink-0 text-xs">
                  {row.status_category.replace('_', ' ')}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
