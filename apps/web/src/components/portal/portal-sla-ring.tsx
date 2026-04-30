import { cn } from '@/lib/utils';

interface Props {
  /** Progress 0-1 (0 = not started, 1 = SLA fully consumed). */
  progress: number;
  /** When true, shows a red ring (SLA breached). */
  breached?: boolean;
  size?: number;
  className?: string;
}

/**
 * Compact conic-gradient progress ring for SLA visibility.
 * Green → amber when >0.66 → red when >0.85 or breached.
 *
 * Progress is rendered as a fractional CSS variable so the parent can
 * tick `useNow()` and the ring sweeps continuously rather than stepping
 * 1% at a time.
 */
export function PortalSlaRing({
  progress,
  breached,
  size = 32,
  className,
}: Props) {
  const clamped = Math.max(0, Math.min(1, progress));
  const color =
    breached || clamped > 0.85
      ? 'rgb(239 68 68)'
      : clamped > 0.66
        ? 'rgb(234 179 8)'
        : 'rgb(34 197 94)';
  const pct = clamped * 100;
  const ariaPct = Math.round(pct);

  return (
    <div
      className={cn('relative shrink-0 rounded-full transition-[background] duration-500', className)}
      style={{
        width: size,
        height: size,
        background: `conic-gradient(${color} ${pct}%, rgb(229 231 235 / 0.3) 0)`,
        transitionTimingFunction: 'var(--ease-portal)',
      }}
      aria-label={`SLA ${ariaPct}% used`}
      role="progressbar"
      aria-valuenow={ariaPct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="absolute inset-1 rounded-full bg-background" />
    </div>
  );
}
