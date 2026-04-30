import { Search, ChevronDown, FileText, CalendarDays, UserPlus } from 'lucide-react';
import { usePortal } from '@/providers/portal-provider';
import { useAuth } from '@/providers/auth-provider';
import { useBranding } from '@/hooks/use-branding';
import { timeOfDayGreeting } from '@/lib/portal-greeting';
import { useCommandPalette } from '@/components/command-palette/command-palette';
import { PortalLocationSwitcher } from './portal-location-picker';
import { GlassButtonPill, GlassLinkPill } from './portal-glass';

const HERO_IMAGE_WIDTH = 1600;
const HERO_IMAGE_HEIGHT = 480;

/**
 * Detect Mac-class platforms via UA. `navigator.platform` is deprecated
 * and lies on iPad Safari (claims macOS) — use the UA string and treat
 * iOS as a Mac-class device for the keyboard hint, then hide the hint
 * on coarse pointers via CSS.
 */
function isMacLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

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

  const kbdLabel = isMacLike() ? '⌘ K' : 'Ctrl K';

  const hasImage = Boolean(heroUrl);

  const locationChip = locationName ? (
    <PortalLocationSwitcher
      align="start"
      trigger={
        <GlassButtonPill
          tone={hasImage ? 'glass' : 'solid'}
          disabled={!canSwitchLocation}
          className="h-7 px-2.5 text-[12px]"
        >
          <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
          <span className="truncate max-w-[18ch]">{locationName}</span>
          {canSwitchLocation && <ChevronDown className="size-3 opacity-70" aria-hidden />}
        </GlassButtonPill>
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
              width={HERO_IMAGE_WIDTH}
              height={HERO_IMAGE_HEIGHT}
              fetchPriority="high"
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
        <div
          className={
            hasImage
              ? 'portal-stagger max-w-2xl text-white'
              : 'portal-stagger max-w-2xl text-foreground'
          }
        >
          <div className="flex items-center gap-2.5 flex-wrap">
            {eyebrow && (
              <div className={'text-[12px] font-medium ' + (hasImage ? 'text-white/75' : 'text-muted-foreground')}>
                {eyebrow}
              </div>
            )}
            {locationChip}
          </div>

          <h1 className="mt-3 text-[clamp(1.875rem,4.2vw,2.875rem)] font-semibold leading-[1.05] tracking-[-0.02em] text-balance">
            {headline}
          </h1>

          {customSupporting && (
            <p className={'mt-3 max-w-xl text-[15px] leading-relaxed text-pretty ' + (hasImage ? 'text-white/85' : 'text-muted-foreground')}>
              {customSupporting}
            </p>
          )}

          {/* Search "input" — a button styled like an input that opens ⌘K */}
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={`Open search (${kbdLabel.replace(' ', ' ')})`}
            className={
              hasImage
                ? 'mt-7 max-w-xl group relative flex h-11 w-full items-center rounded-xl border border-white/15 bg-white/10 pl-10 pr-14 text-left text-[14px] text-white/85 outline-none backdrop-blur-md transition-colors hover:bg-white/15 active:translate-y-px focus-visible:ring-3 focus-visible:ring-white/30'
                : 'mt-7 max-w-xl group relative flex h-11 w-full items-center rounded-xl border border-border bg-background/80 pl-10 pr-14 text-left text-[14px] text-muted-foreground outline-none backdrop-blur-sm transition-colors hover:bg-background hover:text-foreground active:translate-y-px focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40'
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
                'pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 hidden lg:inline-flex h-5 items-center rounded border px-1.5 text-[10px] font-medium ' +
                (hasImage ? 'border-white/20 text-white/65' : 'border-border bg-muted/40 text-muted-foreground')
              }
            >
              {kbdLabel}
            </kbd>
          </button>

          {/* Quick actions — three pill links to the most-used flows. */}
          <div className="mt-5 flex flex-wrap gap-2">
            <GlassLinkPill tone={hasImage ? 'glass' : 'solid'} to="/portal/submit">
              <FileText className="size-3.5" aria-hidden />
              <span>Submit a request</span>
            </GlassLinkPill>
            <GlassLinkPill tone={hasImage ? 'glass' : 'solid'} to="/portal/rooms">
              <CalendarDays className="size-3.5" aria-hidden />
              <span>Book a room</span>
            </GlassLinkPill>
            <GlassLinkPill tone={hasImage ? 'glass' : 'solid'} to="/portal/visitors">
              <UserPlus className="size-3.5" aria-hidden />
              <span>Invite a visitor</span>
            </GlassLinkPill>
          </div>
        </div>
      </div>
    </section>
  );
}
