import { AlertTriangle, ChevronRight, ExternalLink, Plus, Users, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { InlineBanner } from '@/components/ui/inline-banner';
import { RoomThumbnail } from '@/components/room-thumbnail';
import { amenityMeta } from '@/components/room-amenities';
import { SPACE_TYPE_LABELS } from '@/components/admin/space-type-icon';
import type { SchedulerRoom } from '@/api/room-booking';
import type { SpaceType } from '@prequest/shared';
import { cn } from '@/lib/utils';

interface Props {
  room: SchedulerRoom;
  onClose: () => void;
  onBook: (room: SchedulerRoom) => void;
}

const STATUS_COPY: Record<string, { label: string; tone: string }> = {
  deny: { label: 'Booking denied', tone: 'bg-destructive/10 text-destructive' },
  require_approval: {
    label: 'Requires approval',
    tone: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
  warn: {
    label: 'Warning on booking',
    tone: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
  },
  allow: {
    label: 'Available',
    tone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  },
  allow_override: {
    label: 'Available',
    tone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  },
};

/**
 * Right-pinned inspector panel. Replaces the click-through modal —
 * keeps the canvas visible behind the panel and lets operators flip
 * between rooms without re-mounting a portal each time. The panel is
 * mounted by the page only when a room is selected; collapsed state
 * returns the full width to the calendar canvas.
 *
 * Width: 360px, fixed. Wider would crowd the calendar at typical 1440
 * monitors; narrower clips the hero image's aspect ratio.
 */
export function SchedulerInspector({ room, onClose, onBook }: Props) {
  const status = STATUS_COPY[room.rule_outcome.effect] ?? STATUS_COPY.allow;
  const typeLabel = SPACE_TYPE_LABELS[room.space_type as SpaceType] ?? room.space_type;
  const breadcrumb = room.parent_chain.map((c) => c.name);
  const denied = room.rule_outcome.effect === 'deny';

  return (
    <aside
      aria-label="Room details"
      className="flex w-[360px] shrink-0 flex-col border-l bg-background"
    >
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Room details
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close inspector"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        <RoomThumbnail
          variant="hero"
          imageUrl={room.image_url}
          capacity={room.capacity}
          keywords={room.keywords}
          maxWidth={720}
        />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold leading-tight">{room.name}</h2>
            <span
              className={cn(
                'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
                status.tone,
              )}
            >
              {status.label}
            </span>
          </div>
          {breadcrumb.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground/70">
                {typeLabel}
              </span>
              {breadcrumb.map((name, idx) => (
                <span key={`${name}-${idx}`} className="inline-flex items-center gap-1">
                  <ChevronRight className="size-3 text-muted-foreground/50" />
                  <span className="truncate">{name}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <DetailBlock label="Capacity">
            <div className="flex items-baseline gap-2">
              <Users className="size-4 text-foreground/70" aria-hidden />
              <span className="text-2xl font-semibold tabular-nums">
                {room.capacity ?? '—'}
              </span>
              {room.capacity != null && (
                <span className="text-xs text-muted-foreground">seats</span>
              )}
            </div>
            {room.min_attendees != null && room.min_attendees > 1 && (
              <span className="text-[11px] text-muted-foreground">
                Minimum {room.min_attendees} attendees
              </span>
            )}
          </DetailBlock>

          <DetailBlock label="Type">
            <span className="text-sm">{typeLabel}</span>
          </DetailBlock>
        </div>

        <DetailBlock label={`Amenities${room.amenities.length > 0 ? ` (${room.amenities.length})` : ''}`}>
          {room.amenities.length === 0 ? (
            <span className="text-xs text-muted-foreground">None set</span>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {room.amenities.map((slug) => {
                const { Icon, label } = amenityMeta(slug);
                return (
                  <li
                    key={slug}
                    className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-xs"
                  >
                    {Icon ? (
                      <Icon className="size-3.5 text-foreground/70" aria-hidden />
                    ) : null}
                    <span>{label}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </DetailBlock>

        {room.keywords.length > 0 && (
          <DetailBlock label="Tags">
            <div className="flex flex-wrap gap-1">
              {room.keywords.map((kw) => (
                <span
                  key={kw}
                  className="rounded bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                >
                  {kw}
                </span>
              ))}
            </div>
          </DetailBlock>
        )}

        {room.rule_outcome.denial_message && (
          <InlineBanner tone="destructive" icon={AlertTriangle} role="status">
            <span className="text-destructive">{room.rule_outcome.denial_message}</span>
          </InlineBanner>
        )}
      </div>

      {/* Footer CTAs — Book is the primary action so it gets default
          variant and a prominent place. Open settings is a secondary
          jump-to-admin escape hatch for power users. The Book button is
          disabled on deny, with the denial message above explaining why. */}
      <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-4 py-3">
        <Button
          variant="outline"
          size="sm"
          render={
            <Link to={`/admin/locations/${room.space_id}`} />
          }
        >
          <ExternalLink className="size-3.5" />
          Settings
        </Button>
        <Button
          size="sm"
          disabled={denied}
          onClick={() => onBook(room)}
        >
          <Plus className="size-3.5" />
          Book this room
        </Button>
      </div>
    </aside>
  );
}

function DetailBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}
