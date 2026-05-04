import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TimesSummaryCard } from './times-summary-card';

// Use timestamps without `Z` so the runtime parses them as local time —
// keeps the local-day comparison deterministic regardless of CI timezone.
// `formatTimeShort` uses the runtime's default locale, so we assert only on
// stable patterns (digits + en-dash) rather than the AM/PM suffix.

describe('TimesSummaryCard', () => {
  describe('empty state', () => {
    it('renders the empty CTA when startAt is null', () => {
      render(<TimesSummaryCard startAt={null} endAt="2026-05-07T11:00:00" onPick={vi.fn()} />);
      expect(screen.getByText('Set start and end time')).toBeInTheDocument();
    });

    it('renders the empty CTA when endAt is null', () => {
      render(<TimesSummaryCard startAt="2026-05-07T10:00:00" endAt={null} onPick={vi.fn()} />);
      expect(screen.getByText('Set start and end time')).toBeInTheDocument();
    });

    it('invokes onPick when the empty CTA is clicked', async () => {
      const onPick = vi.fn();
      render(<TimesSummaryCard startAt={null} endAt={null} onPick={onPick} />);
      await userEvent.click(screen.getByRole('button', { name: 'When: Set start and end time' }));
      expect(onPick).toHaveBeenCalledTimes(1);
    });
  });

  describe('filled state — same day', () => {
    it('renders weekday-date line and time range with en-dash', () => {
      render(
        <TimesSummaryCard
          startAt="2026-05-07T10:00:00"
          endAt="2026-05-07T11:00:00"
          onPick={vi.fn()}
        />,
      );
      // Weekday-date formatter is locked to en-US, so this is stable.
      expect(screen.getByText(/Thu, May 7/)).toBeInTheDocument();
      // Time digits + en-dash (U+2013), tz-agnostic.
      expect(screen.getByText(/10:00.*–.*11:00/)).toBeInTheDocument();
    });

    it('does not render a Remove button (times are mandatory)', () => {
      render(
        <TimesSummaryCard
          startAt="2026-05-07T10:00:00"
          endAt="2026-05-07T11:00:00"
          onPick={vi.fn()}
        />,
      );
      expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
    });

    it('invokes onPick when the Change button is clicked', async () => {
      const onPick = vi.fn();
      render(
        <TimesSummaryCard
          startAt="2026-05-07T10:00:00"
          endAt="2026-05-07T11:00:00"
          onPick={onPick}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: /change/i }));
      expect(onPick).toHaveBeenCalledTimes(1);
    });
  });

  describe('filled state — cross-day overnight booking', () => {
    it('renders single line containing both date labels', () => {
      render(
        <TimesSummaryCard
          startAt="2026-05-07T22:00:00"
          endAt="2026-05-08T02:00:00"
          onPick={vi.fn()}
        />,
      );
      // Both endpoints rendered with their own date label, joined by en-dash.
      expect(screen.getByText(/Thu, May 7.*–.*Fri, May 8/)).toBeInTheDocument();
    });
  });
});
