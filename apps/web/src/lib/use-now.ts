import { useEffect, useState } from 'react';

/**
 * Returns the current time, ticking on a fixed interval. Used by SLA
 * progress indicators and other "minutes-since" rendering that should
 * stay live without forcing re-fetches.
 *
 * Default interval (30s) is a reasonable compromise: SLA breaches are
 * typically measured in hours so per-second precision is wasteful, and
 * re-rendering the whole detail page every second is undesirable.
 */
export function useNow(intervalMs: number = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
