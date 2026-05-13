import { Injectable } from '@nestjs/common';
import {
  PLANNING_LANES_MAX,
  PLANNING_WINDOW_MAX_DAYS,
  type PlanningLaneId,
  type WorkOrderPlanningBlock,
  type WorkOrderPlanningResponse,
} from '@prequest/shared';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { AppErrors } from '../../common/errors';
import {
  TicketVisibilityService,
  canPlanRow,
  type VisibilityContext,
} from '../ticket/ticket-visibility.service';

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
  // 00382: row-version trigger column. Returned on every block so the
  // FE can stage plan-touching PATCHes with optimistic locking.
  plan_version: number;
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
      return { planned: [], unscheduled: [], lanes: [] };
    }

    // Operator-only visibility — codex review 2026-05-12 flagged that the
    // general predicate (`work_orders_visible_for_actor`) leaks plandate to
    // requesters/watchers via their visibility paths. The planning surface
    // must be operator-scoped (per project_plandate_not_for_requester).
    // 00380's `work_orders_planning_visible_for_actor` drops the requester
    // + watcher branches; tickets.read_all still grants admin override.
    const baseQuery = () =>
      this.supabase.admin
        .rpc('work_orders_planning_visible_for_actor', {
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
      plan_version: row.plan_version,
    });

    const plannedBlocks = plannedRows.map(toBlock);
    const unscheduledBlocks = unscheduledRows.map(toBlock);

    const { lanes, truncated } = await this.deriveLanes(
      filters,
      tenant.id,
      plannedBlocks,
      unscheduledBlocks,
      userMap,
      vendorMap,
    );

    return {
      planned: plannedBlocks,
      unscheduled: unscheduledBlocks,
      lanes,
      ...(truncated ? { truncated: true as const } : {}),
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
   * Per-row plandate verdict. Delegates to the shared `canPlanRow` policy
   * in `ticket-visibility.service.ts` so this batch path and the single-
   * row `assertCanPlan` gate cannot drift. The only work done here is
   * projecting the raw work_order row + the preloaded parent-team /
   * request-type maps into the policy's input shape.
   */
  private evaluateCanPlan(
    row: RawWorkOrderRow,
    ctx: VisibilityContext,
    parentTeamMap: Map<string, string | null>,
    requestTypeMap: Map<string, { id: string; name: string; domain: string }>,
  ): boolean {
    const parentTeam =
      row.parent_kind === 'case' && row.parent_ticket_id
        ? parentTeamMap.get(row.parent_ticket_id) ?? null
        : null;
    const domain = row.ticket_type_id
      ? requestTypeMap.get(row.ticket_type_id)?.domain ?? null
      : null;
    return canPlanRow(
      {
        assigned_user_id: row.assigned_user_id,
        assigned_team_id: row.assigned_team_id,
        assigned_vendor_id: row.assigned_vendor_id,
        parent_assigned_team_id: parentTeam,
        location_id: row.location_id,
        domain,
      },
      ctx,
    );
  }

  // ── lane derivation ────────────────────────────────────────────────

  /**
   * Server-side lane derivation. Returns the set of `PlanningLaneId`s the
   * FE should render as rows on the grid (drop targets), and a `truncated`
   * flag when the result was capped at `PLANNING_LANES_MAX`.
   *
   * Two modes:
   *
   *   - **team filter active.** Return the full team roster as lanes —
   *     every `team_members.user_id` becomes a user-kind lane, plus any
   *     vendor that holds an active `vendor_service_areas` row in the
   *     tenant. The dispatcher needs to see idle assignees as drop
   *     targets; the FE-derived path (from blocks alone) hid them.
   *
   *   - **no team filter.** Only lanes that already hold at least one
   *     block are returned. The all-teams view scales naturally —
   *     returning every user in every team would explode the rendered
   *     grid.
   *
   * Sort order matches the existing FE `orderLanes` (planning-grid.tsx)
   * so the FE doesn't re-sort: unassigned first, then alphabetical by
   * label, ties broken by kind (user → team → vendor). The FE's local
   * sort becomes a no-op for server-supplied lanes.
   *
   * Visibility: lane membership is operator-team identity, not block
   * visibility — DO NOT route this through `work_orders_planning_
   * visible_for_actor`. Lanes can include team members the actor doesn't
   * share a visibility scope with (that's by design — they're the
   * dispatcher's roster).
   *
   * Tenant: every read uses `.eq('tenant_id', tenantId)`. Missing this
   * filter would leak cross-tenant rosters into the lane set (P0).
   */
  private async deriveLanes(
    filters: PlanningFilters,
    tenantId: string,
    plannedBlocks: WorkOrderPlanningBlock[],
    unscheduledBlocks: WorkOrderPlanningBlock[],
    userMap: Map<string, string>,
    vendorMap: Map<string, string>,
  ): Promise<{ lanes: PlanningLaneId[]; truncated: boolean }> {
    const byKey = new Map<string, { lane: PlanningLaneId; blockCount: number }>();
    const upsert = (lane: PlanningLaneId, blockCountDelta: number) => {
      const key = laneKey(lane);
      const existing = byKey.get(key);
      if (existing) {
        existing.blockCount += blockCountDelta;
        if (!existing.lane.label && lane.label) existing.lane = lane;
      } else {
        byKey.set(key, { lane, blockCount: blockCountDelta });
      }
    };

    for (const b of plannedBlocks) upsert(b.lane, 1);
    for (const b of unscheduledBlocks) upsert(b.lane, 1);

    if (filters.team_id) {
      // Roster pull — team members + tenant vendors. Idle members (zero
      // blocks in this window) join the lane set at blockCount=0; they
      // sort to the bottom of the cap if it kicks in.
      const [memberRows, vendorRows] = await Promise.all([
        this.loadTeamRoster(filters.team_id, tenantId),
        this.loadActiveTenantVendors(tenantId),
      ]);
      for (const member of memberRows) {
        upsert(
          {
            kind: 'user',
            id: member.user_id,
            label: userMap.get(member.user_id) ?? member.fallback_label,
          },
          0,
        );
      }
      for (const vendor of vendorRows) {
        upsert(
          {
            kind: 'vendor',
            id: vendor.id,
            label: vendorMap.get(vendor.id) ?? vendor.name,
          },
          0,
        );
      }
    }

    let entries = Array.from(byKey.values());
    let truncated = false;
    if (entries.length > PLANNING_LANES_MAX) {
      // Cap by most-active first (blockCount desc); within ties keep the
      // deterministic alpha order so the cut is stable across refetches.
      entries.sort(
        (a, b) =>
          b.blockCount - a.blockCount ||
          compareLanes(a.lane, b.lane),
      );
      entries = entries.slice(0, PLANNING_LANES_MAX);
      truncated = true;
    }

    const lanes = entries.map((e) => e.lane).sort(compareLanes);
    return { lanes, truncated };
  }

  private async loadTeamRoster(
    teamId: string,
    tenantId: string,
  ): Promise<Array<{ user_id: string; fallback_label: string }>> {
    const { data, error } = await this.supabase.admin
      .from('team_members')
      .select(
        'user_id, user:users!team_members_user_id_fkey(id, email, tenant_id, person:persons!users_person_id_fkey(first_name, last_name))',
      )
      .eq('tenant_id', tenantId)
      .eq('team_id', teamId);
    if (error) throw error;
    const rows = (data ?? []) as Array<{
      user_id: string;
      user:
        | {
            id: string;
            email: string;
            tenant_id: string;
            person:
              | { first_name: string; last_name: string }
              | { first_name: string; last_name: string }[]
              | null;
          }
        | {
            id: string;
            email: string;
            tenant_id: string;
            person:
              | { first_name: string; last_name: string }
              | { first_name: string; last_name: string }[]
              | null;
          }[]
        | null;
    }>;
    const out: Array<{ user_id: string; fallback_label: string }> = [];
    for (const row of rows) {
      const user = Array.isArray(row.user) ? row.user[0] : row.user;
      // Defence-in-depth: the FK constraint already pins tenant_id on
      // join, but the nested-select tenant_id check guards against an
      // attacker that ever managed to point team_members.user_id at a
      // cross-tenant users row. Drop the row silently rather than throw.
      if (!user || user.tenant_id !== tenantId) continue;
      const person = Array.isArray(user.person) ? user.person[0] : user.person;
      const fallback = person
        ? `${person.first_name} ${person.last_name}`.trim() || user.email
        : user.email;
      out.push({ user_id: row.user_id, fallback_label: fallback || row.user_id });
    }
    return out;
  }

  private async loadActiveTenantVendors(
    tenantId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    // Vendor inclusion rule (handoff §3 P1-1): "active grant in the
    // tenant" = at least one active vendor_service_areas row. Memory
    // `project_vendor_count_reality` says <10 vendors per tenant — fine
    // to scan the small table once per request. We narrow to vendors
    // first (active=true) then filter by service-area presence.
    const { data, error } = await this.supabase.admin
      .from('vendors')
      .select('id, name, vendor_service_areas!inner(id, tenant_id, active)')
      .eq('tenant_id', tenantId)
      .eq('active', true)
      .eq('vendor_service_areas.tenant_id', tenantId)
      .eq('vendor_service_areas.active', true);
    if (error) throw error;
    const seen = new Set<string>();
    const out: Array<{ id: string; name: string }> = [];
    for (const row of (data ?? []) as Array<{ id: string; name: string }>) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({ id: row.id, name: row.name });
    }
    return out;
  }
}

function laneKey(lane: PlanningLaneId): string {
  return `${lane.kind}:${lane.id ?? '∅'}`;
}

const LANE_KIND_ORDER: Record<PlanningLaneId['kind'], number> = {
  unassigned: -1,
  user: 0,
  team: 1,
  vendor: 2,
};

export function compareLanes(a: PlanningLaneId, b: PlanningLaneId): number {
  const ak = LANE_KIND_ORDER[a.kind];
  const bk = LANE_KIND_ORDER[b.kind];
  if (ak === -1 && bk !== -1) return -1;
  if (bk === -1 && ak !== -1) return 1;
  const labelCmp = a.label.localeCompare(b.label);
  if (labelCmp !== 0) return labelCmp;
  const kindCmp = ak - bk;
  if (kindCmp !== 0) return kindCmp;
  return (a.id ?? '').localeCompare(b.id ?? '');
}

function uniqueIds<T>(rows: T[], picker: (row: T) => string | null | undefined): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    const id = picker(row);
    if (id) set.add(id);
  }
  return Array.from(set);
}
