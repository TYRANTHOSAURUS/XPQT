// apps/web/src/components/portal/portal-category-banner.tsx
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBranding } from '@/hooks/use-branding';
import { resolvePortalIcon } from '@/lib/portal-icons';

const PLATFORM_COVERS: Record<string, string> = {
  'platform:cover-1': 'bg-gradient-to-br from-blue-500/70 to-indigo-700',
  'platform:cover-2': 'bg-gradient-to-br from-purple-500/70 to-violet-700',
  'platform:cover-3': 'bg-gradient-to-br from-emerald-500/70 to-teal-700',
  'platform:cover-4': 'bg-gradient-to-br from-orange-500/70 to-amber-700',
};

interface Props {
  /** Stable category id — used for the cover→banner view-transition morph. */
  id?: string | null;
  name: string;
  description?: string | null;
  parentName?: string | null;
  parentId?: string | null;
  iconName?: string | null;
  cover_source?: 'image' | 'icon';
  cover_image_url?: string | null;
}

/**
 * Sub-page banner shown at the top of a catalog category page. Visually a
 * sibling of `PortalHomeHero` — same rounded card chrome, same scrim
 * direction, same tenant-coloured radial fallback — sized smaller because
 * it's a secondary surface, not the marquee. Includes a single back-pill
 * (no breadcrumb): `← Home` for top-level, `← {parentName}` for sub-cats.
 */
export function PortalCategoryBanner({ id, name, description, parentName, parentId, iconName, cover_source, cover_image_url }: Props) {
  const { branding } = useBranding();
  const platformClass = cover_image_url ? PLATFORM_COVERS[cover_image_url] : null;
  const useImage = cover_source === 'image' && cover_image_url;
  const Icon = iconName ? resolvePortalIcon(iconName) : null;
  const hasArt = Boolean(useImage || platformClass);

  const primary = branding?.primary_color ?? '#6366f1';
  const accent = branding?.accent_color ?? '#ec4899';

  const backHref = parentId ? `/portal/catalog/${parentId}` : '/portal';
  const backLabel = parentName ?? 'Home';

  return (
    <section
      className="portal-rise relative overflow-hidden rounded-2xl ring-1 ring-border/50"
      style={{
        viewTransitionName: id ? `portal-cat-${id}` : undefined,
      }}
    >
      <div className="absolute inset-0" aria-hidden>
        {useImage && platformClass ? (
          <div className={cn(platformClass, 'h-full w-full')} />
        ) : useImage ? (
          <>
            <img
              src={cover_image_url ?? undefined}
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
              backgroundImage: `radial-gradient(900px 320px at 12% -10%, ${primary}1f, transparent 60%),
                                radial-gradient(700px 260px at 95% 110%, ${accent}1a, transparent 65%)`,
            }}
          />
        )}
      </div>

      <div className="relative px-6 md:px-10 lg:px-12 py-8 md:py-12">
        <div className={hasArt ? 'max-w-2xl text-white' : 'max-w-2xl text-foreground'}>
          <Link
            to={backHref}
            viewTransition
            aria-label={`Back to ${backLabel}`}
            className={
              (hasArt
                ? 'border-white/20 bg-white/10 text-white hover:bg-white/15'
                : 'border-border/70 bg-background/60 text-foreground hover:bg-background/90 hover:border-border') +
              ' inline-flex h-7 items-center gap-1 rounded-full border pl-1.5 pr-3 text-[12px] font-medium' +
              ' backdrop-blur transition-[background-color,border-color,transform] active:translate-y-px' +
              ' focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50'
            }
            style={{ transitionTimingFunction: 'var(--ease-portal)', transitionDuration: 'var(--dur-portal-press)' }}
          >
            <ChevronLeft className="size-3.5" aria-hidden />
            <span>{backLabel}</span>
          </Link>

          <h1 className="mt-3 text-[clamp(1.5rem,3.5vw,2.25rem)] font-semibold leading-[1.1] tracking-[-0.015em]">
            {name}
          </h1>

          {description && (
            <p className={'mt-2 max-w-prose text-sm md:text-base ' + (hasArt ? 'text-white/85' : 'text-muted-foreground')}>
              {description}
            </p>
          )}

          {!useImage && Icon && (
            <Icon
              className={cn(
                'absolute right-6 top-6 size-10 md:size-14 hidden sm:block',
                hasArt ? 'text-white/40' : 'text-muted-foreground/40',
              )}
              aria-hidden
            />
          )}
        </div>
      </div>
    </section>
  );
}
