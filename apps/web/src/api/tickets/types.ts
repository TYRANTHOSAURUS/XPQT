export interface TicketRequester {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  department: string;
}

export interface TicketLocation {
  id: string;
  name: string;
  type: string;
}

export interface TicketAsset {
  id: string;
  name: string;
  serial_number: string;
}

export interface TicketRequestType {
  id: string;
  name: string;
  domain: string;
}

export interface TicketDetail {
  id: string;
  ticket_kind: 'case' | 'work_order';
  module_number: number;
  parent_ticket_id: string | null;
  title: string;
  description: string;
  status: string;
  status_category: string;
  priority: string;
  waiting_reason: string | null;
  interaction_mode: string;
  tags: string[];
  sla_id: string | null;
  sla_at_risk: boolean;
  sla_response_due_at: string | null;
  sla_resolution_due_at: string | null;
  sla_response_breached_at: string | null;
  sla_resolution_breached_at: string | null;
  planned_start_at: string | null;
  planned_duration_minutes: number | null;
  created_at: string;
  requester?: TicketRequester;
  location?: TicketLocation;
  asset?: TicketAsset;
  assigned_team?: { id: string; name: string };
  assigned_agent?: { id: string; email: string };
  request_type?: TicketRequestType;
  form_data?: Record<string, unknown> | null;
  cost?: number | null;
  watchers?: string[];
  assigned_vendor?: { id: string; name: string } | null;
  reclassified_at?: string | null;
  reclassified_reason?: string | null;
  reclassified_from_id?: string | null;
}

export interface TicketActivity {
  id: string;
  activity_type: string;
  visibility: string;
  content: string;
  attachments?: Array<{
    name: string;
    url?: string;
    path?: string;
    size: number;
    type: string;
  }>;
  author?: { first_name: string; last_name: string };
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** Fields writable via PATCH /tickets/:id. */
export interface UpdateTicketPayload {
  title?: string;
  description?: string;
  status?: string;
  status_category?: string;
  waiting_reason?: string | null;
  priority?: string;
  assigned_team_id?: string | null;
  assigned_user_id?: string | null;
  assigned_vendor_id?: string | null;
  tags?: string[];
  watchers?: string[];
  cost?: number | null;
  sla_id?: string | null;
}

export type AssignmentKind = 'team' | 'user' | 'vendor';

export const ASSIGNMENT_FIELD: Record<AssignmentKind, keyof UpdateTicketPayload> = {
  team: 'assigned_team_id',
  user: 'assigned_user_id',
  vendor: 'assigned_vendor_id',
};

export interface ReassignVariables {
  kind: AssignmentKind;
  id: string | null;
  nextLabel: string | null;
  previousLabel: string | null;
  reason?: string;
  actorPersonId?: string;
}

export interface SetPlanPayload {
  /** ISO timestamp, or null to clear the plan. */
  planned_start_at: string | null;
  /** Optional duration. Cleared automatically when planned_start_at is null. */
  planned_duration_minutes?: number | null;
}
