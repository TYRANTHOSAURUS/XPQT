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
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import {
  ChevronDown,
  ChevronRight,
  Inbox,
  KeyRound,
  LayoutList,
  Plus,
  Search,
  Table as TableIcon,
  UserPlus,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { ReceptionBuildingPicker } from '@/components/desk/desk-building-picker';
import { VisitorListRow } from '@/components/desk/visitor-list-row';
import { VisitorContextMenu } from '@/components/desk/visitor-context-menu';
import { VisitorDetail } from '@/components/desk/visitor-detail';
import { AssignPassDialog } from '@/components/desk/visitor-assign-pass-dialog';
import { CheckoutDialog } from '@/components/desk/visitor-checkout-dialog';
import { WalkupForm } from '@/components/desk/visitor-walkup-form';
import { VisitorInviteForm } from '@/components/portal/visitor-invite-form';
import {
  formatPrimaryHost,
  formatReceptionRowName,
  useMarkArrived,
  useMarkPassMissing,
  useReceptionSearch,
  useReceptionToday,
  useReceptionYesterday,
  useReturnPass,
  type ReceptionTodayView,
  type ReceptionVisitorRow as RowT,
} from '@/api/visitors/reception';
import { toastCreated, toastError, toastSaved } from '@/lib/toast';
import { useDeskLens } from '@/api/visitors/admin';
import {
  useVisitorFilters,
  visitorDateMatches,
  visitorViewPresets,
  type VisitorViewId,
} from '@/pages/desk/use-visitor-filters';
import { VisitorFilterBar } from '@/components/desk/visitor-filter-bar';
import { formatTimeShort } from '@/lib/format';

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

/** A named slice of the today view, preserving the receptionist's
 *  mental model. Each bucket is rendered as a heading TR + its rows
 *  so the table stays a single continuous body. */
interface VisitorBucket {
  id: string;
  title: string;
  description?: string;
  rows: RowT[];
  /** When true, the bucket starts collapsed. Receptionists open it on
   *  demand — the today view stays focused on what's happening *now*. */
  collapsedByDefault?: boolean;
}

const ARRIVAL_RECENT_MIN = 30; // "currently arriving" window in minutes.

function buildTodayBuckets(rows: RowT[], now: Date): VisitorBucket[] {
  const recentMs = ARRIVAL_RECENT_MIN * 60_000;
  const nowMs = now.getTime();
  const arriving: RowT[] = [];
  const expectedSoon: RowT[] = [];
  const expectedLater: RowT[] = [];
  const onSite: RowT[] = [];
  const closed: RowT[] = [];

  for (const row of rows) {
    if (row.status === 'checked_out' || row.status === 'cancelled' || row.status === 'no_show') {
      closed.push(row);
      continue;
    }
    if (row.status === 'arrived') {
      const at = row.arrived_at ? new Date(row.arrived_at).getTime() : null;
      if (at !== null && nowMs - at < recentMs) {
        arriving.push(row);
      } else {
        onSite.push(row);
      }
      continue;
    }
    if (row.status === 'in_meeting') {
      onSite.push(row);
      continue;
    }
    if (row.status === 'expected' || row.status === 'pending_approval') {
      const at = row.expected_at ? new Date(row.expected_at).getTime() : null;
      if (at !== null && at - nowMs < recentMs) {
        expectedSoon.push(row);
      } else {
        expectedLater.push(row);
      }
      continue;
    }
  }

  return [
    {
      id: 'arriving',
      title: 'Currently arriving',
      description: 'Within the last 30 minutes',
      rows: arriving,
    },
    {
      id: 'expected_soon',
      title: 'Expected next 30 min',
      rows: expectedSoon,
    },
    {
      id: 'expected_later',
      title: 'Expected later today',
      rows: expectedLater,
    },
    {
      id: 'on_site',
      title: 'On site',
      rows: onSite,
    },
    {
      id: 'closed',
      title: 'Checked out today',
      rows: closed,
      collapsedByDefault: true,
    },
  ].filter((b) => b.rows.length > 0);
}

interface VisitorTableRowProps {
  row: RowT;
  buildingId: string | null;
  selected: boolean;
  checked: boolean;
  onSelect: (id: string) => void;
  onToggleCheck: (id: string) => void;
  onAssignPass: (row: RowT) => void;
  /** See VisitorListRow — Enter on a focused row resolves to a status-
   *  aware primary action. Cmd/Ctrl+Enter still opens the detail panel. */
  onPrimaryAction: (row: RowT) => void;
}

const VisitorTableRow = memo(function VisitorTableRow({
  row,
  buildingId,
  selected,
  checked,
  onSelect,
  onToggleCheck,
  onAssignPass,
  onPrimaryAction,
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
          tabIndex={0}
          className={cn(
            'cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
            selected
              ? 'bg-primary/10 hover:bg-primary/15'
              : menuOpen
                ? 'bg-muted/60'
                : 'hover:bg-muted/40',
          )}
          style={selected ? { boxShadow: 'inset 2px 0 0 var(--primary)' } : undefined}
          onClick={() => onSelect(row.visitor_id)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter → always open detail; Enter alone → status-
            // aware primary action; Space → open detail (parity with
            // click). See VisitorListRow for the canonical mapping.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSelect(row.visitor_id);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              onPrimaryAction(row);
            } else if (e.key === ' ') {
              e.preventDefault();
              onSelect(row.visitor_id);
            }
          }}
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
  onPrimaryAction,
  buckets,
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
  onPrimaryAction: (row: RowT) => void;
  /** When provided (today view), render rows grouped by bucket with a
   *  heading TR per group. Otherwise render rows flat. */
  buckets?: VisitorBucket[];
  emptyText: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    return new Set((buckets ?? []).filter((b) => b.collapsedByDefault).map((b) => b.id));
  });
  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
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
          {!loading && buckets ? (
            buckets.map((bucket) => {
              const isCollapsed = collapsed.has(bucket.id);
              return (
                <Fragment key={bucket.id}>
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={6} className="px-3 py-2 bg-muted/20 border-b">
                      <button
                        type="button"
                        onClick={() => toggleCollapse(bucket.id)}
                        className="flex w-full items-baseline gap-3 text-left"
                      >
                        <ChevronRight
                          className={cn(
                            'size-3 text-muted-foreground transition-transform',
                            !isCollapsed && 'rotate-90',
                          )}
                          aria-hidden
                        />
                        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {bucket.title}
                        </span>
                        {bucket.description && (
                          <span className="text-xs text-muted-foreground/70">
                            {bucket.description}
                          </span>
                        )}
                        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                          {bucket.rows.length}
                        </span>
                      </button>
                    </TableCell>
                  </TableRow>
                  {!isCollapsed &&
                    bucket.rows.map((row) => (
                      <VisitorTableRow
                        key={row.visitor_id}
                        row={row}
                        buildingId={buildingId}
                        selected={selectedId === row.visitor_id}
                        checked={selectedIds.has(row.visitor_id)}
                        onSelect={onSelect}
                        onToggleCheck={toggleSelect}
                        onAssignPass={onAssignPass}
                        onPrimaryAction={onPrimaryAction}
                      />
                    ))}
                </Fragment>
              );
            })
          ) : (
            rows.map((row) => (
              <VisitorTableRow
                key={row.visitor_id}
                row={row}
                buildingId={buildingId}
                selected={selectedId === row.visitor_id}
                checked={selectedIds.has(row.visitor_id)}
                onSelect={onSelect}
                onToggleCheck={toggleSelect}
                onAssignPass={onAssignPass}
                onPrimaryAction={onPrimaryAction}
              />
            ))
          )}
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
  onPrimaryAction,
  buckets,
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
  onPrimaryAction: (row: RowT) => void;
  buckets?: VisitorBucket[];
  emptyText: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    return new Set((buckets ?? []).filter((b) => b.collapsedByDefault).map((b) => b.id));
  });
  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
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
        {!loading && buckets ? (
          buckets.map((bucket) => {
            const isCollapsed = collapsed.has(bucket.id);
            return (
              <Fragment key={bucket.id}>
                <button
                  type="button"
                  onClick={() => toggleCollapse(bucket.id)}
                  className="flex w-full items-baseline gap-3 bg-muted/20 px-3 py-2 text-left transition-colors hover:bg-muted/30"
                >
                  <ChevronRight
                    className={cn(
                      'size-3 text-muted-foreground transition-transform',
                      !isCollapsed && 'rotate-90',
                    )}
                    aria-hidden
                  />
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {bucket.title}
                  </span>
                  {bucket.description && (
                    <span className="text-xs text-muted-foreground/70">
                      {bucket.description}
                    </span>
                  )}
                  <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                    {bucket.rows.length}
                  </span>
                </button>
                {!isCollapsed &&
                  bucket.rows.map((row) => (
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
                            onPrimaryAction={onPrimaryAction}
                          />
                        </div>
                      )}
                    </VisitorContextMenu>
                  ))}
              </Fragment>
            );
          })
        ) : (
          rows.map((row) => (
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
                    onPrimaryAction={onPrimaryAction}
                  />
                </div>
              )}
            </VisitorContextMenu>
          ))
        )}
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
  const [walkupOpen, setWalkupOpen] = useState(false);
  const [assignPassRow, setAssignPassRow] = useState<RowT | null>(null);
  const [checkoutRow, setCheckoutRow] = useState<RowT | null>(null);
  const [searchInput, setSearchInput] = useState(raw.q);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const markArrived = useMarkArrived(buildingId);

  /** Status-aware primary action triggered by Enter on a focused row.
   *  Expected → mark arrived. On-site → open the checkout dialog.
   *  Otherwise fall back to opening the detail panel. */
  const handlePrimaryAction = useCallback(
    (row: RowT) => {
      if (row.status === 'expected' || row.status === 'pending_approval') {
        markArrived.mutate(
          { visitorId: row.visitor_id },
          {
            // Silent at the rush — multiple Enter presses in quick
            // succession would stack toasts. The optimistic move from
            // expected → arrived is the visible feedback.
            onSuccess: () => toastSaved('visitor', { silent: true }),
            onError: (err) =>
              toastError("Couldn't mark arrived", {
                error: err,
                retry: () => handlePrimaryAction(row),
              }),
          },
        );
        return;
      }
      if (row.status === 'arrived' || row.status === 'in_meeting') {
        setCheckoutRow(row);
        return;
      }
      // Closed / cancelled / no-show — Enter falls back to "open detail".
      setSelectedId(row.visitor_id);
    },
    [markArrived],
  );

  const setView = (v: ViewMode) => {
    setViewState(v);
    window.localStorage.setItem(VIEW_STORAGE_KEY, v);
  };

  // Focus the search field on first mount only when nothing else has
  // taken focus. Avoids stealing focus from the sidebar / detail panel
  // when the page mounts inside the desk shell.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.activeElement === document.body) {
      searchInputRef.current?.focus();
    }
  }, []);

  // Mirror the URL ?q= → local input so back/forward sync.
  useEffect(() => setSearchInput(raw.q), [raw.q]);
  // Push debounced changes back to the URL. `patch` is stable (useCallback
  // in use-visitor-filters); depending on the whole `filters` object would
  // re-fire on every parent render because the literal is reconstructed.
  useEffect(() => {
    if (searchInput === raw.q) return;
    const handle = window.setTimeout(() => {
      patch({ q: searchInput || null });
    }, 200);
    return () => window.clearTimeout(handle);
  }, [searchInput, raw.q, patch]);

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
      // Loose-ends has its own dedicated panel rendered below the
      // toolbar — it surfaces unreturned passes + bounce events with
      // pass-state mutations, not visitor rows. Returning [] here keeps
      // the visitor table empty when this view is active so the panel
      // is the only thing on screen.
      return [];
    }
    return flattenToday(today.data);
  }, [activeView, today.data, deskLens.data]);

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

  // The today preset renders bucketed sections (Currently arriving /
  // Expected next 30 min / Expected later today / On site / Checked out)
  // so the receptionist's mental model of *what's happening now* maps
  // 1:1 to the screen. Other views stay flat.
  const todayBuckets = useMemo<VisitorBucket[] | undefined>(() => {
    if (activeView !== 'today') return undefined;
    return buildTodayBuckets(filteredRows, new Date());
  }, [activeView, filteredRows]);

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
        {/* Search box — cmdk-driven so arrow keys + Enter + Escape work
            without us hand-rolling the keyboard logic. Results are
            pre-filtered server-side, so shouldFilter={false}. */}
        <Command
          shouldFilter={false}
          className="relative max-w-sm flex-1 overflow-visible bg-transparent rounded-none"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && searchInput) {
              e.preventDefault();
              setSearchInput('');
            }
          }}
        >
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              placeholder="Search visitors, hosts, companies…"
              className="pl-9"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-label="Search visitors"
            />
          </div>
          {/* Search results overlay — anchored to the input. The bucket
              list stays visible behind it. */}
          {isSearching && (
            <CommandList className="absolute inset-x-0 top-full z-30 mt-2 max-h-[60vh] overflow-y-auto rounded-lg border bg-popover shadow-md p-0">
              {searchFetching && (searchResults?.length ?? 0) === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Searching…
                </div>
              ) : (
                <>
                  <CommandEmpty>No matches.</CommandEmpty>
                  {(searchResults ?? []).map((row) => (
                    <CommandItem
                      key={row.visitor_id}
                      value={`${row.visitor_id} ${formatReceptionRowName(row)} ${formatPrimaryHost(row) ?? ''}`}
                      onSelect={() => {
                        setSelectedId(row.visitor_id);
                        setSearchInput('');
                      }}
                      className="rounded-none"
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
                    </CommandItem>
                  ))}
                </>
              )}
            </CommandList>
          )}
        </Command>

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
            {/* Multi-building tenants get a picker so reception can switch
             *  scope without leaving the desk shell. Single-building
             *  tenants see nothing here (the picker self-hides). */}
            {buildings.length > 1 && <ReceptionBuildingPicker />}
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
            {/* Split button — primary verb is Invite (most-used at most
             *  tenants); chevron pulls up the walk-up surface so the
             *  rush-time alternative is one click away. The walk-up
             *  form is rendered inline above the table (NOT a modal)
             *  so reception can batch-enter without losing the today
             *  view. */}
            <div className="inline-flex">
              <Button
                size="sm"
                className="rounded-r-none"
                onClick={() => setInviteOpen(true)}
              >
                <Plus className="size-4" /> Invite
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      size="sm"
                      className="rounded-l-none border-l border-primary-foreground/20 px-1.5"
                      aria-label="More add actions"
                    />
                  }
                >
                  <ChevronDown className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => setWalkupOpen(true)}
                    disabled={!buildingId}
                  >
                    <UserPlus /> Add walk-up
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setInviteOpen(true)}>
                    <Plus /> Invite a visitor
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}
      </div>

      <VisitorFilterBar
        raw={raw}
        patch={patch}
        activeCount={activeCount}
        onClearAll={clearAll}
      />

      {walkupOpen && buildingId && (
        <div className="mx-6 mb-3">
          <WalkupForm buildingId={buildingId} onClose={() => setWalkupOpen(false)} />
        </div>
      )}

      {isError && !isLoading && (
        <div className="mx-6 mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          Couldn’t load visitors. Refresh to retry.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto overscroll-contain pb-4">
        {activeView === 'loose_ends' ? (
          <LooseEndsPanel
            buildingId={buildingId}
            data={yesterday.data}
            isLoading={yesterday.isLoading}
          />
        ) : view === 'list' ? (
          <VisitorList
            rows={filteredRows}
            loading={isLoading}
            buildingId={buildingId}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            selectedIds={selectedIds}
            setSelectedIds={setSelectedIds}
            onAssignPass={onAssignPass}
            onPrimaryAction={handlePrimaryAction}
            buckets={todayBuckets}
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
            onPrimaryAction={handlePrimaryAction}
            buckets={todayBuckets}
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
              {/* Soft slide-in + fade when the detail panel mounts. The
                  Group itself layouts the column instantly; this wrapper
                  smooths the transition from "no selection" → "selected"
                  so the row click feels connected to the panel reveal. */}
              <div
                data-state="open"
                className={cn(
                  'absolute inset-0 overflow-auto overscroll-contain border-l',
                  'data-[state=open]:translate-x-0 data-[state=closed]:translate-x-2',
                  'data-[state=open]:opacity-100 data-[state=closed]:opacity-0',
                  'transition-[transform,opacity] duration-200 ease-[var(--ease-smooth)]',
                )}
              >
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

      {checkoutRow && (
        <CheckoutDialog
          open
          onOpenChange={(open) => !open && setCheckoutRow(null)}
          buildingId={buildingId}
          visitorId={checkoutRow.visitor_id}
          visitorLabel={formatReceptionRowName(checkoutRow)}
          hasPass={Boolean(checkoutRow.pass_number)}
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

/**
 * Yesterday's loose ends — auto-checked-out count, unreturned passes
 * with mark-returned / mark-lost actions, and bounce events.
 *
 * This is the receptionist's "what slipped through?" reconciliation
 * surface. The visitor table is intentionally empty when this view is
 * active so the panel is the entire workspace.
 */
function LooseEndsPanel({
  buildingId,
  data,
  isLoading,
}: {
  buildingId: string | null;
  data: ReturnType<typeof useReceptionYesterday>['data'];
  isLoading: boolean;
}) {
  const returnPass = useReturnPass(buildingId);
  const markPassMissing = useMarkPassMissing(buildingId);

  if (isLoading) {
    return (
      <div className="mx-6 flex flex-col gap-3">
        <div className="portal-skeleton h-16 rounded-md" />
        <div className="portal-skeleton h-32 rounded-md" />
      </div>
    );
  }

  const autoCheckedOut = data?.auto_checked_out_count ?? 0;
  const passes = data?.unreturned_passes ?? [];
  const bounces = data?.bounced_emails ?? [];
  const totalSignals = autoCheckedOut + passes.length + bounces.length;

  if (totalSignals === 0) {
    return (
      <div className="mx-6 flex flex-col items-center gap-3 rounded-md border bg-muted/20 px-6 py-16 text-center">
        <Inbox className="size-6 text-muted-foreground/60" aria-hidden />
        <div>
          <p className="text-sm font-medium">No loose ends from yesterday.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Everyone returned their pass and the autopilot stayed quiet.
          </p>
        </div>
      </div>
    );
  }

  const handleReturn = (passId: string) => {
    returnPass.mutate(
      { passId },
      {
        onSuccess: () => toastSaved('pass', { silent: true }),
        onError: (err) =>
          toastError("Couldn’t mark returned", {
            error: err,
            retry: () => handleReturn(passId),
          }),
      },
    );
  };

  const handleMarkLost = (passId: string) => {
    markPassMissing.mutate(
      { passId },
      {
        onSuccess: () => toastSaved('pass', { silent: true }),
        onError: (err) =>
          toastError("Couldn’t mark lost", {
            error: err,
            retry: () => handleMarkLost(passId),
          }),
      },
    );
  };

  return (
    <div className="mx-6 flex flex-col gap-4">
      {/* Auto-checked-out + bounce counters in a single condensed strip. */}
      {(autoCheckedOut > 0 || bounces.length > 0) && (
        <div className="flex flex-wrap gap-3">
          {autoCheckedOut > 0 && (
            <div className="flex-1 min-w-[200px] rounded-md border bg-amber-50/40 px-4 py-3 dark:bg-amber-950/20">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Auto-checked-out
              </div>
              <div className="mt-1 text-lg font-medium tabular-nums">
                {autoCheckedOut}
              </div>
              <div className="text-xs text-muted-foreground">
                Visitors closed by the nightly job because they never checked
                out manually.
              </div>
            </div>
          )}
          {bounces.length > 0 && (
            <div className="flex-1 min-w-[200px] rounded-md border bg-rose-50/40 px-4 py-3 dark:bg-rose-950/20">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Email bounces
              </div>
              <div className="mt-1 text-lg font-medium tabular-nums">
                {bounces.length}
              </div>
              <div className="text-xs text-muted-foreground">
                Invitation emails that didn’t reach the visitor — host should
                resend with a corrected address.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Unreturned passes — the actionable list. */}
      {passes.length > 0 && (
        <div className="rounded-md border">
          <div className="flex items-baseline gap-3 border-b bg-muted/30 px-4 py-2 backdrop-blur-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Unreturned passes
            </span>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {passes.length}
            </span>
          </div>
          <ul className="divide-y">
            {passes.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <KeyRound className="size-4 text-muted-foreground" aria-hidden />
                  <div className="min-w-0">
                    <div className="text-sm font-medium tabular-nums">
                      #{p.pass_number}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {p.last_assigned_at
                        ? `Last assigned ${formatTimeShort(p.last_assigned_at)}`
                        : 'Never assigned'}
                      {p.notes ? ` · ${p.notes}` : ''}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleReturn(p.id)}
                    disabled={returnPass.isPending}
                  >
                    Mark returned
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleMarkLost(p.id)}
                    disabled={markPassMissing.isPending}
                  >
                    Mark lost
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Bounce list — read-only; surfaced for awareness so reception
       *  can flag the host. No mutation here yet. */}
      {bounces.length > 0 && (
        <div className="rounded-md border">
          <div className="flex items-baseline gap-3 border-b bg-muted/30 px-4 py-2 backdrop-blur-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Bounce events
            </span>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {bounces.length}
            </span>
          </div>
          <ul className="divide-y">
            {bounces.map((b) => (
              <li
                key={`${b.visitor_id}-${b.bounced_at}`}
                className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {[b.first_name, b.last_name].filter(Boolean).join(' ').trim() ||
                      'Unnamed visitor'}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {b.email ?? 'no email on record'}
                    {b.reason ? ` · ${b.reason}` : ''}
                  </div>
                </div>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatTimeShort(b.bounced_at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
