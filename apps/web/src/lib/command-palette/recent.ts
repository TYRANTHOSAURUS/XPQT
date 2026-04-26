import { useCallback, useEffect, useState } from 'react';

export interface RecentEntry {
  /** Stable identifier — `${kind}:${id}` for entities, `route:${path}` for nav. */
  key: string;
  kind: 'ticket' | 'person' | 'space' | 'room' | 'asset' | 'vendor' | 'team' | 'request_type' | 'route';
  id: string;
  title: string;
  subtitle?: string | null;
  path: string;
  ts: number;
}

const STORAGE_KEY = 'cmd-palette:recent:v1';
const MAX_RECENTS = 8;

function read(): RecentEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validate shape — drop anything malformed.
    return parsed.filter(
      (x): x is RecentEntry =>
        x && typeof x.key === 'string' && typeof x.id === 'string' && typeof x.title === 'string' && typeof x.path === 'string',
    );
  } catch {
    return [];
  }
}

function write(items: RecentEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_RECENTS)));
  } catch {
    // localStorage may be disabled or full — silently noop.
  }
}

/**
 * In-memory cache + storage event sync, so multiple palette instances stay
 * in step without re-reading localStorage on every render.
 */
export function useRecents(): {
  recents: RecentEntry[];
  push: (entry: Omit<RecentEntry, 'ts'>) => void;
  clear: () => void;
} {
  const [recents, setRecents] = useState<RecentEntry[]>(() => read());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setRecents(read());
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
      write(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setRecents([]);
    write([]);
  }, []);

  return { recents, push, clear };
}
