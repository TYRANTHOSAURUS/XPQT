import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PickerSelection } from '@/components/booking-composer/service-picker-sheet';
import { CateringSummaryCard } from './catering-summary-card';

/**
 * Minimal factory for `PickerSelection` to keep test cases readable. Only
 * fields the card actually reads need realistic values; everything else
 * gets a sane default that satisfies the type.
 */
function selection(overrides: Partial<PickerSelection> = {}): PickerSelection {
  return {
    catalog_item_id: 'item-1',
    menu_id: 'menu-1',
    quantity: 1,
    unit_price: 10,
    unit: 'per_item',
    name: 'Default item',
    service_type: 'catering',
    ...overrides,
  };
}

describe('CateringSummaryCard', () => {
  describe('empty state', () => {
    it('renders the "Add catering" CTA when no catering selections', () => {
      render(
        <CateringSummaryCard
          selections={[]}
          attendeeCount={5}
          onPick={vi.fn()}
          onClearAll={vi.fn()}
        />,
      );
      expect(screen.getByText('Add catering')).toBeInTheDocument();
      expect(screen.queryByText('Suggested')).not.toBeInTheDocument();
    });

    it('renders the Suggested chip with the reason as a tooltip when suggested', () => {
      render(
        <CateringSummaryCard
          selections={[]}
          attendeeCount={5}
          onPick={vi.fn()}
          onClearAll={vi.fn()}
          suggested
          suggestionReason="Most lunch bookings include catering"
        />,
      );
      const chip = screen.getByText('Suggested');
      expect(chip).toBeInTheDocument();
      expect(chip).toHaveAttribute('title', 'Most lunch bookings include catering');
    });

    it('invokes onPick when the empty CTA is clicked', async () => {
      const onPick = vi.fn();
      render(
        <CateringSummaryCard
          selections={[]}
          attendeeCount={5}
          onPick={onPick}
          onClearAll={vi.fn()}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Catering: Add catering' }));
      expect(onPick).toHaveBeenCalledTimes(1);
    });
  });

  describe('filled state', () => {
    it('renders count + total for a single fixed-price item', () => {
      render(
        <CateringSummaryCard
          selections={[
            selection({
              name: 'Coffee tray',
              quantity: 1,
              unit_price: 25,
              unit: 'per_item',
            }),
          ]}
          attendeeCount={1}
          onPick={vi.fn()}
          onClearAll={vi.fn()}
        />,
      );
      expect(screen.getByText('1 item · $25.00')).toBeInTheDocument();
    });

    it('matches legacy math across per_person + flat_rate + per_item', () => {
      // 12 × $8 per_person at attendeeCount=10 → 12 × 8 × 10 = 960
      // flat_rate $50 (quantity ignored) → 50
      // 3 × $4 per_item → 12
      // total = 1022
      render(
        <CateringSummaryCard
          selections={[
            selection({
              name: 'Lunch sandwiches',
              quantity: 12,
              unit_price: 8,
              unit: 'per_person',
            }),
            selection({
              catalog_item_id: 'item-2',
              name: 'Setup fee',
              quantity: 1,
              unit_price: 50,
              unit: 'flat_rate',
            }),
            selection({
              catalog_item_id: 'item-3',
              name: 'Sodas',
              quantity: 3,
              unit_price: 4,
              unit: 'per_item',
            }),
          ]}
          attendeeCount={10}
          onPick={vi.fn()}
          onClearAll={vi.fn()}
        />,
      );
      expect(screen.getByText('3 items · $1,022.00')).toBeInTheDocument();
    });

    it('shows top 2 items inline and " + N more" when more exist', () => {
      render(
        <CateringSummaryCard
          selections={[
            selection({ catalog_item_id: '1', name: 'Lunch sandwiches', quantity: 12 }),
            selection({ catalog_item_id: '2', name: 'Coffee', quantity: 3 }),
            selection({ catalog_item_id: '3', name: 'Tea', quantity: 2 }),
            selection({ catalog_item_id: '4', name: 'Pastries', quantity: 4 }),
            selection({ catalog_item_id: '5', name: 'Water', quantity: 6 }),
          ]}
          attendeeCount={10}
          onPick={vi.fn()}
          onClearAll={vi.fn()}
        />,
      );
      expect(
        screen.getByText('12 × Lunch sandwiches · 3 × Coffee + 3 more'),
      ).toBeInTheDocument();
    });

    it('invokes onPick when Change is clicked', async () => {
      const onPick = vi.fn();
      render(
        <CateringSummaryCard
          selections={[selection()]}
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
        <CateringSummaryCard
          selections={[selection()]}
          attendeeCount={1}
          onPick={vi.fn()}
          onClearAll={onClearAll}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: /remove/i }));
      expect(onClearAll).toHaveBeenCalledTimes(1);
    });

    it('filters out non-catering selections when computing count + breakdown', () => {
      render(
        <CateringSummaryCard
          selections={[
            selection({
              catalog_item_id: 'cat-1',
              name: 'Lunch',
              quantity: 5,
              unit_price: 10,
              unit: 'per_item',
              service_type: 'catering',
            }),
            selection({
              catalog_item_id: 'av-1',
              name: 'Projector',
              quantity: 1,
              unit_price: 200,
              unit: 'per_item',
              service_type: 'av_equipment',
            }),
            selection({
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
      // Only the catering line counts: 5 × $10 = $50.
      expect(screen.getByText('1 item · $50.00')).toBeInTheDocument();
      // Breakdown only shows the catering item, no AV / facilities entries.
      expect(screen.getByText('5 × Lunch')).toBeInTheDocument();
      expect(screen.queryByText(/Projector/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Theater layout/)).not.toBeInTheDocument();
    });
  });
});
