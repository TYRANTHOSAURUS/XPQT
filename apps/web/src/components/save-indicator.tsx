import { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SaveIndicatorProps {
  /** True while a mutation is in flight. */
  isPending: boolean;
  /** Timestamp from the mutation (e.g. react-query's `submittedAt`). Changes per call. */
  submittedAt?: number;
  /** Did the most recent mutation succeed? */
  isSuccess?: boolean;
  className?: string;
}

/**
 * Subtle "Saving… / Saved" marker for auto-saving detail pages. Shows
 * "Saving…" while pending, then flashes "Saved" for 1.5s after each
 * successful mutation, then disappears. Designed to sit next to a status
 * pill or row title — not to be a full toast.
 */
export function SaveIndicator({ isPending, submittedAt, isSuccess, className }: SaveIndicatorProps) {
  const [recent, setRecent] = useState(false);

  useEffect(() => {
    if (!isPending && submittedAt && isSuccess) {
      setRecent(true);
      const t = setTimeout(() => setRecent(false), 1500);
      return () => clearTimeout(t);
    }
  }, [isPending, submittedAt, isSuccess]);

  if (isPending) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-xs text-muted-foreground',
          'animate-in fade-in duration-150',
          className,
        )}
        aria-live="polite"
      >
        <Loader2 className="size-3 animate-spin" aria-hidden />
        Saving…
      </span>
    );
  }

  if (recent) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-xs text-muted-foreground',
          'animate-in fade-in slide-in-from-bottom-0.5 duration-150',
          className,
        )}
        aria-live="polite"
      >
        <Check className="size-3 text-emerald-500" aria-hidden />
        Saved
      </span>
    );
  }

  return null;
}
