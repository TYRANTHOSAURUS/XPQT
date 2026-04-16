import type {
  StatusCategory,
  WaitingReason,
  InteractionMode,
  ActivityType,
  Visibility,
} from './enums';

export interface Ticket {
  id: string;
  tenant_id: string;
  ticket_type_id: string;
  parent_ticket_id: string | null;
  title: string;
  description: string;
  status: string;
  status_category: StatusCategory;
  waiting_reason: WaitingReason | null;
  interaction_mode: InteractionMode;
  priority: string;
  impact: string | null;
  urgency: string | null;
  requester_person_id: string;
  location_id: string | null;
  asset_id: string | null;
  assigned_team_id: string | null;
  assigned_user_id: string | null;
  workflow_id: string | null;
  sla_id: string | null;
  source_channel: string;
  tags: string[];
  watchers: string[];
  cost: number | null;
  satisfaction_rating: number | null;
  satisfaction_comment: string | null;
  sla_breached_at: string | null;
  sla_at_risk: boolean;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  closed_at: string | null;
}

export interface TicketActivity {
  id: string;
  tenant_id: string;
  ticket_id: string;
  activity_type: ActivityType;
  author_person_id: string | null;
  visibility: Visibility;
  content: string;
  attachments: string[];
  metadata: Record<string, unknown> | null;
  created_at: string;
}
