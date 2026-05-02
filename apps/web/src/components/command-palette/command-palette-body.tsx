import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Box,
  CalendarClock,
  CalendarDays,
  History,
  MapPin,
  Package,
  Search as SearchIcon,
  Store,
  Ticket,
  User,
  UserCheck,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { Badge } from '@/components/ui/badge';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import { useAuth } from '@/providers/auth-provider';
import { formatRelativeTime } from '@/lib/format';
import { useSearch, type SearchHit, type SearchKind } from '@/api/search';
import {
  paletteActions,
  paletteRoutes,
  visibleEntries,
  type PaletteEntry,
  type RouteRoleScope,
} from '@/lib/command-palette/routes';
import {
  useRecents,
  useRecentQueries,
  type RecentEntry,
} from '@/lib/command-palette/recent';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type ResolvedHref = (id: string, ctx: { scope: RouteRoleScope }) => string;

// Stable empty-groups fallback. `data?.groups ?? {}` would create a fresh
// object literal on every render — the partition memo below treats the
// fallback as part of its dep set and would recompute unnecessarily. A
// module-level constant means undefined data → identical reference.
const EMPTY_GROUPS: Partial<Record<SearchKind, SearchHit[]>> = {};

// Backend types we ever ask the search RPC for. The synthetic 'visitor'
// kind is render-only — it would be ignored or rejected if we sent it
// to /search. We keep the user-visible `SearchKind` union with 'visitor'
// in the search api to label render groups (and to type partition
// outputs) but downcast at the call site to `BackendSearchKind` when
// we hit the wire.
type BackendSearchKind = Exclude<SearchKind, 'visitor'>;

const KIND_META: Record<
  SearchKind,
  { label: string; singular: string; icon: LucideIcon; href: ResolvedHref; listHref?: (q: string) => string }
> = {
  ticket: {
    label: 'Tickets',
    singular: 'ticket',
    icon: Ticket,
    href: (id, { scope }) =>
      scope === 'public' ? `/portal/requests/${id}` : `/desk/tickets/${id}`,
    listHref: (q) => `/desk/tickets?q=${encodeURIComponent(q)}`,
  },
  person: {
    label: 'People',
    singular: 'person',
    icon: User,
    href: (id) => `/admin/persons/${id}`,
    listHref: (q) => `/admin/persons?q=${encodeURIComponent(q)}`,
  },
  // Synthetic kind — the search SQL groups visitors under `person`, but
  // the palette splits them out so they render under a "Visitors"
  // heading. Per-row routing is handled by `resolveHitPath` below
  // (which is the source of truth for the visitor → URL mapping); the
  // entry here only owns the icon + label + list-fallback URL.
  visitor: {
    label: 'Visitors',
    singular: 'visitor',
    icon: UserCheck,
    // Never invoked — resolveHitPath handles visitor routing. Returning
    // empty stays harmless if a future change accidentally calls it.
    href: () => '',
    listHref: (q) => `/desk/visitors?q=${encodeURIComponent(q)}`,
  },
  space: {
    label: 'Locations',
    singular: 'location',
    icon: MapPin,
    href: (id) => `/admin/locations/${id}`,
    listHref: (q) => `/admin/locations?q=${encodeURIComponent(q)}`,
  },
  location: {
    label: 'Locations',
    singular: 'location',
    icon: MapPin,
    href: (id) => `/admin/locations/${id}`,
  },
  room: {
    label: 'Rooms',
    singular: 'room',
    icon: CalendarDays,
    href: (id) => `/admin/locations/${id}`,
    listHref: (q) => `/portal/rooms?q=${encodeURIComponent(q)}`,
  },
  asset: {
    label: 'Assets',
    singular: 'asset',
    icon: Package,
    href: (id) => `/admin/assets/${id}`,
    listHref: (q) => `/admin/assets?q=${encodeURIComponent(q)}`,
  },
  vendor: {
    label: 'Vendors',
    singular: 'vendor',
    icon: Store,
    href: (id) => `/admin/vendors/${id}`,
    listHref: (q) => `/admin/vendors?q=${encodeURIComponent(q)}`,
  },
  team: {
    label: 'Teams',
    singular: 'team',
    icon: Users,
    href: (id) => `/admin/teams/${id}`,
    listHref: (q) => `/admin/teams?q=${encodeURIComponent(q)}`,
  },
  request_type: {
    label: 'Request types',
    singular: 'request type',
    icon: Box,
    href: (id) => `/admin/request-types/${id}`,
    listHref: (q) => `/admin/request-types?q=${encodeURIComponent(q)}`,
  },
  reservation: {
    label: 'Bookings',
    singular: 'booking',
    icon: CalendarClock,
    href: (id, { scope }) =>
      scope === 'public' ? `/portal/me/bookings/${id}` : `/desk/bookings/${id}`,
    listHref: (q) => `/desk/bookings?q=${encodeURIComponent(q)}`,
  },
};

const PER_TYPE_LIMIT = 4;

// Visitors render before persons so a "james doe" search lands on the
// visitor surface, not the /admin/persons row. The synthetic 'visitor'
// kind is materialised in the body below by partitioning person hits.
const RESULT_KIND_ORDER: SearchKind[] = [
  'ticket',
  'visitor',
  'person',
  'reservation',
  'room',
  'space',
  'asset',
  'vendor',
  'team',
  'request_type',
];

// ⌘1-9 maps to a scope. Index 8 (⌘9) resets to "all".
const DIGIT_SCOPE: Array<SearchKind[] | 'pages' | null> = [
  ['ticket'],
  ['person'],
  ['room', 'space', 'location'],
  ['asset'],
  ['vendor'],
  ['team'],
  ['request_type'],
  'pages',
  null,
];
const DIGIT_LABEL: string[] = [
  'Tickets',
  'People',
  'Locations',
  'Assets',
  'Vendors',
  'Teams',
  'Request types',
  'Pages',
  'All',
];

const HUMAN_LABEL: Record<string, string> = {
  site: 'Site',
  building: 'Building',
  floor: 'Floor',
  room: 'Room',
  desk: 'Desk',
  meeting_room: 'Meeting room',
  common_area: 'Common area',
  storage_room: 'Storage room',
  technical_room: 'Technical room',
  parking_space: 'Parking space',
  fixed: 'Fixed asset',
  personal: 'Personal asset',
  pooled: 'Pooled asset',
  employee: 'Employee',
  visitor: 'Visitor',
  contractor: 'Contractor',
  vendor_contact: 'Vendor contact',
  temporary_worker: 'Temporary worker',
};

function humaniseSubtitle(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .split(' · ')
    .map((part) => HUMAN_LABEL[part] ?? part)
    .join(' · ');
}

/**
 * Resolve the navigation target for a search hit.
 *
 * Kept as a single function so the row click handler and the row's
 * `data-href` (used for ⌘+Enter open-in-new-tab) stay in lock-step. The
 * previous duplicate `if (hit.kind === 'visitor') …` branch in two call
 * sites kept drifting whenever the visitor routing rules changed.
 *
 * Visitor routing rationale:
 *   - The synthetic `visitor` kind is materialised from a `person` hit
 *     whose `extra.type === 'visitor'`. The hit's `id` is a `persons.id`,
 *     NOT a `visitors.id`.
 *   - When the backend's LATERAL lookup found a recent visit row, the
 *     hit carries `extra.latest_visitor_id` and we deep-link to the
 *     visitor detail page (the right surface for "find this visitor").
 *   - When NO visit row exists yet (visitor person without any visits),
 *     we route to `/admin/persons/<id>` instead. That's the truthful
 *     target for the row — it's a person record, full stop. The previous
 *     fallback to `/desk/visitors?q=<name>` lied: it landed reception on
 *     a building-filtered table that often didn't contain the visitor,
 *     producing an empty-table mystery.
 */
function resolveHitPath(hit: SearchHit, scope: RouteRoleScope): string {
  if (hit.kind === 'visitor') {
    const visitorId = hit.extra?.latest_visitor_id;
    if (typeof visitorId === 'string' && visitorId.length > 0) {
      return `/desk/visitors/${visitorId}`;
    }
    // No visit row yet — `hit.id` is a persons.id. The persons row is
    // the truthful target for a visitor-typed person without any visit.
    return `/admin/persons/${hit.id}`;
  }
  return KIND_META[hit.kind].href(hit.id, { scope });
}

const STATUS_TONE: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  new: 'default',
  assigned: 'default',
  in_progress: 'default',
  waiting: 'secondary',
  resolved: 'outline',
  closed: 'outline',
};

// ---------------------------------------------------------------------------
// Prefix syntax
// ---------------------------------------------------------------------------

interface ParsedQuery {
  text: string;
  scope: SearchKind[] | null;
  pagesOnly: boolean;
  scopeLabel: string | null;
}

function parsePrefix(raw: string): ParsedQuery {
  const t = raw.trimStart();
  if (t.startsWith('@')) {
    return { text: t.slice(1).trim(), scope: ['person'], pagesOnly: false, scopeLabel: 'People' };
  }
  if (t.startsWith('#')) {
    return {
      text: t.slice(1).trim(),
      scope: ['room', 'space', 'location'],
      pagesOnly: false,
      scopeLabel: 'Locations',
    };
  }
  if (t.startsWith('>')) {
    return { text: t.slice(1).trim(), scope: [], pagesOnly: true, scopeLabel: 'Pages' };
  }
  return { text: t.trim(), scope: null, pagesOnly: false, scopeLabel: null };
}

// ---------------------------------------------------------------------------

export interface CommandPaletteBodyProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

export function CommandPaletteBody({ open, onOpenChange }: CommandPaletteBodyProps) {
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const { recents, push: pushRecent, drop: dropRecent, clear: clearRecents } = useRecents();
  const { queries: recentQueries, push: pushRecentQuery } = useRecentQueries();

  const [rawQuery, setRawQuery] = useState('');
  const [debouncedRaw, setDebouncedRaw] = useState('');
  // ⌘1-9 sets this; clears when user types or backspaces or palette closes.
  const [scopeOverride, setScopeOverride] = useState<SearchKind[] | 'pages' | null>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedRaw(rawQuery), 150);
    return () => window.clearTimeout(handle);
  }, [rawQuery]);

  // Reset all transient state when palette closes.
  useEffect(() => {
    if (!open) {
      const t = window.setTimeout(() => {
        setRawQuery('');
        setDebouncedRaw('');
        setScopeOverride(null);
      }, 200);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  const parsed = useMemo(() => parsePrefix(debouncedRaw), [debouncedRaw]);
  const liveParsed = useMemo(() => parsePrefix(rawQuery), [rawQuery]);

  // Effective scope label for the chip — override wins over prefix.
  const effectiveScopeLabel = useMemo(() => {
    if (scopeOverride === 'pages') return 'Pages';
    if (Array.isArray(scopeOverride)) {
      const idx = DIGIT_SCOPE.findIndex(
        (s) => Array.isArray(s) && s.length === scopeOverride.length && s.every((k, i) => scopeOverride[i] === k),
      );
      return idx >= 0 ? DIGIT_LABEL[idx] : 'Filtered';
    }
    return liveParsed.scopeLabel;
  }, [scopeOverride, liveParsed.scopeLabel]);

  const scope: RouteRoleScope = useMemo(() => {
    if (hasRole('admin')) return 'admin';
    if (hasRole('agent')) return 'agent';
    return 'public';
  }, [hasRole]);

  const visibleRoutes = useMemo(() => visibleEntries(paletteRoutes, scope), [scope]);
  const visibleActions = useMemo(() => visibleEntries(paletteActions, scope), [scope]);

  const isPagesOnly = scopeOverride === 'pages' || parsed.pagesOnly;

  // Effective entity types: scopeOverride > prefix > role.
  const requestedTypes: SearchKind[] | undefined = useMemo(() => {
    if (isPagesOnly) return [];
    if (Array.isArray(scopeOverride)) return scopeOverride;
    const roleScoped: SearchKind[] | undefined =
      scope === 'public' ? ['ticket', 'space', 'room', 'request_type'] : undefined;
    if (parsed.scope) {
      if (!roleScoped) return parsed.scope;
      return parsed.scope.filter((k) => roleScoped.includes(k));
    }
    return roleScoped;
  }, [isPagesOnly, scopeOverride, parsed.scope, scope]);

  // The synthetic `visitor` kind is render-only — the backend doesn't
  // know about it. Strip it before sending to /search so a stray
  // ['visitor'] from a future scope override doesn't error the RPC.
  const backendRequestedTypes = useMemo<BackendSearchKind[] | undefined>(() => {
    if (!requestedTypes) return undefined;
    const filtered = requestedTypes.filter(
      (k): k is BackendSearchKind => k !== 'visitor',
    );
    return filtered.length > 0 ? filtered : undefined;
  }, [requestedTypes]);

  const serverQuery = isPagesOnly ? '' : parsed.text;
  const { data, isFetching, error } = useSearch(serverQuery, backendRequestedTypes);

  useEffect(() => {
    if (error) {
      // eslint-disable-next-line no-console
      console.error('[command-palette] search error', error);
    }
  }, [error]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const onSelectRoute = useCallback(
    (entry: PaletteEntry, openInNewTab = false) => {
      pushRecent({
        key: `route:${entry.path}`,
        kind: 'route',
        id: entry.path,
        title: entry.title,
        subtitle: entry.section,
        path: entry.path,
      });
      if (openInNewTab) {
        window.open(entry.path, '_blank', 'noopener');
      } else {
        navigate(entry.path);
        close();
      }
    },
    [navigate, pushRecent, close],
  );

  const onSelectHit = useCallback(
    (hit: SearchHit, openInNewTab = false) => {
      const path = resolveHitPath(hit, scope);
      pushRecent({
        key: `${hit.kind}:${hit.id}`,
        kind: hit.kind === 'location' ? 'space' : (hit.kind as RecentEntry['kind']),
        id: hit.id,
        title: hit.title,
        subtitle: hit.subtitle,
        path,
      });
      if (parsed.text) pushRecentQuery(parsed.text);
      if (openInNewTab) {
        window.open(path, '_blank', 'noopener');
      } else {
        navigate(path);
        close();
      }
    },
    [navigate, pushRecent, pushRecentQuery, close, scope, parsed.text],
  );

  const onSelectRecent = useCallback(
    (entry: RecentEntry, openInNewTab = false) => {
      if (openInNewTab) {
        window.open(entry.path, '_blank', 'noopener');
      } else {
        navigate(entry.path);
        close();
      }
    },
    [navigate, close],
  );

  const onSelectViewAll = useCallback(
    (kind: SearchKind, q: string) => {
      const meta = KIND_META[kind];
      if (!meta.listHref) return;
      pushRecentQuery(q);
      navigate(meta.listHref(q));
      close();
    },
    [navigate, pushRecentQuery, close],
  );

  // Keyboard handling on the Command root: ⌘+digit scope, ⌘/⇧+Enter new tab.
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    // ⌘1-9 / Ctrl+1-9 — set scope override.
    if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
      const idx = parseInt(event.key, 10) - 1;
      const next = DIGIT_SCOPE[idx];
      event.preventDefault();
      setScopeOverride(next);
      return;
    }
    // ⌘↵ / ⇧↵ — open focused row in new tab. cmdk's selected item carries
    // a data-href we set per row.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || event.shiftKey)) {
      const selected = event.currentTarget.querySelector<HTMLElement>('[data-selected="true"]');
      const href = selected?.dataset.href;
      if (href) {
        event.preventDefault();
        event.stopPropagation();
        window.open(href, '_blank', 'noopener');
      }
    }
  }, []);

  // Clear scope override when user starts typing — explicit prefixes /
  // free-text take over.
  const onValueChange = useCallback((next: string) => {
    setRawQuery(next);
    if (scopeOverride !== null) setScopeOverride(null);
  }, [scopeOverride]);

  const trimmed = parsed.text;
  const hasQuery = trimmed.length >= 2 || isPagesOnly;
  // Module-level fallback so undefined data doesn't churn `groups`'
  // dependency on every render.
  const rawGroups = data?.groups ?? EMPTY_GROUPS;

  // Partition the backend's `person` group so visitor-typed persons
  // ALSO appear under a synthetic 'visitor' heading.
  //
  // We surface visitor persons in BOTH groups (visitor + person), not
  // just the visitor one. Reasoning: a visitor person can also be a
  // tenant employee or have tickets/bookings under their persons.id —
  // moving the row exclusively into "Visitors" would hide the persons-
  // graph context that operators searching by name often need. The
  // cost is one extra row in a separate group; the gain is operators
  // get the full picture.
  //
  // The visitor copy carries `kind: 'visitor'` so resolveHitPath sends
  // it to /desk/visitors/<latest_visitor_id> (or /admin/persons/<id>
  // when no visit row exists). The person copy stays `kind: 'person'`
  // and routes to /admin/persons/<id> as usual.
  const groups = useMemo<Partial<Record<SearchKind, SearchHit[]>>>(() => {
    const personHits = rawGroups.person;
    if (!personHits || personHits.length === 0) return rawGroups;
    const visitors: SearchHit[] = [];
    for (const hit of personHits) {
      const t = (hit.extra?.type as string | undefined) ?? '';
      if (t === 'visitor') {
        visitors.push({ ...hit, kind: 'visitor' });
      }
    }
    if (visitors.length === 0) return rawGroups;
    // Person group keeps the original hits (visitors included). Visitor
    // group holds the duplicated, kind-flipped copies.
    return { ...rawGroups, visitor: visitors };
  }, [rawGroups]);

  // Don't double-count: visitor hits are duplicated copies of person
  // hits, so we sum the person group only (which still contains them)
  // and add every other group's count. Used downstream to gate the
  // Pages section ("show only when no entities matched").
  const entityHitCount = useMemo(() => {
    let total = 0;
    for (const [kind, hits] of Object.entries(groups)) {
      if (kind === 'visitor') continue;
      total += hits?.length ?? 0;
    }
    return total;
  }, [groups]);

  const showPages = !hasQuery || isPagesOnly || entityHitCount === 0;

  // Smart empty state for portal-scoped users hitting prefixes that don't
  // resolve in their world (e.g. @noor — persons aren't searchable for them).
  const emptyMessage = useMemo(() => {
    if (!hasQuery || !data || data.total !== 0 || isPagesOnly) return null;
    if (scope === 'public' && parsed.scope?.includes('person')) {
      return 'Portal users can only search their own org. Try without “@” to search wider.';
    }
    return `No matches for “${trimmed}”${effectiveScopeLabel ? ` in ${effectiveScopeLabel}` : ''}.`;
  }, [hasQuery, data, isPagesOnly, scope, parsed.scope, trimmed, effectiveScopeLabel]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      className="sm:max-w-2xl"
    >
      <Command
        loop
        onKeyDown={onKeyDown}
        filter={(value, search, keywords) => {
          if (value.startsWith('__server__:')) return 1;
          const parsedSearch = parsePrefix(search).text;
          const haystack = (value + ' ' + (keywords ?? []).join(' ')).toLowerCase();
          const needle = parsedSearch.toLowerCase().trim();
          if (!needle) return 1;
          return haystack.includes(needle) ? 1 : 0;
        }}
      >
        <div className="relative">
          <CommandInput
            placeholder={
              effectiveScopeLabel
                ? `Search ${effectiveScopeLabel.toLowerCase()}…`
                : 'Search tickets, people, rooms, pages… (try @ # > or ⌘1)'
            }
            value={rawQuery}
            onValueChange={onValueChange}
            aria-label="Global search"
            className={effectiveScopeLabel ? 'pr-24' : undefined}
          />
          {effectiveScopeLabel && (
            <Badge
              variant="secondary"
              className="absolute right-3 top-1/2 -translate-y-1/2 select-none text-[10px] uppercase tracking-wider transition-opacity duration-200 ease-[var(--ease-smooth)]"
            >
              {effectiveScopeLabel}
            </Badge>
          )}
        </div>

        <CommandList className="max-h-[min(480px,60vh)]">
          {emptyMessage && <CommandEmpty>{emptyMessage}</CommandEmpty>}

          {hasQuery && !isFetching && error && (
            <div className="px-3 py-3 text-xs text-destructive">
              Search failed: {error.message}. Check the console for details.
            </div>
          )}

          {/* Recents — only on empty query. Includes a Clear affordance. */}
          {!hasQuery && recents.length > 0 && (
            <RecentsGroup
              recents={recents}
              onSelect={onSelectRecent}
              onClear={clearRecents}
              onDrop={dropRecent}
            />
          )}

          {!hasQuery && recentQueries.length > 0 && (
            <CommandGroup heading="Recent searches">
              {recentQueries.map((q) => (
                <CommandItem
                  key={`q:${q}`}
                  value={`recent-query ${q}`}
                  onSelect={() => onValueChange(q)}
                  aria-label={`Recent search: ${q}`}
                >
                  <SearchIcon className="text-muted-foreground" />
                  <span className="truncate">{q}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {visibleActions.length > 0 && !hasQuery && (
            <CommandGroup heading="Actions">
              {visibleActions.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={`action ${entry.title} ${(entry.aliases ?? []).join(' ')}`}
                  data-href={entry.path}
                  onSelect={() => onSelectRoute(entry)}
                  aria-label={`Action: ${entry.title}`}
                >
                  <entry.icon />
                  <span className="truncate">{entry.title}</span>
                  <CommandShortcut>{entry.section}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {/* Skeleton during first load — shaped like the rows we'll render. */}
          {hasQuery && isFetching && !data && !isPagesOnly && (
            <CommandGroup heading="Searching…">
              {[0, 1, 2].map((i) => (
                <SkeletonRow key={i} />
              ))}
            </CommandGroup>
          )}

          {hasQuery && !isPagesOnly &&
            RESULT_KIND_ORDER.map((kind) => {
              const hits = groups[kind];
              if (!hits || hits.length === 0) return null;
              const meta = KIND_META[kind];
              const showViewAll = hits.length >= PER_TYPE_LIMIT && meta.listHref;
              return (
                <CommandGroup key={kind} heading={meta.label}>
                  {hits.map((hit) => (
                    <ResultRow
                      key={`${kind}:${hit.id}`}
                      hit={hit}
                      hrefScope={scope}
                      onSelect={onSelectHit}
                    />
                  ))}
                  {showViewAll && (
                    <CommandItem
                      value={`__viewall__:${kind}`}
                      onSelect={() => onSelectViewAll(kind, parsed.text)}
                      aria-label={`View all ${meta.label.toLowerCase()} matching ${parsed.text}`}
                      className="text-muted-foreground"
                    >
                      <ArrowRight className="opacity-60" />
                      <span className="text-xs">
                        View all {meta.label.toLowerCase()} matching “{parsed.text}”
                      </span>
                    </CommandItem>
                  )}
                </CommandGroup>
              );
            })}

          {visibleRoutes.length > 0 && showPages && (
            <>
              {hasQuery && entityHitCount > 0 ? <CommandSeparator /> : null}
              <CommandGroup heading="Pages">
                {visibleRoutes.map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={`page ${entry.title} ${(entry.aliases ?? []).join(' ')} ${entry.section} ${entry.description ?? ''}`}
                    data-href={entry.path}
                    onSelect={() => onSelectRoute(entry)}
                    aria-label={`Page: ${entry.title}`}
                  >
                    <entry.icon />
                    <span className="truncate">{entry.title}</span>
                    <CommandShortcut>{entry.section}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
        </CommandList>

        <FooterHints />
      </Command>
    </CommandDialog>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RecentsGroup({
  recents,
  onSelect,
  onClear,
  onDrop: _onDrop,
}: {
  recents: RecentEntry[];
  onSelect: (entry: RecentEntry, openInNewTab?: boolean) => void;
  onClear: () => void;
  onDrop: (key: string) => void;
}) {
  // The clear-recents control must be reachable by keyboard. cmdk strips
  // focus from non-CommandItem children inside CommandGroup heading, so
  // a `<Button onMouseDown>` in the heading was mouse-only. We render
  // the action as the LAST CommandItem in the group instead — arrow keys
  // walk into it; Enter triggers `onClear`.
  return (
    <CommandGroup heading="Recent">
      {recents.map((r) => (
        <CommandItem
          key={r.key}
          value={`recent ${r.title} ${r.subtitle ?? ''}`}
          data-href={r.path}
          onSelect={() => onSelect(r)}
          aria-label={`Recent: ${r.title}`}
        >
          <History className="text-muted-foreground" />
          <span className="truncate">{r.title}</span>
          {r.subtitle ? (
            <span className="ml-2 truncate text-xs text-muted-foreground">{r.subtitle}</span>
          ) : null}
        </CommandItem>
      ))}
      <CommandItem
        value="__clear_recents__"
        onSelect={onClear}
        aria-label="Clear recent items"
        className="text-muted-foreground"
      >
        <X className="opacity-60" />
        <span className="text-xs">Clear recent</span>
      </CommandItem>
    </CommandGroup>
  );
}

function FooterHints() {
  return (
    <div className="flex items-center gap-3 border-t px-3 py-2 text-[10px] text-muted-foreground/80">
      <span className="inline-flex items-center gap-1">
        <Kbd>↑↓</Kbd> navigate
      </span>
      <span className="inline-flex items-center gap-1">
        <Kbd>↵</Kbd> open
      </span>
      <span className="inline-flex items-center gap-1">
        <Kbd>⌘↵</Kbd> new tab
      </span>
      <span className="ml-auto inline-flex items-center gap-1">
        <Kbd>esc</Kbd> close
      </span>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-4 select-none items-center rounded border bg-muted/50 px-1 font-mono text-[9px] tracking-tight text-muted-foreground">
      {children}
    </kbd>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-2 px-2 py-2" aria-hidden>
      <div className="size-4 shrink-0 rounded bg-muted animate-pulse" />
      <div className="flex flex-1 flex-col gap-1">
        <div className="h-3 w-2/5 rounded bg-muted animate-pulse" />
        <div className="h-2 w-1/4 rounded bg-muted/70 animate-pulse" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ResultRow + HoverCard
// ---------------------------------------------------------------------------

interface ResultRowProps {
  hit: SearchHit;
  hrefScope: RouteRoleScope;
  onSelect: (hit: SearchHit, openInNewTab?: boolean) => void;
}

const ResultRow = memo(function ResultRow({ hit, hrefScope, onSelect }: ResultRowProps) {
  const meta = KIND_META[hit.kind];
  const Icon = meta.icon;
  // Visitor hits route directly to the visitor detail page (full route),
  // NOT to the embedded /desk/visitors?q=... split-view. The previous
  // search-URL fallback was bad UX: it landed reception on a building-
  // filtered table that often didn't contain the matched visitor (visitor
  // at site B, current building filter on site A → empty table; user
  // confused). The backend search RPC (migration 00274) returns
  // `latest_visitor_id` in extra for visitor-typed person hits; we use
  // that to deep-link to /desk/visitors/<visitor_id> directly. The
  // search-URL fallback only applies when the LATERAL lookup couldn't
  // find a visitors row (rare — visitor person without any visit yet).
  const visitorId =
    hit.kind === 'visitor' ? (hit.extra?.latest_visitor_id as string | null | undefined) : null;
  const path =
    hit.kind === 'visitor'
      ? visitorId
        ? `/desk/visitors/${visitorId}`
        : `/desk/visitors?q=${encodeURIComponent(hit.title)}`
      : meta.href(hit.id, { scope: hrefScope });

  const statusCategory =
    hit.kind === 'ticket' && hit.extra && typeof hit.extra.status_category === 'string'
      ? (hit.extra.status_category as string)
      : null;
  const statusTone = statusCategory ? STATUS_TONE[statusCategory] ?? 'outline' : null;

  // Right-side metadata, kind-specific.
  const rightMeta = useRightMeta(hit);

  const subtitle = humaniseSubtitle(hit.subtitle);
  const breadcrumb = hit.breadcrumb;

  const row = (
    <CommandItem
      value={`__server__:${hit.kind}:${hit.id}`}
      data-href={path}
      onSelect={() => onSelect(hit)}
      aria-label={`${meta.singular}: ${hit.title}`}
    >
      <Icon className="text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm">{hit.title}</span>
        {(subtitle || breadcrumb) && (
          <span className="truncate text-xs text-muted-foreground">
            {breadcrumb ? breadcrumb : subtitle}
          </span>
        )}
      </div>
      {statusCategory && statusTone && (
        <Badge variant={statusTone} className="ml-auto select-none text-[10px] capitalize">
          {statusCategory.replace(/_/g, ' ')}
        </Badge>
      )}
      {!statusCategory && rightMeta && (
        <span className="ml-auto select-none text-[10px] text-muted-foreground">{rightMeta}</span>
      )}
    </CommandItem>
  );

  // Hover cards only for kinds where we have meaningful extra info to show.
  const hoverContent = useHoverContent(hit);
  if (!hoverContent) return row;

  // base-ui PreviewCard substitutes the rendered element via `render`, not
  // asChild. The CommandItem stays interactive for cmdk; the hover wrapper
  // adds the popover behaviour without breaking keyboard navigation.
  return (
    <HoverCard>
      <HoverCardTrigger render={row} delay={300} closeDelay={80} />
      <HoverCardContent side="right" align="start" className="w-72 p-3 text-xs">
        {hoverContent}
      </HoverCardContent>
    </HoverCard>
  );
});

function useRightMeta(hit: SearchHit): string | null {
  if (!hit.extra) return null;
  if (hit.kind === 'asset' && typeof hit.extra.tag === 'string') {
    return hit.extra.tag;
  }
  if ((hit.kind === 'room' || hit.kind === 'space') && typeof hit.extra.capacity === 'number') {
    return `${hit.extra.capacity} seats`;
  }
  if (hit.kind === 'person' && typeof hit.extra.cost_center === 'string') {
    return hit.extra.cost_center;
  }
  return null;
}

function useHoverContent(hit: SearchHit): React.ReactNode | null {
  if (!hit.extra) return null;

  if (hit.kind === 'ticket') {
    const status = (hit.extra.status as string) ?? '—';
    const created = hit.extra.created_at as string | undefined;
    return (
      <div className="space-y-2">
        <div className="font-medium text-sm">{hit.title}</div>
        <div className="text-muted-foreground space-y-1">
          <div className="flex justify-between"><span>Status</span><span className="capitalize">{status.replace(/_/g, ' ')}</span></div>
          {created && (
            <div className="flex justify-between">
              <span>Created</span>
              <time dateTime={created}>{formatRelativeTime(created)}</time>
            </div>
          )}
          <div className="flex justify-between"><span>ID</span><code className="font-mono">{hit.id.slice(0, 8).toUpperCase()}</code></div>
        </div>
      </div>
    );
  }

  if (hit.kind === 'person') {
    const email = hit.extra.email as string | null;
    const cc = hit.extra.cost_center as string | null;
    const type = hit.extra.type as string | null;
    return (
      <div className="space-y-2">
        <div className="font-medium text-sm">{hit.title}</div>
        <div className="text-muted-foreground space-y-1">
          {email && <div>{email}</div>}
          {cc && <div>Cost center: {cc}</div>}
          {type && <div>Type: {HUMAN_LABEL[type] ?? type}</div>}
        </div>
      </div>
    );
  }

  if (hit.kind === 'room' || hit.kind === 'space') {
    const type = hit.extra.type as string | null;
    const capacity = hit.extra.capacity as number | null;
    const code = hit.extra.code as string | null;
    return (
      <div className="space-y-2">
        <div className="font-medium text-sm">{hit.title}</div>
        {hit.breadcrumb && <div className="text-[11px] text-muted-foreground">{hit.breadcrumb}</div>}
        <div className="text-muted-foreground space-y-1">
          {type && <div>Type: {HUMAN_LABEL[type] ?? type}</div>}
          {typeof capacity === 'number' && <div>Capacity: {capacity}</div>}
          {code && <div>Code: <code className="font-mono">{code}</code></div>}
        </div>
      </div>
    );
  }

  if (hit.kind === 'asset') {
    const tag = hit.extra.tag as string | null;
    const status = hit.extra.status as string | null;
    const typeName = hit.extra.asset_type_name as string | null;
    const role = hit.extra.asset_role as string | null;
    return (
      <div className="space-y-2">
        <div className="font-medium text-sm">{hit.title}</div>
        {hit.breadcrumb && <div className="text-[11px] text-muted-foreground">{hit.breadcrumb}</div>}
        <div className="text-muted-foreground space-y-1">
          {typeName && <div>Type: {typeName}</div>}
          {role && <div>Role: {HUMAN_LABEL[role] ?? role}</div>}
          {tag && <div>Tag: <code className="font-mono">{tag}</code></div>}
          {status && <div>Status: <span className="capitalize">{status.replace(/_/g, ' ')}</span></div>}
        </div>
      </div>
    );
  }

  return null;
}
