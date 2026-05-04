import { Coffee } from 'lucide-react';
import type { PickerSelection } from '@/components/booking-composer/service-picker-sheet';
import { formatCurrency } from '@/lib/format';
import { SummaryCard } from './summary-card';

export interface CateringSummaryCardProps {
  selections: PickerSelection[];
  attendeeCount: number;
  /** Open the catering picker (modal wires this to `setView('picker:catering')`). */
  onPick: () => void;
  /** Clear all catering-only selections (modal handler filters them out). */
  onClearAll: () => void;
  suggested?: boolean;
  suggestionReason?: string;
}

/**
 * Compute the running total for catering-only selections. Mirrors the
 * legacy add-in card's math exactly so the right-pane redesign doesn't
 * silently change pricing semantics:
 *
 * - `unit === 'per_person'` → unit_price × quantity × max(1, attendees)
 * - `unit === 'flat_rate'`  → unit_price (quantity ignored, by design)
 * - everything else (incl. `'per_item'` and `null`) → unit_price × quantity
 * - any line with `unit_price == null` is a "ask for a quote" line and
 *   contributes 0 to the total.
 */
function computeCateringTotal(items: PickerSelection[], attendeeCount: number): number {
  return items.reduce((sum, s) => {
    if (s.unit_price == null) return sum;
    if (s.unit === 'per_person') {
      return sum + s.unit_price * s.quantity * Math.max(1, attendeeCount);
    }
    if (s.unit === 'flat_rate') {
      return sum + s.unit_price;
    }
    return sum + s.unit_price * s.quantity;
  }, 0);
}

/**
 * Summary-only domain card for the right pane's catering slot. Two states:
 *
 * - **Empty** (no catering selections): renders the SummaryCard empty CTA
 *   inviting the user to add catering. Optionally shows the Suggested chip
 *   when the parent has decided this booking should suggest catering.
 * - **Filled** (≥1 catering selection): renders a two-line summary —
 *   `N item(s) · €total` on line 1 (medium weight, tabular-nums); a
 *   comma-separated `qty × name` breakdown of the first two items on line 2,
 *   with a trailing " + N more" if there are extra. The SummaryCard's
 *   Change/Remove action row handles re-opening the picker and clearing.
 *
 * Picker UI lives elsewhere (modal `picker:catering` slot); this card is
 * read-only state + entry points back into the picker.
 */
export function CateringSummaryCard({
  selections,
  attendeeCount,
  onPick,
  onClearAll,
  suggested,
  suggestionReason,
}: CateringSummaryCardProps) {
  const cateringItems = selections.filter((s) => s.service_type === 'catering');

  if (cateringItems.length === 0) {
    return (
      <SummaryCard
        icon={Coffee}
        title="Catering"
        emptyPrompt="Add catering"
        onChange={onPick}
        suggested={suggested}
        suggestionReason={suggestionReason}
      />
    );
  }

  const total = computeCateringTotal(cateringItems, attendeeCount);
  const itemCountLabel = `${cateringItems.length} item${cateringItems.length !== 1 ? 's' : ''}`;
  const headline = `${itemCountLabel} · ${formatCurrency(total)}`;

  const visibleItems = cateringItems.slice(0, 2);
  const overflow = cateringItems.length - visibleItems.length;
  const breakdown =
    visibleItems.map((s) => `${s.quantity} × ${s.name}`).join(' · ') +
    (overflow > 0 ? ` + ${overflow} more` : '');

  const summary = (
    <div className="flex flex-col gap-0.5">
      <span className="tabular-nums text-sm font-medium text-foreground">{headline}</span>
      <span className="text-xs text-muted-foreground">{breakdown}</span>
    </div>
  );

  return (
    <SummaryCard
      icon={Coffee}
      title="Catering"
      emptyPrompt="Add catering"
      filled
      summary={summary}
      onChange={onPick}
      onRemove={onClearAll}
    />
  );
}
