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
        callerPersonId="p1"
        hostFirstName="Alex"
      />,
    );
    expect(screen.queryByTestId('booking-composer-left-pane')).not.toBeInTheDocument();
  });
});
