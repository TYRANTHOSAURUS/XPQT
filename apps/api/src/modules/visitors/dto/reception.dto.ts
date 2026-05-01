/**
 * ReceptionService DTOs and view shapes.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §7
 *
 * The shapes here are internal to the service + tests — slice 2d's
 * controller wraps the JSON body with zod and forwards to the service.
 */

import type { VisitorPassPool } from '../pass-pool.service';
import type { VisitorStatus } from './transition-status.dto';

/** Per-visitor row used by today-view + daily list + search results. */
export interface ReceptionVisitorRow {
  visitor_id: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  primary_host_first_name: string | null;
  primary_host_last_name: string | null;
  expected_at: string | null;
  arrived_at: string | null;
  status: VisitorStatus;
  visitor_pass_id: string | null;
  pass_number: string | null;
  visitor_type_id: string | null;
}

/** Today-view buckets (spec §7.3). */
export interface TodayView {
  building_id: string;
  generated_at: string;
  currently_arriving: ReceptionVisitorRow[];
  expected: ReceptionVisitorRow[];
  in_meeting: ReceptionVisitorRow[];
  checked_out_today: ReceptionVisitorRow[];
}

/** Quick-add walk-up form (spec §7.4). */
export interface QuickAddWalkupDto {
  first_name: string;
  last_name?: string;
  company?: string;
  email?: string;
  phone?: string;
  visitor_type_id: string;
  primary_host_person_id: string;
  /** Optional explicit arrival time — defaults to now() (spec §7.5). */
  arrived_at?: string;
}

export interface ReceptionActor {
  user_id: string;
  person_id: string;
  tenant_id: string;
}

export interface YesterdayLooseEnds {
  auto_checked_out_count: number;
  unreturned_passes: VisitorPassPool[];
  // Surface populated when slice 2c VisitorMailDeliveryAdapter lands.
  bounced_emails: ReceptionVisitorRow[];
}

export type DailyListEntry = ReceptionVisitorRow;
