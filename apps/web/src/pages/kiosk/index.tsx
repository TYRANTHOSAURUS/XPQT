/**
 * /kiosk — idle / welcome screen.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §8.2
 *
 * Two big actions:
 *   1. "Have an invitation? Scan your QR" → /kiosk/qr-scan
 *   2. "No invitation? Type your name" → /kiosk/name-fallback
 *
 * Tap targets are deliberately oversized — kiosk users are standing several
 * feet from a tablet and may be wearing gloves / using a stylus. Min 64px
 * tap height per Apple HIG kiosk guidelines.
 */
import { Link } from 'react-router-dom';
import { CalendarCheck, UserPlus, Settings } from 'lucide-react';
import { readKioskSession } from '@/lib/kiosk-auth';

export function KioskIdlePage() {
  const session = readKioskSession();
  const buildingName = session?.buildingName ?? 'our office';
  const tenantName = session?.branding?.tenant_name;
  const logoUrl = session?.branding?.logo_light_url;

  return (
    <div className="kiosk-idle relative flex flex-1 flex-col items-center justify-center gap-12 p-12 portrait:hidden">
      {/* Discreet settings link in the corner — admin can re-provision
          without scrolling through tablet OS settings. */}
      <Link
        to="/kiosk/setup"
        className="absolute right-4 top-4 inline-flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground/50 hover:bg-muted hover:text-muted-foreground"
        aria-label="Kiosk settings"
      >
        <Settings className="size-5" aria-hidden="true" />
      </Link>

      <header className="flex flex-col items-center gap-4 text-center">
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={tenantName ?? 'Logo'}
            className="h-16 max-w-[280px] object-contain"
          />
        ) : null}
        <h1 className="text-balance text-5xl font-semibold tracking-tight md:text-6xl">
          Welcome to {buildingName}
        </h1>
        {tenantName ? (
          <p className="text-xl text-muted-foreground">{tenantName}</p>
        ) : null}
      </header>

      <div className="grid w-full max-w-4xl grid-cols-1 gap-6 md:grid-cols-2">
        <KioskAction
          to="/kiosk/qr-scan"
          icon={<CalendarCheck className="size-12" aria-hidden="true" />}
          title="Have an invitation?"
          subtitle="Scan your QR code"
        />
        <KioskAction
          to="/kiosk/name-fallback"
          icon={<UserPlus className="size-12" aria-hidden="true" />}
          title="No invitation?"
          subtitle="Type your name"
        />
      </div>

      <p className="text-base text-muted-foreground">
        Reception is here to help if you get stuck.
      </p>
    </div>
  );
}

function KioskAction({
  to,
  icon,
  title,
  subtitle,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <Link
      to={to}
      className="group flex min-h-[260px] flex-col items-center justify-center gap-4 rounded-2xl border-2 bg-card p-10 text-center transition-all duration-150 [transition-timing-function:var(--ease-snap)] hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px"
    >
      <span className="text-primary">{icon}</span>
      <span className="text-3xl font-semibold tracking-tight">{title}</span>
      <span className="text-xl text-muted-foreground">{subtitle}</span>
    </Link>
  );
}
