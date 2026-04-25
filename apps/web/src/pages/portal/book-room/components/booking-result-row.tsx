import { Sparkles, MapPin, Users as UsersIcon, ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatCount } from '@/lib/format';
import type { RankedRoom } from '@/api/room-booking';
import { MiniTimelineStrip } from './mini-timeline-strip';
import { RoomTypeIcon } from './room-type-icon';

interface Props {
  room: RankedRoom;
  requestedStartIso: string;
  requestedEndIso: string;
  /** Position in the ranked list — index 0 gets the BEST MATCH treatment. */
  rank: number;
  showRestricted?: boolean;
  onBook: (room: RankedRoom) => void;
}

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

  const floor =
    room.parent_chain.find((p) => p.type === 'floor')?.name ??
    room.parent_chain.find((p) => p.type === 'building')?.name;

  const ctaLabel = isDenied
    ? 'Restricted'
    : requiresApproval
      ? 'Request'
      : 'Book this room';

  const accentBar = isBestMatch && !isDenied;

  return (
    <article
      className={cn(
        'group/row relative overflow-hidden rounded-2xl border bg-card transition-all',
        'hover:border-foreground/15 hover:shadow-[0_2px_24px_-12px_rgba(0,0,0,0.18)]',
        accentBar && 'border-primary/40',
        isDenied && 'opacity-55',
      )}
      style={{ transitionDuration: '180ms', transitionTimingFunction: 'var(--ease-smooth)' }}
    >
      {accentBar && (
        <div
          aria-hidden
          className="absolute left-0 top-0 h-full w-[3px] bg-gradient-to-b from-primary to-primary/40"
        />
      )}

      <div className="grid gap-4 p-4 sm:p-5 md:grid-cols-[auto_1fr_auto] md:items-center md:gap-6">
        {/* Identity */}
        <div className="flex items-center gap-3 md:items-start">
          <RoomTypeIcon
            capacity={room.capacity}
            keywords={[]} // search keywords not yet in picker payload — TODO when backend exposes
            className="h-12 w-12 sm:h-14 sm:w-14"
          />
          <div className="md:hidden">
            <h3 className={cn('text-base font-semibold tracking-tight', isDenied && 'line-through')}>
              {room.name}
            </h3>
            <RoomMeta capacity={room.capacity} floor={floor} />
          </div>
        </div>

        {/* Body */}
        <div className="min-w-0 space-y-2.5">
          <div className="hidden flex-wrap items-baseline gap-x-3 gap-y-1 md:flex">
            <h3
              className={cn(
                'text-lg font-semibold tracking-tight',
                isDenied && 'line-through',
              )}
            >
              {room.name}
            </h3>
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
            <RoomMeta capacity={room.capacity} floor={floor} />
          </div>

          {room.amenities.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {room.amenities.slice(0, 6).map((a) => (
                <span
                  key={a}
                  className="inline-flex h-6 items-center rounded-full bg-muted/70 px-2 text-[11px] capitalize text-foreground/70"
                >
                  {a.replace(/_/g, ' ')}
                </span>
              ))}
              {room.amenities.length > 6 && (
                <span className="text-[11px] text-muted-foreground">
                  +{room.amenities.length - 6}
                </span>
              )}
            </div>
          )}

          {room.ranking_reasons.length > 0 && !isDenied && (
            <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <Sparkles className="size-3 shrink-0 translate-y-0.5 text-amber-500/70" />
              <span>{room.ranking_reasons.join(' · ')}</span>
            </div>
          )}

          {requiresApproval && room.rule_outcome.denial_message && (
            <p className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
              {room.rule_outcome.denial_message}
            </p>
          )}
          {isDenied && showRestricted && room.rule_outcome.denial_message && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[11px] leading-relaxed text-destructive">
              {room.rule_outcome.denial_message} <em className="opacity-70">(visible to service desk)</em>
            </p>
          )}
          {hasWarning && (room.rule_outcome.warning_messages?.length || room.rule_outcome.denial_message) && (
            <p className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
              {room.rule_outcome.warning_messages?.length
                ? room.rule_outcome.warning_messages.join(' · ')
                : room.rule_outcome.denial_message}
            </p>
          )}

          <div className="pt-1">
            <MiniTimelineStrip
              blocks={room.day_blocks}
              requestedStartIso={requestedStartIso}
              requestedEndIso={requestedEndIso}
            />
          </div>
        </div>

        {/* CTA */}
        <div className="flex md:flex-col md:items-end md:justify-center md:gap-2">
          <Button
            size="lg"
            variant={isBestMatch && !isDenied ? 'default' : 'outline'}
            disabled={isDenied}
            onClick={() => onBook(room)}
            className={cn(
              'w-full gap-1.5 md:w-auto md:min-w-[148px]',
              isDenied && 'cursor-not-allowed',
            )}
          >
            {ctaLabel}
            {!isDenied && <ArrowRight className="size-4 opacity-70" />}
          </Button>
        </div>
      </div>
    </article>
  );
}

function RoomMeta({
  capacity,
  floor,
}: {
  capacity: number | null;
  floor: string | undefined;
}) {
  if (capacity == null && !floor) return null;
  return (
    <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground tabular-nums">
      {capacity != null && (
        <span className="inline-flex items-center gap-1">
          <UsersIcon className="size-3" />
          {formatCount(capacity)}
        </span>
      )}
      {floor && (
        <span className="inline-flex items-center gap-1">
          <MapPin className="size-3" />
          {floor}
        </span>
      )}
    </div>
  );
}
