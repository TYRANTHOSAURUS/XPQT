import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBookingDraft } from './use-booking-draft';

describe('useBookingDraft', () => {
  it('initializes with the empty draft when no seed is provided', () => {
    const { result } = renderHook(() => useBookingDraft());
    expect(result.current.draft.spaceId).toBeNull();
    expect(result.current.draft.title).toBe('');
  });

  it('honors a seed', () => {
    const { result } = renderHook(() =>
      useBookingDraft({
        seed: { spaceId: 'r1', title: 'Sprint review' },
      }),
    );
    expect(result.current.draft.spaceId).toBe('r1');
    expect(result.current.draft.title).toBe('Sprint review');
  });

  it('updates room without losing other fields', () => {
    const { result } = renderHook(() =>
      useBookingDraft({ seed: { title: 'Sync' } }),
    );
    act(() => result.current.setRoom('r2'));
    expect(result.current.draft.spaceId).toBe('r2');
    expect(result.current.draft.title).toBe('Sync');
  });

  it('updates time as a pair', () => {
    const { result } = renderHook(() => useBookingDraft());
    act(() => result.current.setTime('2026-05-07T10:00:00.000Z', '2026-05-07T11:00:00.000Z'));
    expect(result.current.draft.startAt).toBe('2026-05-07T10:00:00.000Z');
    expect(result.current.draft.endAt).toBe('2026-05-07T11:00:00.000Z');
  });

  it('add/remove visitors', () => {
    const { result } = renderHook(() => useBookingDraft());
    act(() =>
      result.current.addVisitor({
        local_id: 'v1',
        first_name: 'Alex',
        email: 'a@x.com',
        visitor_type_id: 'vt1',
      }),
    );
    expect(result.current.draft.visitors).toHaveLength(1);
    act(() => result.current.removeVisitor('v1'));
    expect(result.current.draft.visitors).toHaveLength(0);
  });

  it('exposes a stable identity on each call setter', () => {
    const { result, rerender } = renderHook(() => useBookingDraft());
    const first = result.current.setRoom;
    rerender();
    expect(result.current.setRoom).toBe(first);
  });
});
