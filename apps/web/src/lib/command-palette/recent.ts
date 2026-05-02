import { useCallback, useEffect, useState } from 'react';

export interface RecentEntry {
  /** Stable identifier — `${kind}:${id}` for entities, `route:${path}` for nav. */
  key: string;
  kind: 'ticket' | 'person' | 'visitor' | 'space' | 'room' | 'asset' | 'vendor' | 'team' | 'request_type' | 'route';
  id: string;
  title: string;
  subtitle?: string | null;
  path: string;
  ts: number;
}

const STORAGE_KEY = 'cmd-palette:recent:v1';
const QUERY_STORAGE_KEY = 'cmd-palette:recent-queries:v1';
const MAX_RECENTS = 8;
const MAX_QUERIES = 5;

function readJSON<T>(key: string, isValid: (v: unknown) => v is T): T[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValid);
  } catch {
    return [];
  }
}

function writeJSON<T>(key: string, items: T[], cap: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(items.slice(0, cap)));
  } catch {
    // localStorage may be disabled or full — silently noop.
  }
}

function isRecentEntry(x: unknown): x is RecentEntry {
  return (
    !!x
    && typeof x === 'object'
    && typeof (x as RecentEntry).key === 'string'
    && typeof (x as RecentEntry).id === 'string'
    && typeof (x as RecentEntry).title === 'string'
    && typeof (x as RecentEntry).path === 'string'
  );
}

interface RecentQuery {
  q: string;
  ts: number;
}

function isRecentQuery(x: unknown): x is RecentQuery {
  return !!x && typeof x === 'object' && typeof (x as RecentQuery).q === 'string';
}

/**
 * In-memory cache + storage event sync, so multiple palette instances stay
 * in step without re-reading localStorage on every render.
 */
export function useRecents(): {
  recents: RecentEntry[];
  push: (entry: Omit<RecentEntry, 'ts'>) => void;
  /** Drop a single entry (used for ghost eviction on 404 nav). */
  drop: (key: string) => void;
  clear: () => void;
} {
  const [recents, setRecents] = useState<RecentEntry[]>(() =>
    readJSON<RecentEntry>(STORAGE_KEY, isRecentEntry),
  );

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        setRecents(readJSON<RecentEntry>(STORAGE_KEY, isRecentEntry));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const push = useCallback((entry: Omit<RecentEntry, 'ts'>) => {
    setRecents((prev) => {
      const next: RecentEntry[] = [
        { ...entry, ts: Date.now() },
        ...prev.filter((r) => r.key !== entry.key),
      ].slice(0, MAX_RECENTS);
      writeJSON(STORAGE_KEY, next, MAX_RECENTS);
      return next;
    });
  }, []);

  const drop = useCallback((key: string) => {
    setRecents((prev) => {
      const next = prev.filter((r) => r.key !== key);
      writeJSON(STORAGE_KEY, next, MAX_RECENTS);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setRecents([]);
    writeJSON(STORAGE_KEY, [], MAX_RECENTS);
  }, []);

  return { recents, push, drop, clear };
}

/**
 * Recent search queries — distinct from recent items. Pushed when the user
 * actually navigates to a hit (so we know the query was useful).
 */
export function useRecentQueries(): {
  queries: string[];
  push: (q: string) => void;
  clear: () => void;
} {
  const [items, setItems] = useState<RecentQuery[]>(() =>
    readJSON<RecentQuery>(QUERY_STORAGE_KEY, isRecentQuery),
  );

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === QUERY_STORAGE_KEY) {
        setItems(readJSON<RecentQuery>(QUERY_STORAGE_KEY, isRecentQuery));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const push = useCallback((q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) return;
    setItems((prev) => {
      const next: RecentQuery[] = [
        { q: trimmed, ts: Date.now() },
        ...prev.filter((r) => r.q !== trimmed),
      ].slice(0, MAX_QUERIES);
      writeJSON(QUERY_STORAGE_KEY, next, MAX_QUERIES);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setItems([]);
    writeJSON(QUERY_STORAGE_KEY, [], MAX_QUERIES);
  }, []);

  return { queries: items.map((x) => x.q), push, clear };
}
