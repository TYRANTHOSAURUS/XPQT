export interface ReclassifyPreviewDto {
  newRequestTypeId: string;
}

export interface ReclassifyExecuteDto {
  newRequestTypeId: string;
  reason: string;
  acknowledgedChildrenInProgress?: boolean;
}

export interface ReclassifyImpactChild {
  id: string;
  title: string;
  status_category: string;
  is_in_progress: boolean;
  assignee: { kind: 'user' | 'vendor' | 'team'; id: string; name: string } | null;
}

export interface ReclassifyImpactActiveTimer {
  id: string;
  metric_name: string;
  elapsed_minutes: number;
  target_minutes: number;
}

export interface ReclassifyImpactDto {
  ticket: {
    id: string;
    current_request_type: { id: string; name: string };
    new_request_type: { id: string; name: string };
  };
  workflow: {
    current_instance: { id: string; definition_name: string; current_step: string } | null;
    will_be_cancelled: boolean;
    new_definition: { id: string; name: string } | null;
  };
  children: ReclassifyImpactChild[];
  sla: {
    active_timers: ReclassifyImpactActiveTimer[];
    will_be_stopped: boolean;
    new_policy: {
      id: string;
      name: string;
      metrics: Array<{ name: string; target_minutes: number }>;
    } | null;
  };
  routing: {
    current_assignment: {
      team?: { id: string; name: string };
      user?: { id: string; name: string };
      vendor?: { id: string; name: string };
    };
    new_decision: {
      team?: { id: string; name: string };
      user?: { id: string; name: string };
      vendor?: { id: string; name: string };
      rule_name: string;
      explanation: string;
    };
    current_user_will_become_watcher: boolean;
  };
}
