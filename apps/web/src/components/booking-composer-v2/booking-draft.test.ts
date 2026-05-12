import { describe, expect, it } from 'vitest';
import {
  emptyDraft,
  draftFromComposerSeed,
  validateDraft,
  defaultTitle,
  type BookingDraft,
} from './booking-draft';

describe('emptyDraft', () => {
  it('returns a stable shape with sensible defaults', () => {
    const d = emptyDraft();
    expect(d.spaceId).toBeNull();
    // Phase D.1: seeds a future 15-min-aligned start + 1h end so the
    // TimesSummaryCard opens filled instead of in the empty branch.
    expect(d.startAt).not.toBeNull();
    expect(d.endAt).not.toBeNull();
    const start = new Date(d.startAt!);
    const end = new Date(d.endAt!);
    expect(start.getMinutes() % 15).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
    expect(end.getTime() - start.getTime()).toBe(60 * 60_000);
    expect(start.getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(d.title).toBe('');
    expect(d.attendeeCount).toBe(1);
    expect(d.visitors).toEqual([]);
    expect(d.services).toEqual([]);
  });
});

describe('draftFromComposerSeed', () => {
  it('honors a partial seed', () => {
    const d = draftFromComposerSeed({
      spaceId: 'room-1',
      startAt: '2026-05-07T10:00:00.000Z',
      endAt: '2026-05-07T11:00:00.000Z',
      attendeeCount: 4,
    });
    expect(d.spaceId).toBe('room-1');
    expect(d.attendeeCount).toBe(4);
    expect(d.title).toBe('');
  });
});

describe('validateDraft', () => {
  // Pick a future date for "ready to submit" cases so the date-in-past
  // rule (/full-review v4 I1) doesn't trip on the hard-coded fixtures.
  const futureStart = new Date(Date.now() + 60 * 60_000).toISOString();
  const futureEnd = new Date(Date.now() + 2 * 60 * 60_000).toISOString();

  it('returns null when ready to submit', () => {
    const d: BookingDraft = {
      ...emptyDraft(),
      spaceId: 'room-1',
      startAt: futureStart,
      endAt: futureEnd,
      hostPersonId: 'p1',
    };
    expect(validateDraft(d, 'self')).toBeNull();
  });

  it('requires a room', () => {
    expect(validateDraft(emptyDraft(), 'self')).toEqual({
      field: 'room',
      message: 'Pick a room.',
    });
  });

  it('requires time', () => {
    const d = { ...emptyDraft(), spaceId: 'room-1', startAt: null, endAt: null };
    expect(validateDraft(d, 'self')).toEqual({
      field: 'time',
      message: 'Pick a date and time.',
    });
  });

  it('blocks end ≤ start', () => {
    const d: BookingDraft = {
      ...emptyDraft(),
      spaceId: 'room-1',
      startAt: futureEnd,
      endAt: futureStart, // swapped — end is earlier
    };
    expect(validateDraft(d, 'self')).toEqual({
      field: 'time',
      message: 'End time must be after start.',
    });
  });

  it('blocks date in the past (outside 60s grace)', () => {
    const d: BookingDraft = {
      ...emptyDraft(),
      spaceId: 'room-1',
      // 2 minutes ago — well outside the 60s clock-skew grace.
      startAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      endAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
    expect(validateDraft(d, 'self')).toEqual({
      field: 'time',
      message: 'Pick a time in the future.',
    });
  });

  it('tolerates a fresh "now" start (60s clock-skew grace)', () => {
    const d: BookingDraft = {
      ...emptyDraft(),
      spaceId: 'room-1',
      // 30 seconds ago — within the 60s grace, should pass.
      startAt: new Date(Date.now() - 30_000).toISOString(),
      endAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
    expect(validateDraft(d, 'self')).toBeNull();
  });

  it('operator mode requires a requester', () => {
    const d: BookingDraft = {
      ...emptyDraft(),
      spaceId: 'room-1',
      startAt: futureStart,
      endAt: futureEnd,
    };
    expect(validateDraft(d, 'operator')).toEqual({
      field: 'requester',
      message: 'Pick who the booking is for.',
    });
  });
});

describe('defaultTitle', () => {
  it('combines host first name and room name', () => {
    expect(defaultTitle({ hostFirstName: 'Ada', roomName: 'Maple' })).toBe(
      "Ada's Maple booking",
    );
  });

  it('falls back to room-only when host is null/blank', () => {
    expect(defaultTitle({ hostFirstName: null, roomName: 'Maple' })).toBe(
      'Maple booking',
    );
    expect(defaultTitle({ hostFirstName: '   ', roomName: 'Maple' })).toBe(
      'Maple booking',
    );
  });

  it('falls back to host-only when room is null/blank', () => {
    expect(defaultTitle({ hostFirstName: 'Ada', roomName: null })).toBe(
      "Ada's booking",
    );
  });

  it('returns the generic placeholder when both are null', () => {
    expect(defaultTitle({ hostFirstName: null, roomName: null })).toBe('Booking');
  });
});
