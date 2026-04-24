import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { usePortal } from '@/providers/portal-provider';
import { useAuth } from '@/providers/auth-provider';
import { useBranding } from '@/hooks/use-branding';
import { timeOfDayGreeting } from '@/lib/portal-greeting';

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
  const supporting = appearance?.supporting_line?.trim()
    ?? (portal?.current_location?.name
      ? `Submit a request, book a room, or invite a visitor at ${portal.current_location.name}.`
      : 'Submit a request, book a room, or invite a visitor.');

  const heroUrl = appearance?.hero_image_url ?? null;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = q.trim();
    if (trimmed) navigate(`/portal?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <section
      className="relative -mx-4 md:-mx-6 lg:-mx-8 overflow-hidden"
      style={{ minHeight: 'clamp(180px, 32vw, 340px)' }}
    >
      <div className="absolute inset-0" aria-hidden>
        {heroUrl ? (
          <img src={heroUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div
            className="h-full w-full"
            style={{
              background: `radial-gradient(ellipse at 25% 15%, ${branding?.primary_color ?? '#6366f1'}44, transparent 55%),
                           radial-gradient(ellipse at 80% 80%, ${branding?.accent_color ?? '#ec4899'}22, transparent 55%),
                           linear-gradient(135deg, #312e81 0%, #4c1d95 40%, #1e1b4b 100%)`,
            }}
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/40 to-black/70" />
      </div>

      <div className="relative mx-auto max-w-[1600px] px-4 md:px-6 lg:px-8 py-10 md:py-14">
        <div className="max-w-2xl text-white">
          {eyebrow && (
            <div className="text-xs md:text-sm uppercase tracking-widest opacity-80">{eyebrow}</div>
          )}
          <h1 className="mt-2 text-3xl md:text-5xl font-semibold tracking-tight text-balance">
            {headline}
          </h1>
          <p className="mt-2 text-sm md:text-base opacity-80 text-pretty">{supporting}</p>

          <form onSubmit={onSubmit} className="mt-6 max-w-lg">
            <label htmlFor="portal-hero-search" className="sr-only">Search</label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 size-4 text-white/70" />
              <input
                id="portal-hero-search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search services, rooms, or people…"
                className="h-11 w-full rounded-lg border border-white/20 bg-white/15 pl-11 pr-4 text-sm text-white placeholder:text-white/60 backdrop-blur focus:outline-none focus-visible:ring-3 focus-visible:ring-white/40"
              />
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}
