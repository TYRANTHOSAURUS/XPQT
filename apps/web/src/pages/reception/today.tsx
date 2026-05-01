/**
 * /reception/today — the 9am-rush surface.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §7.2 / §7.3
 *
 * UX rules baked in:
 *   - Search input is autofocused on mount (mandatory).
 *   - Result rows + bucketed sections share `<ReceptionVisitorRow>`.
 *   - Walk-up button is permanently visible top-right; clicking opens an
 *     inline form (NOT a modal).
 *   - Real-time refresh: today-view query refetches every 15s while open
 *     (set in `receptionTodayOptions`).
 *   - Polling vs SSE: we went with polling for v1. The SSE endpoint
 *     `/reception/host-arrivals` is host-scoped (filters by host_person_id);
 *     reception isn't necessarily a host on every visit so plumbing it in
 *     would require a tenant-wide channel. Polling at 15s covers the rush
 *     well enough; SSE is a v2 upgrade.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import {
  ChevronDown,
  ChevronRight,
  Coffee,
  Plus,
  Search,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  formatReceptionRowName,
  useMarkArrived,
  useMarkNoShow,
  useReceptionSearch,
  useReceptionToday,
  useReceptionYesterday,
  type ReceptionVisitorRow as RowT,
} from '@/api/visitors/reception';
import { useReceptionBuilding } from '@/components/reception/reception-building-context';
import { ReceptionVisitorRow } from '@/components/reception/visitor-row';
import { WalkupForm } from '@/components/reception/walkup-form';
import { AssignPassDialog } from '@/components/reception/assign-pass-dialog';
import { CheckoutDialog } from '@/components/reception/checkout-dialog';
import { toastError, toastSaved, toastSuccess } from '@/lib/toast';
import { Link } from 'react-router-dom';

export function ReceptionTodayPage() {
  const { buildingId, buildings, loading: buildingsLoading } = useReceptionBuilding();
  const { data: today, isLoading, isError } = useReceptionToday(buildingId);
  const { data: yesterday } = useReceptionYesterday(buildingId);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 200);
  const { data: searchResults, isFetching: searchFetching } = useReceptionSearch(
    buildingId,
    debouncedSearch,
  );

  const [walkupOpen, setWalkupOpen] = useState(false);
  const [onSiteExpanded, setOnSiteExpanded] = useState(false);
  const [activeRow, setActiveRow] = useState<{
    row: RowT;
    action: 'assign-pass' | 'checkout';
  } | null>(null);
  const [noShowConfirm, setNoShowConfirm] = useState<RowT | null>(null);

  const markArrived = useMarkArrived(buildingId);
  const markNoShow = useMarkNoShow(buildingId);

  // Autofocus the search input on mount + when the building changes — the
  // search bar IS the rush UX.
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    searchInputRef.current?.focus();
  }, [buildingId]);

  // Active keyboard navigation index — when search is non-empty, arrow
  // keys move through results; Enter triggers a default check-in.
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    setActiveIndex(0);
  }, [debouncedSearch]);

  const isSearching = debouncedSearch.length > 0;
  const results = useMemo(() => searchResults ?? [], [searchResults]);

  const handleCheckIn = async (row: RowT, arrivedAt?: string) => {
    try {
      await markArrived.mutateAsync({ visitorId: row.visitor_id, arrived_at: arrivedAt });
      // Silent on success — at the 9am rush 8 visitors arriving in close
      // succession would stack 8 toasts. The optimistic move from the
      // expected bucket → currently_arriving is the visible feedback.
      toastSaved('visitor', { silent: true });
    } catch (err) {
      toastError("Couldn't check the visitor in", {
        error: err,
        retry: () => handleCheckIn(row, arrivedAt),
      });
    }
  };

  const handleNoShow = async (row: RowT) => {
    try {
      await markNoShow.mutateAsync({ visitorId: row.visitor_id });
      toastSuccess(`${formatReceptionRowName(row)} marked no-show`);
    } catch (err) {
      toastError("Couldn't mark no-show", {
        error: err,
        retry: () => handleNoShow(row),
      });
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isSearching || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = results[activeIndex];
      if (row) handleCheckIn(row);
    } else if (e.key === 'Escape') {
      setSearch('');
    }
  };

  // No buildings in scope → permission-blocked empty state.
  if (!buildingsLoading && buildings.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <Users className="mx-auto size-10 text-muted-foreground" aria-hidden />
        <h2 className="mt-3 text-lg font-medium">No buildings in scope</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          You don't have reception access at any building. Ask an admin to
          extend your location grants.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      {/* Sticky header: search + walk-up */}
      <div className="sticky top-14 z-20 -mx-6 mb-6 border-b bg-background/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              ref={searchInputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search visitors, hosts, companies…"
              autoComplete="off"
              spellCheck={false}
              className="h-10 pl-9 text-base"
              aria-label="Search visitors"
              aria-autocomplete="list"
              aria-expanded={isSearching}
            />
            {/* Search results overlay — anchored to the input. The today
                buckets stay visible behind it so the receptionist never
                loses orientation while typing. Esc clears the search. */}
            {isSearching && (
              <div
                role="listbox"
                aria-label="Search results"
                className="absolute left-0 right-0 top-full z-30 mt-2 max-h-[60vh] overflow-y-auto rounded-lg border bg-popover shadow-md divide-y"
              >
                {searchFetching && results.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    Searching…
                  </div>
                ) : results.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No matches in today's list.
                  </div>
                ) : (
                  results.map((row, i) => (
                    <div
                      key={row.visitor_id}
                      role="option"
                      aria-selected={i === activeIndex}
                      className={
                        i === activeIndex ? 'bg-accent/50' : undefined
                      }
                    >
                      <ReceptionVisitorRow
                        row={row}
                        busy={
                          markArrived.isPending &&
                          markArrived.variables?.visitorId === row.visitor_id
                        }
                        onCheckIn={(at) => handleCheckIn(row, at)}
                        onCheckOut={() => setActiveRow({ row, action: 'checkout' })}
                        onAssignPass={() => setActiveRow({ row, action: 'assign-pass' })}
                        onNoShow={() => setNoShowConfirm(row)}
                      />
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          <Button onClick={() => setWalkupOpen((v) => !v)} className="h-10">
            <Plus className="size-4" aria-hidden />
            Add walk-up
          </Button>
        </div>
      </div>

      {/* Walk-up form (inline expansion). */}
      {walkupOpen && buildingId && (
        <div className="mb-6">
          <WalkupForm buildingId={buildingId} onClose={() => setWalkupOpen(false)} />
        </div>
      )}

      {/* Bucket layout — always rendered. Search results overlay above
          via the popover anchored to the input. */}
      {isLoading && (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {isError && !isLoading && (
        <div role="alert" className="text-sm text-destructive">
          Couldn't load today's visitors. Try refreshing.
        </div>
      )}

      {today && (
        <div className="flex flex-col gap-6">
          <Bucket
            title="Currently arriving"
            description="Within the last 30 minutes"
            rows={today.currently_arriving}
            emptyText="No-one has arrived yet."
            onCheckIn={handleCheckIn}
            onCheckout={(row) => setActiveRow({ row, action: 'checkout' })}
            onAssignPass={(row) => setActiveRow({ row, action: 'assign-pass' })}
            onNoShow={(row) => setNoShowConfirm(row)}
            busyVisitorId={
              markArrived.isPending ? markArrived.variables?.visitorId : undefined
            }
          />

          <Bucket
            title="Expected"
            description="Pre-registered for today"
            rows={today.expected}
            emptyText="Nothing on the books."
            onCheckIn={handleCheckIn}
            onCheckout={(row) => setActiveRow({ row, action: 'checkout' })}
            onAssignPass={(row) => setActiveRow({ row, action: 'assign-pass' })}
            onNoShow={(row) => setNoShowConfirm(row)}
            busyVisitorId={
              markArrived.isPending ? markArrived.variables?.visitorId : undefined
            }
          />

          {/* On site — collapsed by default to keep the rush surface clean. */}
          <CollapsibleBucket
            title="On site"
            description={`${today.in_meeting.length} ${
              today.in_meeting.length === 1 ? 'visitor' : 'visitors'
            } currently in meetings`}
            expanded={onSiteExpanded}
            onToggle={() => setOnSiteExpanded((v) => !v)}
          >
            {today.in_meeting.map((row) => (
              <ReceptionVisitorRow
                key={row.visitor_id}
                row={row}
                onCheckIn={() => handleCheckIn(row)}
                onCheckOut={() => setActiveRow({ row, action: 'checkout' })}
                onAssignPass={() => setActiveRow({ row, action: 'assign-pass' })}
              />
            ))}
          </CollapsibleBucket>

          {/* Yesterday's loose ends — link, not expanded. */}
          <YesterdayWidget
            autoCheckedOut={yesterday?.auto_checked_out_count ?? 0}
            unreturnedPasses={yesterday?.unreturned_passes.length ?? 0}
          />
        </div>
      )}

      {/* Modals */}
      {activeRow?.action === 'assign-pass' && (
        <AssignPassDialog
          open
          onOpenChange={(open) => !open && setActiveRow(null)}
          buildingId={buildingId}
          visitorId={activeRow.row.visitor_id}
          visitorLabel={formatReceptionRowName(activeRow.row)}
        />
      )}
      {activeRow?.action === 'checkout' && (
        <CheckoutDialog
          open
          onOpenChange={(open) => !open && setActiveRow(null)}
          buildingId={buildingId}
          visitorId={activeRow.row.visitor_id}
          visitorLabel={formatReceptionRowName(activeRow.row)}
          hasPass={Boolean(activeRow.row.visitor_pass_id)}
        />
      )}

      <ConfirmDialog
        open={noShowConfirm !== null}
        onOpenChange={(open) => !open && setNoShowConfirm(null)}
        title={
          noShowConfirm
            ? `Mark ${formatReceptionRowName(noShowConfirm)} as no-show?`
            : 'Mark no-show?'
        }
        description="The visitor record will close. The host gets a no-show notification."
        confirmLabel="Mark no-show"
        destructive
        onConfirm={async () => {
          if (noShowConfirm) {
            await handleNoShow(noShowConfirm);
            setNoShowConfirm(null);
          }
        }}
      />
    </div>
  );
}

interface BucketProps {
  title: string;
  description?: string;
  rows: RowT[];
  emptyText: string;
  onCheckIn: (row: RowT, arrivedAt?: string) => void;
  onCheckout: (row: RowT) => void;
  onAssignPass: (row: RowT) => void;
  onNoShow?: (row: RowT) => void;
  busyVisitorId?: string;
}

function Bucket({
  title,
  description,
  rows,
  emptyText,
  onCheckIn,
  onCheckout,
  onAssignPass,
  onNoShow,
  busyVisitorId,
}: BucketProps) {
  return (
    <section>
      <header className="mb-2 flex items-baseline gap-3">
        <h2 className="text-base font-medium">{title}</h2>
        {description && (
          <span className="text-xs text-muted-foreground">{description}</span>
        )}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {rows.length}
        </span>
      </header>
      {rows.length === 0 ? (
        <div className="rounded-lg border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
          <Coffee className="mx-auto mb-2 size-5 opacity-60" aria-hidden />
          {emptyText}
        </div>
      ) : (
        <div className="rounded-lg border bg-card divide-y overflow-hidden">
          {rows.map((row) => (
            <ReceptionVisitorRow
              key={row.visitor_id}
              row={row}
              busy={busyVisitorId === row.visitor_id}
              onCheckIn={(at) => onCheckIn(row, at)}
              onCheckOut={() => onCheckout(row)}
              onAssignPass={() => onAssignPass(row)}
              onNoShow={onNoShow ? () => onNoShow(row) : undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface CollapsibleBucketProps {
  title: string;
  description: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function CollapsibleBucket({
  title,
  description,
  expanded,
  onToggle,
  children,
}: CollapsibleBucketProps) {
  return (
    <section className="rounded-lg border bg-card overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
        )}
        <h2 className="text-sm font-medium">{title}</h2>
        <span className="text-xs text-muted-foreground">{description}</span>
      </button>
      {expanded && <div className="divide-y border-t">{children}</div>}
    </section>
  );
}

interface YesterdayWidgetProps {
  autoCheckedOut: number;
  unreturnedPasses: number;
}

function YesterdayWidget({ autoCheckedOut, unreturnedPasses }: YesterdayWidgetProps) {
  const total = autoCheckedOut + unreturnedPasses;
  if (total === 0) return null;
  return (
    <Link
      to="/reception/yesterday"
      className="block rounded-lg border bg-amber-50/40 px-4 py-3 hover:bg-amber-50/80 transition-colors dark:bg-amber-950/20 dark:hover:bg-amber-950/40"
    >
      <div className="flex items-center gap-3">
        <div className="flex-1 text-sm">
          <span className="font-medium">Yesterday's loose ends</span>
          <span className="text-muted-foreground">
            {' · '}
            {autoCheckedOut} auto-checked-out, {unreturnedPasses} pass
            {unreturnedPasses === 1 ? '' : 'es'} unreturned
          </span>
        </div>
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
      </div>
    </Link>
  );
}
