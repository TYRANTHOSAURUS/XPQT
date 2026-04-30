import { Link } from 'react-router-dom';
import { forwardRef, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type GlassTone = 'glass' | 'solid';

interface Props {
  tone: GlassTone;
  className?: string;
  children: ReactNode;
  style?: CSSProperties;
}

interface LinkPillProps extends Props {
  to: string;
}

interface ButtonPillProps extends Props {
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
}

const TONE_CLASSES: Record<GlassTone, string> = {
  glass: 'border-white/20 bg-white/10 text-white hover:bg-white/15',
  solid: 'border-border/70 bg-background/60 text-foreground hover:bg-background/90 hover:border-border',
};

const SHARED =
  'inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-[13px] font-medium ' +
  'backdrop-blur transition-[background-color,border-color,transform] active:translate-y-px ' +
  'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50';

const PILL_STYLE: CSSProperties = {
  transitionTimingFunction: 'var(--ease-portal)',
  transitionDuration: 'var(--dur-portal-press)',
};

/**
 * Pill-shaped link that sits on either the portal hero image (`tone='glass'`)
 * or a flat surface (`tone='solid'`). The two themes were copy-pasted four
 * times in `portal-home-hero.tsx`; this is the single source.
 */
export const GlassLinkPill = forwardRef<HTMLAnchorElement, LinkPillProps>(function GlassLinkPill(
  { tone, to, className, style, children },
  ref,
) {
  return (
    <Link
      to={to}
      viewTransition
      ref={ref}
      className={cn(SHARED, TONE_CLASSES[tone], className)}
      style={{ ...PILL_STYLE, ...style }}
    >
      {children}
    </Link>
  );
});

/**
 * Same shape as `GlassLinkPill` but wired to `<button>`. Used by the
 * location chip in the hero — disabled when the user has only one
 * authorized location.
 */
export const GlassButtonPill = forwardRef<HTMLButtonElement, ButtonPillProps>(function GlassButtonPill(
  { tone, type = 'button', disabled, onClick, ariaLabel, className, style, children },
  ref,
) {
  return (
    <button
      type={type}
      ref={ref}
      onClick={onClick}
      aria-label={ariaLabel}
      disabled={disabled}
      className={cn(
        SHARED,
        TONE_CLASSES[tone],
        'disabled:opacity-90 disabled:cursor-default',
        className,
      )}
      style={{ ...PILL_STYLE, ...style }}
    >
      {children}
    </button>
  );
});
