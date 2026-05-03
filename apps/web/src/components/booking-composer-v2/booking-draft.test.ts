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
    expect(d.startAt).toBeNull();
    expect(d.endAt).toBeNull();
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
  it('returns null when ready to submit', () => {
    const d: BookingDraft = {
      ...emptyDraft(),
      spaceId: 'room-1',
      startAt: '2026-05-07T10:00:00.000Z',
      endAt: '2026-05-07T11:00:00.000Z',
      hostPersonId: 'p1',
    };
    expect(validateDraft(d, 'self')).toBeNull();
  });

  it('requires a room', () => {
    expect(validateDraft(emptyDraft(), 'self')).toBe('Pick a room.');
  });

  it('requires time', () => {
    const d = { ...emptyDraft(), spaceId: 'room-1' };
    expect(validateDraft(d, 'self')).toBe('Pick a date and time.');
  });

  it('operator mode requires a requester', () => {
    const d: BookingDraft = {
      ...emptyDraft(),
      spaceId: 'room-1',
      startAt: '2026-05-07T10:00:00.000Z',
      endAt: '2026-05-07T11:00:00.000Z',
    };
    expect(validateDraft(d, 'operator')).toBe('Pick who the booking is for.');
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
