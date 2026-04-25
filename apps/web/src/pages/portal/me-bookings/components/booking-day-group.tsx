import type { ReactNode } from 'react';

interface Props {
  /** Title shown above the group (e.g. "Today", "Tomorrow", "Wed, Apr 30"). */
  title: string;
  /** Optional smaller subtitle (e.g. count, weekday hint). */
  subtitle?: string;
  /** Right-aligned annotation (e.g. "3 bookings"). */
  meta?: string;
  children: ReactNode;
}

/**
 * One day's worth of bookings — date header + bordered card holding
 * `BookingRow` children. The header is sticky-friendly because the
 * portal page is short enough to read top-to-bottom; if we ever virtualise
 * this list we'll lift the header into a sticky container.
 */
export function BookingDayGroup({ title, subtitle, meta, children }: Props) {
  return (
    <section>
      <header className="mb-2 flex items-baseline justify-between gap-2 px-1">
        <h2 className="text-[13px] font-semibold tracking-tight">
          {title}
          {subtitle && (
            <span className="ml-2 text-[12px] font-normal text-muted-foreground">
              {subtitle}
            </span>
          )}
        </h2>
        {meta && (
          <span className="text-[11px] tabular-nums text-muted-foreground">{meta}</span>
        )}
      </header>
      <div className="overflow-hidden rounded-xl border bg-card divide-y divide-border/60">
        {children}
      </div>
    </section>
  );
}
