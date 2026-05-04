import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { QuickBookPopover } from './quick-book-popover';

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
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
        mode="self"
        callerPersonId="p1"
        onBooked={vi.fn()}
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
        mode="self"
        callerPersonId="p1"
        onBooked={vi.fn()}
        onAdvanced={onAdvanced}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /advanced/i }));
    expect(onAdvanced).toHaveBeenCalledTimes(1);
    expect(onAdvanced.mock.calls[0][0].spaceId).toBe('r1');
  });

  // /full-review v1 I7 regression guard — chip selection must survive a
  // parent re-render with new start/end. Prior bug: the reset effect
  // depended on `[open, initialChip]`; `initialChip` recomputed when
  // start/end changed; effect re-fired and clobbered the user's chip.
  //
  // The chip's effect on the draft surfaces via `effectiveEnd` (line
  // 130-138 of quick-book-popover.tsx). Asserting via the draft passed
  // to onAdvanced gives us a behavioural test that doesn't depend on
  // the ToggleGroup's internal data-state attribute.
  it('preserves the user-picked duration chip across a parent re-render with new times', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onAdvanced = vi.fn();

    const renderProps = (endAtIso: string) => (
      <QueryClientProvider client={qc}>
        <MemoryRouter>
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
            endAtIso={endAtIso}
            hostFirstName="Alex"
            mode="self"
            callerPersonId="p1"
            onBooked={vi.fn()}
            onAdvanced={onAdvanced}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );

    const { rerender } = render(renderProps('2026-05-07T10:30:00.000Z'));

    // Pick the 2h chip — a deliberate user choice the effect must NOT
    // wipe when the parent re-renders.
    await userEvent.click(screen.getByRole('button', { name: '2h' }));

    // Parent re-renders with NEW endAtIso (e.g. drag-resize on the
    // scheduler tile underneath the popover). Pre-fix: `initialChip`
    // recomputed to '60', the effect re-fired, chip silently reverted
    // to 30m. Post-fix: only the open-edge fires the reset; chip stays.
    rerender(renderProps('2026-05-07T11:00:00.000Z'));

    // Assert via the resulting draft when the user clicks Advanced.
    await userEvent.click(screen.getByRole('button', { name: /advanced/i }));
    expect(onAdvanced).toHaveBeenCalledTimes(1);
    const draft = onAdvanced.mock.calls[0][0];
    // 2h from 10:00 = 12:00, NOT the parent's 11:00 (drag-resize) and
    // NOT the prior 10:30 (initial). The chip won.
    expect(draft.endAt).toBe('2026-05-07T12:00:00.000Z');
  });
});
