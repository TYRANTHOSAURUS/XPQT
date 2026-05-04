import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RoomSummaryCard } from './room-summary-card';

describe('RoomSummaryCard', () => {
  describe('empty state', () => {
    it('renders the "Pick a room" CTA and invokes onPick on click', async () => {
      const onPick = vi.fn();
      render(
        <RoomSummaryCard
          spaceId={null}
          roomName={null}
          capacity={null}
          onPick={onPick}
          onRemove={vi.fn()}
        />,
      );
      expect(screen.getByText('Pick a room')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Room: Pick a room' }));
      expect(onPick).toHaveBeenCalledTimes(1);
    });
  });

  describe('filled state', () => {
    it('renders name, capacity, and Available badge when available=true', () => {
      render(
        <RoomSummaryCard
          spaceId="space-1"
          roomName="Maple"
          capacity={10}
          available
          onPick={vi.fn()}
          onRemove={vi.fn()}
        />,
      );
      expect(screen.getByText('Maple')).toBeInTheDocument();
      expect(screen.getByText('10 cap')).toBeInTheDocument();
      expect(screen.getByText('Available')).toBeInTheDocument();
      expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
    });

    it('renders Unavailable badge when available=false', () => {
      render(
        <RoomSummaryCard
          spaceId="space-1"
          roomName="Maple"
          capacity={10}
          available={false}
          onPick={vi.fn()}
          onRemove={vi.fn()}
        />,
      );
      expect(screen.getByText('Unavailable')).toBeInTheDocument();
      expect(screen.queryByText('Available')).not.toBeInTheDocument();
    });

    it('renders no availability badge when available is null/undefined', () => {
      render(
        <RoomSummaryCard
          spaceId="space-1"
          roomName="Maple"
          capacity={10}
          onPick={vi.fn()}
          onRemove={vi.fn()}
        />,
      );
      expect(screen.queryByText('Available')).not.toBeInTheDocument();
      expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
    });

    it('invokes onPick when the Change button is clicked', async () => {
      const onPick = vi.fn();
      render(
        <RoomSummaryCard
          spaceId="space-1"
          roomName="Maple"
          capacity={10}
          onPick={onPick}
          onRemove={vi.fn()}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: /change/i }));
      expect(onPick).toHaveBeenCalledTimes(1);
    });

    it('invokes onRemove when the Remove button is clicked', async () => {
      const onRemove = vi.fn();
      render(
        <RoomSummaryCard
          spaceId="space-1"
          roomName="Maple"
          capacity={10}
          onPick={vi.fn()}
          onRemove={onRemove}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: /remove/i }));
      expect(onRemove).toHaveBeenCalledTimes(1);
    });

    it('falls back to "Selected room" when roomName is null', () => {
      render(
        <RoomSummaryCard
          spaceId="space-1"
          roomName={null}
          capacity={null}
          onPick={vi.fn()}
          onRemove={vi.fn()}
        />,
      );
      expect(screen.getByText('Selected room')).toBeInTheDocument();
    });
  });
});
