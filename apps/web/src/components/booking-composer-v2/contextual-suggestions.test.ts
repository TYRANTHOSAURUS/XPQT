import { describe, expect, it } from 'vitest';
import {
  getSuggestions,
  type SuggestionRoomFacts,
} from './contextual-suggestions';
import type { MealWindow } from '@/api/meal-windows';
import { emptyDraft } from './booking-draft';

const lunch: MealWindow = {
  id: 'w-lunch',
  tenant_id: 't1',
  label: 'Lunch',
  start_time: '11:30:00',
  end_time: '13:30:00',
  active: true,
};

const room: SuggestionRoomFacts = {
  space_id: 'room-1',
  name: 'Maple',
  has_av_equipment: false,
  has_catering_vendor: false,
  needs_visitor_pre_registration: false,
};

function isoOnDay(year: number, month: number, day: number, hh: number, mm = 0): string {
  return new Date(year, month - 1, day, hh, mm, 0).toISOString();
}

describe('getSuggestions', () => {
  it('returns empty when no signals fire', () => {
    const draft = {
      ...emptyDraft(),
      startAt: isoOnDay(2026, 5, 7, 9, 0),
      endAt: isoOnDay(2026, 5, 7, 9, 30),
    };
    expect(getSuggestions(draft, room, [lunch])).toEqual([]);
  });

  it('flags catering when the booking spans a meal window', () => {
    const draft = {
      ...emptyDraft(),
      startAt: isoOnDay(2026, 5, 7, 11, 0),
      endAt: isoOnDay(2026, 5, 7, 12, 30),
    };
    const suggestions = getSuggestions(draft, room, [lunch]);
    const catering = suggestions.find((s) => s.target === 'catering');
    expect(catering).toBeDefined();
    expect(catering?.reason).toContain('lunch');
  });

  it('flags catering when the room has a linked catering vendor', () => {
    const draft = {
      ...emptyDraft(),
      startAt: isoOnDay(2026, 5, 7, 9, 0),
      endAt: isoOnDay(2026, 5, 7, 10, 0),
    };
    const suggestions = getSuggestions(
      draft,
      { ...room, has_catering_vendor: true },
      [lunch],
    );
    expect(suggestions.some((s) => s.target === 'catering')).toBe(true);
  });

  it('flags AV when the room has equipment AND duration > 30min', () => {
    const draft = {
      ...emptyDraft(),
      startAt: isoOnDay(2026, 5, 7, 9, 0),
      endAt: isoOnDay(2026, 5, 7, 10, 0),
    };
    const suggestions = getSuggestions(
      draft,
      { ...room, has_av_equipment: true },
      [],
    );
    expect(suggestions.some((s) => s.target === 'av_equipment')).toBe(true);
  });

  it('does NOT flag AV for sub-30min bookings even with equipment', () => {
    const draft = {
      ...emptyDraft(),
      startAt: isoOnDay(2026, 5, 7, 9, 0),
      endAt: isoOnDay(2026, 5, 7, 9, 25),
    };
    const suggestions = getSuggestions(
      draft,
      { ...room, has_av_equipment: true },
      [],
    );
    expect(suggestions.some((s) => s.target === 'av_equipment')).toBe(false);
  });

  it('flags visitors when the room is a pre-reg wing', () => {
    const draft = {
      ...emptyDraft(),
      startAt: isoOnDay(2026, 5, 7, 9, 0),
      endAt: isoOnDay(2026, 5, 7, 10, 0),
    };
    const suggestions = getSuggestions(
      draft,
      { ...room, needs_visitor_pre_registration: true },
      [],
    );
    expect(suggestions.some((s) => s.target === 'visitors')).toBe(true);
  });

  it('treats null room as no signals', () => {
    const draft = {
      ...emptyDraft(),
      startAt: isoOnDay(2026, 5, 7, 11, 0),
      endAt: isoOnDay(2026, 5, 7, 12, 30),
    };
    expect(getSuggestions(draft, null, [lunch])).toEqual([]);
  });

  it('handles meal window that crosses no part of the booking', () => {
    const draft = {
      ...emptyDraft(),
      startAt: isoOnDay(2026, 5, 7, 14, 0),
      endAt: isoOnDay(2026, 5, 7, 15, 0),
    };
    expect(getSuggestions(draft, room, [lunch])).toEqual([]);
  });
});
