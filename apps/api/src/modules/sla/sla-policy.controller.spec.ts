import { BadRequestException } from '@nestjs/common';
import { validateEscalationThresholds } from './sla-policy.controller';

const u1 = '00000000-0000-0000-0000-000000000001';
const u2 = '00000000-0000-0000-0000-000000000002';

describe('validateEscalationThresholds', () => {
  it('returns [] for null or undefined', () => {
    expect(validateEscalationThresholds(null)).toEqual([]);
    expect(validateEscalationThresholds(undefined)).toEqual([]);
  });

  it('accepts a well-formed array', () => {
    const input = [
      { at_percent: 80, timer_type: 'response', action: 'notify', target_type: 'user', target_id: u1 },
      { at_percent: 100, timer_type: 'resolution', action: 'escalate', target_type: 'team', target_id: u2 },
      { at_percent: 120, timer_type: 'both', action: 'notify', target_type: 'manager_of_requester', target_id: null },
    ];
    expect(validateEscalationThresholds(input)).toHaveLength(3);
  });

  it('rejects non-integer or out-of-range at_percent', () => {
    expect(() => validateEscalationThresholds([{ at_percent: 0, timer_type: 'response', action: 'notify', target_type: 'user', target_id: u1 }])).toThrow(BadRequestException);
    expect(() => validateEscalationThresholds([{ at_percent: 201, timer_type: 'response', action: 'notify', target_type: 'user', target_id: u1 }])).toThrow(BadRequestException);
    expect(() => validateEscalationThresholds([{ at_percent: 80.5, timer_type: 'response', action: 'notify', target_type: 'user', target_id: u1 }])).toThrow(BadRequestException);
  });

  it('rejects unknown timer_type / action / target_type', () => {
    expect(() => validateEscalationThresholds([{ at_percent: 80, timer_type: 'bogus', action: 'notify', target_type: 'user', target_id: u1 }])).toThrow(BadRequestException);
    expect(() => validateEscalationThresholds([{ at_percent: 80, timer_type: 'response', action: 'delete', target_type: 'user', target_id: u1 }])).toThrow(BadRequestException);
    expect(() => validateEscalationThresholds([{ at_percent: 80, timer_type: 'response', action: 'notify', target_type: 'nobody', target_id: u1 }])).toThrow(BadRequestException);
  });

  it('rejects missing target_id for user/team', () => {
    expect(() => validateEscalationThresholds([{ at_percent: 80, timer_type: 'response', action: 'notify', target_type: 'user', target_id: null }])).toThrow(BadRequestException);
    expect(() => validateEscalationThresholds([{ at_percent: 80, timer_type: 'response', action: 'notify', target_type: 'team', target_id: 'not-a-uuid' }])).toThrow(BadRequestException);
  });

  it('rejects non-null target_id for manager_of_requester', () => {
    expect(() => validateEscalationThresholds([{ at_percent: 80, timer_type: 'response', action: 'notify', target_type: 'manager_of_requester', target_id: u1 }])).toThrow(BadRequestException);
  });

  it('rejects duplicate (at_percent, timer_type) pairs', () => {
    const dup = [
      { at_percent: 80, timer_type: 'response', action: 'notify', target_type: 'user', target_id: u1 },
      { at_percent: 80, timer_type: 'response', action: 'escalate', target_type: 'team', target_id: u2 },
    ];
    expect(() => validateEscalationThresholds(dup)).toThrow(BadRequestException);
  });
});
