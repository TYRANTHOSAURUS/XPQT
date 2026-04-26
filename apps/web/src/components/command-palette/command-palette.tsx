import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Box,
  CalendarDays,
  History,
  MapPin,
  Package,
  Settings,
  Store,
  Ticket,
  User,
  Users,
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
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/providers/auth-provider';
import { useSearch, type SearchHit, type SearchKind } from '@/api/search';
import {
  paletteActions,
  paletteRoutes,
  visibleEntries,
  type PaletteEntry,
  type RouteRoleScope,
} from '@/lib/command-palette/routes';
import { useRecents, type RecentEntry } from '@/lib/command-palette/recent';

interface PaletteCtx {
  open: boolean;
  setOpen: (next: boolean) => void;
  toggle: () => void;
}

const Ctx = createContext<PaletteCtx | undefined>(undefined);

/**
 * Returns true when the keyboard event is bubbling from a typed control —
 * an input, textarea, or contenteditable element. We don't want '/' to
 * hijack focus when the user is mid-edit somewhere.
 */
function isInTypedControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  // ⌘K / Ctrl+K — global, captured at document level so any focused control
  // (input, textarea, ContentEditable) still triggers it.
  // '/' is an alt-trigger, but only when nothing typed is focused.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isCmdK =
        (event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey);
      const isSlash =
        event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey;

      if (isCmdK) {
        event.preventDefault();
        setOpen((v) => !v);
        return;
      }

      if (isSlash && !isInTypedControl(event.target)) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const value = useMemo<PaletteCtx>(() => ({ open, setOpen, toggle }), [open, toggle]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <CommandPalette open={open} onOpenChange={setOpen} />
    </Ctx.Provider>
  );
}

export function useCommandPalette() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCommandPalette must be used inside <CommandPaletteProvider>');
  return ctx;
}

// ---------------------------------------------------------------------------

type ResolvedHref = (id: string, ctx: { scope: RouteRoleScope }) => string;

const KIND_META: Record<
  SearchKind,
  { label: string; singular: string; icon: LucideIcon; href: ResolvedHref; listHref?: (q: string) => string }
> = {
  ticket: {
    label: 'Tickets',
    singular: 'ticket',
    icon: Ticket,
    // Portal-only users land on the requester view; agents+ on the desk view.
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
};

// Per-type result cap as configured in the API. Used to decide whether to
// show the "View all" footer for a group.
const PER_TYPE_LIMIT = 4;

// Order in which we render result groups. Mirrors SEARCH_KIND_ORDER but is
// kept local because the palette layers Recent + Pages + Actions on top.
const RESULT_KIND_ORDER: SearchKind[] = [
  'ticket',
  'person',
  'room',
  'space',
  'asset',
  'vendor',
  'team',
  'request_type',
];

// Humanise DB enums in subtitles. Without this the user sees `meeting_room`,
// `common_area`, `personal` literally — fine for engineers, jarring for
// everyone else.
const HUMAN_LABEL: Record<string, string> = {
  // Space types
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
  // Asset roles
  fixed: 'Fixed asset',
  personal: 'Personal asset',
  pooled: 'Pooled asset',
  // Person types
  employee: 'Employee',
  visitor: 'Visitor',
  contractor: 'Contractor',
  vendor_contact: 'Vendor contact',
  temporary_worker: 'Temporary worker',
};

function humaniseSubtitle(s: string | null | undefined): string {
  if (!s) return '';
  // The subtitle may contain " · "-joined fragments (e.g. ticket "ABC123 · resolved").
  // Map each fragment through HUMAN_LABEL so single enums are pretty.
  return s
    .split(' · ')
    .map((part) => HUMAN_LABEL[part] ?? part)
    .join(' · ');
}

// Status → tone mapping for the small ticket badge. Mirrors what the desk
// uses elsewhere so the palette feels native.
const STATUS_TONE: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  new: 'default',
  assigned: 'default',
  in_progress: 'default',
  waiting: 'secondary',
  resolved: 'outline',
  closed: 'outline',
};

// ---------------------------------------------------------------------------
// Prefix syntax: @noor → People, #room → Rooms+Spaces, >page → Pages only.
// ---------------------------------------------------------------------------

interface ParsedQuery {
  /** The actual text to send to the search RPC (prefix stripped). */
  text: string;
  /** Restricted entity types when a prefix is active; null = no restriction. */
  scope: SearchKind[] | null;
  /** True when '>' is active — server skipped, only Pages/Actions render. */
  pagesOnly: boolean;
  /** Display label for the active scope chip ("People", "Rooms", "Pages"). */
  scopeLabel: string | null;
}

function parsePrefix(raw: string): ParsedQuery {
  const t = raw.trimStart();
  if (t.startsWith('@')) {
    return {
      text: t.slice(1).trim(),
      scope: ['person'],
      pagesOnly: false,
      scopeLabel: 'People',
    };
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
    return {
      text: t.slice(1).trim(),
      scope: [],
      pagesOnly: true,
      scopeLabel: 'Pages',
    };
  }
  return { text: t.trim(), scope: null, pagesOnly: false, scopeLabel: null };
}

// ---------------------------------------------------------------------------

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const { recents, push: pushRecent } = useRecents();

  const [rawQuery, setRawQuery] = useState('');
  const [debouncedRaw, setDebouncedRaw] = useState('');

  // Debounce so the entity search RPC fires once per pause, not per keystroke.
  // Static groups (Pages, Actions, Recent) update instantly off rawQuery
  // because they're filtered locally by cmdk.
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedRaw(rawQuery), 150);
    return () => window.clearTimeout(handle);
  }, [rawQuery]);

  // Reset query when palette closes so reopening is fresh.
  useEffect(() => {
    if (!open) {
      const t = window.setTimeout(() => {
        setRawQuery('');
        setDebouncedRaw('');
      }, 200);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  const parsed = useMemo(() => parsePrefix(debouncedRaw), [debouncedRaw]);
  const liveParsed = useMemo(() => parsePrefix(rawQuery), [rawQuery]);

  const scope: RouteRoleScope = useMemo(() => {
    if (hasRole('admin')) return 'admin';
    if (hasRole('agent')) return 'agent';
    return 'public';
  }, [hasRole]);

  const visibleRoutes = useMemo(() => visibleEntries(paletteRoutes, scope), [scope]);
  const visibleActions = useMemo(() => visibleEntries(paletteActions, scope), [scope]);

  // Effective entity types to query the server for: prefix-scope ∩ role-scope.
  const requestedTypes: SearchKind[] | undefined = useMemo(() => {
    if (parsed.pagesOnly) return [];
    const roleScoped: SearchKind[] | undefined =
      scope === 'public' ? ['ticket', 'space', 'room', 'request_type'] : undefined;
    if (parsed.scope) {
      if (!roleScoped) return parsed.scope;
      return parsed.scope.filter((k) => roleScoped.includes(k));
    }
    return roleScoped;
  }, [parsed, scope]);

  const serverQuery = parsed.pagesOnly ? '' : parsed.text;
  const { data, isFetching, error } = useSearch(
    serverQuery,
    requestedTypes && requestedTypes.length > 0 ? requestedTypes : undefined,
  );

  // Surface unexpected failures so empty-results aren't silent.
  useEffect(() => {
    if (error) {
      // eslint-disable-next-line no-console
      console.error('[command-palette] search error', error);
    }
  }, [error]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const onSelectRoute = useCallback(
    (entry: PaletteEntry) => {
      pushRecent({
        key: `route:${entry.path}`,
        kind: 'route',
        id: entry.path,
        title: entry.title,
        subtitle: entry.section,
        path: entry.path,
      });
      navigate(entry.path);
      close();
    },
    [navigate, pushRecent, close],
  );

  const onSelectHit = useCallback(
    (hit: SearchHit) => {
      const meta = KIND_META[hit.kind];
      const path = meta.href(hit.id, { scope });
      pushRecent({
        key: `${hit.kind}:${hit.id}`,
        kind: hit.kind === 'location' ? 'space' : (hit.kind as RecentEntry['kind']),
        id: hit.id,
        title: hit.title,
        subtitle: hit.subtitle,
        path,
      });
      navigate(path);
      close();
    },
    [navigate, pushRecent, close, scope],
  );

  const onSelectRecent = useCallback(
    (entry: RecentEntry) => {
      navigate(entry.path);
      close();
    },
    [navigate, close],
  );

  const onSelectViewAll = useCallback(
    (kind: SearchKind, q: string) => {
      const meta = KIND_META[kind];
      if (!meta.listHref) return;
      navigate(meta.listHref(q));
      close();
    },
    [navigate, close],
  );

  const trimmed = parsed.text;
  const hasQuery = trimmed.length >= 2 || parsed.pagesOnly;
  const groups = data?.groups ?? {};
  const entityHitCount = useMemo(
    () => Object.values(groups).reduce((sum, g) => sum + (g?.length ?? 0), 0),
    [groups],
  );

  // #5: Hide Pages group when entity groups have hits — entities are far
  // more likely to be the user's intent than a same-named admin route.
  // Always show Pages on empty query (so the dialog isn't bare) and when
  // user explicitly typed '>' prefix.
  const showPages =
    !hasQuery || parsed.pagesOnly || entityHitCount === 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      className="sm:max-w-2xl"
    >
      <Command
        loop
        // Custom filter: server-matched rows (value prefix __server__) always
        // pass through with full score — they were already ranked by Postgres
        // similarity. Static rows fall back to the default substring match.
        filter={(value, search, keywords) => {
          if (value.startsWith('__server__:')) return 1;
          // For static rows, use the parsed text (without prefix) so '@noor'
          // doesn't accidentally match a Pages row containing '@'.
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
              liveParsed.scopeLabel
                ? `Search ${liveParsed.scopeLabel.toLowerCase()}…`
                : 'Search tickets, people, rooms, pages… (try @ # >)'
            }
            value={rawQuery}
            onValueChange={setRawQuery}
            aria-label="Global search"
            // Reserve right-side space so the scope chip never overlaps text.
            className={liveParsed.scopeLabel ? 'pr-24' : undefined}
          />
          {liveParsed.scopeLabel && (
            <Badge
              variant="secondary"
              className="absolute right-3 top-1/2 -translate-y-1/2 select-none text-[10px] uppercase tracking-wider"
            >
              {liveParsed.scopeLabel}
            </Badge>
          )}
        </div>

        <CommandList className="max-h-[min(480px,60vh)]">
          {!hasQuery && recents.length === 0 && visibleActions.length === 0 ? (
            <CommandEmpty>Type to search across the workspace.</CommandEmpty>
          ) : null}

          {hasQuery && !isFetching && data && data.total === 0 && !parsed.pagesOnly && (
            <CommandEmpty>
              No matches for &ldquo;{trimmed}&rdquo;{liveParsed.scopeLabel ? ` in ${liveParsed.scopeLabel}` : ''}.
            </CommandEmpty>
          )}

          {hasQuery && !isFetching && error && (
            <div className="px-3 py-3 text-xs text-destructive">
              Search failed: {error.message}. Check the console for details.
            </div>
          )}

          {/* Recents — only on empty query */}
          {!hasQuery && recents.length > 0 && (
            <CommandGroup heading="Recent">
              {recents.map((r) => (
                <CommandItem
                  key={r.key}
                  value={`recent ${r.title} ${r.subtitle ?? ''}`}
                  onSelect={() => onSelectRecent(r)}
                  aria-label={`Recent: ${r.title}`}
                >
                  <History className="text-muted-foreground" />
                  <span className="truncate">{r.title}</span>
                  {r.subtitle ? (
                    <span className="ml-2 truncate text-xs text-muted-foreground">
                      {r.subtitle}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {/* Quick actions — visible to scope, hidden under entity-typing */}
          {visibleActions.length > 0 && !hasQuery && (
            <CommandGroup heading="Actions">
              {visibleActions.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={`action ${entry.title} ${(entry.aliases ?? []).join(' ')}`}
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

          {/* Loading skeleton while debounced query in flight */}
          {hasQuery && isFetching && !data && !parsed.pagesOnly && (
            <CommandGroup heading="Searching…">
              {[0, 1, 2].map((i) => (
                <div key={i} className="px-2 py-1.5">
                  <Skeleton className="h-4 w-full" />
                </div>
              ))}
            </CommandGroup>
          )}

          {/* Entity groups */}
          {hasQuery && !parsed.pagesOnly &&
            RESULT_KIND_ORDER.map((kind) => {
              const hits = groups[kind];
              if (!hits || hits.length === 0) return null;
              const meta = KIND_META[kind];
              const showViewAll = hits.length >= PER_TYPE_LIMIT && meta.listHref;
              return (
                <CommandGroup key={kind} heading={meta.label}>
                  {hits.map((hit) => (
                    <ResultRow key={`${kind}:${hit.id}`} hit={hit} onSelect={onSelectHit} />
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
                        View all {meta.label.toLowerCase()} matching &ldquo;{parsed.text}&rdquo;
                      </span>
                    </CommandItem>
                  )}
                </CommandGroup>
              );
            })}

          {/* Pages — always available; cmdk filters them locally on rawQuery */}
          {visibleRoutes.length > 0 && showPages && (
            <>
              {hasQuery && entityHitCount > 0 ? <CommandSeparator /> : null}
              <CommandGroup heading="Pages">
                {visibleRoutes.map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={`page ${entry.title} ${(entry.aliases ?? []).join(' ')} ${entry.section} ${entry.description ?? ''}`}
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
      </Command>
    </CommandDialog>
  );
}

interface ResultRowProps {
  hit: SearchHit;
  onSelect: (hit: SearchHit) => void;
}

const ResultRow = memo(function ResultRow({ hit, onSelect }: ResultRowProps) {
  const meta = KIND_META[hit.kind];
  const Icon = meta.icon;

  // Status badge for tickets — small visual cue lifted from extra.status_category.
  const statusCategory =
    hit.kind === 'ticket' && hit.extra && typeof hit.extra.status_category === 'string'
      ? (hit.extra.status_category as string)
      : null;
  const statusTone = statusCategory ? STATUS_TONE[statusCategory] ?? 'outline' : null;

  const subtitle = humaniseSubtitle(hit.subtitle);
  const breadcrumb = hit.breadcrumb;

  return (
    <CommandItem
      value={`__server__:${hit.kind}:${hit.id}`}
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
        <Badge
          variant={statusTone}
          className="ml-auto select-none text-[10px] capitalize"
        >
          {statusCategory.replace(/_/g, ' ')}
        </Badge>
      )}
    </CommandItem>
  );
});

// Re-export icons used by sidebar consumers (kept for external imports).
export { Settings, User };
