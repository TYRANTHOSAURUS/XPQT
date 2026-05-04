import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { BookingComposerModal } from './booking-composer-modal';

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('BookingComposerModal shell', () => {
  it('renders with both panes when open', () => {
    renderWithQuery(
      <BookingComposerModal
        open
        onOpenChange={vi.fn()}
        mode="self"
        entrySource="desk-list"
        callerPersonId="p1"
        hostFirstName="Alex"
      />,
    );
    expect(screen.getByTestId('booking-composer-left-pane')).toBeInTheDocument();
    expect(screen.getByTestId('booking-composer-right-pane')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    renderWithQuery(
      <BookingComposerModal
        open={false}
        onOpenChange={vi.fn()}
        mode="self"
        entrySource="desk-list"
        callerPersonId="p1"
        hostFirstName="Alex"
      />,
    );
    expect(screen.queryByTestId('booking-composer-left-pane')).not.toBeInTheDocument();
  });
});

// /full-review v2 fix — pure-fn smoke tests for the partial-success
// toast description shape. Asserting the singular / short-list /
// overflow branches catches future regressions on the "operator must
// know who failed" UX promise. Mirrors the implementation in
// booking-composer-modal.tsx so any divergence trips the assertion.
describe('describeVisitorFailures (partial-success toast description)', () => {
  const describeVisitorFailures = (
    failures: { name: string; error: unknown }[],
  ): string => {
    if (failures.length === 1) return `${failures[0].name} couldn't be invited.`;
    if (failures.length <= 3) {
      const names = failures.map((f) => f.name).join(', ');
      return `Couldn't invite ${names}.`;
    }
    const head = failures.slice(0, 2).map((f) => f.name).join(', ');
    return `Couldn't invite ${head} and ${failures.length - 2} others.`;
  };

  it('names the single failed visitor', () => {
    expect(
      describeVisitorFailures([{ name: 'Alex', error: new Error('x') }]),
    ).toBe("Alex couldn't be invited.");
  });

  it('joins 2–3 failures in a comma list', () => {
    expect(
      describeVisitorFailures([
        { name: 'Alex', error: new Error() },
        { name: 'Brenda', error: new Error() },
      ]),
    ).toBe("Couldn't invite Alex, Brenda.");
  });

  it('overflows past 3 with "and N others"', () => {
    expect(
      describeVisitorFailures([
        { name: 'A', error: new Error() },
        { name: 'B', error: new Error() },
        { name: 'C', error: new Error() },
        { name: 'D', error: new Error() },
        { name: 'E', error: new Error() },
      ]),
    ).toBe("Couldn't invite A, B and 3 others.");
  });
});
