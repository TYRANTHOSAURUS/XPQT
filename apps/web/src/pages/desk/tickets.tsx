import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Search, X, LayoutList, Table as TableIcon, Inbox } from 'lucide-react';
import { useTicketList, usePrefetchTicket, useTicketDetail } from '@/api/tickets';
import { TicketDetail } from '@/components/desk/ticket-detail';
import { CreateTicketDialog } from '@/components/desk/create-ticket-dialog';
import { TicketListRow } from '@/components/desk/ticket-list-row';
import { TicketContextMenu } from '@/components/desk/ticket-context-menu';
import { ReclassifyTicketDialog } from '@/components/desk/reclassify-ticket-dialog';
import { AddSubIssueDialog } from '@/components/desk/add-sub-issue-dialog';
import { PersonAvatar } from '@/components/person-avatar';
import { useTeams } from '@/api/teams';
import { useUsers } from '@/api/users';
import { useVendors } from '@/api/vendors';
import {
  type Ticket,
  PriorityIcon,
  SlaCell,
  statusConfig,
  timeAgo,
} from '@/components/desk/ticket-row-cells';
import { formatTicketRef } from '@/lib/format-ref';
import { TicketFilterBar } from '@/components/desk/ticket-filter-bar';
import { useTicketFilters, viewPresets } from '@/pages/desk/use-ticket-filters';
import { Group, Panel, Separator } from 'react-resizable-panels';

type ViewMode = 'table' | 'list';
const VIEW_STORAGE_KEY = 'tickets:view';

function readStoredView(): ViewMode {
  if (typeof window === 'undefined') return 'table';
  const v = window.localStorage.getItem(VIEW_STORAGE_KEY);
  return v === 'list' ? 'list' : 'table';
}

interface TicketTableRowProps {
  ticket: Ticket;
  selected: boolean;
  checked: boolean;
  onSelect: (id: string) => void;
  onToggleCheck: (id: string) => void;
  onPrefetch: (id: string) => void;
  onReclassify: (ticket: Ticket) => void;
  onAddWorkOrder: (ticket: Ticket) => void;
}

/**
 * Memoized table row. Pulled out of the parent map so a parent re-render (e.g.
 * the toolbar search input updating debounced state) doesn't re-render every
 * row. The row only re-renders when its own ticket / selected / checked / one
 * of the stable callbacks changes.
 */
const TicketTableRow = memo(function TicketTableRow({
  ticket,
  selected,
  checked,
  onSelect,
  onToggleCheck,
  onPrefetch,
  onReclassify,
  onAddWorkOrder,
}: TicketTableRowProps) {
  const status = statusConfig[ticket.status_category] ?? statusConfig.new;
  return (
    <TicketContextMenu
      ticket={ticket}
      onOpenDetail={onSelect}
      onReclassify={onReclassify}
      onAddWorkOrder={onAddWorkOrder}
    >
      {(triggerProps, { open: menuOpen }) => (
        <TableRow
          {...triggerProps}
          data-selected={selected ? 'true' : undefined}
          className={cn(
            'cursor-pointer transition-colors',
            selected
              ? 'bg-primary/10 hover:bg-primary/15'
              : menuOpen
                ? 'bg-muted/60'
                : 'hover:bg-muted/40',
          )}
          // Inset shadow over border + padding shift — keeps cell text
          // anchored when selection toggles.
          style={selected ? { boxShadow: 'inset 2px 0 0 var(--primary)' } : undefined}
          onClick={() => onSelect(ticket.id)}
          onMouseEnter={() => onPrefetch(ticket.id)}
          onFocus={() => onPrefetch(ticket.id)}
        >
          <TableCell className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
            <Checkbox checked={checked} onCheckedChange={() => onToggleCheck(ticket.id)} />
          </TableCell>
          <TableCell className="px-3 py-2 font-mono text-xs text-muted-foreground tabular-nums">
            {formatTicketRef(ticket.ticket_kind, ticket.module_number)}
          </TableCell>
          <TableCell className="px-3 py-2">
            <div className="min-w-0">
              <span
                className="text-sm block truncate"
                // Name lives on the row when it's NOT the selected one.
                // The detail panel's h1 always carries the name; pairing
                // produces the row→detail morph on open and the reverse
                // on close. When the row IS selected the name moves
                // to the detail h1, avoiding a duplicate-name collision.
                style={{ viewTransitionName: selected ? undefined : `ticket-${ticket.id}-title` }}
              >
                {ticket.title}
              </span>
              {(ticket.requester || ticket.location) && (
                <span className="text-xs text-muted-foreground block truncate mt-0.5">
                  {ticket.requester
                    ? `${ticket.requester.first_name} ${ticket.requester.last_name}`
                    : ''}
                  {ticket.location ? ` · ${ticket.location.name}` : ''}
                </span>
              )}
            </div>
          </TableCell>
          <TableCell className="px-3 py-2">
            <div className="flex items-center gap-2">
              <div
                className={cn('h-2 w-2 rounded-full shrink-0 transition-colors', status.dotColor)}
                style={{ transitionDuration: 'var(--dur-portal-hover)', transitionTimingFunction: 'var(--ease-portal)' }}
              />
              <span className="text-xs text-muted-foreground">{status.label}</span>
            </div>
          </TableCell>
          <TableCell className="px-3 py-2">
            <PriorityIcon priority={ticket.priority} />
          </TableCell>
          <TableCell className="px-3 py-2">
            <span className="text-xs text-muted-foreground truncate block">
              {ticket.assigned_team?.name ?? '—'}
            </span>
          </TableCell>
          <TableCell className="px-3 py-2">
            <SlaCell
              dueAt={ticket.sla_resolution_due_at}
              breachedAt={ticket.sla_resolution_breached_at}
            />
          </TableCell>
          <TableCell className="px-3 py-2">
            <span className="text-xs text-muted-foreground">{timeAgo(ticket.created_at)}</span>
          </TableCell>
        </TableRow>
      )}
    </TicketContextMenu>
  );
});

function TicketTable({
  tickets,
  loading,
  selectedTicketId,
  setSelectedTicketId,
  selectedIds,
  setSelectedIds,
  onReclassify,
  onAddWorkOrder,
}: {
  tickets: Ticket[];
  loading: boolean;
  selectedTicketId: string | null;
  setSelectedTicketId: (id: string | null) => void;
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  onReclassify: (ticket: Ticket) => void;
  onAddWorkOrder: (ticket: Ticket) => void;
}) {
  const prefetchTicket = usePrefetchTicket();
  // Stable callbacks so the memoized row doesn't see new function identities
  // every render and bail out of `memo`'s shallow compare.
  const onSelect = useCallback((id: string) => setSelectedTicketId(id), [setSelectedTicketId]);
  const toggleSelect = useCallback(
    (id: string) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [setSelectedIds],
  );

  const toggleSelectAll = () => {
    if (selectedIds.size === tickets.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(tickets.map((t) => t.id)));
  };

  const headHeaderClass = 'h-8 px-3 text-xs font-medium text-muted-foreground';

  return (
    <div className="mx-6 rounded-md border">
      <Table containerClassName="overflow-visible">
        <TableHeader className="sticky top-0 z-10 bg-muted/30 backdrop-blur-sm">
          <TableRow className="hover:bg-transparent bg-transparent">
            <TableHead className={cn(headHeaderClass, 'w-10')}>
              <Checkbox
                checked={tickets.length > 0 && selectedIds.size === tickets.length}
                onCheckedChange={toggleSelectAll}
              />
            </TableHead>
            <TableHead className={cn(headHeaderClass, 'w-[90px]')}>Ref</TableHead>
            <TableHead className={cn(headHeaderClass, 'min-w-[250px]')}>Title</TableHead>
            <TableHead className={cn(headHeaderClass, 'w-[120px]')}>Status</TableHead>
            <TableHead className={cn(headHeaderClass, 'w-[70px]')}>Priority</TableHead>
            <TableHead className={cn(headHeaderClass, 'w-[150px]')}>Team</TableHead>
            <TableHead className={cn(headHeaderClass, 'w-[110px]')}>SLA</TableHead>
            <TableHead className={cn(headHeaderClass, 'w-[70px]')}>Age</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="desk-stagger">
          {loading && tickets.length === 0 && (
            <>
              {Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={`skeleton-${i}`} className="hover:bg-transparent">
                  <TableCell className="px-3 py-2"><div className="portal-skeleton size-4 rounded" /></TableCell>
                  <TableCell className="px-3 py-2"><div className="portal-skeleton h-3 w-14 rounded" /></TableCell>
                  <TableCell className="px-3 py-2">
                    <div className="space-y-1.5">
                      <div className="portal-skeleton h-3.5 w-2/5 rounded" />
                      <div className="portal-skeleton h-2.5 w-1/4 rounded" />
                    </div>
                  </TableCell>
                  <TableCell className="px-3 py-2"><div className="portal-skeleton h-3 w-20 rounded" /></TableCell>
                  <TableCell className="px-3 py-2"><div className="portal-skeleton h-3 w-3 rounded" /></TableCell>
                  <TableCell className="px-3 py-2"><div className="portal-skeleton h-3 w-24 rounded" /></TableCell>
                  <TableCell className="px-3 py-2"><div className="portal-skeleton h-3 w-16 rounded" /></TableCell>
                  <TableCell className="px-3 py-2"><div className="portal-skeleton h-3 w-8 rounded" /></TableCell>
                </TableRow>
              ))}
            </>
          )}
          {!loading && tickets.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={8} className="px-6 py-16">
                <div className="flex flex-col items-center gap-3 text-center desk-rise">
                  <Inbox className="size-6 text-muted-foreground/60" aria-hidden />
                  <div>
                    <p className="text-sm font-medium">No tickets here.</p>
                    <p className="mt-1 text-xs text-muted-foreground">Try adjusting your filters or search.</p>
                  </div>
                </div>
              </TableCell>
            </TableRow>
          )}
          {tickets.map((ticket) => (
            <TicketTableRow
              key={ticket.id}
              ticket={ticket}
              selected={selectedTicketId === ticket.id}
              checked={selectedIds.has(ticket.id)}
              onSelect={onSelect}
              onToggleCheck={toggleSelect}
              onPrefetch={prefetchTicket}
              onReclassify={onReclassify}
              onAddWorkOrder={onAddWorkOrder}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function TicketList({
  tickets,
  loading,
  selectedTicketId,
  setSelectedTicketId,
  selectedIds,
  setSelectedIds,
  onReclassify,
  onAddWorkOrder,
}: {
  tickets: Ticket[];
  loading: boolean;
  selectedTicketId: string | null;
  setSelectedTicketId: (id: string | null) => void;
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  onReclassify: (ticket: Ticket) => void;
  onAddWorkOrder: (ticket: Ticket) => void;
}) {
  const prefetchTicket = usePrefetchTicket();
  // Stable callbacks so memoized rows don't re-render when the parent does.
  const onSelect = useCallback(
    (id: string) => setSelectedTicketId(id),
    [setSelectedTicketId],
  );
  const toggleSelect = useCallback(
    (id: string) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [setSelectedIds],
  );

  const toggleSelectAll = () => {
    if (selectedIds.size === tickets.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(tickets.map((t) => t.id)));
  };

  return (
    <div className="mx-6 rounded-md border">
      {/* Muted column label strip — matches row column widths */}
      <div className="sticky top-0 z-10 flex items-center gap-3 px-3 py-1.5 border-b bg-muted/30 backdrop-blur-sm text-xs font-medium text-muted-foreground">
        <div className="w-4 shrink-0">
          <Checkbox
            checked={tickets.length > 0 && selectedIds.size === tickets.length}
            onCheckedChange={toggleSelectAll}
          />
        </div>
        <span className="w-20 shrink-0">Ref</span>
        <span className="w-28 shrink-0">Status</span>
        <span className="w-6 shrink-0 text-center">Pri</span>
        <span className="flex-1 min-w-0">Title</span>
        <span className="w-36 shrink-0">Team</span>
        <span className="w-24 shrink-0">SLA</span>
        <span className="w-10 shrink-0 text-right">Age</span>
      </div>

      {loading && tickets.length === 0 && (
        <div className="desk-stagger divide-y">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={`skeleton-${i}`} className="flex items-center gap-3 px-3 py-2">
              <div className="portal-skeleton size-4 shrink-0 rounded" />
              <div className="portal-skeleton h-3 w-14 shrink-0 rounded" />
              <div className="portal-skeleton h-3 w-20 shrink-0 rounded" />
              <div className="portal-skeleton h-3 w-3 shrink-0 rounded" />
              <div className="flex-1 space-y-1.5">
                <div className="portal-skeleton h-3.5 w-2/5 rounded" />
                <div className="portal-skeleton h-2.5 w-1/4 rounded" />
              </div>
              <div className="portal-skeleton h-3 w-24 shrink-0 rounded" />
              <div className="portal-skeleton h-3 w-16 shrink-0 rounded" />
              <div className="portal-skeleton h-3 w-8 shrink-0 rounded" />
            </div>
          ))}
        </div>
      )}
      {!loading && tickets.length === 0 && (
        <div className="desk-rise flex flex-col items-center gap-3 px-6 py-16 text-center">
          <Inbox className="size-6 text-muted-foreground/60" aria-hidden />
          <div>
            <p className="text-sm font-medium">No tickets here.</p>
            <p className="mt-1 text-xs text-muted-foreground">Try adjusting your filters or search.</p>
          </div>
        </div>
      )}

      <div className="desk-stagger divide-y">
        {tickets.map((ticket) => (
          <TicketContextMenu
            key={ticket.id}
            ticket={ticket}
            onOpenDetail={onSelect}
            onReclassify={onReclassify}
            onAddWorkOrder={onAddWorkOrder}
          >
            {(triggerProps, { open: menuOpen }) => (
              <div
                {...triggerProps}
                onMouseEnter={() => prefetchTicket(ticket.id)}
                onFocus={() => prefetchTicket(ticket.id)}
              >
                <TicketListRow
                  ticket={ticket}
                  selected={selectedTicketId === ticket.id}
                  checked={selectedIds.has(ticket.id)}
                  menuOpen={menuOpen}
                  onSelect={onSelect}
                  onToggleCheck={toggleSelect}
                />
              </div>
            )}
          </TicketContextMenu>
        ))}
      </div>
    </div>
  );
}

interface TicketsViewProps {
  tickets: Ticket[];
  loading: boolean;
  selectedTicketId: string | null;
  setSelectedTicketId: (id: string | null) => void;
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  view: ViewMode;
  setView: (v: ViewMode) => void;
  filtersHook: ReturnType<typeof useTicketFilters>;
  /** Local debounced text the user is typing into the toolbar search. */
  searchInput: string;
  setSearchInput: (v: string) => void;
  /** Label for the active named view, if any (shown inline in the toolbar). */
  activeViewLabel: string | null;
  onReclassify: (ticket: Ticket) => void;
  onAddWorkOrder: (ticket: Ticket) => void;
}

function TicketsView({
  tickets,
  loading,
  selectedTicketId,
  setSelectedTicketId,
  selectedIds,
  setSelectedIds,
  view,
  setView,
  filtersHook,
  searchInput,
  setSearchInput,
  activeViewLabel,
  onReclassify,
  onAddWorkOrder,
}: TicketsViewProps) {
  const tableProps = {
    tickets,
    loading,
    selectedTicketId,
    setSelectedTicketId,
    selectedIds,
    setSelectedIds,
    onReclassify,
    onAddWorkOrder,
  };

  const { raw, patch, currentUserId, activeCount, clearAll } = filtersHook;

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-6 py-4 shrink-0">
        {activeViewLabel && (
          <Badge variant="secondary" className="h-7 gap-1 text-xs font-medium">
            {activeViewLabel}
          </Badge>
        )}
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search tickets..."
            className="pl-9"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>

        {selectedIds.size > 0 ? (
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{selectedIds.size} selected</Badge>
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => setSelectedIds(new Set())}
            >
              <X className="h-4 w-4" />
              Clear selection
            </Button>
          </div>
        ) : (
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {tickets.length} ticket{tickets.length !== 1 ? 's' : ''}
            </span>
            <ToggleGroup
              value={[view]}
              onValueChange={(v) => {
                const next = v[0];
                if (next === 'table' || next === 'list') setView(next);
              }}
              variant="outline"
              className="h-8"
            >
              <ToggleGroupItem value="table" aria-label="Table view" className="h-8 px-2">
                <TableIcon className="h-4 w-4" />
              </ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label="List view" className="h-8 px-2">
                <LayoutList className="h-4 w-4" />
              </ToggleGroupItem>
            </ToggleGroup>
            <CreateTicketDialog />
          </div>
        )}
      </div>

      {/* Filter chip bar */}
      <TicketFilterBar
        raw={raw}
        patch={patch}
        currentUserId={currentUserId}
        activeCount={activeCount}
        onClearAll={clearAll}
      />

      {/* Table or List */}
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain pb-4">
        {view === 'list' ? <TicketList {...tableProps} /> : <TicketTable {...tableProps} />}
      </div>
    </div>
  );
}

export function TicketsPage() {
  const navigate = useNavigate();
  const filtersHook = useTicketFilters();
  const [selectedTicketId, setSelectedTicketIdRaw] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [view, setViewState] = useState<ViewMode>(readStoredView);
  const [reclassifyTarget, setReclassifyTarget] = useState<Ticket | null>(null);
  const [addWorkOrderTarget, setAddWorkOrderTarget] = useState<Ticket | null>(null);

  /**
   * Selecting a ticket morphs the row's title into the detail panel's
   * title via the `ticket-${id}-title` view-transition name. Wrap the
   * state update so the browser pairs the named elements between the
   * old (no-detail) and new (detail-open) snapshots. flushSync forces
   * React to commit synchronously inside the transition callback.
   */
  const setSelectedTicketId = useCallback((next: string | null) => {
    const start = (document as { startViewTransition?: (cb: () => void) => unknown }).startViewTransition;
    if (typeof start === 'function') {
      start.call(document, () => flushSync(() => setSelectedTicketIdRaw(next)));
    } else {
      setSelectedTicketIdRaw(next);
    }
  }, []);

  const setView = (v: ViewMode) => {
    setViewState(v);
    window.localStorage.setItem(VIEW_STORAGE_KEY, v);
  };

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === VIEW_STORAGE_KEY && (e.newValue === 'list' || e.newValue === 'table')) {
        setViewState(e.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Keep an immediate input string so typing doesn't ping-pong through the URL
  // every keystroke. Push to the URL after a short debounce.
  const [searchInput, setSearchInput] = useState(filtersHook.raw.q);
  useEffect(() => {
    setSearchInput(filtersHook.raw.q);
  }, [filtersHook.raw.q]);

  useEffect(() => {
    if (searchInput === filtersHook.raw.q) return;
    const handle = window.setTimeout(() => {
      filtersHook.patch({ q: searchInput || null });
    }, 250);
    return () => window.clearTimeout(handle);
  }, [searchInput, filtersHook]);

  const { data, isPending: loading } = useTicketList<Ticket>(filtersHook.filters);
  const tickets = data?.items ?? [];

  const activeViewLabel = filtersHook.raw.view
    ? viewPresets[filtersHook.raw.view]?.label ?? null
    : null;

  // Stable callbacks so the memoized rows don't bail out of `memo`'s shallow compare.
  const onReclassify = useCallback((ticket: Ticket) => setReclassifyTarget(ticket), []);
  const onAddWorkOrder = useCallback((ticket: Ticket) => setAddWorkOrderTarget(ticket), []);

  /**
   * Keyboard navigation — j/k or ArrowDown/ArrowUp moves selection
   * through visible rows; Escape closes the detail panel. Bails out
   * when the user is typing in an input/textarea/contenteditable so
   * the search bar and dialogs keep their native key behaviour.
   *
   * Each step goes through the transitioned setter so the row→detail
   * morph fires; the browser cancels in-flight transitions on rapid
   * keypresses, so holding j/k feels smooth, not queued.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'Escape' && selectedTicketId) {
        e.preventDefault();
        setSelectedTicketId(null);
        return;
      }

      const isDown = e.key === 'j' || e.key === 'ArrowDown';
      const isUp = e.key === 'k' || e.key === 'ArrowUp';
      if (!isDown && !isUp) return;
      if (tickets.length === 0) return;

      e.preventDefault();
      const currentIdx = tickets.findIndex((t) => t.id === selectedTicketId);
      const nextIdx = currentIdx === -1
        ? (isDown ? 0 : tickets.length - 1)
        : (isDown ? Math.min(currentIdx + 1, tickets.length - 1) : Math.max(currentIdx - 1, 0));
      if (nextIdx === currentIdx) return;
      setSelectedTicketId(tickets[nextIdx].id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [tickets, selectedTicketId, setSelectedTicketId]);

  /**
   * Scroll the newly-selected row into view (no-op if already visible).
   * Uses `block: 'nearest'` so the row only moves the minimum needed —
   * agents pressing j repeatedly stay anchored at the bottom of the
   * viewport instead of every step centring the row.
   */
  useEffect(() => {
    if (!selectedTicketId) return;
    const row = document.querySelector('[data-selected="true"]');
    if (row && 'scrollIntoView' in row) {
      (row as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [selectedTicketId]);

  const viewProps: TicketsViewProps = {
    tickets,
    loading,
    selectedTicketId,
    setSelectedTicketId,
    selectedIds,
    setSelectedIds,
    view,
    setView,
    filtersHook,
    searchInput,
    setSearchInput,
    activeViewLabel,
    onReclassify,
    onAddWorkOrder,
  };

  return (
    <>
      <Group orientation="horizontal" style={{ height: '100%' }}>
        {selectedTicketId ? (
          <>
            <Panel id="table" defaultSize="55%" className="relative">
              <TicketsView {...viewProps} />
            </Panel>
            <Separator />
            <Panel id="detail" defaultSize="45%" className="relative">
              <div className="absolute inset-0 overflow-auto overscroll-contain border-l">
                <TicketDetail
                  ticketId={selectedTicketId}
                  onClose={() => setSelectedTicketId(null)}
                  onOpenTicket={setSelectedTicketId}
                  onExpand={() => navigate(`/desk/tickets/${selectedTicketId}`)}
                />
              </div>
            </Panel>
          </>
        ) : (
          <Panel id="table" className="relative">
            <TicketsView {...viewProps} />
          </Panel>
        )}
      </Group>

      {reclassifyTarget && (
        <ReclassifyTargetDialog
          ticket={reclassifyTarget}
          onOpenChange={(open) => {
            if (!open) setReclassifyTarget(null);
          }}
        />
      )}

      {addWorkOrderTarget && (
        <AddWorkOrderTargetDialog
          ticket={addWorkOrderTarget}
          onOpenChange={(open) => {
            if (!open) setAddWorkOrderTarget(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Wraps `ReclassifyTicketDialog` so it can fetch the target's full detail
 * (for `currentRequestType`) when invoked from the tickets list. The dialog
 * mounts only when there's an active target.
 */
function ReclassifyTargetDialog({
  ticket,
  onOpenChange,
}: {
  ticket: Ticket;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: detail } = useTicketDetail(ticket.id);
  return (
    <ReclassifyTicketDialog
      open
      onOpenChange={onOpenChange}
      ticketId={ticket.id}
      currentRequestType={detail?.request_type ?? null}
      onReclassified={() => onOpenChange(false)}
    />
  );
}

/**
 * Wraps `AddSubIssueDialog` so it can lazily load team / user / vendor options
 * when triggered from the tickets list (instead of holding them at page level
 * for every render).
 */
function AddWorkOrderTargetDialog({
  ticket,
  onOpenChange,
}: {
  ticket: Ticket;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: teams } = useTeams();
  const { data: users } = useUsers();
  const { data: vendors } = useVendors();

  const teamOptions = useMemo(
    () => (teams ?? []).map((t) => ({ id: t.id, label: t.name })),
    [teams],
  );
  const vendorOptions = useMemo(
    () => (vendors ?? []).filter((v) => v.active !== false).map((v) => ({ id: v.id, label: v.name })),
    [vendors],
  );
  const userOptions = useMemo(
    () => (users ?? []).map((u) => ({
      id: u.id,
      label: u.person
        ? `${u.person.first_name ?? ''} ${u.person.last_name ?? ''}`.trim() || u.email
        : u.email,
      sublabel: u.email,
      leading: <PersonAvatar size="sm" person={u.person ?? { email: u.email }} />,
    })),
    [users],
  );

  return (
    <AddSubIssueDialog
      open
      onOpenChange={onOpenChange}
      parentId={ticket.id}
      parentPriority={ticket.priority ?? 'medium'}
      teamOptions={teamOptions}
      userOptions={userOptions}
      vendorOptions={vendorOptions}
      onDispatched={() => onOpenChange(false)}
    />
  );
}
