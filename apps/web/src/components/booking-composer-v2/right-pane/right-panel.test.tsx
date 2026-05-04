import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RightPanel, type RightPanelView } from './right-panel';

const PICKER_TITLES = {
  room: 'Pick a room',
  catering: 'Add catering',
  av: 'Add AV equipment',
} as const;

interface HarnessProps {
  initialView?: RightPanelView;
  onViewChangeSpy?: (next: RightPanelView) => void;
}

function Harness({ initialView = 'summary', onViewChangeSpy }: HarnessProps) {
  const [view, setView] = useState<RightPanelView>(initialView);
  return (
    <div>
      <div data-testid="current-view">{view}</div>
      <RightPanel
        view={view}
        onViewChange={(next) => {
          onViewChangeSpy?.(next);
          setView(next);
        }}
        pickerTitles={PICKER_TITLES}
        summary={<div data-testid="summary-content">summary content</div>}
        picker={{
          room: <div data-testid="picker-room-content">room picker</div>,
          catering: <div data-testid="picker-catering-content">catering picker</div>,
          av: <div data-testid="picker-av-content">av picker</div>,
        }}
      />
    </div>
  );
}

describe('RightPanel', () => {
  it('renders summary content by default when view is summary', () => {
    render(<Harness initialView="summary" />);
    expect(screen.getByTestId('summary-content')).toBeInTheDocument();
    // Picker contents should not be mounted while on summary
    expect(screen.queryByTestId('picker-room-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('picker-catering-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('picker-av-content')).not.toBeInTheDocument();
    // Back button only exists in the picker frame
    expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
  });

  it('renders the picker:room content with Back button and matching title', () => {
    render(<Harness initialView="picker:room" />);
    expect(screen.getByTestId('picker-room-content')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Pick a room' })).toBeInTheDocument();
    // Summary slot stays mounted (animation needs both panels), so its
    // content is still in the DOM. We only assert the picker is visible.
  });

  it('clicking Back calls onViewChange with summary and reflects the transition', async () => {
    const spy = vi.fn();
    render(<Harness initialView="picker:catering" onViewChangeSpy={spy} />);
    expect(screen.getByTestId('current-view')).toHaveTextContent('picker:catering');

    await userEvent.click(screen.getByRole('button', { name: /back/i }));

    expect(spy).toHaveBeenCalledWith('summary');
    expect(screen.getByTestId('current-view')).toHaveTextContent('summary');
  });

  it('uses the title from pickerTitles prop, not a hardcoded label', () => {
    function CustomTitlesHarness() {
      const [view, setView] = useState<RightPanelView>('picker:room');
      return (
        <RightPanel
          view={view}
          onViewChange={setView}
          pickerTitles={{
            room: 'Custom room title',
            catering: 'Custom catering title',
            av: 'Custom AV title',
          }}
          summary={<div>summary</div>}
          picker={{
            room: <div>room</div>,
            catering: <div>catering</div>,
            av: <div>av</div>,
          }}
        />
      );
    }
    render(<CustomTitlesHarness />);
    expect(
      screen.getByRole('heading', { level: 3, name: 'Custom room title' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Pick a room')).not.toBeInTheDocument();
  });

  it.each([
    {
      view: 'picker:catering' as const,
      contentTestId: 'picker-catering-content',
      title: 'Add catering',
    },
    {
      view: 'picker:av' as const,
      contentTestId: 'picker-av-content',
      title: 'Add AV equipment',
    },
  ])('renders the correct picker slot for view %s', ({ view, contentTestId, title }) => {
    render(<Harness initialView={view} />);
    expect(screen.getByTestId(contentTestId)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: title })).toBeInTheDocument();
  });
});
