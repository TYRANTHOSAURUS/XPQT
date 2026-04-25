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
      <div className="text-xs uppercase tracking-widest text-muted-foreground font-semibold">Services</div>
      <div className="grid gap-3 sm:grid-cols-2">
        {services.map((s) => {
          const Icon = s.iconName && (Icons as Record<string, unknown>)[s.iconName] as React.ComponentType<{ className?: string }> | undefined;
          return (
            <Link
              key={s.id}
              to={`/portal/submit?type=${encodeURIComponent(s.id)}`}
              className="flex items-start gap-3 rounded-xl border bg-card p-4 transition-colors hover:bg-accent/40"
              style={{ transitionTimingFunction: 'var(--ease-smooth)', transitionDuration: '180ms' }}
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
          className={cn(
            'flex items-start gap-3 rounded-xl border border-dashed bg-transparent p-4 transition-colors hover:bg-muted/40',
          )}
          style={{ transitionTimingFunction: 'var(--ease-smooth)', transitionDuration: '180ms' }}
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
