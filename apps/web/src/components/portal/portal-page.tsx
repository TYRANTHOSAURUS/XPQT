import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type PortalPageBleed = 'none' | 'horizontal' | 'top' | 'both';
export type PortalPageWidth = 'compact' | 'narrow' | 'default' | 'wide' | 'ultra';

interface Props {
  children: ReactNode;
  className?: string;
  /**
   * Edge-to-edge layout for hero-style content. `'horizontal'` drops the
   * page padding on the sides; `'top'` drops the top padding; `'both'`
   * drops both. Default keeps standard portal padding.
   */
  bleed?: PortalPageBleed;
  /**
   * Content column width. Most portal pages live in `'ultra'` (1600px max,
   * the canonical portal canvas). Choose `'wide'` for booking flows and
   * `'compact'`/`'narrow'`/`'default'` for list-of-decisions pages like
   * My Bookings, the standalone order flow, and individual detail pages.
   */
  width?: PortalPageWidth;
}

const WIDTH_CLASSES: Record<PortalPageWidth, string> = {
  compact: 'max-w-2xl',
  narrow:  'max-w-3xl',
  default: 'max-w-5xl',
  wide:    'max-w-6xl',
  ultra:   'max-w-[1600px]',
};

/**
 * Content wrapper for portal pages. The width enum mirrors the
 * `SettingsPageWidth` convention used by admin pages — pages should
 * pick the smallest width that works rather than inventing arbitrary
 * `max-w-[Npx]` values.
 */
export function PortalPage({ children, className, bleed = 'none', width = 'ultra' }: Props) {
  const horizontal = bleed === 'horizontal' || bleed === 'both';
  const top = bleed === 'top' || bleed === 'both';
  return (
    <div
      className={cn(
        'mx-auto w-full',
        WIDTH_CLASSES[width],
        !horizontal && 'px-3 md:px-4 lg:px-6',
        !top && 'pt-6 md:pt-10',
        'pb-24 md:pb-10',
        className,
      )}
    >
      {children}
    </div>
  );
}
