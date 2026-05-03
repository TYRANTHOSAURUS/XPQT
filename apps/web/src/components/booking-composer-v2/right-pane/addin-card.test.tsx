import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Coffee } from 'lucide-react';
import { AddinCard } from './addin-card';

describe('AddinCard', () => {
  it('renders the collapsed state with an empty prompt', () => {
    render(
      <AddinCard
        icon={Coffee}
        title="Catering"
        emptyPrompt="Add catering"
        filled={false}
        expanded={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('Add catering')).toBeInTheDocument();
  });

  it('shows the Suggested chip when suggested is true', () => {
    render(
      <AddinCard
        icon={Coffee}
        title="Catering"
        emptyPrompt="Add catering"
        filled={false}
        expanded={false}
        onToggle={vi.fn()}
        suggested
        suggestionReason="Booking spans lunch"
      />,
    );
    expect(screen.getByText('Suggested')).toBeInTheDocument();
  });

  it('calls onToggle when the header is clicked', async () => {
    const onToggle = vi.fn();
    render(
      <AddinCard
        icon={Coffee}
        title="Catering"
        emptyPrompt="Add catering"
        filled={false}
        expanded={false}
        onToggle={onToggle}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /catering/i }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('renders children inside the expanded body', () => {
    render(
      <AddinCard
        icon={Coffee}
        title="Catering"
        emptyPrompt="Add catering"
        filled={false}
        expanded={true}
        onToggle={vi.fn()}
      >
        <div data-testid="addin-body">picker goes here</div>
      </AddinCard>,
    );
    expect(screen.getByTestId('addin-body')).toBeInTheDocument();
  });
});
