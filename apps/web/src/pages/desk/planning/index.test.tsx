import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@/lib/api';
import {
  extractPlanVersionConflict,
  PlanVersionConflictDialog,
} from './index';

/**
 * P1-2 (00382) — surface coverage for the planning-board's 409
 * `planning.version_conflict` path.
 *
 * The page-level wiring is not unit-tested directly here because mounting
 * the planning page requires a QueryClient, MemoryRouter, a mocked
 * useWorkOrderPlanning, and a fetch mock — heavy machinery for a thin
 * contract. The handoff spec calls out: "Don't test 'Keep mine' deeply
 * — race-and-retry is fragile to test; one assertion that the re-PATCH
 * fires is enough." So we cover the two contracts that matter:
 *
 *   1. `extractPlanVersionConflict` correctly identifies the 409 shape
 *      and rejects every other error shape (so the dialog opens for
 *      conflicts and only conflicts).
 *   2. `PlanVersionConflictDialog` exposes both CTAs, invokes the right
 *      callback per click, and treats overlay-dismiss as "Reload" (the
 *      safe default).
 */

describe('extractPlanVersionConflict', () => {
  it('returns serverVersion when ApiError 409 with planning.version_conflict body', () => {
    const err = new ApiError({
      status: 409,
      message: 'conflict',
      body: {
        code: 'planning.version_conflict',
        serverVersion: '7',
        clientVersion: '6',
      },
    });
    expect(extractPlanVersionConflict(err)).toEqual({ serverVersion: 7 });
  });

  it('returns null when 409 with a different code', () => {
    const err = new ApiError({
      status: 409,
      message: 'conflict',
      body: { code: 'booking.slot_conflict' },
    });
    expect(extractPlanVersionConflict(err)).toBeNull();
  });

  it('returns null when status is not 409', () => {
    const err = new ApiError({
      status: 500,
      message: 'boom',
      body: { code: 'planning.version_conflict', serverVersion: '7' },
    });
    expect(extractPlanVersionConflict(err)).toBeNull();
  });

  it('returns null when error is not an ApiError', () => {
    expect(extractPlanVersionConflict(new Error('something else'))).toBeNull();
    expect(extractPlanVersionConflict(null)).toBeNull();
    expect(extractPlanVersionConflict(undefined)).toBeNull();
  });

  it('returns null when serverVersion is missing or unparseable', () => {
    const noVersion = new ApiError({
      status: 409,
      message: 'conflict',
      body: { code: 'planning.version_conflict' },
    });
    expect(extractPlanVersionConflict(noVersion)).toBeNull();
    const garbage = new ApiError({
      status: 409,
      message: 'conflict',
      body: { code: 'planning.version_conflict', serverVersion: 'abc' },
    });
    expect(extractPlanVersionConflict(garbage)).toBeNull();
  });
});

describe('PlanVersionConflictDialog', () => {
  it('renders title + block title in description when open', () => {
    render(
      <PlanVersionConflictDialog
        open
        blockTitle="WO #42"
        onReload={vi.fn()}
        onKeepMine={vi.fn()}
      />,
    );
    expect(screen.getByText('Moved by someone else')).toBeInTheDocument();
    expect(screen.getByText(/WO #42/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(
      <PlanVersionConflictDialog
        open={false}
        blockTitle="WO #42"
        onReload={vi.fn()}
        onKeepMine={vi.fn()}
      />,
    );
    expect(screen.queryByText('Moved by someone else')).not.toBeInTheDocument();
  });

  it('clicking Reload invokes onReload', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    const onKeepMine = vi.fn();
    render(
      <PlanVersionConflictDialog
        open
        blockTitle="WO #42"
        onReload={onReload}
        onKeepMine={onKeepMine}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onKeepMine).not.toHaveBeenCalled();
  });

  it('clicking Keep mine invokes onKeepMine (re-PATCH path)', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    const onKeepMine = vi.fn();
    render(
      <PlanVersionConflictDialog
        open
        blockTitle="WO #42"
        onReload={onReload}
        onKeepMine={onKeepMine}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(onKeepMine).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();
  });

  it('pressing Escape routes through onReload (safe-default dismiss)', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    const onKeepMine = vi.fn();
    render(
      <PlanVersionConflictDialog
        open
        blockTitle="WO #42"
        onReload={onReload}
        onKeepMine={onKeepMine}
      />,
    );
    await user.keyboard('{Escape}');
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onKeepMine).not.toHaveBeenCalled();
  });
});
