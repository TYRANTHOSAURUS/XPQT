import { Speaker } from 'lucide-react';
import { AddinCard } from './addin-card';
import { ServicePickerBody, type PickerSelection } from '@/components/booking-composer/service-picker-sheet';

export interface AvCardProps {
  spaceId: string | null;
  startAt: string | null;
  endAt: string | null;
  attendeeCount: number;
  selections: PickerSelection[];
  onSelectionsChange: (next: PickerSelection[]) => void;
  expanded: boolean;
  onToggle: (next: boolean) => void;
  suggested?: boolean;
  suggestionReason?: string;
}

export function AvCard({
  spaceId,
  startAt,
  endAt,
  attendeeCount,
  selections,
  onSelectionsChange,
  expanded,
  onToggle,
  suggested,
  suggestionReason,
}: AvCardProps) {
  const av = selections.filter((s) => s.service_type === 'av_equipment');
  const summary = av.length
    ? `${av.length} item${av.length !== 1 ? 's' : ''}`
    : undefined;
  const onDate = startAt ? startAt.slice(0, 10) : null;
  return (
    <AddinCard
      icon={Speaker}
      title="AV equipment"
      emptyPrompt="Add AV equipment"
      summary={summary}
      filled={av.length > 0}
      expanded={expanded}
      onToggle={onToggle}
      suggested={suggested}
      suggestionReason={suggestionReason}
    >
      <ServicePickerBody
        deliverySpaceId={spaceId}
        onDate={onDate}
        attendeeCount={attendeeCount}
        bookingStartAt={startAt}
        bookingEndAt={endAt}
        selections={selections}
        onSelectionsChange={onSelectionsChange}
        initialServiceType="av_equipment"
      />
    </AddinCard>
  );
}
