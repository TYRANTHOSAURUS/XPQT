import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type InlineBannerTone = 'info' | 'warning' | 'destructive';

interface InlineBannerProps {
  /** Tonal palette of the banner. Each tone matches a specific failure
   *  semantic — `info` for soft non-blocking advisories (capacity tight,
   *  approval routing), `warning` for actionable pre-flight blockers
   *  (lead-time, scheduling conflict), `destructive` for post-failure
   *  recovery surfaces (409 alternatives). */
  tone?: InlineBannerTone;
  /** Lucide icon component rendered to the left of the content.
   *  Required — banners without an icon should be plain inline text,
   *  not this primitive. */
  icon: LucideIcon;
  /** Override the icon's color independent of the banner's bg/border.
   *  Used by the approval-route variant where the chrome is `info`
   *  (neutral) but the icon stays purple to telegraph the routing tier. */
  iconClassName?: string;
  /** ARIA live-region role. Default is no role — static advisories
   *  shouldn't announce on mount. Opt into `status` (polite) for soft
   *  warnings that recompute on every state change, or `alert`
   *  (assertive) for post-failure surfaces the user should notice now. */
  role?: 'status' | 'alert';
  /** Single-line: render directly. Multi-line / list: pass JSX. */
  children: React.ReactNode;
  className?: string;
}

const TONES: Record<InlineBannerTone, { container: string; defaultIcon: string }> = {
  info: {
    container: 'border-border/60 text-foreground',
    defaultIcon: 'text-muted-foreground',
  },
  warning: {
    // Dark variant uses amber-200 + a slightly heavier amber-950/30 wash
    // so 12px body copy clears AA contrast (amber-300 on amber-500/5
    // measures ~3.9:1, just under threshold).
    container:
      'border-amber-500/30 bg-amber-500/5 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200',
    defaultIcon: 'text-amber-700 dark:text-amber-300',
  },
  destructive: {
    // Body copy stays foreground — chrome + icon carry the destructive
    // signal. Callsites color the heading explicitly with `text-destructive`
    // so secondary content (room names, helper copy) doesn't read as red.
    container: 'border-destructive/40 bg-destructive/5 text-foreground',
    defaultIcon: 'text-destructive',
  },
};

/**
 * One primitive for every soft alert / advisory in the booking composer
 * (and elsewhere). Replaces the previous four hand-rolled banner shapes
 * (approval-route, capacity, lead-time, conflict-alternatives ×2) with
 * a single tone-driven wrapper so the visual grammar stays cohesive.
 *
 * Motion: shared `animate-in fade-in slide-in-from-top-1` at 200ms
 * `--ease-smooth`. The global `prefers-reduced-motion` clamp in
 * apps/web/src/index.css already turns this into an opacity-only
 * fade for users who opt out of motion.
 */
export function InlineBanner({
  tone = 'info',
  icon: Icon,
  iconClassName,
  role,
  children,
  className,
}: InlineBannerProps) {
  const t = TONES[tone];
  return (
    <div
      role={role}
      aria-live={role === 'status' ? 'polite' : undefined}
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
        'duration-200 ease-[var(--ease-smooth)] animate-in fade-in slide-in-from-top-1',
        t.container,
        className,
      )}
    >
      <Icon
        className={cn('mt-px size-3.5 shrink-0', iconClassName ?? t.defaultIcon)}
        aria-hidden
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
