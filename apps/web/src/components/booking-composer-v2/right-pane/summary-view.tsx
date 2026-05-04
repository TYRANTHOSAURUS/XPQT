import { type ReactNode } from 'react';

export interface SummaryViewProps {
  times: ReactNode;
  room: ReactNode;
  catering: ReactNode;
  av: ReactNode;
  headerCopy?: string;
}

/**
 * Default-view container for the booking-composer right pane.
 *
 * Pure layout: a small header copy line followed by a vertical stack of
 * four domain summary slots (times · room · catering · av), separated by
 * hairlines. Cards control their own horizontal padding; this shell only
 * sets the rhythm between them.
 *
 * Callbacks live in the per-domain summary cards (B.1–B.4).
 */
export function SummaryView({
  times,
  room,
  catering,
  av,
  headerCopy = "We'll update suggestions as you build the booking.",
}: SummaryViewProps) {
  return (
    <div>
      <p className="text-xs text-muted-foreground px-4 pt-3 pb-2">{headerCopy}</p>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <div className="rounded-lg border border-border/60 bg-background overflow-hidden">{times}</div>
        <div className="rounded-lg border border-border/60 bg-background overflow-hidden">{room}</div>
        <div className="rounded-lg border border-border/60 bg-background overflow-hidden">{catering}</div>
        <div className="rounded-lg border border-border/60 bg-background overflow-hidden">{av}</div>
      </div>
    </div>
  );
}
