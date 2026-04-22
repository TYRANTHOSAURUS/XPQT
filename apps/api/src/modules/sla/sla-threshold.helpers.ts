import type {
  EscalationThreshold,
  SlaTimerRow,
  TimerType,
} from './sla-threshold.types';
import { crossingKey } from './sla-threshold.types';

export function percentElapsed(timer: SlaTimerRow, now: Date): number {
  const start = new Date(timer.started_at).getTime();
  const due = new Date(timer.due_at).getTime();
  const total = due - start;
  if (total <= 0) return 0;
  const elapsed = now.getTime() - start;
  return (elapsed / total) * 100;
}

export interface SelectArgs {
  percent: number;
  timerType: TimerType;
  timerId: string;
  thresholds: EscalationThreshold[];
  firedKeys: Set<string>;
}

export function selectApplicableThresholds(args: SelectArgs): EscalationThreshold[] {
  const { percent, timerType, timerId, thresholds, firedKeys } = args;
  return thresholds.filter((t) => {
    const matchesTimer = t.timer_type === timerType || t.timer_type === 'both';
    if (!matchesTimer) return false;
    if (percent < t.at_percent) return false;
    const key = crossingKey({
      sla_timer_id: timerId,
      at_percent: t.at_percent,
      timer_type: timerType,
    });
    return !firedKeys.has(key);
  });
}
