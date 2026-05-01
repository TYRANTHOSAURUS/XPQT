/**
 * useDebouncedValue — return a debounced copy of a value that updates after
 * `delayMs` of inactivity.
 *
 * Replaces three local copies (today.tsx, name-fallback.tsx, walkup.tsx)
 * that all implemented the same useEffect+setTimeout pattern.
 */
import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
