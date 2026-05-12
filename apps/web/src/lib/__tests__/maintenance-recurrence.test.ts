import { describe, expect, it } from 'vitest';
import { describeRecurrence } from '../maintenance-recurrence';

describe('describeRecurrence', () => {
  it('renders singular for interval of 1', () => {
    expect(describeRecurrence(1, 'day')).toBe('Every 1 day');
    expect(describeRecurrence(1, 'week')).toBe('Every 1 week');
    expect(describeRecurrence(1, 'month')).toBe('Every 1 month');
    expect(describeRecurrence(1, 'year')).toBe('Every 1 year');
  });

  it('renders plural for interval > 1', () => {
    expect(describeRecurrence(3, 'day')).toBe('Every 3 days');
    expect(describeRecurrence(2, 'week')).toBe('Every 2 weeks');
    expect(describeRecurrence(6, 'month')).toBe('Every 6 months');
    expect(describeRecurrence(5, 'year')).toBe('Every 5 years');
  });

  it('returns em dash for invalid intervals', () => {
    expect(describeRecurrence(0, 'day')).toBe('—');
    expect(describeRecurrence(-1, 'day')).toBe('—');
    expect(describeRecurrence(1.5, 'day')).toBe('—');
  });
});
