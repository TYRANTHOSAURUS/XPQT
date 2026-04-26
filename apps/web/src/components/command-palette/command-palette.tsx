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
  Box,
  CalendarDays,
  Clock,
  History,
  MapPin,
  Package,
  PlusCircle,
  Settings,
  Store,
  Ticket,
  User,
  Users,
  Zap,
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

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  // ⌘K / Ctrl+K — global, captured at document level so any focused control
  // (input, textarea, ContentEditable) still triggers it.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isToggle =
        (event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey);
      if (!isToggle) return;
      event.preventDefault();
      setOpen((v) => !v);
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

const KIND_META: Record<
  SearchKind,
  { label: string; icon: LucideIcon; href: (id: string) => string }
> = {
  ticket: { label: 'Tickets', icon: Ticket, href: (id) => `/desk/tickets/${id}` },
  person: { label: 'People', icon: Users, href: (id) => `/admin/persons/${id}` },
  space: { label: 'Locations', icon: MapPin, href: (id) => `/admin/locations/${id}` },
  location: { label: 'Locations', icon: MapPin, href: (id) => `/admin/locations/${id}` },
  room: { label: 'Rooms', icon: CalendarDays, href: (id) => `/portal/rooms?roomId=${id}` },
  asset: { label: 'Assets', icon: Package, href: (id) => `/admin/assets?id=${id}` },
  vendor: { label: 'Vendors', icon: Store, href: (id) => `/admin/vendors?id=${id}` },
  team: { label: 'Teams', icon: Users, href: (id) => `/admin/teams?id=${id}` },
  request_type: {
    label: 'Request types',
    icon: Box,
    href: (id) => `/admin/request-types?id=${id}`,
  },
};

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

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const { recents, push: pushRecent } = useRecents();

  const [rawQuery, setRawQuery] = useState('');
  const [query, setQuery] = useState('');

  // Debounce so the entity search RPC fires once per pause, not per keystroke.
  // The static groups (Pages, Actions, Recent) update instantly off rawQuery
  // because they're filtered locally by cmdk.
  useEffect(() => {
    const handle = window.setTimeout(() => setQuery(rawQuery.trim()), 150);
    return () => window.clearTimeout(handle);
  }, [rawQuery]);

  // Reset query when palette closes so reopening is fresh.
  useEffect(() => {
    if (!open) {
      const t = window.setTimeout(() => {
        setRawQuery('');
        setQuery('');
      }, 200);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  const scope: RouteRoleScope = useMemo(() => {
    if (hasRole('admin')) return 'admin';
    if (hasRole('agent')) return 'agent';
    return 'public';
  }, [hasRole]);

  const visibleRoutes = useMemo(() => visibleEntries(paletteRoutes, scope), [scope]);
  const visibleActions = useMemo(() => visibleEntries(paletteActions, scope), [scope]);

  // Also gate the *types* of entity we ask the server for. Pure portal users
  // get tickets + spaces + request_types only; agents and admins get all.
  const requestedTypes: SearchKind[] | undefined = useMemo(() => {
    if (scope === 'public') return ['ticket', 'space', 'room', 'request_type'];
    return undefined; // server returns all
  }, [scope]);

  const { data, isFetching } = useSearch(query, requestedTypes);

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
      const path = meta.href(hit.id);
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
    [navigate, pushRecent, close],
  );

  const onSelectRecent = useCallback(
    (entry: RecentEntry) => {
      navigate(entry.path);
      close();
    },
    [navigate, close],
  );

  const trimmed = query;
  const hasQuery = trimmed.length >= 2;
  const groups = data?.groups ?? {};

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <Command
        loop
        // Custom filter: server-matched rows (value prefix __server__) always
        // pass through with full score — they were already ranked by Postgres
        // similarity, and cmdk's substring scorer would drop fuzzy hits whose
        // titles don't literally contain the query. Static rows (Pages,
        // Actions, Recent) fall through to the default scorer.
        filter={(value, search, keywords) => {
          if (value.startsWith('__server__:')) return 1;
          const haystack = (value + ' ' + (keywords ?? []).join(' ')).toLowerCase();
          const needle = search.toLowerCase().trim();
          if (!needle) return 1;
          return haystack.includes(needle) ? 1 : 0;
        }}
      >
        <CommandInput
          placeholder="Search tickets, people, rooms, pages…"
          value={rawQuery}
          onValueChange={setRawQuery}
        />

        <CommandList>
          {!hasQuery && recents.length === 0 && visibleActions.length === 0 ? (
            <CommandEmpty>Type to search across the workspace.</CommandEmpty>
          ) : null}

          {hasQuery && !isFetching && data && data.total === 0 && (
            <CommandEmpty>No matches for “{trimmed}”.</CommandEmpty>
          )}

          {/* Recents — only on empty query */}
          {!hasQuery && recents.length > 0 && (
            <CommandGroup heading="Recent">
              {recents.map((r) => (
                <CommandItem
                  key={r.key}
                  value={`recent ${r.title} ${r.subtitle ?? ''}`}
                  onSelect={() => onSelectRecent(r)}
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

          {/* Quick actions — always visible to scope */}
          {visibleActions.length > 0 && (
            <CommandGroup heading="Actions">
              {visibleActions.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={`action ${entry.title} ${(entry.aliases ?? []).join(' ')}`}
                  onSelect={() => onSelectRoute(entry)}
                >
                  <entry.icon />
                  <span className="truncate">{entry.title}</span>
                  <CommandShortcut>{entry.section}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {/* Loading skeleton while debounced query in flight */}
          {hasQuery && isFetching && !data && (
            <CommandGroup heading="Searching…">
              {[0, 1, 2].map((i) => (
                <div key={i} className="px-2 py-1.5">
                  <Skeleton className="h-4 w-full" />
                </div>
              ))}
            </CommandGroup>
          )}

          {/* Entity groups */}
          {hasQuery &&
            RESULT_KIND_ORDER.map((kind) => {
              const hits = groups[kind];
              if (!hits || hits.length === 0) return null;
              const meta = KIND_META[kind];
              return (
                <CommandGroup key={kind} heading={meta.label}>
                  {hits.map((hit) => (
                    <ResultRow key={`${kind}:${hit.id}`} hit={hit} onSelect={onSelectHit} />
                  ))}
                </CommandGroup>
              );
            })}

          {/* Pages — always available; cmdk filters them locally on rawQuery */}
          {visibleRoutes.length > 0 && (
            <>
              {hasQuery && Object.values(groups).some((g) => g && g.length > 0) ? (
                <CommandSeparator />
              ) : null}
              <CommandGroup heading="Pages">
                {visibleRoutes.map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={`page ${entry.title} ${(entry.aliases ?? []).join(' ')} ${entry.section} ${entry.description ?? ''}`}
                    onSelect={() => onSelectRoute(entry)}
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
  return (
    <CommandItem
      // Empty value disables cmdk filtering for this row — we already filtered
      // it server-side, and we don't want cmdk to drop it on a fuzzy miss.
      value={`__server__:${hit.kind}:${hit.id}`}
      onSelect={() => onSelect(hit)}
    >
      <Icon className="text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm">{hit.title}</span>
        {(hit.subtitle || hit.breadcrumb) && (
          <span className="truncate text-xs text-muted-foreground">
            {hit.breadcrumb ? hit.breadcrumb : hit.subtitle}
          </span>
        )}
      </div>
    </CommandItem>
  );
});

// Re-export icon constants used by consumers if they need them.
export { Zap, PlusCircle, Settings, Clock, User };
