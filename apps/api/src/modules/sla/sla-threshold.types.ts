export type TimerType = 'response' | 'resolution';
export type ThresholdTimerScope = TimerType | 'both';
export type ThresholdAction = 'notify' | 'escalate';
export type ThresholdTargetType = 'user' | 'team' | 'manager_of_requester';
export type RecordedAction = ThresholdAction | 'skipped_no_manager';

export interface EscalationThreshold {
  at_percent: number;          // 1..200
  timer_type: ThresholdTimerScope;
  action: ThresholdAction;
  target_type: ThresholdTargetType;
  target_id: string | null;    // null when target_type === 'manager_of_requester'
}

export interface SlaTimerRow {
  id: string;
  tenant_id: string;
  ticket_id: string;
  sla_policy_id: string;
  timer_type: TimerType;
  target_minutes: number;
  started_at: string;
  due_at: string;
  total_paused_minutes: number;
}

export interface CrossingKey {
  sla_timer_id: string;
  at_percent: number;
  timer_type: TimerType;
}

export function crossingKey(k: CrossingKey): string {
  return `${k.sla_timer_id}|${k.at_percent}|${k.timer_type}`;
}
