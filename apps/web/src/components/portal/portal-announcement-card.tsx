import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { usePortal } from '@/providers/portal-provider';
import { formatRelativeTime } from '@/lib/format';

const DISMISS_KEY_PREFIX = 'portal.announcement.dismissed:';

type Phase = 'idle' | 'exiting' | 'gone';

function safeStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Safari Private Mode, quota exceeded — silently degrade.
  }
}

/**
 * Dismissable announcement banner. On dismiss the card collapses
 * (height → 0, opacity → 0) instead of vanishing — masks the page jump
 * below it. Uses the grid-template-rows 1fr→0fr trick (Chrome 117+ /
 * Safari 17.4+); on older engines the element still removes, just
 * without the smooth collapse.
 */
export function PortalAnnouncementCard() {
  const { data: portal } = usePortal();
  const ann = portal?.announcement ?? null;
  const [dismissedNow, setDismissedNow] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const dismissedFromStorageRef = useRef(false);

  // Restore dismissed state when the announcement identity changes.
  // Treat a same-id+different-published_at as a fresh announcement.
  // The dep array intentionally tracks identity fields rather than `ann`
  // itself so a refetch with the same announcement doesn't reset the
  // dismissal state.
  useEffect(() => {
    if (!ann) {
      dismissedFromStorageRef.current = false;
      return;
    }
    const stored = safeStorageGet(DISMISS_KEY_PREFIX + ann.id) === '1';
    dismissedFromStorageRef.current = stored;
    setDismissedNow(false);
    setPhase('idle');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ann?.id, ann?.published_at]);

  if (!ann) return null;
  if (dismissedFromStorageRef.current && !dismissedNow) return null;
  if (phase === 'gone') return null;

  const onDismiss = () => {
    if (phase !== 'idle') return;
    // Persist immediately on click so a fast unmount (route change before
    // the exit animation finishes, browser skipping the transition under
    // reduced-motion, transitionend never firing) still durably records
    // the dismissal. The transitionend below is for visual finalisation
    // only.
    safeStorageSet(DISMISS_KEY_PREFIX + ann.id, '1');
    setDismissedNow(true);
    setPhase('exiting');
  };

  // Finalise removal when the rows transition completes (it's the longest
  // of the three properties on the collapse). Storage is already persisted
  // at click time — this is purely visual.
  const onTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>) => {
    if (phase === 'exiting' && e.propertyName === 'grid-template-rows') {
      setPhase('gone');
    }
  };

  return (
    <div
      className="portal-collapse portal-rise mb-6 md:mb-8"
      data-state={phase === 'exiting' ? 'exiting' : 'idle'}
      style={{ animationDelay: '120ms' }}
      onTransitionEnd={onTransitionEnd}
    >
      <div className="rounded-xl border border-border/70 bg-card p-4">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <div className="text-sm font-semibold">{ann.title}</div>
            <div className="mt-1 text-xs text-muted-foreground">{ann.body}</div>
            <div className="mt-2 text-[11px] text-muted-foreground">{formatRelativeTime(ann.published_at)}</div>
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={onDismiss}
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            style={{ transitionTimingFunction: 'var(--ease-portal)', transitionDuration: 'var(--dur-portal-press)' }}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
