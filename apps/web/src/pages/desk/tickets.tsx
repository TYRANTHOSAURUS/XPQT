import { memo, useCallback, useEffect, useMemo, useState } from 'react';
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
          <TableCell className="px-3 py-2 font-mono text-xs text-muted-foreground tabular-nums">
            {formatTicketRef(ticket.ticket_kind, ticket.module_number)}
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

  return (
    <div className="mx-6 rounded-md border">
      <Table containerClassName="overflow-visible">
        <TableHeader className="sticky top-0 z-10 bg-muted/30 backdrop-blur-sm">
          <TableRow className="hover:bg-transparent bg-transparent">
            <TableHead className="h-8 w-10 px-3 text-xs uppercase text-muted-foreground">
              <Checkbox
                checked={tickets.length > 0 && selectedIds.size === tickets.length}
                onCheckedChange={toggleSelectAll}
              />
            </TableHead>
            <TableHead className="h-8 w-[90px] px-3 text-xs uppercase text-muted-foreground">
              Ref
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
              <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                Loading tickets...
              </TableCell>
            </TableRow>
          )}
          {!loading && tickets.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="h-32 text-center">
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
      <div className="sticky top-0 z-10 flex items-center gap-3 px-3 py-1.5 border-b bg-muted/30 backdrop-blur-sm text-xs uppercase text-muted-foreground">
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
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [view, setViewState] = useState<ViewMode>(readStoredView);
  const [reclassifyTarget, setReclassifyTarget] = useState<Ticket | null>(null);
  const [addWorkOrderTarget, setAddWorkOrderTarget] = useState<Ticket | null>(null);

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
