import {
  percentElapsed,
  selectApplicableThresholds,
} from './sla-threshold.helpers';
import type { EscalationThreshold, SlaTimerRow } from './sla-threshold.types';

const baseTimer: SlaTimerRow = {
  id: 't1',
  tenant_id: 'tenant',
  ticket_id: 'ticket',
  sla_policy_id: 'policy',
  timer_type: 'resolution',
  target_minutes: 240,
  started_at: '2026-04-20T10:00:00Z',
  due_at: '2026-04-20T14:00:00Z',
  total_paused_minutes: 0,
};

describe('percentElapsed', () => {
  it('returns 0 at start', () => {
    expect(percentElapsed(baseTimer, new Date('2026-04-20T10:00:00Z'))).toBe(0);
  });

  it('returns 50 at midpoint', () => {
    expect(percentElapsed(baseTimer, new Date('2026-04-20T12:00:00Z'))).toBe(50);
  });

  it('returns 100 at due_at', () => {
    expect(percentElapsed(baseTimer, new Date('2026-04-20T14:00:00Z'))).toBe(100);
  });

  it('returns >100 past due_at', () => {
    expect(percentElapsed(baseTimer, new Date('2026-04-20T16:00:00Z'))).toBe(150);
  });

  it('returns 0 when due equals start (defensive)', () => {
    const degenerate = { ...baseTimer, due_at: baseTimer.started_at };
    expect(percentElapsed(degenerate, new Date(baseTimer.started_at))).toBe(0);
  });
});

describe('selectApplicableThresholds', () => {
  const thresholds: EscalationThreshold[] = [
    { at_percent: 80, timer_type: 'resolution', action: 'notify', target_type: 'user', target_id: 'u1' },
    { at_percent: 100, timer_type: 'resolution', action: 'escalate', target_type: 'team', target_id: 't1' },
    { at_percent: 80, timer_type: 'response', action: 'notify', target_type: 'user', target_id: 'u2' },
    { at_percent: 50, timer_type: 'both', action: 'notify', target_type: 'user', target_id: 'u3' },
  ];

  it('returns thresholds whose at_percent is <= elapsed and timer_type matches', () => {
    const out = selectApplicableThresholds({
      percent: 85,
      timerType: 'resolution',
      timerId: 't1',
      thresholds,
      firedKeys: new Set(),
    });
    expect(out.map((t) => `${t.at_percent}/${t.timer_type}`).sort()).toEqual([
      '50/both',
      '80/resolution',
    ]);
  });

  it('excludes thresholds already fired', () => {
    const fired = new Set(['t1|80|resolution']);
    const out = selectApplicableThresholds({
      percent: 85,
      timerType: 'resolution',
      timerId: 't1',
      thresholds,
      firedKeys: fired,
    });
    expect(out.map((t) => `${t.at_percent}/${t.timer_type}`).sort()).toEqual(['50/both']);
  });

  it('treats "both" as matching either timer type', () => {
    const onlyBoth: EscalationThreshold[] = [
      { at_percent: 10, timer_type: 'both', action: 'notify', target_type: 'user', target_id: 'u1' },
    ];
    const onResponse = selectApplicableThresholds({
      percent: 20,
      timerType: 'response',
      timerId: 't1',
      thresholds: onlyBoth,
      firedKeys: new Set(),
    });
    const onResolution = selectApplicableThresholds({
      percent: 20,
      timerType: 'resolution',
      timerId: 't1',
      thresholds: onlyBoth,
      firedKeys: new Set(),
    });
    expect(onResponse).toHaveLength(1);
    expect(onResolution).toHaveLength(1);
  });

  it('returns empty when percent is below every threshold', () => {
    const out = selectApplicableThresholds({
      percent: 5,
      timerType: 'resolution',
      timerId: 't1',
      thresholds,
      firedKeys: new Set(),
    });
    expect(out).toEqual([]);
  });
});
