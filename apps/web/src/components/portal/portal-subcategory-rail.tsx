// apps/web/src/components/portal/portal-subcategory-rail.tsx
import { Link } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { cn } from '@/lib/utils';

interface SubItem {
  id: string;
  name: string;
  iconName?: string | null;
  count?: number;
}

interface Props {
  items: SubItem[];
  className?: string;
}

export function PortalSubcategoryRail({ items, className }: Props) {
  if (items.length === 0) return null;
  return (
    <section className={cn('space-y-3', className)}>
      <h2 className="text-sm font-semibold tracking-tight">Subcategories</h2>
      <div className="portal-stagger grid gap-2 sm:grid-cols-2 md:grid-cols-3">
        {items.map((s) => {
          const Icon = s.iconName && (Icons as Record<string, unknown>)[s.iconName] as React.ComponentType<{ className?: string }> | undefined;
          return (
            <Link
              key={s.id}
              to={`/portal/catalog/${s.id}`}
              viewTransition
              style={{
                transitionTimingFunction: 'var(--ease-portal)',
                transitionDuration: 'var(--dur-portal-hover)',
                viewTransitionName: `portal-cat-${s.id}`,
              }}
              className="
                flex items-center gap-3 rounded-lg border border-border/70 bg-card px-3 py-2.5 text-sm
                transition-[transform,border-color,background-color]
                hover:-translate-y-0.5 hover:border-border
                active:translate-y-0 active:bg-accent/40
                focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50
              "
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                {Icon ? <Icon className="size-3.5" /> : <Icons.FolderOpen className="size-3.5" />}
              </span>
              <span className="flex-1 truncate font-medium">{s.name}</span>
              {typeof s.count === 'number' && (
                <span className="text-xs text-muted-foreground tabular-nums">{s.count}</span>
              )}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
