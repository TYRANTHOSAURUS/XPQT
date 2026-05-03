import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QuickBookPopover } from './quick-book-popover';

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('QuickBookPopover', () => {
  it('renders the title input with the expected placeholder', () => {
    renderWithQuery(
      <QuickBookPopover
        open
        onOpenChange={vi.fn()}
        anchorEl={null}
        room={{
          space_id: 'r1',
          name: 'Maple',
          has_av_equipment: false,
          has_catering_vendor: false,
          needs_visitor_pre_registration: false,
        }}
        startAtIso="2026-05-07T10:00:00.000Z"
        endAtIso="2026-05-07T10:30:00.000Z"
        hostFirstName="Alex"
        onBook={vi.fn()}
        onAdvanced={vi.fn()}
      />,
    );
    expect(
      screen.getByPlaceholderText("Alex's Maple booking"),
    ).toBeInTheDocument();
  });

  it('calls onAdvanced with the current draft when Advanced is clicked', async () => {
    const onAdvanced = vi.fn();
    renderWithQuery(
      <QuickBookPopover
        open
        onOpenChange={vi.fn()}
        anchorEl={null}
        room={{
          space_id: 'r1',
          name: 'Maple',
          has_av_equipment: false,
          has_catering_vendor: false,
          needs_visitor_pre_registration: false,
        }}
        startAtIso="2026-05-07T10:00:00.000Z"
        endAtIso="2026-05-07T10:30:00.000Z"
        hostFirstName="Alex"
        onBook={vi.fn()}
        onAdvanced={onAdvanced}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /advanced/i }));
    expect(onAdvanced).toHaveBeenCalledTimes(1);
    expect(onAdvanced.mock.calls[0][0].spaceId).toBe('r1');
  });
});
