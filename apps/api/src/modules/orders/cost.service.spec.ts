import { computeLineTotal, estimateAnnualisedOccurrences } from './cost.service';

describe('CostService.computeLineTotal', () => {
  it('per_item multiplies price × quantity', () => {
    expect(
      computeLineTotal({ quantity: 14, unit_price: 30, unit: 'per_item' }, 14),
    ).toBe(420);
  });

  it('per_person multiplies by attendee_count (default 1 when null)', () => {
    expect(
      computeLineTotal({ quantity: 1, unit_price: 25, unit: 'per_person' }, 14),
    ).toBe(350);
    expect(
      computeLineTotal({ quantity: 1, unit_price: 25, unit: 'per_person' }, null),
    ).toBe(25);
  });

  it('per_person × quantity_per_attendee folds quantity through', () => {
    // quantity = 2 lunches per attendee × 14 attendees × 25/person.
    expect(
      computeLineTotal({ quantity: 2, unit_price: 25, unit: 'per_person' }, 14),
    ).toBe(700);
  });

  it('flat_rate ignores quantity entirely', () => {
    expect(
      computeLineTotal({ quantity: 99, unit_price: 200, unit: 'flat_rate' }, 14),
    ).toBe(200);
  });

  it('null unit_price contributes 0', () => {
    expect(
      computeLineTotal({ quantity: 14, unit_price: null, unit: 'per_item' }, 14),
    ).toBe(0);
  });

  it('null unit defaults to per_item behaviour', () => {
    expect(
      computeLineTotal({ quantity: 5, unit_price: 10, unit: null }, 14),
    ).toBe(50);
  });
});

describe('estimateAnnualisedOccurrences', () => {
  it('returns null for null rule', () => {
    expect(estimateAnnualisedOccurrences(null)).toBeNull();
  });

  it('honors explicit count when supplied', () => {
    expect(estimateAnnualisedOccurrences({ count: 6 })).toBe(6);
  });

  it('weekly = 52', () => {
    expect(estimateAnnualisedOccurrences({ freq: 'WEEKLY' })).toBe(52);
  });

  it('weekly with interval=2 (every other week) = 26', () => {
    expect(estimateAnnualisedOccurrences({ freq: 'WEEKLY', interval: 2 })).toBe(26);
  });

  it('monthly = 12', () => {
    expect(estimateAnnualisedOccurrences({ freq: 'MONTHLY' })).toBe(12);
  });

  it('daily = 365', () => {
    expect(estimateAnnualisedOccurrences({ freq: 'DAILY' })).toBe(365);
  });

  it('returns null for unknown freq', () => {
    expect(estimateAnnualisedOccurrences({ freq: 'HOURLY' })).toBeNull();
  });
});
