import { MapPin } from 'lucide-react';
import { SummaryCard } from './summary-card';

export interface RoomSummaryCardProps {
  spaceId: string | null;
  roomName: string | null;
  capacity: number | null;
  /**
   * Tri-state availability:
   * - `true`: room is available — show green "Available" pill.
   * - `false`: room is unavailable — show red "Unavailable" pill.
   * - `null` / `undefined`: signal unknown — render no pill.
   */
  available?: boolean | null;
  /** Open the room picker (parent typically calls `setView('picker:room')`). */
  onPick: () => void;
  /** Clear the draft `spaceId` via the parent. */
  onRemove: () => void;
}

/**
 * Summary-only domain card for the right pane's room slot. Two states:
 *
 * - **Empty** (`spaceId == null`): renders the `<SummaryCard>` empty CTA
 *   inviting the user to pick a room. No suggestion is wired here — room
 *   is mandatory and the Suggested chip is reserved for catering + AV.
 * - **Filled** (`spaceId != null`): renders a two-line summary —
 *   room name on line 1, "<capacity> cap" + optional Available/Unavailable
 *   pill on line 2 — plus the SummaryCard's Change/Remove action row.
 *
 * Picker UI lives elsewhere (modal `picker:room` slot); this card is
 * read-only state + entry points back into the picker.
 */
export function RoomSummaryCard({
  spaceId,
  roomName,
  capacity,
  available,
  onPick,
  onRemove,
}: RoomSummaryCardProps) {
  if (spaceId == null) {
    return (
      <SummaryCard
        icon={MapPin}
        title="Room"
        emptyPrompt="Pick a room"
        onChange={onPick}
      />
    );
  }

  const displayName = roomName ?? 'Selected room';
  const capLabel = capacity != null ? `${capacity} cap` : null;

  let availabilityPill: React.ReactNode = null;
  if (available === true) {
    availabilityPill = (
      <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
        Available
      </span>
    );
  } else if (available === false) {
    availabilityPill = (
      <span className="inline-flex items-center rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">
        Unavailable
      </span>
    );
  }

  const summary = (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-foreground">{displayName}</span>
      {(capLabel || availabilityPill) && (
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {capLabel && <span className="tabular-nums">{capLabel}</span>}
          {availabilityPill}
        </span>
      )}
    </div>
  );

  return (
    <SummaryCard
      icon={MapPin}
      title="Room"
      emptyPrompt="Pick a room"
      filled
      summary={summary}
      onChange={onPick}
      onRemove={onRemove}
    />
  );
}
