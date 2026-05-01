/**
 * Kiosk shell — `/kiosk/*`.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §8.1
 *
 * Self-contained full-viewport layout. NO portal / desk / admin / reception
 * navigation — the kiosk is its own surface with one purpose: get a single
 * visitor through check-in in under a minute.
 *
 * Responsibilities:
 *   - Pull tenant branding from kiosk session storage (set at provisioning).
 *     The kiosk runs anonymously, so we can't call `/tenants/current/branding`.
 *     Instead the admin's "Provision kiosk" flow seeds the branding hint at
 *     setup time (slice 9). When absent we fall back to neutral defaults.
 *   - Auto-lock after 30s of no interaction — return to /kiosk (idle).
 *   - Refuse to render in portrait orientation; show a "rotate device"
 *     message instead.
 *   - Geist Sans / Geist Mono everywhere (inherits global), large-text scale
 *     (min 18px, line-height 1.4).
 *
 * Auto-lock implementation:
 *   - A 30s timer reset on any pointerdown / pointermove / keydown anywhere
 *     in the layout.
 *   - On timeout we navigate to `/kiosk` if the user is anywhere else. The
 *     idle screen itself doesn't trigger the timeout (no-op when already
 *     there).
 *
 * Provisioning gate:
 *   - If localStorage has no `pq.kiosk.session` AND we're not on the setup
 *     page, redirect to `/kiosk/setup?msg=needs-provisioning`.
 */
import { useEffect, useRef } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { readKioskSession } from '@/lib/kiosk-auth';
import { flushQueue } from '@/lib/kiosk-offline-queue';

const IDLE_TIMEOUT_MS = 30_000;

export function KioskLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  // Re-read on every render — the setup page mutates this and we want the
  // gate to react immediately. The cost is a tiny localStorage read; the
  // alternative (memoised) means a freshly-provisioned kiosk would have
  // to refresh the page to leave the setup gate.
  const session = readKioskSession();
  const isSetupRoute = location.pathname.startsWith('/kiosk/setup');
  const isIdleRoute = location.pathname === '/kiosk' || location.pathname === '/kiosk/';
  const idleTimer = useRef<number | null>(null);

  // Reset on every interaction. Auto-lock cancels in-flight flows by
  // navigating back to idle.
  useEffect(() => {
    if (isIdleRoute || isSetupRoute) {
      // No auto-lock on idle or setup — there's nothing to reset to.
      return;
    }
    function reset() {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => {
        navigate('/kiosk', { replace: true });
      }, IDLE_TIMEOUT_MS);
    }
    reset();
    const evts: Array<keyof DocumentEventMap> = [
      'pointerdown',
      'pointermove',
      'keydown',
      'touchstart',
      'wheel',
    ];
    evts.forEach((e) => document.addEventListener(e, reset, { passive: true }));
    return () => {
      evts.forEach((e) => document.removeEventListener(e, reset));
      if (idleTimer.current) {
        window.clearTimeout(idleTimer.current);
        idleTimer.current = null;
      }
    };
  }, [isIdleRoute, isSetupRoute, navigate]);

  // Best-effort flush of the offline queue on every page mount + when the
  // browser reports back online.
  useEffect(() => {
    if (isSetupRoute) return;
    void flushQueue();
    function onOnline() {
      void flushQueue();
    }
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [isSetupRoute, location.pathname]);

  // Apply tenant primary color as a CSS variable so primary buttons / accent
  // marks pick it up. Falls back to the global theme primary.
  useEffect(() => {
    const color = session?.branding?.primary_color;
    if (!color) return;
    const prev = document.documentElement.style.getPropertyValue('--kiosk-primary');
    document.documentElement.style.setProperty('--kiosk-primary', color);
    return () => {
      document.documentElement.style.setProperty('--kiosk-primary', prev);
    };
  }, [session?.branding?.primary_color]);

  // Provisioning gate. Setup pages are exempt.
  if (!session && !isSetupRoute) {
    return <Navigate to="/kiosk/setup?msg=needs-provisioning" replace />;
  }

  return (
    <div className="kiosk-root fixed inset-0 flex flex-col bg-background text-foreground antialiased">
      {/* Portrait-mode block. Tablets in landscape are the design target;
          if someone mounts a portrait-locked iPad we'd rather show a
          rotation prompt than a broken-looking layout. */}
      <div className="kiosk-portrait-only fixed inset-0 z-50 hidden flex-col items-center justify-center gap-6 bg-background p-12 text-center portrait:flex">
        <RotateIcon className="size-16 text-muted-foreground" />
        <h1 className="text-3xl font-semibold">Please rotate your device</h1>
        <p className="text-lg text-muted-foreground">
          The check-in kiosk is designed for landscape view.
        </p>
      </div>

      <main className="flex flex-1 flex-col overflow-hidden text-[18px] leading-[1.4]">
        <Outlet />
      </main>
    </div>
  );
}

function RotateIcon({ className }: { className?: string }) {
  // Inline SVG so we don't depend on a specific lucide-react icon name.
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16.5 11h.5a4 4 0 0 1 0 8h-1m-9 0H5a4 4 0 0 1 0-8h.5" />
      <path d="M12 7v6" />
      <path d="m9 10 3-3 3 3" />
    </svg>
  );
}
