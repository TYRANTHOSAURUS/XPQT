import { Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatCount } from '@/lib/format';
import type { RankedRoom } from '@/api/room-booking';
import { MiniTimelineStrip } from './mini-timeline-strip';

interface Props {
  room: RankedRoom;
  requestedStartIso: string;
  requestedEndIso: string;
  /** Position in the ranked list — index 0 gets the BEST MATCH treatment. */
  rank: number;
  /** Whether the viewer can see denial-restricted rooms (service desk only). */
  showRestricted?: boolean;
  onBook: (room: RankedRoom) => void;
}

/**
 * One ranked candidate room. Visual hierarchy mirrors §4.1 + portal-picker.html:
 *  - Top row: name, BEST MATCH badge (rank 0), capacity / floor / walking distance,
 *    status badges (Capacity tight, Needs approval, Restricted).
 *  - Sub-row: amenities + smart-rank reasons, comma-separated.
 *  - Mini-timeline strip with the requested slot outlined.
 *  - Trailing CTA: "Book" or "Request" depending on rule effect.
 */
export function BookingResultRow({
  room,
  requestedStartIso,
  requestedEndIso,
  rank,
  showRestricted = false,
  onBook,
}: Props) {
  const isBestMatch = rank === 0;
  const effect = room.rule_outcome?.effect ?? 'allow';
  const isDenied = effect === 'deny';
  const requiresApproval = effect === 'require_approval';
  const hasWarning = effect === 'warn';

  // Per §4.1 / Q2: denied rooms are hidden from employees entirely. The
  // "shadow" service-desk view (showRestricted=true) keeps them visible
  // with a Restricted badge + dimmed treatment.
  if (isDenied && !showRestricted) return null;

  const floor =
    room.parent_chain.find((p) => p.type === 'floor')?.name ??
    room.parent_chain.find((p) => p.type === 'building')?.name;

  const capacityTight =
    room.capacity != null &&
    room.capacity > 0 &&
    room.capacity < (room.min_attendees ?? 0);

  const ctaLabel = isDenied
    ? 'Restricted'
    : requiresApproval
      ? 'Request'
      : 'Book';

  return (
    <article
      className={cn(
        'group/row rounded-lg border bg-card px-4 py-3.5 transition-colors',
        isBestMatch && 'border-primary/60 bg-primary/[0.04] ring-1 ring-primary/10',
        isDenied && 'opacity-55',
      )}
      style={{ transitionDuration: '160ms', transitionTimingFunction: 'var(--ease-smooth)' }}
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3
              className={cn(
                'truncate text-sm font-semibold',
                isDenied && 'line-through',
              )}
            >
              {room.name}
            </h3>
            {isBestMatch && !isDenied && (
              <Badge variant="default" className="h-4 rounded-sm px-1.5 text-[10px] uppercase tracking-wide">
                Best match
              </Badge>
            )}
            {capacityTight && !isDenied && (
              <Badge variant="outline" className="h-5 border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400">
                Capacity tight
              </Badge>
            )}
            {requiresApproval && (
              <Badge variant="outline" className="h-5 border-purple-500/30 bg-purple-500/10 text-[10px] text-purple-700 dark:text-purple-400">
                Needs approval
              </Badge>
            )}
            {hasWarning && !requiresApproval && (
              <Badge variant="outline" className="h-5 border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400">
                Warning
              </Badge>
            )}
            {isDenied && (
              <Badge variant="outline" className="h-5 border-destructive/30 bg-destructive/10 text-[10px] text-destructive">
                Restricted
              </Badge>
            )}
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {room.capacity != null ? `${formatCount(room.capacity)} cap` : null}
              {floor ? ` · ${floor}` : null}
            </span>
          </div>

          {(room.amenities.length > 0 || room.ranking_reasons.length > 0) && (
            <p className="line-clamp-2 text-xs text-muted-foreground text-pretty">
              {[...room.amenities, ...room.ranking_reasons.map(reasonWithIcon)]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}

          {/* Self-explaining denial / approval / warning messages per §4.10 */}
          {requiresApproval && room.rule_outcome.denial_message && (
            <p className="rounded-md bg-purple-500/10 px-2 py-1 text-[11px] text-purple-700 dark:text-purple-300">
              <Sparkles className="mr-1 inline size-3" />
              {room.rule_outcome.denial_message}
            </p>
          )}
          {isDenied && showRestricted && room.rule_outcome.denial_message && (
            <p className="rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              {room.rule_outcome.denial_message} <em className="opacity-75">(visible to service desk only)</em>
            </p>
          )}
          {hasWarning && (room.rule_outcome.warning_messages?.length || room.rule_outcome.denial_message) ? (
            <p className="rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
              {room.rule_outcome.warning_messages?.length
                ? room.rule_outcome.warning_messages.join(' · ')
                : room.rule_outcome.denial_message}
            </p>
          ) : null}

          <MiniTimelineStrip
            blocks={room.day_blocks}
            requestedStartIso={requestedStartIso}
            requestedEndIso={requestedEndIso}
          />
        </div>

        <Button
          size="sm"
          variant={isBestMatch ? 'default' : 'outline'}
          disabled={isDenied}
          onClick={() => onBook(room)}
          className="shrink-0"
        >
          {ctaLabel}
        </Button>
      </div>
    </article>
  );
}

function reasonWithIcon(reason: string): string {
  // The picker returns plain reason strings; we keep them readable. Icons
  // would help here but require structured reason types from the API —
  // tracked for the ranking polish slice (Phase H).
  return reason;
}
