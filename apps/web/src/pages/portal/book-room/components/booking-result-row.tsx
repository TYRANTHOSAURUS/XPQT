import { ArrowRight, Users as UsersIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { RankedRoom } from '@/api/room-booking';
import { MiniTimelineStrip } from './mini-timeline-strip';

interface Props {
  room: RankedRoom;
  requestedStartIso: string;
  requestedEndIso: string;
  /** Position in the ranked list — index 0 gets the BEST MATCH treatment. */
  rank: number;
  showRestricted?: boolean;
  onBook: (room: RankedRoom) => void;
}

/**
 * One ranked candidate. Compact, two-row design:
 *   row 1: name · location chip · capacity · status badges · CTA
 *   row 2: half-height availability strip
 *
 * No type-icon tile, no amenity chips, no reason text — when the data is
 * uniform (typical for this seed where every "Meeting Room X" has the
 * same amenities + capacity), those decorations make every row read
 * identical and add visual noise. The location chip from `parent_chain`
 * is the primary differentiator.
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

  if (isDenied && !showRestricted) return null;

  const locationLabel = formatLocation(room.parent_chain);

  const ctaLabel = isDenied ? 'Restricted' : requiresApproval ? 'Request' : 'Book';

  return (
    <article
      className={cn(
        'group/row relative flex flex-col gap-3 rounded-xl border bg-card px-4 py-3.5 transition-all',
        'hover:border-foreground/20',
        isBestMatch && !isDenied && 'border-primary/45 shadow-[0_1px_0_0_rgba(0,0,0,0.02),0_8px_24px_-12px_rgba(59,130,246,0.18)]',
        isDenied && 'opacity-55',
      )}
      style={{ transitionDuration: '160ms', transitionTimingFunction: 'var(--ease-smooth)' }}
    >
      {/* Header row: name | meta | badges | CTA */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-3">
          <h3
            className={cn(
              'truncate text-[15px] font-semibold tracking-tight',
              isDenied && 'line-through',
            )}
          >
            {room.name}
          </h3>
          {locationLabel && (
            <span
              className="inline-flex shrink-0 items-center rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground"
              title={locationLabel.full}
            >
              {locationLabel.short}
            </span>
          )}
          {typeof room.capacity === 'number' && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[12px] tabular-nums text-muted-foreground">
              <UsersIcon className="size-3" />
              {room.capacity}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {isBestMatch && !isDenied && (
            <Badge
              variant="default"
              className="h-5 rounded-full px-2 text-[10px] uppercase tracking-wider"
            >
              Best match
            </Badge>
          )}
          {requiresApproval && (
            <Badge
              variant="outline"
              className="h-5 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400"
            >
              Needs approval
            </Badge>
          )}
          {hasWarning && !requiresApproval && (
            <Badge
              variant="outline"
              className="h-5 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400"
            >
              Warning
            </Badge>
          )}
          {isDenied && (
            <Badge
              variant="outline"
              className="h-5 border-destructive/40 bg-destructive/10 text-[10px] text-destructive"
            >
              Restricted
            </Badge>
          )}
        </div>

        <Button
          size="sm"
          variant={isBestMatch && !isDenied ? 'default' : 'outline'}
          disabled={isDenied}
          onClick={() => onBook(room)}
          className={cn('shrink-0 gap-1', isDenied && 'cursor-not-allowed')}
        >
          {ctaLabel}
          {!isDenied && <ArrowRight className="size-3.5 opacity-70" />}
        </Button>
      </div>

      {/* Self-explaining message (only when there's something to say) */}
      {requiresApproval && room.rule_outcome.denial_message && (
        <p className="rounded-md bg-amber-500/8 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
          {room.rule_outcome.denial_message}
        </p>
      )}
      {isDenied && showRestricted && room.rule_outcome.denial_message && (
        <p className="rounded-md bg-destructive/8 px-2.5 py-1.5 text-[11px] leading-relaxed text-destructive">
          {room.rule_outcome.denial_message} <em className="opacity-70">(visible to service desk)</em>
        </p>
      )}
      {hasWarning && (room.rule_outcome.warning_messages?.length || room.rule_outcome.denial_message) && (
        <p className="rounded-md bg-amber-500/8 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
          {room.rule_outcome.warning_messages?.length
            ? room.rule_outcome.warning_messages.join(' · ')
            : room.rule_outcome.denial_message}
        </p>
      )}

      {/* Availability strip */}
      <MiniTimelineStrip
        blocks={room.day_blocks}
        requestedStartIso={requestedStartIso}
        requestedEndIso={requestedEndIso}
        compact
      />
    </article>
  );
}

/**
 * Picks the most-specific location label from the parent chain. Buildings +
 * floors are the disambiguators; we drop sites because they're typically
 * already filtered by the criteria bar.
 */
function formatLocation(chain: RankedRoom['parent_chain']): { short: string; full: string } | null {
  if (!chain || chain.length === 0) return null;
  const floor = chain.find((p) => p.type === 'floor');
  const building = chain.find((p) => p.type === 'building');
  const site = chain.find((p) => p.type === 'site');
  const parts: string[] = [];
  if (floor) parts.push(floor.name);
  if (building) parts.push(building.name);
  if (parts.length === 0 && site) parts.push(site.name);
  if (parts.length === 0) return null;
  return {
    short: parts.join(' · '),
    full: chain.map((p) => p.name).reverse().join(' › '),
  };
}
