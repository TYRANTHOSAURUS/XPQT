import { Link } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { cn } from '@/lib/utils';

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

export function PortalCategoryCard({ id, name, description, icon, cover_source, cover_image_url, className }: Props) {
  const IconCmp = icon && (Icons as Record<string, unknown>)[icon] as React.ComponentType<{ className?: string }> | undefined;
  const platformClass = cover_image_url ? PLATFORM_COVERS[cover_image_url] : null;

  return (
    <Link
      to={`/portal/catalog/${id}`}
      className={cn(
        'group block overflow-hidden rounded-xl border bg-card transition-colors hover:bg-accent/40',
        className,
      )}
      style={{ transitionTimingFunction: 'var(--ease-smooth)', transitionDuration: '200ms' }}
    >
      <div className="relative aspect-[2.1/1] bg-muted">
        {cover_source === 'image' && cover_image_url && platformClass ? (
          <div className={cn(platformClass, 'h-full w-full')} />
        ) : cover_source === 'image' && cover_image_url ? (
          <img src={cover_image_url} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/20 to-primary/5 text-primary">
            {IconCmp ? <IconCmp className="size-7" /> : <Icons.HelpCircle className="size-7" />}
          </div>
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
