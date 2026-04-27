// apps/web/src/components/portal/portal-category-banner.tsx
import { Link } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { cn } from '@/lib/utils';

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

export function PortalCategoryBanner({ id, name, description, parentName, parentId, iconName, cover_source, cover_image_url }: Props) {
  const platformClass = cover_image_url ? PLATFORM_COVERS[cover_image_url] : null;
  const useImage = cover_source === 'image' && cover_image_url;
  const Icon = iconName && (Icons as Record<string, unknown>)[iconName] as React.ComponentType<{ className?: string }> | undefined;

  return (
    <section
      className="portal-rise relative -mx-4 md:-mx-6 lg:-mx-8 overflow-hidden"
      style={{
        minHeight: 'clamp(140px, 22vw, 220px)',
        viewTransitionName: id ? `portal-cat-${id}` : undefined,
      }}
    >
      <div className="absolute inset-0" aria-hidden>
        {useImage && platformClass ? (
          <div className={cn(platformClass, 'h-full w-full')} />
        ) : useImage ? (
          <img
            src={cover_image_url ?? undefined}
            alt=""
            data-portal-fade
            data-loaded="false"
            onLoad={(e) => e.currentTarget.setAttribute('data-loaded', 'true')}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-primary/30 via-primary/10 to-background" />
        )}
        {/* Lighter, more photographic scrim — reads like a soft-light overlay,
            not a wash. Bottom is darker so the title still pops. */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/25 to-black/55" />
      </div>

      <div className="relative mx-auto max-w-[1600px] px-4 md:px-6 lg:px-8 py-7 md:py-10">
        <nav className="text-xs text-white/70 mb-2 flex items-center gap-1.5" aria-label="Breadcrumb">
          <Link to="/portal" viewTransition className="hover:text-white/90 underline-offset-2 hover:underline">
            Home
          </Link>
          <span aria-hidden>›</span>
          {parentId && parentName ? (
            <>
              <Link
                to={`/portal/catalog/${parentId}`}
                viewTransition
                className="hover:text-white/90 underline-offset-2 hover:underline"
              >
                {parentName}
              </Link>
              <span aria-hidden>›</span>
            </>
          ) : null}
          <span>{name}</span>
        </nav>
        <h1 className="text-2xl md:text-4xl font-semibold tracking-tight text-white">{name}</h1>
        {description && (
          <p className="mt-2 max-w-prose text-sm md:text-base text-white/80">{description}</p>
        )}
        {!useImage && Icon && (
          <Icon className="absolute right-6 top-6 size-10 md:size-14 text-white/40 hidden sm:block" aria-hidden />
        )}
      </div>
    </section>
  );
}
