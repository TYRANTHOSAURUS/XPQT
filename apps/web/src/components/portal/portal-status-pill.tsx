import { cn } from '@/lib/utils';
import { STATUS_TONE_CLASSES, type PortalStatus } from '@/lib/portal-status';

interface Props {
  status: PortalStatus;
  size?: 'xs' | 'sm';
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<Props['size']>, string> = {
  xs: 'rounded px-2 py-0.5 text-[10px]',
  sm: 'rounded-md px-2 py-0.5 text-[11px]',
};

/**
 * Shared status badge for portal lists, activity feeds, and detail
 * sidebars. The same colors and the same transition timing live in
 * one place — when a polling refresh flips a ticket's tone, the pill
 * crossfades consistently across surfaces.
 */
export function PortalStatusPill({ status, size = 'sm', className }: Props) {
  return (
    <span
      className={cn(
        'shrink-0 font-medium tabular-nums',
        'transition-colors',
        SIZE_CLASSES[size],
        STATUS_TONE_CLASSES[status.tone],
        className,
      )}
      style={{
        transitionTimingFunction: 'var(--ease-portal)',
        transitionDuration: 'var(--dur-portal-hover)',
      }}
    >
      {status.label}
    </span>
  );
}
