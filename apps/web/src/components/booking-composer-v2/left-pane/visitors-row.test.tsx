import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VisitorsRow } from './visitors-row';

describe('VisitorsRow', () => {
  it('renders existing visitors as chips with a remove control', async () => {
    const onRemove = vi.fn();
    render(
      <VisitorsRow
        visitors={[
          {
            local_id: 'v1',
            first_name: 'Alex',
            email: 'a@x.com',
            visitor_type_id: 'vt',
          },
        ]}
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onRemove={onRemove}
        bookingDefaults={{}}
        disabled={false}
      />,
    );
    expect(screen.getByText('Alex')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: /remove visitor alex/i }),
    );
    expect(onRemove).toHaveBeenCalledWith('v1');
  });

  it('renders the disabled hint when disabled', () => {
    render(
      <VisitorsRow
        visitors={[]}
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
        bookingDefaults={{}}
        disabled
        disabledReason="Pick a room first."
      />,
    );
    expect(screen.getByText('Pick a room first.')).toBeInTheDocument();
  });
});
