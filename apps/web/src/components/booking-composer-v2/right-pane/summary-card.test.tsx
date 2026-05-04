import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Bed } from 'lucide-react';
import { SummaryCard } from './summary-card';

describe('SummaryCard', () => {
  describe('empty state', () => {
    it('renders title and emptyPrompt without Change/Remove buttons', () => {
      render(
        <SummaryCard icon={Bed} title="Room" emptyPrompt="Pick a room" onChange={vi.fn()} />,
      );
      expect(screen.getByText('Room')).toBeInTheDocument();
      expect(screen.getByText('Pick a room')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /change/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
    });

    it('renders the Suggested chip when suggested is true', () => {
      render(
        <SummaryCard
          icon={Bed}
          title="Room"
          emptyPrompt="Pick a room"
          onChange={vi.fn()}
          suggested
          suggestionReason="Capacity matches headcount"
        />,
      );
      expect(screen.getByText('Suggested')).toBeInTheDocument();
    });

    it('does not render the Suggested chip by default', () => {
      render(
        <SummaryCard icon={Bed} title="Room" emptyPrompt="Pick a room" onChange={vi.fn()} />,
      );
      expect(screen.queryByText('Suggested')).not.toBeInTheDocument();
    });

    it('calls onChange when the empty card is clicked', async () => {
      const onChange = vi.fn();
      render(
        <SummaryCard icon={Bed} title="Room" emptyPrompt="Pick a room" onChange={onChange} />,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Room: Pick a room' }));
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('exposes an aria-label combining title and emptyPrompt', () => {
      render(
        <SummaryCard icon={Bed} title="Room" emptyPrompt="Pick a room" onChange={vi.fn()} />,
      );
      expect(
        screen.getByRole('button', { name: 'Room: Pick a room' }),
      ).toBeInTheDocument();
    });
  });

  describe('filled state', () => {
    it('renders summary content and Change button; omits Remove when onRemove not given', () => {
      render(
        <SummaryCard
          icon={Bed}
          title="Room"
          emptyPrompt="Pick a room"
          filled
          summary={<span data-testid="summary-body">Maple · 8 seats</span>}
          onChange={vi.fn()}
        />,
      );
      expect(screen.getByTestId('summary-body')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /change/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
    });

    it('renders Remove button when onRemove is provided', () => {
      render(
        <SummaryCard
          icon={Bed}
          title="Room"
          emptyPrompt="Pick a room"
          filled
          summary={<span>Maple · 8 seats</span>}
          onChange={vi.fn()}
          onRemove={vi.fn()}
        />,
      );
      expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
    });

    it('calls onChange when the Change button is clicked', async () => {
      const onChange = vi.fn();
      render(
        <SummaryCard
          icon={Bed}
          title="Room"
          emptyPrompt="Pick a room"
          filled
          summary={<span>Maple · 8 seats</span>}
          onChange={onChange}
          onRemove={vi.fn()}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: /change/i }));
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('calls onRemove when the Remove button is clicked', async () => {
      const onRemove = vi.fn();
      render(
        <SummaryCard
          icon={Bed}
          title="Room"
          emptyPrompt="Pick a room"
          filled
          summary={<span>Maple · 8 seats</span>}
          onChange={vi.fn()}
          onRemove={onRemove}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: /remove/i }));
      expect(onRemove).toHaveBeenCalledTimes(1);
    });
  });
});
