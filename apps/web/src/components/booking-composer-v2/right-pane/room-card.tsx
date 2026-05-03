import { MapPin } from 'lucide-react';
import { AddinCard } from './addin-card';
import { RoomPickerInline } from '@/components/booking-composer/sections/room-picker-inline';

export interface RoomCardProps {
  spaceId: string | null;
  roomName: string | null;
  capacity: number | null;
  attendeeCount: number;
  expanded: boolean;
  onToggle: (next: boolean) => void;
  onChange: (spaceId: string | null) => void;
}

export function RoomCard({
  spaceId,
  roomName,
  capacity,
  attendeeCount,
  expanded,
  onToggle,
  onChange,
}: RoomCardProps) {
  const summary = roomName
    ? `${roomName}${capacity != null ? ` · ${capacity} cap` : ''}`
    : undefined;
  return (
    <AddinCard
      icon={MapPin}
      title="Room"
      emptyPrompt="Pick a room"
      summary={summary}
      filled={Boolean(spaceId)}
      expanded={expanded}
      onToggle={onToggle}
    >
      <RoomPickerInline
        value={spaceId}
        attendeeCount={attendeeCount}
        excludeIds={[]}
        onChange={onChange}
      />
    </AddinCard>
  );
}
