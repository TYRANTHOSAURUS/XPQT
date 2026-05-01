/**
 * /kiosk/confirmation — success screen after any check-in path.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §8.3 / §8.6
 *
 * Shows for 8 seconds then auto-redirects to /kiosk (idle). A "Done" button
 * lets the visitor advance immediately.
 *
 * The confirmation copy is identical online + offline (per spec §8.6 — we
 * don't surface the offline state to the visitor; reception sees the
 * "queued" badge instead).
 */
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

const REDIRECT_MS = 8_000;

interface ConfirmationState {
  hostFirstName: string | null;
  hasReceptionAtBuilding: boolean;
  queued: boolean;
}

export function KioskConfirmationPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? null) as ConfirmationState | null;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      navigate('/kiosk', { replace: true });
    }, REDIRECT_MS);
    return () => window.clearTimeout(timer);
  }, [navigate]);

  const subline = composeSubline(state);

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center gap-8 p-12 text-center">
      {/* Auto-dismiss progress bar at the top edge — gives the visitor a
          visual cue for how much time is left before the screen returns
          to idle. CSS-only animation; respects prefers-reduced-motion
          (clamped to 0.001ms by the global media query in index.css). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-1 origin-right bg-primary"
        style={{
          animation: `kiosk-confirmation-countdown ${REDIRECT_MS}ms linear forwards`,
        }}
      />
      <style>{`
        @keyframes kiosk-confirmation-countdown {
          from { transform: scaleX(1); }
          to   { transform: scaleX(0); }
        }
      `}</style>
      <CheckCircle2 className="size-24 text-green-600" aria-hidden="true" />
      <h1 className="text-balance text-5xl font-semibold tracking-tight">
        You're checked in
      </h1>
      <p className="text-balance text-2xl text-muted-foreground">{subline}</p>
      <div className="mt-4 flex items-center gap-3">
        <Button
          size="lg"
          className="h-14 px-8 text-lg"
          onClick={() => navigate('/kiosk', { replace: true })}
        >
          Done
        </Button>
      </div>
      <p
        className="text-base text-muted-foreground"
        aria-live="polite"
      >
        Returning to the welcome screen in a few seconds…
      </p>
    </div>
  );
}

function composeSubline(state: ConfirmationState | null): string {
  // Walk-up + offline always default to the reception line because the
  // host has just been pinged but we can't reliably set the visitor's
  // expectations about who walks out to greet them.
  if (!state || state.queued) {
    return 'Reception will be with you shortly.';
  }
  if (state.hostFirstName) {
    return `${state.hostFirstName} will meet you in the lobby shortly.`;
  }
  if (state.hasReceptionAtBuilding) {
    return 'Reception will be with you shortly.';
  }
  return 'Your host will meet you in the lobby shortly.';
}
