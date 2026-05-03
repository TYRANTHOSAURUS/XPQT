import { Coffee } from 'lucide-react';
import { AddinCard } from './addin-card';
import { ServicePickerBody, type PickerSelection } from '@/components/booking-composer/service-picker-sheet';
import { formatCurrency } from '@/lib/format';

export interface CateringCardProps {
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

export function CateringCard({
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
}: CateringCardProps) {
  const cateringSelections = selections.filter((s) => s.service_type === 'catering');
  const total = cateringSelections.reduce((sum, s) => {
    if (s.unit_price == null) return sum;
    if (s.unit === 'per_person') return sum + s.unit_price * s.quantity * Math.max(1, attendeeCount);
    if (s.unit === 'flat_rate') return sum + s.unit_price;
    return sum + s.unit_price * s.quantity;
  }, 0);
  const summary = cateringSelections.length
    ? `${cateringSelections.length} item${cateringSelections.length !== 1 ? 's' : ''} · ${formatCurrency(total)}`
    : undefined;
  const onDate = startAt ? startAt.slice(0, 10) : null;
  return (
    <AddinCard
      icon={Coffee}
      title="Catering"
      emptyPrompt="Add catering"
      summary={summary}
      filled={cateringSelections.length > 0}
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
        initialServiceType="catering"
      />
    </AddinCard>
  );
}
