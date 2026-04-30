import { cn } from '@/lib/utils';

interface Props {
  /** Tailwind size class — e.g. `size-6`, `size-8`. */
  size?: string;
  /** When true, show the same gradient but render larger initials. */
  initials?: string | null;
  className?: string;
}

/**
 * Branded gradient square used as a logo fallback (top bar) and as the
 * empty-avatar fallback (account menu, request thread). Single component
 * so the gradient stays in one place.
 */
export function PortalBrandMark({ size = 'size-6', initials, className }: Props) {
  return (
    <div
      aria-hidden={initials == null ? true : undefined}
      className={cn(
        size,
        'shrink-0 rounded-md bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-pink-500',
        initials != null && 'flex items-center justify-center text-white font-semibold',
        className,
      )}
    >
      {initials}
    </div>
  );
}
