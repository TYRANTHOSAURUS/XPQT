import { Injectable } from '@nestjs/common';
import {
  PLANNING_WINDOW_MAX_DAYS,
  type PlanningLaneId,
  type WorkOrderPlanningBlock,
  type WorkOrderPlanningResponse,
} from '@prequest/shared';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { AppErrors } from '../../common/errors';
import { TicketVisibilityService, type VisibilityContext } from '../ticket/ticket-visibility.service';

/**
 * Filters accepted by the planning-board read path.
 *
 * `from` / `to` are required ISO 8601 instants. Window is half-open
 * `[from, to)` and capped at 14 days (`PLANNING_WINDOW_MAX_DAYS`); wider
 * requests fail with a 400 so accidental "load this month" doesn't fetch
 * thousands of rows.
 *
 * `status` filters `status_category` — repeated. `team_id` filters
 * `assigned_team_id` (exact match). `unscheduled[]` is always returned
 * alongside `planned[]` and applies the same `status` + `team_id` filters.
 */
export interface PlanningFilters {
  from: string;
  to: string;
  status?: string[];
  team_id?: string | null;
}

interface RawWorkOrderRow {
  id: string;
  tenant_id: string;
  module_number: number;
  title: string;
  status_category: string;
  priority: string;
  planned_start_at: string | null;
  planned_duration_minutes: number | null;
  sla_resolution_due_at: string | null;
  assigned_user_id: string | null;
  assigned_team_id: string | null;
  assigned_vendor_id: string | null;
  ticket_type_id: string | null;
  requester_person_id: string | null;
  watchers: string[] | null;
  location_id: string | null;
  parent_ticket_id: string | null;
  parent_kind: string | null;
}

const VALID_STATUS_CATEGORIES: Set<string> = new Set([
  'new',
  'assigned',
  'in_progress',
  'waiting',
  'resolved',
  'closed',
]);

@Injectable()
export class WorkOrderPlanningService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly visibility: TicketVisibilityService,
  ) {}

  /**
   * Window read. Returns `planned[]` (work orders with `planned_start_at`
   * inside `[from, to)`) and `unscheduled[]` (work orders with no plan, in
   * an open status, matching the same status / team filter).
   *
   * Visibility: uses the SQL function `work_orders_visible_for_actor`
   * (migration 00374) so the predicate stays in SQL — no materialised
   * id-set crossing the wire, no LATERAL projections past the gate. Every
   * dimension table (users / teams / vendors / request_types) is loaded
   * with an explicit `tenant_id` predicate.
   *
   * Tenant: `TenantContext.current()` + per-query `.eq('tenant_id', …)`
   * (memory: `feedback_tenant_id_ultimate_rule`).
   *
   * can_plan: parent-case `assigned_team_id` is batch-preloaded for the
   * whole visible set in one query → in-memory map → `assertCanPlan`'s
   * paths are evaluated purely in TS (no per-block round-trip).
   */
  async getWindow(filters: PlanningFilters, actorAuthUid: string): Promise<WorkOrderPlanningResponse> {
    this.validateFilters(filters);

    const tenant = TenantContext.current();
    const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);

    // Reading the planning board with a zero-context actor (unknown user
    // in this tenant) must return an empty set, not a permission error —
    // the page shell renders even when the user can see nothing yet.
    if (!ctx.user_id) {
      return { planned: [], unscheduled: [] };
    }

    const baseQuery = () =>
      this.supabase.admin
        .rpc('work_orders_visible_for_actor', {
          p_user_id: ctx.user_id,
          p_tenant_id: tenant.id,
          p_has_read_all: ctx.has_read_all,
        });

    // Planned-window query.
    let plannedQuery = baseQuery()
      .gte('planned_start_at', filters.from)
      .lt('planned_start_at', filters.to);
    if (filters.status && filters.status.length > 0) {
      plannedQuery = plannedQuery.in('status_category', filters.status);
    }
    if (filters.team_id) {
      plannedQuery = plannedQuery.eq('assigned_team_id', filters.team_id);
    }
    const plannedRes = await plannedQuery;
    if (plannedRes.error) throw plannedRes.error;
    const plannedRows = (plannedRes.data ?? []) as RawWorkOrderRow[];

    // Unscheduled query — same filters minus the window, plus open-status
    // floor (an unscheduled but already-resolved WO is noise on the rail).
    const openStatuses =
      filters.status && filters.status.length > 0
        ? filters.status.filter((s) => s !== 'resolved' && s !== 'closed')
        : ['new', 'assigned', 'in_progress', 'waiting'];
    let unscheduledQuery = baseQuery()
      .is('planned_start_at', null)
      .in('status_category', openStatuses);
    if (filters.team_id) {
      unscheduledQuery = unscheduledQuery.eq('assigned_team_id', filters.team_id);
    }
    const unscheduledRes = await unscheduledQuery;
    if (unscheduledRes.error) throw unscheduledRes.error;
    const unscheduledRows = (unscheduledRes.data ?? []) as RawWorkOrderRow[];

    const allRows = [...plannedRows, ...unscheduledRows];

    // Hydrate dimension names + preload parent-team for can_plan.
    const [userMap, teamMap, vendorMap, requestTypeMap, parentTeamMap] = await Promise.all([
      this.loadUserLabels(allRows, tenant.id),
      this.loadTeamLabels(allRows, tenant.id),
      this.loadVendorLabels(allRows, tenant.id),
      this.loadRequestTypes(allRows, tenant.id),
      this.loadParentCaseTeams(allRows, tenant.id),
    ]);

    const toBlock = (row: RawWorkOrderRow): WorkOrderPlanningBlock => ({
      id: row.id,
      module_number: row.module_number,
      title: row.title,
      status_category: row.status_category as WorkOrderPlanningBlock['status_category'],
      priority: row.priority as WorkOrderPlanningBlock['priority'],
      planned_start_at: row.planned_start_at,
      planned_duration_minutes: row.planned_duration_minutes,
      sla_resolution_due_at: row.sla_resolution_due_at,
      lane: this.deriveLane(row, userMap, teamMap, vendorMap),
      request_type: row.ticket_type_id ? requestTypeMap.get(row.ticket_type_id) ?? null : null,
      can_plan: this.evaluateCanPlan(row, ctx, parentTeamMap, requestTypeMap),
    });

    return {
      planned: plannedRows.map(toBlock),
      unscheduled: unscheduledRows.map(toBlock),
    };
  }

  // ── validation ─────────────────────────────────────────────────────

  private validateFilters(filters: PlanningFilters): void {
    if (!filters.from || typeof filters.from !== 'string') {
      throw AppErrors.validationFailed('planning.window_invalid', {
        detail: 'from is required (ISO 8601 timestamp)',
      });
    }
    if (!filters.to || typeof filters.to !== 'string') {
      throw AppErrors.validationFailed('planning.window_invalid', {
        detail: 'to is required (ISO 8601 timestamp)',
      });
    }
    const fromMs = Date.parse(filters.from);
    const toMs = Date.parse(filters.to);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
      throw AppErrors.validationFailed('planning.window_invalid', {
        detail: 'from / to must parse as ISO 8601 timestamps',
      });
    }
    if (fromMs >= toMs) {
      throw AppErrors.validationFailed('planning.window_invalid', {
        detail: 'from must be strictly before to',
      });
    }
    const spanMs = toMs - fromMs;
    const maxSpanMs = PLANNING_WINDOW_MAX_DAYS * 24 * 60 * 60 * 1000;
    if (spanMs > maxSpanMs) {
      throw AppErrors.validationFailed('planning.window_too_wide', {
        detail: `window must be ≤ ${PLANNING_WINDOW_MAX_DAYS} days`,
      });
    }
    if (filters.status) {
      for (const s of filters.status) {
        if (!VALID_STATUS_CATEGORIES.has(s)) {
          throw AppErrors.validationFailed('planning.status_invalid', {
            detail: `unknown status_category: ${s}`,
          });
        }
      }
    }
  }

  // ── dimension hydration ────────────────────────────────────────────

  private async loadUserLabels(
    rows: RawWorkOrderRow[],
    tenantId: string,
  ): Promise<Map<string, string>> {
    const ids = uniqueIds(rows, (r) => r.assigned_user_id);
    if (ids.length === 0) return new Map();
    const { data, error } = await this.supabase.admin
      .from('users')
      .select('id, email, person:persons!users_person_id_fkey(first_name, last_name)')
      .eq('tenant_id', tenantId)
      .in('id', ids);
    if (error) throw error;
    const map = new Map<string, string>();
    for (const row of (data ?? []) as Array<{
      id: string;
      email: string;
      person: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null;
    }>) {
      const person = Array.isArray(row.person) ? row.person[0] : row.person;
      const label = person
        ? `${person.first_name} ${person.last_name}`.trim()
        : row.email;
      map.set(row.id, label || row.email || row.id);
    }
    return map;
  }

  private async loadTeamLabels(
    rows: RawWorkOrderRow[],
    tenantId: string,
  ): Promise<Map<string, string>> {
    const ids = uniqueIds(rows, (r) => r.assigned_team_id);
    if (ids.length === 0) return new Map();
    const { data, error } = await this.supabase.admin
      .from('teams')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .in('id', ids);
    if (error) throw error;
    const map = new Map<string, string>();
    for (const row of (data ?? []) as Array<{ id: string; name: string }>) {
      map.set(row.id, row.name);
    }
    return map;
  }

  private async loadVendorLabels(
    rows: RawWorkOrderRow[],
    tenantId: string,
  ): Promise<Map<string, string>> {
    const ids = uniqueIds(rows, (r) => r.assigned_vendor_id);
    if (ids.length === 0) return new Map();
    const { data, error } = await this.supabase.admin
      .from('vendors')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .in('id', ids);
    if (error) throw error;
    const map = new Map<string, string>();
    for (const row of (data ?? []) as Array<{ id: string; name: string }>) {
      map.set(row.id, row.name);
    }
    return map;
  }

  private async loadRequestTypes(
    rows: RawWorkOrderRow[],
    tenantId: string,
  ): Promise<Map<string, { id: string; name: string; domain: string }>> {
    const ids = uniqueIds(rows, (r) => r.ticket_type_id);
    if (ids.length === 0) return new Map();
    const { data, error } = await this.supabase.admin
      .from('request_types')
      .select('id, name, domain')
      .eq('tenant_id', tenantId)
      .in('id', ids);
    if (error) throw error;
    const map = new Map<string, { id: string; name: string; domain: string }>();
    for (const row of (data ?? []) as Array<{ id: string; name: string; domain: string }>) {
      map.set(row.id, { id: row.id, name: row.name, domain: row.domain });
    }
    return map;
  }

  /**
   * Preload `assigned_team_id` of the parent case for every WO whose
   * `parent_kind = 'case'`. Used by `evaluateCanPlan` to apply the
   * parent-case-team branch of `assertCanPlan` without a per-block fetch.
   */
  private async loadParentCaseTeams(
    rows: RawWorkOrderRow[],
    tenantId: string,
  ): Promise<Map<string, string | null>> {
    const parentIds = Array.from(
      new Set(
        rows
          .filter((r) => r.parent_kind === 'case' && r.parent_ticket_id)
          .map((r) => r.parent_ticket_id as string),
      ),
    );
    if (parentIds.length === 0) return new Map();
    const { data, error } = await this.supabase.admin
      .from('tickets')
      .select('id, assigned_team_id')
      .eq('tenant_id', tenantId)
      .in('id', parentIds);
    if (error) throw error;
    const map = new Map<string, string | null>();
    for (const row of (data ?? []) as Array<{ id: string; assigned_team_id: string | null }>) {
      map.set(row.id, row.assigned_team_id);
    }
    return map;
  }

  // ── derivation helpers ─────────────────────────────────────────────

  private deriveLane(
    row: RawWorkOrderRow,
    userMap: Map<string, string>,
    teamMap: Map<string, string>,
    vendorMap: Map<string, string>,
  ): PlanningLaneId {
    if (row.assigned_user_id) {
      return {
        kind: 'user',
        id: row.assigned_user_id,
        label: userMap.get(row.assigned_user_id) ?? 'Unknown user',
      };
    }
    if (row.assigned_vendor_id) {
      return {
        kind: 'vendor',
        id: row.assigned_vendor_id,
        label: vendorMap.get(row.assigned_vendor_id) ?? 'Unknown vendor',
      };
    }
    if (row.assigned_team_id) {
      return {
        kind: 'team',
        id: row.assigned_team_id,
        label: teamMap.get(row.assigned_team_id) ?? 'Unknown team',
      };
    }
    return { kind: 'unassigned', id: null, label: 'Unassigned' };
  }

  /**
   * In-memory replay of `TicketVisibilityService.assertCanPlan`'s logic
   * against the loaded `ctx` + preloaded parent-team map. Stays in lock-
   * step with the gate's allowed-paths set — if assertCanPlan grows a new
   * path, mirror it here.
   *
   * (assertCanPlan today: `has_write_all` override · WO assignee · vendor
   * match · WO team membership · parent-case team membership · non-readonly
   * role with domain+location match.)
   */
  private evaluateCanPlan(
    row: RawWorkOrderRow,
    ctx: VisibilityContext,
    parentTeamMap: Map<string, string | null>,
    requestTypeMap: Map<string, { id: string; name: string; domain: string }>,
  ): boolean {
    if (ctx.has_write_all) return true;
    if (row.assigned_user_id && row.assigned_user_id === ctx.user_id) return true;
    if (
      ctx.vendor_id &&
      row.assigned_vendor_id &&
      row.assigned_vendor_id === ctx.vendor_id
    ) {
      return true;
    }

    const teamCandidates: Array<string | null> = [row.assigned_team_id];
    if (row.parent_kind === 'case' && row.parent_ticket_id) {
      teamCandidates.push(parentTeamMap.get(row.parent_ticket_id) ?? null);
    }
    for (const t of teamCandidates) {
      if (t && ctx.team_ids.includes(t)) return true;
    }

    // Role-operator branch — mirrors `assertCanPlan` paths. Domain is read
    // from the preloaded request_types map (same source the response uses)
    // so a role scoped to one domain does not get can_plan=true on a WO of
    // a different domain.
    const domain = row.ticket_type_id
      ? requestTypeMap.get(row.ticket_type_id)?.domain ?? null
      : null;
    for (const role of ctx.role_assignments) {
      if (role.read_only_cross_domain) continue;
      const domainOk =
        role.domain_scope.length === 0 ||
        (domain != null && role.domain_scope.includes(domain));
      const locationOk =
        role.location_scope_closure.length === 0 ||
        row.location_id == null ||
        role.location_scope_closure.includes(row.location_id);
      if (domainOk && locationOk) return true;
    }
    return false;
  }
}

function uniqueIds<T>(rows: T[], picker: (row: T) => string | null | undefined): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    const id = picker(row);
    if (id) set.add(id);
  }
  return Array.from(set);
}
