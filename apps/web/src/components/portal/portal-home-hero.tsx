import { Link } from 'react-router-dom';
import { Search, ChevronDown, FileText, CalendarDays, UserPlus } from 'lucide-react';
import { usePortal } from '@/providers/portal-provider';
import { useAuth } from '@/providers/auth-provider';
import { useBranding } from '@/hooks/use-branding';
import { timeOfDayGreeting } from '@/lib/portal-greeting';
import { useCommandPalette } from '@/components/command-palette/command-palette';
import { PortalLocationSwitcher } from './portal-location-picker';

/**
 * Top-of-home hero. Three responsibilities:
 *   1. Greet the user + name the workspace.
 *   2. Surface the global ⌘K palette as a real-looking search input.
 *   3. Offer three quick actions (Submit · Book a room · Invite a visitor).
 *
 * The search "input" is a button styled to look like an input — it opens
 * the command palette so the hint and behavior actually match. There is
 * no separate ?q=... route; that was a duplicate search surface.
 */
export function PortalHomeHero() {
  const { data: portal } = usePortal();
  const auth = useAuth();
  const { branding } = useBranding();
  const { setOpen } = useCommandPalette();

  const appearance = portal?.appearance ?? null;
  const firstName = auth.person?.first_name ?? '';
  const eyebrow =
    appearance?.greeting_enabled !== false
      ? `${timeOfDayGreeting()}${firstName ? `, ${firstName}` : ''}`
      : null;
  const headline = appearance?.welcome_headline?.trim() || 'What do you need today?';
  const customSupporting = appearance?.supporting_line?.trim() || null;
  const locationName = portal?.current_location?.name ?? null;
  const canSwitchLocation = (portal?.authorized_locations.length ?? 0) > 1;

  const heroUrl = appearance?.hero_image_url ?? null;
  const primary = branding?.primary_color ?? '#6366f1';
  const accent = branding?.accent_color ?? '#ec4899';

  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  const kbdLabel = isMac ? '⌘K' : 'Ctrl+K';

  const hasImage = Boolean(heroUrl);

  const locationChip = locationName ? (
    <PortalLocationSwitcher
      align="start"
      trigger={
        <button
          type="button"
          disabled={!canSwitchLocation}
          className={
            (hasImage
              ? 'border-white/20 bg-white/10 text-white hover:bg-white/15'
              : 'border-border/70 bg-background/60 text-foreground hover:bg-background/90') +
            ' inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium' +
            ' backdrop-blur transition-[background-color,border-color]' +
            ' focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50' +
            ' disabled:opacity-90 disabled:cursor-default'
          }
          style={{ transitionTimingFunction: 'var(--ease-portal)', transitionDuration: 'var(--dur-portal-press)' }}
        >
          <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
          <span className="truncate max-w-[18ch]">{locationName}</span>
          {canSwitchLocation && <ChevronDown className="size-3 opacity-70" aria-hidden />}
        </button>
      }
    />
  ) : null;

  return (
    <section
      className="portal-rise relative overflow-hidden rounded-2xl ring-1 ring-border/50"
    >
      <div className="absolute inset-0" aria-hidden>
        {hasImage ? (
          <>
            <img
              src={heroUrl!}
              alt=""
              data-portal-fade
              data-loaded="false"
              onLoad={(e) => e.currentTarget.setAttribute('data-loaded', 'true')}
              className="h-full w-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-tr from-black/55 via-black/25 to-transparent" />
          </>
        ) : (
          <div
            className="h-full w-full bg-background"
            style={{
              backgroundImage: `radial-gradient(1100px 380px at 12% -10%, ${primary}1f, transparent 60%),
                                radial-gradient(900px 320px at 95% 110%, ${accent}1a, transparent 65%)`,
            }}
          />
        )}
      </div>

      <div className="relative px-6 md:px-10 lg:px-12 py-12 md:py-16 lg:py-20">
        <div className={hasImage ? 'max-w-2xl text-white' : 'max-w-2xl text-foreground'}>
          <div className="flex items-center gap-2.5 flex-wrap">
            {eyebrow && (
              <div className={'text-[12px] font-medium ' + (hasImage ? 'text-white/75' : 'text-muted-foreground')}>
                {eyebrow}
              </div>
            )}
            {locationChip}
          </div>

          <h1 className="mt-3 text-[clamp(1.875rem,4.2vw,2.875rem)] font-semibold leading-[1.05] tracking-[-0.02em]">
            {headline}
          </h1>

          {customSupporting && (
            <p className={'mt-3 max-w-xl text-[15px] leading-relaxed ' + (hasImage ? 'text-white/85' : 'text-muted-foreground')}>
              {customSupporting}
            </p>
          )}

          {/* Search "input" — a button styled like an input that opens ⌘K */}
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={`Open search (${kbdLabel})`}
            className={
              hasImage
                ? 'mt-7 max-w-xl group relative flex h-11 w-full items-center rounded-xl border border-white/15 bg-white/10 pl-10 pr-14 text-left text-[14px] text-white/85 outline-none backdrop-blur-md transition-colors hover:bg-white/15 focus-visible:ring-3 focus-visible:ring-white/30'
                : 'mt-7 max-w-xl group relative flex h-11 w-full items-center rounded-xl border border-border bg-background/80 pl-10 pr-14 text-left text-[14px] text-muted-foreground outline-none backdrop-blur-sm transition-colors hover:bg-background hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40'
            }
            style={{ transitionTimingFunction: 'var(--ease-portal)', transitionDuration: 'var(--dur-portal-hover)' }}
          >
            <Search
              aria-hidden
              className={'pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 size-4 ' + (hasImage ? 'text-white/65' : 'text-muted-foreground')}
            />
            <span className="flex-1 truncate">Search services, rooms, or people…</span>
            <kbd
              aria-hidden
              className={
                'pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 hidden sm:inline-flex h-5 items-center rounded border px-1.5 text-[10px] font-medium ' +
                (hasImage ? 'border-white/20 text-white/65' : 'border-border bg-muted/40 text-muted-foreground')
              }
            >
              {kbdLabel}
            </kbd>
          </button>

          {/* Quick actions — three pill links to the most-used flows.
              Stagger offset waits for the hero's own portal-rise to clear
              its first ~250ms so the pills feel like a follow-on, not a
              competing layer. */}
          <div
            className="portal-stagger mt-5 flex flex-wrap gap-2"
            style={{ ['--portal-stagger-offset' as string]: '260ms' } as React.CSSProperties}
          >
            <HeroAction to="/portal/submit" icon={FileText} label="Submit a request" hasImage={hasImage} />
            <HeroAction to="/portal/rooms"  icon={CalendarDays} label="Book a room" hasImage={hasImage} />
            <HeroAction to="/portal/visitors" icon={UserPlus} label="Invite a visitor" hasImage={hasImage} />
          </div>
        </div>
      </div>
    </section>
  );
}

interface HeroActionProps {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hasImage: boolean;
}

function HeroAction({ to, icon: Icon, label, hasImage }: HeroActionProps) {
  return (
    <Link
      to={to}
      viewTransition
      className={
        (hasImage
          ? 'border-white/20 bg-white/10 text-white hover:bg-white/15'
          : 'border-border/70 bg-background/60 text-foreground hover:bg-background/90 hover:border-border') +
        ' inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-[13px] font-medium' +
        ' backdrop-blur transition-[background-color,border-color,transform] active:translate-y-px' +
        ' focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50'
      }
      style={{ transitionTimingFunction: 'var(--ease-portal)', transitionDuration: 'var(--dur-portal-press)' }}
    >
      <Icon className="size-3.5" />
      <span>{label}</span>
    </Link>
  );
}
