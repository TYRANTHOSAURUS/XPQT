/**
 * /desk/visitors — service desk's canonical visitor surface.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §7
 *
 * Mirrors /desk/tickets in shape: search-driven toolbar, view-mode
 * toggle (table/list), URL-backed filter chips, click-to-open detail
 * panel on the right, right-click context menu on rows.
 *
 * The receptionist persona at smaller tenants IS a service-desk
 * operator wearing the reception hat (per `docs/users.md` §9), so
 * everything front-desk lives here as a peer of /desk/tickets and
 * /desk/bookings — not in a separate /reception/* shell.
 *
 * Data sources today (no general /visitors list endpoint exists yet):
 *   - default `today` view → `useReceptionToday(buildingId)` flattened.
 *   - `pending_approval`   → `useDeskLens()` cross-building.
 *   - `loose_ends`         → `useReceptionYesterday(buildingId)`.
 *   - search overlay       → `useReceptionSearch(buildingId, q)`.
 *
 * "All / Recent / arbitrary date" surfaces today's data with a banner
 * pointing at the missing list endpoint — we explicitly opt for honesty
 * over implying server-side history works.
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import {
  Inbox,
  KeyRound,
  LayoutList,
  Plus,
  Search,
  Table as TableIcon,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { VisitorStatusBadge } from '@/components/visitors/visitor-status-badge';
import {
  useReceptionBuilding,
  ReceptionBuildingProvider,
} from '@/components/desk/desk-building-context';
import { VisitorListRow } from '@/components/desk/visitor-list-row';
import { VisitorContextMenu } from '@/components/desk/visitor-context-menu';
import { VisitorDetail } from '@/components/desk/visitor-detail';
import { AssignPassDialog } from '@/components/desk/visitor-assign-pass-dialog';
import { VisitorInviteForm } from '@/components/portal/visitor-invite-form';
import {
  formatPrimaryHost,
  formatReceptionRowName,
  useReceptionSearch,
  useReceptionToday,
  useReceptionYesterday,
  type ReceptionTodayView,
  type ReceptionVisitorRow as RowT,
} from '@/api/visitors/reception';
import { useDeskLens } from '@/api/visitors/admin';
import {
  useVisitorFilters,
  visitorDateMatches,
  visitorViewPresets,
  type VisitorViewId,
} from '@/pages/desk/use-visitor-filters';
import { VisitorFilterBar } from '@/components/desk/visitor-filter-bar';
import { formatTimeShort } from '@/lib/format';
import { toastCreated } from '@/lib/toast';

type ViewMode = 'table' | 'list';
const VIEW_STORAGE_KEY = 'visitors:view';

function readStoredView(): ViewMode {
  if (typeof window === 'undefined') return 'table';
  const v = window.localStorage.getItem(VIEW_STORAGE_KEY);
  return v === 'list' ? 'list' : 'table';
}

/** The reception-today buckets are richer than a flat list — flatten
 *  to a sortable, filterable list so the page can render either view
 *  mode against a single shape. Order matches reception's mental model
 *  (currently_arriving → expected → in_meeting → checked_out). */
function flattenToday(today: ReceptionTodayView | undefined): RowT[] {
  if (!today) return [];
  return [
    ...today.currently_arriving,
    ...today.expected,
    ...today.in_meeting,
    ...today.checked_out_today,
  ];
}

interface VisitorTableRowProps {
  row: RowT;
  buildingId: string | null;
  selected: boolean;
  checked: boolean;
  onSelect: (id: string) => void;
  onToggleCheck: (id: string) => void;
  onAssignPass: (row: RowT) => void;
}

const VisitorTableRow = memo(function VisitorTableRow({
  row,
  buildingId,
  selected,
  checked,
  onSelect,
  onToggleCheck,
  onAssignPass,
}: VisitorTableRowProps) {
  const time = row.expected_at ? formatTimeShort(row.expected_at) : null;
  const host = formatPrimaryHost(row);
  const visitor = formatReceptionRowName(row);

  return (
    <VisitorContextMenu
      row={row}
      buildingId={buildingId}
      onOpenDetail={onSelect}
      onAssignPass={onAssignPass}
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
          style={selected ? { boxShadow: 'inset 2px 0 0 var(--primary)' } : undefined}
          onClick={() => onSelect(row.visitor_id)}
        >
          <TableCell className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={checked}
              onCheckedChange={() => onToggleCheck(row.visitor_id)}
            />
          </TableCell>
          <TableCell className="px-3 py-2">
            <div className="min-w-0">
              <span className="block truncate text-sm">{visitor}</span>
              {row.company && (
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {row.company}
                </span>
              )}
            </div>
          </TableCell>
          <TableCell className="px-3 py-2 text-xs text-muted-foreground">
            {host ?? <span className="italic">No host</span>}
          </TableCell>
          <TableCell className="px-3 py-2 tabular-nums text-xs text-muted-foreground">
            {time ?? '—'}
          </TableCell>
          <TableCell className="px-3 py-2">
            <VisitorStatusBadge status={row.status} />
          </TableCell>
          <TableCell className="px-3 py-2 text-xs text-muted-foreground">
            {row.pass_number ? (
              <span className="inline-flex items-center gap-1 tabular-nums">
                <KeyRound className="size-3" aria-hidden /> #{row.pass_number}
              </span>
            ) : (
              <span className="text-muted-foreground/60">—</span>
            )}
          </TableCell>
        </TableRow>
      )}
    </VisitorContextMenu>
  );
});

function VisitorTable({
  rows,
  loading,
  buildingId,
  selectedId,
  setSelectedId,
  selectedIds,
  setSelectedIds,
  onAssignPass,
  emptyText,
}: {
  rows: RowT[];
  loading: boolean;
  buildingId: string | null;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  onAssignPass: (row: RowT) => void;
  emptyText: string;
}) {
  const onSelect = useCallback((id: string) => setSelectedId(id), [setSelectedId]);
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
    if (selectedIds.size === rows.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(rows.map((r) => r.visitor_id)));
  };

  const head = 'h-8 px-3 text-xs font-medium text-muted-foreground';

  return (
    <div className="mx-6 rounded-md border">
      <Table containerClassName="overflow-visible">
        <TableHeader className="sticky top-0 z-10 bg-muted/30 backdrop-blur-sm">
          <TableRow className="bg-transparent hover:bg-transparent">
            <TableHead className={cn(head, 'w-10')}>
              <Checkbox
                checked={rows.length > 0 && selectedIds.size === rows.length}
                onCheckedChange={toggleSelectAll}
              />
            </TableHead>
            <TableHead className={cn(head, 'min-w-[220px]')}>Visitor</TableHead>
            <TableHead className={cn(head, 'w-[180px]')}>Host</TableHead>
            <TableHead className={cn(head, 'w-[80px]')}>Expected</TableHead>
            <TableHead className={cn(head, 'w-[120px]')}>Status</TableHead>
            <TableHead className={cn(head, 'w-[100px]')}>Pass</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && rows.length === 0 && (
            <>
              {Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={`skeleton-${i}`} className="hover:bg-transparent">
                  <TableCell className="px-3 py-2">
                    <div className="portal-skeleton size-4 rounded" />
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <div className="space-y-1.5">
                      <div className="portal-skeleton h-3.5 w-2/5 rounded" />
                      <div className="portal-skeleton h-2.5 w-1/4 rounded" />
                    </div>
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <div className="portal-skeleton h-3 w-24 rounded" />
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <div className="portal-skeleton h-3 w-12 rounded" />
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <div className="portal-skeleton h-3 w-20 rounded" />
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <div className="portal-skeleton h-3 w-12 rounded" />
                  </TableCell>
                </TableRow>
              ))}
            </>
          )}
          {!loading && rows.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={6} className="px-6 py-16">
                <div className="flex flex-col items-center gap-3 text-center">
                  <Inbox className="size-6 text-muted-foreground/60" aria-hidden />
                  <div>
                    <p className="text-sm font-medium">{emptyText}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Try adjusting your filters or search.
                    </p>
                  </div>
                </div>
              </TableCell>
            </TableRow>
          )}
          {rows.map((row) => (
            <VisitorTableRow
              key={row.visitor_id}
              row={row}
              buildingId={buildingId}
              selected={selectedId === row.visitor_id}
              checked={selectedIds.has(row.visitor_id)}
              onSelect={onSelect}
              onToggleCheck={toggleSelect}
              onAssignPass={onAssignPass}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function VisitorList({
  rows,
  loading,
  buildingId,
  selectedId,
  setSelectedId,
  selectedIds,
  setSelectedIds,
  onAssignPass,
  emptyText,
}: {
  rows: RowT[];
  loading: boolean;
  buildingId: string | null;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  onAssignPass: (row: RowT) => void;
  emptyText: string;
}) {
  const onSelect = useCallback((id: string) => setSelectedId(id), [setSelectedId]);
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
    if (selectedIds.size === rows.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(rows.map((r) => r.visitor_id)));
  };

  return (
    <div className="mx-6 rounded-md border">
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur-sm">
        <div className="w-4 shrink-0">
          <Checkbox
            checked={rows.length > 0 && selectedIds.size === rows.length}
            onCheckedChange={toggleSelectAll}
          />
        </div>
        <span className="w-14 shrink-0">Time</span>
        <span className="flex-1 min-w-0">Visitor / host</span>
        <span className="hidden w-24 shrink-0 sm:block">Pass</span>
        <span className="w-24 shrink-0 text-right">Status</span>
      </div>

      {loading && rows.length === 0 && (
        <div className="divide-y">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={`skeleton-${i}`} className="flex items-center gap-3 px-3 py-2">
              <div className="portal-skeleton size-4 shrink-0 rounded" />
              <div className="portal-skeleton h-3 w-12 shrink-0 rounded" />
              <div className="flex-1 space-y-1.5">
                <div className="portal-skeleton h-3.5 w-2/5 rounded" />
                <div className="portal-skeleton h-2.5 w-1/4 rounded" />
              </div>
              <div className="portal-skeleton h-3 w-16 shrink-0 rounded" />
              <div className="portal-skeleton h-3 w-16 shrink-0 rounded" />
            </div>
          ))}
        </div>
      )}
      {!loading && rows.length === 0 && (
        <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <Inbox className="size-6 text-muted-foreground/60" aria-hidden />
          <div>
            <p className="text-sm font-medium">{emptyText}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Try adjusting your filters or search.
            </p>
          </div>
        </div>
      )}

      <div className="divide-y">
        {rows.map((row) => (
          <VisitorContextMenu
            key={row.visitor_id}
            row={row}
            buildingId={buildingId}
            onOpenDetail={onSelect}
            onAssignPass={onAssignPass}
          >
            {(triggerProps, { open: menuOpen }) => (
              <div {...triggerProps}>
                <VisitorListRow
                  row={row}
                  selected={selectedId === row.visitor_id}
                  checked={selectedIds.has(row.visitor_id)}
                  menuOpen={menuOpen}
                  onSelect={onSelect}
                  onToggleCheck={toggleSelect}
                />
              </div>
            )}
          </VisitorContextMenu>
        ))}
      </div>
    </div>
  );
}

function DeskVisitorsInner() {
  const { buildingId, buildings, loading: buildingsLoading } = useReceptionBuilding();
  const filters = useVisitorFilters();
  const { raw, patch, activeCount, clearAll } = filters;

  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('id');
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [view, setViewState] = useState<ViewMode>(readStoredView);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [assignPassRow, setAssignPassRow] = useState<RowT | null>(null);
  const [searchInput, setSearchInput] = useState(raw.q);

  const setView = (v: ViewMode) => {
    setViewState(v);
    window.localStorage.setItem(VIEW_STORAGE_KEY, v);
  };

  // Mirror the URL ?q= → local input so back/forward sync.
  useEffect(() => setSearchInput(raw.q), [raw.q]);
  // Push debounced changes back to the URL.
  useEffect(() => {
    if (searchInput === raw.q) return;
    const handle = window.setTimeout(() => {
      filters.patch({ q: searchInput || null });
    }, 200);
    return () => window.clearTimeout(handle);
  }, [searchInput, raw.q, filters]);

  const debouncedSearch = useDebouncedValue(searchInput, 200);
  const isSearching = debouncedSearch.trim().length > 0;

  const activeView: VisitorViewId = (raw.view ?? 'today') as VisitorViewId;

  // Source query depends on the active view. We don't have a general
  // /visitors list endpoint, so each view picks the closest backend
  // query and we filter client-side from there.
  const today = useReceptionToday(activeView === 'today' || activeView === 'expected' || activeView === 'arrived' || activeView === 'all' || activeView === 'recent' ? buildingId : null);
  const yesterday = useReceptionYesterday(activeView === 'loose_ends' ? buildingId : null);
  const deskLens = useDeskLens();
  const { data: searchResults, isFetching: searchFetching } = useReceptionSearch(
    isSearching ? buildingId : null,
    debouncedSearch,
  );

  // Resolve raw rows for the active view.
  const sourceRows: RowT[] = useMemo(() => {
    if (activeView === 'pending_approval') {
      // The desk-lens payload's `pending_approval` is a different row
      // shape (DeskLensRow); project to ReceptionVisitorRow so the
      // table cell helpers work uniformly.
      return (deskLens.data?.pending_approval ?? []).map((r) => ({
        visitor_id: r.id,
        first_name: r.first_name,
        last_name: r.last_name,
        company: r.company,
        primary_host_first_name: null,
        primary_host_last_name: null,
        expected_at: r.expected_at,
        arrived_at: r.arrived_at,
        status: r.status as RowT['status'],
        visitor_pass_id: null,
        pass_number: null,
        visitor_type_id: r.visitor_type_id,
      }));
    }
    if (activeView === 'loose_ends') {
      // The yesterday endpoint surfaces unreturned passes + bounces, not
      // visitor rows directly. We synthesise a visitor-shaped row for
      // the auto-checked-out summary plus the bounce + pass entries.
      // Today's exemption: this is a v1 best-effort; the dedicated
      // /reception/yesterday tile in the previous workspace had richer
      // affordances. Treated as scoped tech debt — listed in
      // visitors-v1-tech-debt.md as a follow-up.
      const passes = yesterday.data?.unreturned_passes ?? [];
      // Build placeholder rows so the table renders something
      // operational; users still get the count via the section header.
      return passes.map((p) => ({
        visitor_id: p.id,
        first_name: 'Pass',
        last_name: `#${p.pass_number}`,
        company: p.notes,
        primary_host_first_name: null,
        primary_host_last_name: null,
        expected_at: null,
        arrived_at: p.last_assigned_at,
        status: 'checked_out' as const,
        visitor_pass_id: p.id,
        pass_number: p.pass_number,
        visitor_type_id: null,
      }));
    }
    return flattenToday(today.data);
  }, [activeView, today.data, yesterday.data, deskLens.data]);

  // Filter the source rows against the URL filters.
  const filteredRows: RowT[] = useMemo(() => {
    let rows = sourceRows;
    if (raw.status.length > 0) {
      const statusSet = new Set(raw.status);
      rows = rows.filter((r) => statusSet.has(r.status));
    }
    if (raw.date) {
      rows = rows.filter((r) => visitorDateMatches(raw.date, r.expected_at ?? r.arrived_at));
    }
    if (raw.visitorType) {
      rows = rows.filter((r) => r.visitor_type_id === raw.visitorType);
    }
    if (raw.host) {
      // Host filter expects a person id; we don't have it on the row.
      // No-op for v1 — hidden behind the chip until a richer list
      // endpoint surfaces host_person_id.
    }
    return rows;
  }, [sourceRows, raw.status, raw.date, raw.visitorType, raw.host]);

  const isLoading =
    (activeView === 'pending_approval' ? deskLens.isLoading : false) ||
    (activeView === 'loose_ends' ? yesterday.isLoading : false) ||
    (['today', 'expected', 'arrived', 'all', 'recent'].includes(activeView) ? today.isLoading : false);

  const isError =
    (activeView === 'pending_approval' ? deskLens.isError : false) ||
    (activeView === 'loose_ends' ? yesterday.isError : false) ||
    (['today', 'expected', 'arrived', 'all', 'recent'].includes(activeView) ? today.isError : false);

  const activeViewLabel =
    raw.view ? visitorViewPresets[raw.view]?.label ?? null : visitorViewPresets.today.label;

  const onAssignPass = useCallback((row: RowT) => setAssignPassRow(row), []);

  // No buildings in scope → permission-blocked empty state.
  if (!buildingsLoading && buildings.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <Inbox className="mx-auto size-10 text-muted-foreground" aria-hidden />
        <h2 className="mt-3 text-lg font-medium">No buildings in scope</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          You don’t have visitor desk access at any building. Ask an admin to
          extend your location grants.
        </p>
      </div>
    );
  }

  const ToolbarAndList = (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-6 py-4 shrink-0">
        {activeViewLabel && (
          <Badge variant="secondary" className="h-7 gap-1 text-xs font-medium">
            {activeViewLabel}
          </Badge>
        )}
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search visitors, hosts, companies…"
            className="pl-9"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            autoFocus
          />
          {/* Search results overlay — anchored to the input. The bucket
              list stays visible behind it (fix point from slice 7). */}
          {isSearching && (
            <div
              role="listbox"
              className="absolute inset-x-0 top-full z-30 mt-2 max-h-[60vh] divide-y overflow-y-auto rounded-lg border bg-popover shadow-md"
            >
              {searchFetching && (searchResults?.length ?? 0) === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Searching…
                </div>
              ) : (searchResults?.length ?? 0) === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No matches.
                </div>
              ) : (
                (searchResults ?? []).map((row) => (
                  <button
                    key={row.visitor_id}
                    type="button"
                    onClick={() => {
                      setSelectedId(row.visitor_id);
                      setSearchInput('');
                    }}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-accent"
                  >
                    <span className="w-14 shrink-0 text-xs tabular-nums text-muted-foreground">
                      {row.expected_at ? formatTimeShort(row.expected_at) : '—'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {formatReceptionRowName(row)}
                      </span>
                      {formatPrimaryHost(row) && (
                        <span className="block truncate text-xs text-muted-foreground">
                          Host: {formatPrimaryHost(row)}
                        </span>
                      )}
                    </span>
                    <VisitorStatusBadge status={row.status} />
                  </button>
                ))
              )}
            </div>
          )}
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
              <X className="size-4" />
              Clear selection
            </Button>
          </div>
        ) : (
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {filteredRows.length} visitor{filteredRows.length !== 1 ? 's' : ''}
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
                <TableIcon className="size-4" />
              </ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label="List view" className="h-8 px-2">
                <LayoutList className="size-4" />
              </ToggleGroupItem>
            </ToggleGroup>
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <Plus className="size-4" /> Invite
            </Button>
          </div>
        )}
      </div>

      <VisitorFilterBar
        raw={raw}
        patch={patch}
        activeCount={activeCount}
        onClearAll={clearAll}
      />

      {isError && !isLoading && (
        <div className="mx-6 mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          Couldn’t load visitors. Refresh to retry.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto overscroll-contain pb-4">
        {view === 'list' ? (
          <VisitorList
            rows={filteredRows}
            loading={isLoading}
            buildingId={buildingId}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            selectedIds={selectedIds}
            setSelectedIds={setSelectedIds}
            onAssignPass={onAssignPass}
            emptyText={emptyTextFor(activeView)}
          />
        ) : (
          <VisitorTable
            rows={filteredRows}
            loading={isLoading}
            buildingId={buildingId}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            selectedIds={selectedIds}
            setSelectedIds={setSelectedIds}
            onAssignPass={onAssignPass}
            emptyText={emptyTextFor(activeView)}
          />
        )}
      </div>
    </div>
  );

  return (
    <>
      <Group orientation="horizontal" style={{ height: '100%' }}>
        {selectedId ? (
          <>
            <Panel id="list" defaultSize="55%" className="relative">
              {ToolbarAndList}
            </Panel>
            <Separator />
            <Panel id="detail" defaultSize="45%" className="relative">
              <div className="absolute inset-0 overflow-auto overscroll-contain border-l">
                <VisitorDetail
                  visitorId={selectedId}
                  buildingId={buildingId}
                  onClose={() => setSelectedId(null)}
                  onAssignPass={() => {
                    const found = filteredRows.find((r) => r.visitor_id === selectedId) ?? null;
                    if (found) setAssignPassRow(found);
                  }}
                />
              </div>
            </Panel>
          </>
        ) : (
          <Panel id="list" className="relative">
            {ToolbarAndList}
          </Panel>
        )}
      </Group>

      {assignPassRow && (
        <AssignPassDialog
          open
          onOpenChange={(open) => !open && setAssignPassRow(null)}
          buildingId={buildingId}
          visitorId={assignPassRow.visitor_id}
          visitorLabel={formatReceptionRowName(assignPassRow)}
        />
      )}

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle>Invite a visitor</DialogTitle>
          </DialogHeader>
          <VisitorInviteForm
            mode="standalone"
            defaults={{ building_id: buildingId ?? undefined }}
            onSuccess={(visitorId) => {
              setInviteOpen(false);
              setSelectedId(visitorId);
              toastCreated('visitor invitation', {
                onView: () => setSelectedId(visitorId),
              });
            }}
            onCancel={() => setInviteOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function emptyTextFor(view: VisitorViewId): string {
  switch (view) {
    case 'today':
      return 'No visitors today.';
    case 'expected':
      return 'Nothing on the books.';
    case 'arrived':
      return 'No visitors on site.';
    case 'pending_approval':
      return 'No pending approvals.';
    case 'loose_ends':
      return 'No loose ends from yesterday.';
    case 'all':
      return 'No visitors found.';
    case 'recent':
      return 'Nothing recent.';
    default:
      return 'No visitors found.';
  }
}

export function DeskVisitorsPage() {
  // The page consumes per-building queries via `useReceptionBuilding`,
  // so the provider has to wrap the inner component. Building selection
  // is sticky in localStorage + reflected in the URL — see the context
  // implementation under `components/desk/desk-building-context.tsx`.
  return (
    <ReceptionBuildingProvider>
      <DeskVisitorsInner />
    </ReceptionBuildingProvider>
  );
}
