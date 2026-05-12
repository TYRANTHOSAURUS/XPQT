import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import type { WorkOrderPlanningBlock } from '@prequest/shared';
import { PlanningBlock } from './planning-block';

function makeBlock(overrides?: Partial<WorkOrderPlanningBlock>): WorkOrderPlanningBlock {
  return {
    id: 'wo-1',
    module_number: 42,
    title: 'Sample work order',
    status_category: 'in_progress',
    priority: 'medium',
    planned_start_at: '2026-05-12T10:00:00.000Z',
    planned_duration_minutes: 60,
    sla_resolution_due_at: null,
    lane: { kind: 'user', id: 'u-1', label: 'Alex' },
    request_type: null,
    can_plan: true,
    ...overrides,
  };
}

function renderBlock(props: Partial<React.ComponentProps<typeof PlanningBlock>>) {
  return render(
    <MemoryRouter>
      <PlanningBlock
        block={makeBlock()}
        leftPct={0}
        widthPct={20}
        startIso="2026-05-12T10:00:00.000Z"
        endIso="2026-05-12T11:00:00.000Z"
        cellMinutes={30}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('PlanningBlock — keyboard nudges (P1-3)', () => {
  it('ArrowRight fires onKeyboardMove(+cellMinutes)', async () => {
    const user = userEvent.setup();
    const onKeyboardMove = vi.fn();
    renderBlock({ onKeyboardMove });
    const block = screen.getByRole('button');
    block.focus();
    await user.keyboard('{ArrowRight}');
    expect(onKeyboardMove).toHaveBeenCalledTimes(1);
    expect(onKeyboardMove.mock.calls[0][1]).toBe(30);
  });

  it('ArrowLeft fires onKeyboardMove(-cellMinutes)', async () => {
    const user = userEvent.setup();
    const onKeyboardMove = vi.fn();
    renderBlock({ onKeyboardMove });
    screen.getByRole('button').focus();
    await user.keyboard('{ArrowLeft}');
    expect(onKeyboardMove.mock.calls[0][1]).toBe(-30);
  });

  it('Shift+ArrowRight fires onKeyboardMove(+30) regardless of cellMinutes', async () => {
    const user = userEvent.setup();
    const onKeyboardMove = vi.fn();
    renderBlock({ onKeyboardMove, cellMinutes: 15 });
    screen.getByRole('button').focus();
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(onKeyboardMove.mock.calls[0][1]).toBe(30);
  });

  it('Shift+ArrowDown fires onKeyboardResize(-cellMinutes)', async () => {
    const user = userEvent.setup();
    const onKeyboardResize = vi.fn();
    renderBlock({ onKeyboardResize });
    screen.getByRole('button').focus();
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(onKeyboardResize).toHaveBeenCalledTimes(1);
    expect(onKeyboardResize.mock.calls[0][1]).toBe(-30);
  });

  it('Shift+ArrowUp fires onKeyboardResize(+cellMinutes)', async () => {
    const user = userEvent.setup();
    const onKeyboardResize = vi.fn();
    renderBlock({ onKeyboardResize });
    screen.getByRole('button').focus();
    await user.keyboard('{Shift>}{ArrowUp}{/Shift}');
    expect(onKeyboardResize.mock.calls[0][1]).toBe(30);
  });

  it('bare ArrowUp / ArrowDown do NOT call onKeyboardResize (Shift required)', async () => {
    const user = userEvent.setup();
    const onKeyboardResize = vi.fn();
    renderBlock({ onKeyboardResize });
    screen.getByRole('button').focus();
    await user.keyboard('{ArrowUp}{ArrowDown}');
    expect(onKeyboardResize).not.toHaveBeenCalled();
  });

  it('does NOT call any keyboard callback when can_plan=false', async () => {
    const user = userEvent.setup();
    const onKeyboardMove = vi.fn();
    const onKeyboardResize = vi.fn();
    renderBlock({
      block: makeBlock({ can_plan: false }),
      onKeyboardMove,
      onKeyboardResize,
    });
    screen.getByRole('button').focus();
    await user.keyboard('{ArrowRight}{Shift>}{ArrowDown}{/Shift}');
    expect(onKeyboardMove).not.toHaveBeenCalled();
    expect(onKeyboardResize).not.toHaveBeenCalled();
  });

  it('Enter still navigates to /desk/tickets/:id (does not break existing nav)', async () => {
    const user = userEvent.setup();
    const onKeyboardMove = vi.fn();
    const onKeyboardFlush = vi.fn();

    let landedAt: string | null = null;
    render(
      <MemoryRouter initialEntries={['/desk/planning']}>
        <PlanningBlock
          block={makeBlock()}
          leftPct={0}
          widthPct={20}
          startIso="2026-05-12T10:00:00.000Z"
          endIso="2026-05-12T11:00:00.000Z"
          cellMinutes={30}
          onKeyboardMove={onKeyboardMove}
          onKeyboardFlush={onKeyboardFlush}
        />
        <Routes>
          <Route
            path="/desk/tickets/:id"
            element={
              <RouteLanded
                onLanded={(id) => {
                  landedAt = id;
                }}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    screen.getByRole('button').focus();
    await user.keyboard('{Enter}');
    expect(landedAt).toBe('wo-1');
    expect(onKeyboardMove).not.toHaveBeenCalled();
    // Flush fires so a pending burst commits before navigation lands.
    expect(onKeyboardFlush).toHaveBeenCalledTimes(1);
  });

  it('Escape calls onKeyboardFlush', async () => {
    const user = userEvent.setup();
    const onKeyboardFlush = vi.fn();
    renderBlock({ onKeyboardFlush });
    screen.getByRole('button').focus();
    await user.keyboard('{Escape}');
    expect(onKeyboardFlush).toHaveBeenCalledTimes(1);
  });
});

function RouteLanded({ onLanded }: { onLanded: (id: string) => void }) {
  const { id } = useParams<{ id: string }>();
  useEffect(() => {
    if (id) onLanded(id);
  }, [id, onLanded]);
  return <div data-testid="landed">landed:{id}</div>;
}
