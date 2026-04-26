import { memo, useCallback, useEffect, useState } from 'react';
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
import { Search, X, LayoutList, Table as TableIcon } from 'lucide-react';
import { useTicketList, usePrefetchTicket } from '@/api/tickets';
import { TicketDetail } from '@/components/desk/ticket-detail';
import { CreateTicketDialog } from '@/components/desk/create-ticket-dialog';
import { TicketListRow } from '@/components/desk/ticket-list-row';
import {
  type Ticket,
  PriorityIcon,
  SlaCell,
  statusConfig,
  timeAgo,
} from '@/components/desk/ticket-row-cells';
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
}: TicketTableRowProps) {
  const status = statusConfig[ticket.status_category] ?? statusConfig.new;
  return (
    <TableRow
      data-selected={selected ? 'true' : undefined}
      className={cn(
        'cursor-pointer transition-colors',
        selected ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-muted/40',
      )}
      onClick={() => onSelect(ticket.id)}
      onMouseEnter={() => onPrefetch(ticket.id)}
      onFocus={() => onPrefetch(ticket.id)}
    >
      <TableCell
        className={`px-3 py-2 ${selected ? 'border-l-2 border-l-primary pl-[10px]' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <Checkbox checked={checked} onCheckedChange={() => onToggleCheck(ticket.id)} />
      </TableCell>
      <TableCell className="px-3 py-2">
        <div className="min-w-0">
          <span className="text-sm block truncate">{ticket.title}</span>
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
          <div className={`h-2 w-2 rounded-full shrink-0 ${status.dotColor}`} />
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
  );
});

function TicketTable({
  tickets,
  loading,
  selectedTicketId,
  setSelectedTicketId,
  selectedIds,
  setSelectedIds,
}: {
  tickets: Ticket[];
  loading: boolean;
  selectedTicketId: string | null;
  setSelectedTicketId: (id: string | null) => void;
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
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

  return (
    <div className="mx-6 rounded-md border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent bg-muted/30">
            <TableHead className="h-8 w-10 px-3 text-xs uppercase text-muted-foreground">
              <Checkbox
                checked={tickets.length > 0 && selectedIds.size === tickets.length}
                onCheckedChange={toggleSelectAll}
              />
            </TableHead>
            <TableHead className="h-8 min-w-[250px] px-3 text-xs uppercase text-muted-foreground">
              Title
            </TableHead>
            <TableHead className="h-8 w-[120px] px-3 text-xs uppercase text-muted-foreground">
              Status
            </TableHead>
            <TableHead className="h-8 w-[70px] px-3 text-xs uppercase text-muted-foreground">
              Priority
            </TableHead>
            <TableHead className="h-8 w-[150px] px-3 text-xs uppercase text-muted-foreground">
              Team
            </TableHead>
            <TableHead className="h-8 w-[110px] px-3 text-xs uppercase text-muted-foreground">
              SLA
            </TableHead>
            <TableHead className="h-8 w-[70px] px-3 text-xs uppercase text-muted-foreground">
              Age
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && tickets.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                Loading tickets...
              </TableCell>
            </TableRow>
          )}
          {!loading && tickets.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="h-32 text-center">
                <p className="text-lg font-medium text-muted-foreground">No tickets found</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Try adjusting your filters or search
                </p>
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
}: {
  tickets: Ticket[];
  loading: boolean;
  selectedTicketId: string | null;
  setSelectedTicketId: (id: string | null) => void;
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
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
      <div className="flex items-center gap-3 px-3 py-1.5 border-b bg-muted/30 text-xs uppercase text-muted-foreground">
        <div className="w-4 shrink-0">
          <Checkbox
            checked={tickets.length > 0 && selectedIds.size === tickets.length}
            onCheckedChange={toggleSelectAll}
          />
        </div>
        <span className="w-28 shrink-0">Status</span>
        <span className="w-6 shrink-0 text-center">Pri</span>
        <span className="flex-1 min-w-0">Title</span>
        <span className="w-36 shrink-0">Team</span>
        <span className="w-24 shrink-0">SLA</span>
        <span className="w-10 shrink-0 text-right">Age</span>
      </div>

      {loading && tickets.length === 0 && (
        <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">
          Loading tickets...
        </div>
      )}
      {!loading && tickets.length === 0 && (
        <div className="h-32 flex flex-col items-center justify-center">
          <p className="text-lg font-medium text-muted-foreground">No tickets found</p>
          <p className="text-sm text-muted-foreground mt-1">Try adjusting your filters or search</p>
        </div>
      )}

      <div className="divide-y">
        {tickets.map((ticket) => (
          <div
            key={ticket.id}
            onMouseEnter={() => prefetchTicket(ticket.id)}
            onFocus={() => prefetchTicket(ticket.id)}
          >
            <TicketListRow
              ticket={ticket}
              selected={selectedTicketId === ticket.id}
              checked={selectedIds.has(ticket.id)}
              onSelect={onSelect}
              onToggleCheck={toggleSelect}
            />
          </div>
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
}: TicketsViewProps) {
  const tableProps = {
    tickets,
    loading,
    selectedTicketId,
    setSelectedTicketId,
    selectedIds,
    setSelectedIds,
  };

  const { raw, patch, currentUserId, activeCount, clearAll } = filtersHook;

  return (
    <div className="flex h-full flex-col">
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
      <div className="flex-1 overflow-auto overscroll-contain pb-4">
        {view === 'list' ? <TicketList {...tableProps} /> : <TicketTable {...tableProps} />}
      </div>
    </div>
  );
}

export function TicketsPage() {
  const navigate = useNavigate();
  const filtersHook = useTicketFilters();
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [view, setViewState] = useState<ViewMode>(readStoredView);

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
  };

  return (
    <Group orientation="horizontal" style={{ height: '100%' }}>
      {selectedTicketId ? (
        <>
          <Panel id="table" defaultSize="55%">
            <TicketsView {...viewProps} />
          </Panel>
          <Separator />
          <Panel id="detail" defaultSize="45%">
            <div className="h-full overflow-auto overscroll-contain border-l">
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
        <Panel id="table">
          <TicketsView {...viewProps} />
        </Panel>
      )}
    </Group>
  );
}
