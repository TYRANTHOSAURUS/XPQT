import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Calendar, X } from 'lucide-react';
import { useCalendarSyncMe } from '@/api/calendar-sync';

const DISMISS_KEY = 'portal.calendar-sync-nudge.dismissed';

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
 * Dismissable nudge promoting `/portal/me/calendar-sync`. Shown on the
 * portal home when the user has not yet connected an external calendar.
 *
 * Per the Requester persona JTBD: bookings happen primarily from
 * Outlook, then Teams, then mobile, then portal — in that frequency
 * order. The route exists at `/portal/me/calendar-sync` but had zero
 * discovery surface; this nudge is the lowest-cost fix.
 *
 * Renders null when:
 *  - the calendar-sync query is still loading,
 *  - the user already has a sync link (any status other than disabled),
 *  - the user previously dismissed the nudge (per-device localStorage).
 *
 * Uses the same `portal-collapse` exit pattern as the announcement card
 * for consistency. Persistence happens at click time so a fast unmount
 * doesn't strand the dismissal.
 */
export function PortalCalendarSyncNudge() {
  const { data: link, isPending } = useCalendarSyncMe();
  const [dismissedNow, setDismissedNow] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const dismissedFromStorageRef = useRef(false);

  useEffect(() => {
    dismissedFromStorageRef.current = safeStorageGet(DISMISS_KEY) === '1';
  }, []);

  // Loading: render nothing rather than a skeleton — the nudge is
  // optional content; flashing a placeholder would be louder than the
  // nudge itself.
  if (isPending) return null;

  const isConnected = link != null && link.sync_status !== 'disabled';
  if (isConnected) return null;

  if (dismissedFromStorageRef.current && !dismissedNow) return null;
  if (phase === 'gone') return null;

  const onDismiss = () => {
    if (phase !== 'idle') return;
    safeStorageSet(DISMISS_KEY, '1');
    setDismissedNow(true);
    setPhase('exiting');
  };

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
      <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4">
        <div className="flex items-start gap-3">
          <div
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-blue-500/15 text-blue-600 dark:text-blue-400"
          >
            <Calendar className="size-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">
              Book directly from Outlook
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground text-pretty">
              Connect your calendar and your Prequest bookings show up alongside your other meetings — and we pick up changes you make in Outlook.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Link
                to="/portal/me/calendar-sync"
                viewTransition
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-medium text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                style={{
                  transitionTimingFunction: 'var(--ease-portal)',
                  transitionDuration: 'var(--dur-portal-press)',
                }}
              >
                <Calendar className="size-3.5" aria-hidden />
                Connect Outlook
              </Link>
              <button
                type="button"
                onClick={onDismiss}
                className="inline-flex h-8 items-center rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                style={{
                  transitionTimingFunction: 'var(--ease-portal)',
                  transitionDuration: 'var(--dur-portal-press)',
                }}
              >
                Not now
              </button>
            </div>
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={onDismiss}
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            style={{
              transitionTimingFunction: 'var(--ease-portal)',
              transitionDuration: 'var(--dur-portal-press)',
            }}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
