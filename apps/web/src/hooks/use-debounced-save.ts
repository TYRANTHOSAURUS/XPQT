import { useEffect, useRef } from 'react';

/**
 * Save-on-pause helper for text/number inputs in settings rows.
 *
 * - Fires `save(value)` after `delay` ms of no changes.
 * - Skips the first run (initial value coming from the server).
 * - Cancels any pending save on unmount or when `value` changes again.
 *
 * Toggles / switches should call their mutation directly on change — no
 * debounce needed.
 */
export function useDebouncedSave<T>(value: T, save: (v: T) => void, delay = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initial = useRef(true);
  const latest = useRef(save);
  latest.current = save;

  useEffect(() => {
    if (initial.current) {
      initial.current = false;
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current(value), delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, delay]);
}
