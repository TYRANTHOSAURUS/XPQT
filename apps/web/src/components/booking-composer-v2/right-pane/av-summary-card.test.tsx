import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PickerSelection } from '@/components/booking-composer/service-picker-sheet';
import { AvSummaryCard } from './av-summary-card';

/**
 * Minimal factory for `PickerSelection` defaulting to an AV item, so the
 * happy-path tests don't have to repeat `service_type: 'av_equipment'` on
 * every line.
 */
function avSelection(overrides: Partial<PickerSelection> = {}): PickerSelection {
  return {
    catalog_item_id: 'av-1',
    menu_id: 'menu-av-1',
    quantity: 1,
    unit_price: 50,
    unit: 'per_item',
    name: 'Default AV item',
    service_type: 'av_equipment',
    ...overrides,
  };
}

describe('AvSummaryCard', () => {
  describe('empty state', () => {
    it('renders the "Add AV equipment" CTA when no AV selections', () => {
      render(
        <AvSummaryCard
          selections={[]}
          attendeeCount={5}
          onPick={vi.fn()}
          onClearAll={vi.fn()}
        />,
      );
      expect(screen.getByText('Add AV equipment')).toBeInTheDocument();
      expect(screen.queryByText('Suggested')).not.toBeInTheDocument();
    });

    it('renders the Suggested chip with the reason as a tooltip when suggested', () => {
      render(
        <AvSummaryCard
          selections={[]}
          attendeeCount={5}
          onPick={vi.fn()}
          onClearAll={vi.fn()}
          suggested
          suggestionReason="Most all-hands bookings need a projector"
        />,
      );
      const chip = screen.getByText('Suggested');
      expect(chip).toBeInTheDocument();
      expect(chip).toHaveAttribute('title', 'Most all-hands bookings need a projector');
    });

    it('invokes onPick when the empty CTA is clicked', async () => {
      const onPick = vi.fn();
      render(
        <AvSummaryCard
          selections={[]}
          attendeeCount={5}
          onPick={onPick}
          onClearAll={vi.fn()}
        />,
      );
      await userEvent.click(
        screen.getByRole('button', { name: 'AV equipment: Add AV equipment' }),
      );
      expect(onPick).toHaveBeenCalledTimes(1);
    });
  });

  describe('filled state', () => {
    it('renders count + total for a single fixed-price item', () => {
      render(
        <AvSummaryCard
          selections={[
            avSelection({
              name: 'Projector',
              quantity: 1,
              unit_price: 200,
              unit: 'per_item',
            }),
          ]}
          attendeeCount={1}
          onPick={vi.fn()}
          onClearAll={vi.fn()}
        />,
      );
      expect(screen.getByText('1 item · $200.00')).toBeInTheDocument();
    });

    it('matches legacy math across per_person + flat_rate + per_item', () => {
      // 4 × $5 per_person at attendeeCount=20 → 4 × 5 × 20 = 400
      // flat_rate $150 (quantity ignored) → 150
      // 2 × $75 per_item → 150
      // total = 700
      render(
        <AvSummaryCard
          selections={[
            avSelection({
              catalog_item_id: 'av-headsets',
              name: 'Wireless headsets',
              quantity: 4,
              unit_price: 5,
              unit: 'per_person',
            }),
            avSelection({
              catalog_item_id: 'av-techfee',
              name: 'On-site tech fee',
              quantity: 1,
              unit_price: 150,
              unit: 'flat_rate',
            }),
            avSelection({
              catalog_item_id: 'av-mics',
              name: 'Handheld mics',
              quantity: 2,
              unit_price: 75,
              unit: 'per_item',
            }),
          ]}
          attendeeCount={20}
          onPick={vi.fn()}
          onClearAll={vi.fn()}
        />,
      );
      expect(screen.getByText('3 items · $700.00')).toBeInTheDocument();
    });

    it('shows top 2 items inline and " + N more" when more exist', () => {
      render(
        <AvSummaryCard
          selections={[
            avSelection({ catalog_item_id: '1', name: 'Projector', quantity: 1 }),
            avSelection({ catalog_item_id: '2', name: 'HDMI cable', quantity: 2 }),
            avSelection({ catalog_item_id: '3', name: 'Lavalier mic', quantity: 3 }),
            avSelection({ catalog_item_id: '4', name: 'Speaker', quantity: 2 }),
            avSelection({ catalog_item_id: '5', name: 'Clicker', quantity: 1 }),
          ]}
          attendeeCount={10}
          onPick={vi.fn()}
          onClearAll={vi.fn()}
        />,
      );
      expect(
        screen.getByText('1 × Projector · 2 × HDMI cable + 3 more'),
      ).toBeInTheDocument();
    });

    it('invokes onPick when Change is clicked', async () => {
      const onPick = vi.fn();
      render(
        <AvSummaryCard
          selections={[avSelection()]}
          attendeeCount={1}
          onPick={onPick}
          onClearAll={vi.fn()}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: /change/i }));
      expect(onPick).toHaveBeenCalledTimes(1);
    });

    it('invokes onClearAll when Remove is clicked', async () => {
      const onClearAll = vi.fn();
      render(
        <AvSummaryCard
          selections={[avSelection()]}
          attendeeCount={1}
          onPick={vi.fn()}
          onClearAll={onClearAll}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: /remove/i }));
      expect(onClearAll).toHaveBeenCalledTimes(1);
    });

    it('filters out non-AV selections when computing count + breakdown', () => {
      render(
        <AvSummaryCard
          selections={[
            avSelection({
              catalog_item_id: 'av-1',
              name: 'Projector',
              quantity: 1,
              unit_price: 200,
              unit: 'per_item',
              service_type: 'av_equipment',
            }),
            avSelection({
              catalog_item_id: 'cat-1',
              name: 'Lunch',
              quantity: 5,
              unit_price: 10,
              unit: 'per_item',
              service_type: 'catering',
            }),
            avSelection({
              catalog_item_id: 'fac-1',
              name: 'Theater layout',
              quantity: 1,
              unit_price: 100,
              unit: 'flat_rate',
              service_type: 'facilities_services',
            }),
          ]}
          attendeeCount={10}
          onPick={vi.fn()}
          onClearAll={vi.fn()}
        />,
      );
      // Only the AV line counts: 1 × $200 = $200.
      expect(screen.getByText('1 item · $200.00')).toBeInTheDocument();
      // Breakdown only shows the AV item, no catering / facilities entries.
      expect(screen.getByText('1 × Projector')).toBeInTheDocument();
      expect(screen.queryByText(/Lunch/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Theater layout/)).not.toBeInTheDocument();
    });
  });
});
