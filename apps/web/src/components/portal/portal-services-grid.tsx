// apps/web/src/components/portal/portal-services-grid.tsx
import { Link } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { cn } from '@/lib/utils';

interface ServiceItem {
  id: string;
  name: string;
  description?: string | null;
  iconName?: string | null;
}

interface Props {
  services: ServiceItem[];
  /** Optional category id used to deep-link the "Other" tile to a generic submit prefilled with the category. */
  categoryIdForOther?: string | null;
  className?: string;
}

export function PortalServicesGrid({ services, categoryIdForOther, className }: Props) {
  return (
    <section className={cn('space-y-3', className)}>
      <h2 className="text-sm font-semibold tracking-tight">Services</h2>
      <div className="portal-stagger grid gap-3 sm:grid-cols-2">
        {services.map((s) => {
          const Icon = s.iconName && (Icons as Record<string, unknown>)[s.iconName] as React.ComponentType<{ className?: string }> | undefined;
          return (
            <Link
              key={s.id}
              to={categoryIdForOther
                ? `/portal/submit/${encodeURIComponent(categoryIdForOther)}?type=${encodeURIComponent(s.id)}`
                : `/portal/submit?type=${encodeURIComponent(s.id)}`}
              viewTransition
              className="
                flex items-start gap-3 rounded-xl border border-border/70 bg-card p-4
                transition-[transform,border-color,background-color]
                hover:-translate-y-0.5 hover:border-border hover:bg-card
                active:translate-y-0 active:bg-accent/40
                focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50
              "
              style={{ transitionTimingFunction: 'var(--ease-portal)', transitionDuration: 'var(--dur-portal-hover)' }}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                {Icon ? <Icon className="size-4" /> : <Icons.HelpCircle className="size-4" />}
              </span>
              <span className="flex-1">
                <span className="block text-sm font-semibold tracking-tight">{s.name}</span>
                {s.description && (
                  <span className="mt-1 block text-xs text-muted-foreground line-clamp-2">{s.description}</span>
                )}
              </span>
            </Link>
          );
        })}
        <Link
          to={categoryIdForOther
            ? `/portal/submit/${encodeURIComponent(categoryIdForOther)}`
            : '/portal/submit'}
          viewTransition
          className="
            flex items-start gap-3 rounded-xl border border-dashed border-border/70 bg-transparent p-4
            transition-[transform,border-color,background-color]
            hover:-translate-y-0.5 hover:border-border hover:bg-muted/40
            active:translate-y-0
            focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50
          "
          style={{ transitionTimingFunction: 'var(--ease-portal)', transitionDuration: 'var(--dur-portal-hover)' }}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Icons.Plus className="size-4" />
          </span>
          <span className="flex-1">
            <span className="block text-sm font-semibold tracking-tight">Other</span>
            <span className="mt-1 block text-xs text-muted-foreground">Can't find what you need? Submit a general request.</span>
          </span>
        </Link>
      </div>
    </section>
  );
}
