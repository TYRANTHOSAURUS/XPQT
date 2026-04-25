import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { usePortal } from '@/providers/portal-provider';
import { useAuth } from '@/providers/auth-provider';
import { useBranding } from '@/hooks/use-branding';
import { timeOfDayGreeting } from '@/lib/portal-greeting';
import { PortalLocationSwitcher } from './portal-location-picker';

export function PortalHomeHero() {
  const navigate = useNavigate();
  const { data: portal } = usePortal();
  const auth = useAuth();
  const { branding } = useBranding();
  const [q, setQ] = useState('');

  const appearance = portal?.appearance ?? null;
  const firstName = auth.person?.first_name ?? '';
  const eyebrow =
    appearance?.greeting_enabled !== false
      ? `${timeOfDayGreeting()}${firstName ? `, ${firstName}` : ''}`
      : null;
  const headline = appearance?.welcome_headline?.trim() || 'How can we help you today?';
  const customSupporting = appearance?.supporting_line?.trim() || null;
  const locationName = portal?.current_location?.name ?? null;
  const canSwitchLocation = (portal?.authorized_locations.length ?? 0) > 1;

  const heroUrl = appearance?.hero_image_url ?? null;
  const primary = branding?.primary_color ?? '#6366f1';
  const accent = branding?.accent_color ?? '#ec4899';

  const inlineLocationTrigger = locationName ? (
    <button
      type="button"
      className="inline-flex items-baseline gap-1 rounded font-medium text-foreground underline decoration-foreground/30 decoration-1 underline-offset-[5px] outline-none transition-colors hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      style={{ transitionTimingFunction: 'var(--ease-snap)', transitionDuration: '120ms' }}
    >
      {locationName}
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground/80">switch</span>
    </button>
  ) : null;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = q.trim();
    if (trimmed) navigate(`/portal?q=${encodeURIComponent(trimmed)}`);
  };

  // Hero variants:
  //  · with image  → image fills, soft scrim ensures legibility, white text
  //  · without     → off-white surface with low-saturation brand wash, dark text
  const hasImage = Boolean(heroUrl);

  return (
    <section className="relative overflow-hidden rounded-2xl ring-1 ring-border/40">
      <div className="absolute inset-0" aria-hidden>
        {hasImage ? (
          <>
            <img src={heroUrl!} alt="" className="h-full w-full object-cover" />
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
          {eyebrow && (
            <div
              className={
                'text-[12px] font-medium ' +
                (hasImage ? 'text-white/75' : 'text-muted-foreground')
              }
            >
              {eyebrow}
            </div>
          )}
          <h1 className="mt-3 text-[clamp(1.875rem,4.2vw,2.875rem)] font-semibold leading-[1.05] tracking-[-0.02em] text-balance">
            {headline}
          </h1>
          <p
            className={
              'mt-3 max-w-xl text-[15px] leading-relaxed text-pretty ' +
              (hasImage ? 'text-white/85' : 'text-muted-foreground')
            }
          >
            {customSupporting ? (
              customSupporting
            ) : locationName ? (
              <>
                Submit a request, book a room, or invite a visitor at{' '}
                {canSwitchLocation && inlineLocationTrigger ? (
                  hasImage ? (
                    <PortalLocationSwitcher
                      trigger={
                        <button
                          type="button"
                          className="inline-flex items-baseline gap-1 rounded font-medium text-white underline decoration-white/40 decoration-1 underline-offset-[5px] outline-none transition-colors hover:decoration-white focus-visible:ring-3 focus-visible:ring-white/50"
                          style={{ transitionTimingFunction: 'var(--ease-snap)', transitionDuration: '120ms' }}
                        >
                          {locationName}
                          <span className="text-[11px] uppercase tracking-wide text-white/70">switch</span>
                        </button>
                      }
                      align="start"
                    />
                  ) : (
                    <PortalLocationSwitcher trigger={inlineLocationTrigger} align="start" />
                  )
                ) : (
                  <span className="font-medium">{locationName}</span>
                )}
                .
              </>
            ) : (
              'Submit a request, book a room, or invite a visitor.'
            )}
          </p>

          <form onSubmit={onSubmit} className="mt-7 max-w-xl">
            <label htmlFor="portal-hero-search" className="sr-only">Search</label>
            <div className="group relative">
              <Search
                className={
                  'pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 size-4 ' +
                  (hasImage ? 'text-white/65' : 'text-muted-foreground')
                }
              />
              <input
                id="portal-hero-search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search services, rooms, or people…"
                className={
                  hasImage
                    ? 'h-11 w-full rounded-xl border border-white/15 bg-white/10 pl-10 pr-14 text-[14px] text-white placeholder:text-white/55 outline-none backdrop-blur-md transition-colors focus:bg-white/15 focus:border-white/25 focus-visible:ring-3 focus-visible:ring-white/30'
                    : 'h-11 w-full rounded-xl border border-border bg-background/80 pl-10 pr-14 text-[14px] text-foreground placeholder:text-muted-foreground outline-none backdrop-blur-sm shadow-sm transition-colors hover:bg-background focus:border-ring focus-visible:ring-3 focus-visible:ring-ring/40'
                }
                style={{ transitionTimingFunction: 'var(--ease-smooth)', transitionDuration: '180ms' }}
              />
              <kbd
                className={
                  'pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 hidden sm:inline-flex h-5 items-center gap-0.5 rounded border px-1.5 text-[10px] font-medium tabular-nums ' +
                  (hasImage
                    ? 'border-white/20 text-white/65'
                    : 'border-border bg-muted/40 text-muted-foreground')
                }
              >
                <span>⌘</span>
                <span>K</span>
              </kbd>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}
