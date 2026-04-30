import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { resolvePortalIcon } from '@/lib/portal-icons';

interface Props {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  cover_source: 'image' | 'icon';
  cover_image_url: string | null;
  className?: string;
}

// Platform cover tokens → gradient classNames (matching CategoryCoverPicker in admin)
const PLATFORM_COVERS: Record<string, string> = {
  'platform:cover-1': 'bg-gradient-to-br from-blue-500/70 to-indigo-700',
  'platform:cover-2': 'bg-gradient-to-br from-purple-500/70 to-violet-700',
  'platform:cover-3': 'bg-gradient-to-br from-emerald-500/70 to-teal-700',
  'platform:cover-4': 'bg-gradient-to-br from-orange-500/70 to-amber-700',
};

const COVER_WIDTH = 400;
const COVER_HEIGHT = 190;

export function PortalCategoryCard({ id, name, description, icon, cover_source, cover_image_url, className }: Props) {
  const IconCmp = resolvePortalIcon(icon);
  const platformClass = cover_image_url ? PLATFORM_COVERS[cover_image_url] : null;

  return (
    <Link
      to={`/portal/catalog/${id}`}
      viewTransition
      className={cn(
        'group block overflow-hidden rounded-xl border border-border/70 bg-card',
        'transition-[transform,border-color,background-color,box-shadow]',
        'hover:-translate-y-0.5 hover:border-border hover:bg-card hover:shadow-sm',
        'active:translate-y-px active:shadow-none',
        'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        className,
      )}
      style={{
        transitionTimingFunction: 'var(--ease-portal)',
        transitionDuration: 'var(--dur-portal-hover)',
        viewTransitionName: `portal-cat-${id}`,
      }}
    >
      <div className="relative aspect-[2.1/1] bg-muted overflow-hidden">
        {cover_source === 'image' && cover_image_url && platformClass ? (
          <div className={cn(platformClass, 'h-full w-full')} aria-hidden />
        ) : cover_source === 'image' && cover_image_url ? (
          <img
            src={cover_image_url}
            alt=""
            loading="lazy"
            width={COVER_WIDTH}
            height={COVER_HEIGHT}
            data-portal-fade
            data-loaded="false"
            onLoad={(e) => e.currentTarget.setAttribute('data-loaded', 'true')}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.05]"
            style={{ transitionTimingFunction: 'var(--ease-portal)' }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/20 to-primary/5 text-primary">
            <IconCmp className="size-7" aria-hidden />
          </div>
        )}
        {/* Bottom scrim — keeps title readable when an image is present */}
        {cover_source === 'image' && cover_image_url && !platformClass && (
          <div
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/25 to-transparent"
          />
        )}
      </div>
      <div className="p-4">
        <div className="text-sm font-semibold tracking-tight">{name}</div>
        {description && (
          <div className="mt-1 text-xs text-muted-foreground line-clamp-2">{description}</div>
        )}
      </div>
    </Link>
  );
}
