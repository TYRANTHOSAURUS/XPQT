import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  NotImplementedException,
  forwardRef,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import {
  validateAssigneesInTenant,
  validateWatcherIdsInTenant,
} from '../../common/tenant-validation';
import { SlaService } from '../sla/sla.service';
import { TicketVisibilityService } from '../ticket/ticket-visibility.service';

export const SYSTEM_ACTOR = '__system__';

/**
 * Row shape returned by command methods (`updateSla`, `setPlan`, …). The
 * work_orders table mirrors most of `tickets` (Step 1c.1/1c.10c) but
 * post-cutover it is its own base table — callers should not assume the
 * field set is identical to `TicketDetail`.
 */
export type WorkOrderRow = Record<string, unknown> & {
  id: string;
  tenant_id: string;
  sla_id: string | null;
  planned_start_at: string | null;
  planned_duration_minutes: number | null;
};

/**
 * Union DTO accepted by the orchestrator `WorkOrderService.update`. Every
 * field is optional; the orchestrator dispatches per-field-group to the
 * existing per-field service methods (`updateSla` / `setPlan` / `updateStatus`
 * / `updatePriority` / `updateAssignment`). At least one field must be
 * present — an empty DTO is rejected as `BadRequest`.
 *
 * See `docs/assignments-routing-fulfillment.md` §7 for the per-field gates
 * that fire inside the orchestrator.
 */
export interface UpdateWorkOrderDto {
  sla_id?: string | null;
  planned_start_at?: string | null;
  planned_duration_minutes?: number | null;
  status?: string;
  status_category?: string;
  waiting_reason?: string | null;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  assigned_team_id?: string | null;
  assigned_user_id?: string | null;
  assigned_vendor_id?: string | null;
  // Slice 3.1 metadata fields. Match the case-side
  // (TicketService.update) shape: bulk-write, no permission gate beyond
  // the visibility floor, no per-field activity emission. Adding finer
  // gates / activity rows is deferred — case side has the same gap.
  title?: string;
  description?: string | null;
  cost?: number | null;
  tags?: string[] | null;
  watchers?: string[] | null;
}

const PLAN_FIELDS = ['planned_start_at', 'planned_duration_minutes'] as const;
const STATUS_FIELDS = ['status', 'status_category', 'waiting_reason'] as const;
const ASSIGNMENT_FIELDS = ['assigned_team_id', 'assigned_user_id', 'assigned_vendor_id'] as const;
const METADATA_FIELDS = ['title', 'description', 'cost', 'tags', 'watchers'] as const;

// Module-level shared constants — used by both per-field methods and the
// orchestrator's preflight. Single source of truth so a future tweak to
// any bound or enum doesn't drift between the two validation surfaces.
// Full-review on commit 4b2f6e0 caught a divergent duration cap (preflight
// 30d vs setPlan 1y) — the same shape of bug; this is the structural fix.
export const MAX_DURATION_MINUTES = 60 * 24 * 365; // 1 year
export const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Priority = (typeof VALID_PRIORITIES)[number];

export const ERR_DURATION_INVALID = (max = MAX_DURATION_MINUTES) =>
  `planned_duration_minutes must be a positive integer ≤ ${max}`;
export const ERR_PRIORITY_INVALID = `priority must be one of: ${VALID_PRIORITIES.join(', ')}`;
export const ERR_PLANNED_START_INVALID =
  'planned_start_at must be a valid ISO 8601 timestamp or null';
export const ERR_TITLE_EMPTY = 'title must not be empty';
export const ERR_COST_NOT_FINITE = 'cost must be a finite number or null';
export const ERR_TAGS_INVALID = 'tags must be an array of strings or null';
export const ERR_WATCHERS_SHAPE_INVALID =
  'watchers must be an array of strings (person UUIDs) or null';
export const ERR_PERM_SLA_OVERRIDE =
  "missing 'sla.override' permission";
export const ERR_PERM_PRIORITY_CHANGE =
  "missing 'tickets.change_priority' permission";
export const ERR_PERM_ASSIGN =
  "missing 'tickets.assign' permission";

/**
 * WorkOrderService — the work-order command surface.
 *
 * Step 1c.10c made `TicketService.update` case-only. Any command that
 * mutates a work_order row (sla_id, plan, status, priority, assignment,
 * watchers, etc.) belongs here, NOT on TicketService. Today this service
 * exposes the SLA + plandate commands; status/priority/assignment/watchers
 * accumulate here as they get rewired off the case-only TicketService.
 *
 * See `docs/assignments-routing-fulfillment.md` §6/§7 for the case-vs-WO
 * model and SLA editability rules.
 */
@Injectable()
export class WorkOrderService {
  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => SlaService))
    private readonly slaService: SlaService,
    private readonly visibility: TicketVisibilityService,
  ) {}

  /**
   * Single-endpoint command surface for `PATCH /work-orders/:id`.
   *
   * Plan-reviewer P1 (post-1c.10c): per-field PATCH endpoints (`/sla`,
   * `/plan`, `/status`, `/priority`, `/assignment`) accreted as Slice 2 grew
   * — each new field adds another route, hook, gate. The right shape is one
   * endpoint that accepts a union DTO and dispatches per-field-group
   * server-side. This method is that orchestrator.
   *
   * Behavior:
   * - Accepts any subset of `UpdateWorkOrderDto`. At least one field must be
   *   present — empty DTO rejects as `BadRequest`.
   * - Dispatches to the existing per-field service methods (`updateSla`,
   *   `setPlan`, `updateStatus`, `updatePriority`, `updateAssignment`) so
   *   side effects (timer pause/resume, activity emission, no-op fast-path,
   *   refetch) are reused unchanged. The per-field methods remain callable
   *   directly from internal callers (cron, workflow engine, SYSTEM_ACTOR).
   * - Each per-field method enforces its own gate (visibility floor +
   *   permission ceiling). Calling `update()` with multiple field-groups
   *   evaluates each gate independently — there is no "common floor" that
   *   short-circuits subsequent checks. SLA's danger gate (`sla.override`)
   *   only fires inside the SLA branch; priority's `tickets.change_priority`
   *   only fires inside the priority branch; etc.
   * - Order of application is fixed: SLA → plan → status → priority →
   *   assignment. This matches the side-effect dependency order
   *   (status changes can pause/resume timers, which depend on the SLA
   *   policy being already set). Multiple fields in one call are applied
   *   sequentially, NOT atomically — a failure mid-sequence leaves earlier
   *   updates committed. This matches the per-field endpoint behavior the
   *   FE was already coded against; a transactional wrapper is class-wide
   *   debt tracked alongside the activity-row swallow pattern.
   * - Returns the final row state after all dispatched updates apply.
   *   Single-field calls return the per-field method's row directly; multi-
   *   field calls refetch once at the end so the response reflects every
   *   side effect (e.g. resolved_at synthesized by status, sla_id-derived
   *   columns from SLA edits).
   * - SYSTEM_ACTOR bypasses every gate (the per-field methods already do
   *   this individually).
   */
  async update(
    workOrderId: string,
    dto: UpdateWorkOrderDto,
    actorAuthUid: string,
  ): Promise<WorkOrderRow> {
    if (!dto || typeof dto !== 'object') {
      throw new BadRequestException('body required');
    }

    // A key is "present" when set to any value other than undefined. We
    // intentionally treat `null` as present (means "clear this field");
    // explicit `undefined` is treated as absent so callers passing
    // `{ ...maybeStatus, title: undefined }` don't accidentally trigger
    // the metadata branch with an empty inner DTO. Code-review (Slice 3.1
    // full-review #2): without the `!== undefined` guard, an extra DB
    // round-trip + visibility load would fire for an absent-by-shape key.
    const present = (k: string) =>
      Object.prototype.hasOwnProperty.call(dto, k) &&
      (dto as Record<string, unknown>)[k] !== undefined;

    const hasSla = present('sla_id');
    const hasPlan = PLAN_FIELDS.some((f) => present(f));
    const hasStatus = STATUS_FIELDS.some((f) => present(f));
    const hasPriority = present('priority');
    const hasAssignment = ASSIGNMENT_FIELDS.some((f) => present(f));
    const hasMetadata = METADATA_FIELDS.some((f) => present(f));

    if (!hasSla && !hasPlan && !hasStatus && !hasPriority && !hasAssignment && !hasMetadata) {
      throw new BadRequestException(
        'update requires at least one of: sla_id, planned_start_at, planned_duration_minutes, status, status_category, waiting_reason, priority, assigned_team_id, assigned_user_id, assigned_vendor_id, title, description, cost, tags, watchers',
      );
    }

    // Pre-flight validation — closes the partial-commit-on-validation-
    // failure hole. Without this, a multi-field PATCH like
    // `{ priority: 'high', assigned_team: 'X', title: '' }` would write
    // priority + assignment, then reject the empty title — leaving the
    // user with two committed changes they thought "failed".
    //
    // preflightValidateUpdate runs every check that any per-field method
    // could throw on (visibility, tenant-validation, permission RPCs,
    // format / enum / range), but does NOT write. If it throws, the
    // dispatch loop below never starts and no partial state lands.
    //
    // Per-field methods retain their own validations as defense-in-depth
    // — preflight is not a substitute for them, just a structural gate
    // that closes the multi-field race.
    //
    // HONEST SCOPE NOTE — what preflight does and does NOT close:
    //
    // Closed by preflight:
    //   • All validation throws on the work_orders row write itself.
    //     A multi-field PATCH where one field is malformed/forbidden
    //     now rejects atomically with no partial state.
    //
    // NOT closed (still partial-commit hazards on the WO orchestrator):
    //   1. **Activity-row insert failures** — every per-field method
    //      writes an activity row in a try/catch that `console.error`s
    //      on failure (status_changed, priority_changed,
    //      assignment_changed, sla_changed, plan_changed,
    //      metadata_changed). The work_orders row commits; the audit
    //      row may be missing. User sees a 200 but the audit log is
    //      lying. Tagged as known debt across the file.
    //   2. **SLA timer churn** — `applyWaitingStateTransition`,
    //      `restartTimers`, `pauseTimers` write to sla_timers AFTER
    //      the work_orders write commits. Failure leaves status
    //      committed and timers stale.
    //   3. **Multi-field WRITE race** — between phase-2 writes (six
    //      independent UPDATE statements per orchestrator call), a
    //      transient DB error / serialization conflict / row-deleted-
    //      concurrently can leave 1-N branches committed and 1-N not.
    //
    // The fix for all three is full transactional wrapping via
    // `DbService.tx` + raw-SQL writes — separate class-wide debt that
    // also subsumes the activity-row swallow pattern. Until shipped,
    // partial commits beyond validation failures remain possible.
    // Don't claim "atomic"; claim "validation-atomic".
    await this.preflightValidateUpdate(workOrderId, dto, actorAuthUid, {
      hasSla, hasPlan, hasStatus, hasPriority, hasAssignment, hasMetadata,
    });

    let last: WorkOrderRow | null = null;
    const dispatched: Array<'sla' | 'plan' | 'status' | 'priority' | 'assignment' | 'metadata'> = [];

    // SLA first — its restartTimers side effect changes columns that
    // downstream status transitions read (sla_id is loaded before the
    // pause/resume helper runs).
    if (hasSla) {
      last = await this.updateSla(workOrderId, dto.sla_id ?? null, actorAuthUid);
      dispatched.push('sla');
    }

    if (hasPlan) {
      const plannedStartAt = present('planned_start_at')
        ? (dto.planned_start_at ?? null)
        : null;
      // Mirror the per-field controller: when only duration is supplied
      // without start, we still need a current-row read. Pull from `last`
      // (refreshed if SLA branch ran) or load fresh.
      const plannedDuration = present('planned_duration_minutes')
        ? (dto.planned_duration_minutes ?? null)
        : null;
      // If start wasn't explicitly provided but duration was, preserve the
      // current start. Otherwise the server would clear the plan when the
      // caller only meant to bump duration.
      const startToWrite = present('planned_start_at')
        ? plannedStartAt
        : (last?.planned_start_at ?? null);
      last = await this.setPlan(workOrderId, startToWrite, plannedDuration, actorAuthUid);
      dispatched.push('plan');
    }

    if (hasStatus) {
      const statusDto: { status?: string; status_category?: string; waiting_reason?: string | null } = {};
      if (present('status')) statusDto.status = dto.status;
      if (present('status_category')) statusDto.status_category = dto.status_category;
      if (present('waiting_reason')) statusDto.waiting_reason = dto.waiting_reason ?? null;
      last = await this.updateStatus(workOrderId, statusDto, actorAuthUid);
      dispatched.push('status');
    }

    if (hasPriority) {
      // Priority is required-when-present; the type-narrowing already
      // forbids undefined here.
      last = await this.updatePriority(workOrderId, dto.priority as 'low' | 'medium' | 'high' | 'critical', actorAuthUid);
      dispatched.push('priority');
    }

    if (hasAssignment) {
      const assignmentDto: {
        assigned_team_id?: string | null;
        assigned_user_id?: string | null;
        assigned_vendor_id?: string | null;
      } = {};
      for (const f of ASSIGNMENT_FIELDS) {
        if (present(f)) {
          assignmentDto[f] = dto[f] ?? null;
        }
      }
      last = await this.updateAssignment(workOrderId, assignmentDto, actorAuthUid);
      dispatched.push('assignment');
    }

    if (hasMetadata) {
      // Slice 3.1 fields are last in the dispatch order — they're plain
      // metadata writes with no side-effects on timers, status promotion,
      // or assignment cascade. Order doesn't matter relative to them but
      // running them last keeps the side-effect-bearing branches first.
      const metadataDto: {
        title?: string;
        description?: string | null;
        cost?: number | null;
        tags?: string[] | null;
        watchers?: string[] | null;
      } = {};
      if (present('title')) metadataDto.title = dto.title;
      if (present('description')) metadataDto.description = dto.description ?? null;
      if (present('cost')) metadataDto.cost = dto.cost ?? null;
      if (present('tags')) metadataDto.tags = dto.tags ?? null;
      if (present('watchers')) metadataDto.watchers = dto.watchers ?? null;
      last = await this.updateMetadata(workOrderId, metadataDto, actorAuthUid);
      dispatched.push('metadata');
    }

    // Multi-field calls: refetch once so the final row reflects every side
    // effect. Single-field calls already returned a fresh row from the
    // per-field method.
    if (dispatched.length > 1) {
      const tenant = TenantContext.current();
      const { data: refreshed, error: refetchErr } = await this.supabase.admin
        .from('work_orders')
        .select('*')
        .eq('id', workOrderId)
        .eq('tenant_id', tenant.id)
        .maybeSingle();
      if (refetchErr) throw refetchErr;
      if (!refreshed) {
        throw new ForbiddenException('Work order no longer accessible');
      }
      return refreshed as WorkOrderRow;
    }

    // Defensive: dispatched is non-empty (we threw on empty DTO above), so
    // `last` is always set here. The `!` would be unsafe-looking; throw
    // explicitly for clarity instead.
    if (!last) {
      throw new BadRequestException(
        'update requires at least one of: sla_id, planned_start_at, planned_duration_minutes, status, status_category, waiting_reason, priority, assigned_team_id, assigned_user_id, assigned_vendor_id, title, description, cost, tags, watchers',
      );
    }
    return last;
  }

  /**
   * Pre-flight validation for the orchestrator. Runs every check the per-
   * field methods would run, but writes nothing. If any check fails,
   * the orchestrator throws BEFORE dispatching to per-field methods —
   * eliminating partial-commit-on-validation-failure for multi-field
   * PATCH calls.
   *
   * What it checks (mirrors per-field method validation):
   *   - Visibility: assertCanPlan (operator floor)
   *   - Permissions: sla.override (if hasSla), tickets.change_priority
   *     (if hasPriority), tickets.assign (if hasAssignment) — all
   *     skipped when has_write_all
   *   - Tenant validation: validateAssigneesInTenant,
   *     validateWatcherIdsInTenant
   *   - SLA policy reference exists in tenant (if hasSla and not null)
   *   - Plan: ISO timestamp parse + duration bounds
   *   - Priority: enum membership
   *   - Metadata: empty title, finite cost, tags-are-strings,
   *     watchers-are-strings
   *
   * SYSTEM_ACTOR bypass — matches the existing per-field method
   * convention. Workflow engine + cron writes pass through without
   * paying for the preflight DB round-trips.
   *
   * NOT in scope: runtime DB error mid-write (concurrent serialization,
   * row-deleted-between-read-and-write, transient connection error).
   * Those still partial-commit; closing them needs full transactional
   * wrapping via DbService.tx — separate slice.
   */
  private async preflightValidateUpdate(
    workOrderId: string,
    dto: UpdateWorkOrderDto,
    actorAuthUid: string,
    flags: {
      hasSla: boolean;
      hasPlan: boolean;
      hasStatus: boolean;
      hasPriority: boolean;
      hasAssignment: boolean;
      hasMetadata: boolean;
    },
  ): Promise<void> {
    // Two tiers of validation:
    //   1. Stateless format / enum / range — ALWAYS runs, even for
    //      SYSTEM_ACTOR. Workflow-engine and cron writes shouldn't be
    //      able to land malformed data either; matches the per-field
    //      method convention where format checks fire before the
    //      SYSTEM_ACTOR bypass on visibility/permission.
    //   2. DB-dependent (visibility, permissions, tenant validation,
    //      SLA policy lookup) — SKIPPED for SYSTEM_ACTOR. Trusted-system
    //      writes shouldn't pay the round-trip cost.

    // ── tier 1: stateless format / enum / range / shape checks ──────
    // Always run, even for SYSTEM_ACTOR. Workflow + cron writes shouldn't
    // be able to land malformed data either; matches the per-field method
    // convention where format checks fire before the SYSTEM_ACTOR bypass.
    if (flags.hasPlan) {
      if (
        Object.prototype.hasOwnProperty.call(dto, 'planned_start_at') &&
        dto.planned_start_at !== null &&
        dto.planned_start_at !== undefined
      ) {
        const ts = Date.parse(dto.planned_start_at);
        if (Number.isNaN(ts)) {
          throw new BadRequestException(ERR_PLANNED_START_INVALID);
        }
      }
      if (
        Object.prototype.hasOwnProperty.call(dto, 'planned_duration_minutes') &&
        dto.planned_duration_minutes !== null &&
        dto.planned_duration_minutes !== undefined
      ) {
        const d = dto.planned_duration_minutes;
        if (
          typeof d !== 'number' ||
          !Number.isInteger(d) ||
          d <= 0 ||
          d > MAX_DURATION_MINUTES
        ) {
          throw new BadRequestException(ERR_DURATION_INVALID());
        }
      }
    }
    if (flags.hasPriority) {
      if (!VALID_PRIORITIES.includes(dto.priority as Priority)) {
        throw new BadRequestException(ERR_PRIORITY_INVALID);
      }
    }
    if (flags.hasMetadata) {
      if (dto.title !== undefined && dto.title.trim() === '') {
        throw new BadRequestException(ERR_TITLE_EMPTY);
      }
      if (
        Object.prototype.hasOwnProperty.call(dto, 'cost') &&
        dto.cost !== null &&
        dto.cost !== undefined &&
        !Number.isFinite(dto.cost)
      ) {
        throw new BadRequestException(ERR_COST_NOT_FINITE);
      }
      if (
        Object.prototype.hasOwnProperty.call(dto, 'tags') &&
        dto.tags !== null &&
        dto.tags !== undefined &&
        (!Array.isArray(dto.tags) || !dto.tags.every((t) => typeof t === 'string'))
      ) {
        throw new BadRequestException(ERR_TAGS_INVALID);
      }
      // Watchers SHAPE check (full-review #2 critical fix). Pre-fix this
      // wasn't in tier-1; SYSTEM_ACTOR with `watchers: "foo"` would commit
      // prior fields then 400 on metadata — the exact partial-commit
      // class preflight is meant to prevent. The DEEPER tenant-membership
      // check stays in tier-2 because it needs DB access.
      if (
        Object.prototype.hasOwnProperty.call(dto, 'watchers') &&
        dto.watchers !== null &&
        dto.watchers !== undefined &&
        (!Array.isArray(dto.watchers) ||
          !dto.watchers.every((w) => typeof w === 'string'))
      ) {
        throw new BadRequestException(ERR_WATCHERS_SHAPE_INVALID);
      }
    }

    // Stateless assignee uuid format check.
    if (flags.hasAssignment) {
      const UUID_RE =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      for (const f of ASSIGNMENT_FIELDS) {
        const v = (dto as Record<string, unknown>)[f];
        if (typeof v === 'string' && !UUID_RE.test(v)) {
          throw new BadRequestException(`${f} is not a valid uuid: ${v}`);
        }
      }
    }

    // SLA policy existence in tenant (full-review #3 critical fix).
    // Pre-fix this lived in tier-2 and was skipped for SYSTEM_ACTOR;
    // `updateSla` validates the same thing for SYSTEM_ACTOR (line 587+),
    // so SYSTEM_ACTOR multi-field PATCH with bad sla_id + good other
    // fields would commit the others and then reject — partial commit
    // reintroduced. Hoisted into tier-1 because it's an auth-free DB
    // lookup keyed by a deterministic id.
    if (
      flags.hasSla &&
      dto.sla_id !== null &&
      dto.sla_id !== undefined
    ) {
      const tenant = TenantContext.current();
      const { data: policy, error } = await this.supabase.admin
        .from('sla_policies')
        .select('id')
        .eq('id', dto.sla_id)
        .eq('tenant_id', tenant.id)
        .maybeSingle();
      if (error) throw error;
      if (!policy) {
        throw new BadRequestException(
          `sla_id ${dto.sla_id} does not reference a known SLA policy in this tenant`,
        );
      }
    }

    // ── tier 2: visibility + permission + tenant validation ──────────
    // (skipped for SYSTEM_ACTOR — matches per-field method convention)
    if (actorAuthUid === SYSTEM_ACTOR) return;

    const tenant = TenantContext.current();
    const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);

    // Visibility floor — fail-fast for callers who can't see the row at all.
    await this.visibility.assertCanPlan(workOrderId, ctx);

    // Permission gates — each skipped when has_write_all. Order matches
    // the dispatch order in update(); failure throws before any write.
    const checkPermission = async (key: string): Promise<boolean> => {
      const { data, error } = await this.supabase.admin.rpc('user_has_permission', {
        p_user_id: ctx.user_id,
        p_tenant_id: tenant.id,
        p_permission: key,
      });
      if (error) throw error;
      return !!data;
    };

    if (flags.hasSla && !ctx.has_write_all) {
      if (!(await checkPermission('sla.override'))) {
        throw new ForbiddenException(ERR_PERM_SLA_OVERRIDE);
      }
    }
    if (flags.hasPriority && !ctx.has_write_all) {
      if (!(await checkPermission('tickets.change_priority'))) {
        throw new ForbiddenException(ERR_PERM_PRIORITY_CHANGE);
      }
    }
    if (flags.hasAssignment && !ctx.has_write_all) {
      if (!(await checkPermission('tickets.assign'))) {
        throw new ForbiddenException(ERR_PERM_ASSIGN);
      }
    }

    // Tenant validations.
    if (flags.hasAssignment) {
      await validateAssigneesInTenant(
        this.supabase,
        {
          assigned_team_id: dto.assigned_team_id,
          assigned_user_id: dto.assigned_user_id,
          assigned_vendor_id: dto.assigned_vendor_id,
        },
        tenant.id,
        { skipForSystemActor: false }, // already returned above for SYSTEM_ACTOR
      );
    }
    if (flags.hasMetadata && dto.watchers !== undefined) {
      await validateWatcherIdsInTenant(this.supabase, dto.watchers, tenant.id, {
        skipForSystemActor: false,
      });
    }

    // SLA policy existence — moved to tier 1 (auth-free; needs to fire
    // for SYSTEM_ACTOR too because per-field updateSla validates it
    // there).
  }

  /**
   * Reassign the executor SLA on a work_order. Mirrors the pre-1c.10c
   * `TicketService.update({ sla_id })` behavior for child tickets.
   *
   * - Visibility gate is `assertCanPlan` (parent-case team owners can act on
   *   child WOs — wider than `assertVisible('write')` which doesn't model
   *   that path). See `ticket-visibility.service.ts:184`.
   * - No-op (no DB write, no timer churn) when the new value equals the
   *   current value — avoids stomping on stable timers.
   * - Validates `slaId` references a real `sla_policies` row in the tenant
   *   before persisting; null clears the SLA.
   * - Calls `SlaService.restartTimers` so existing timers stop and fresh
   *   ones start from the new policy.
   * - Records a `sla_changed` system-event activity (mirrors the activity
   *   that `TicketService.update` previously emitted on this path).
   */
  async updateSla(
    workOrderId: string,
    slaId: string | null,
    actorAuthUid: string,
  ): Promise<WorkOrderRow> {
    const tenant = TenantContext.current();

    // Two-axis gate: visibility floor + danger-permission check.
    //
    // Visibility (assertCanPlan): the user must be able to see the WO at all
    // (assignee / assigned vendor / WO team / parent case team / scoped role
    // / tickets.write_all). Without this, the permission check could leak WO
    // ids from other locations/domains.
    //
    // Permission (sla.override OR tickets.write_all): SLA reassignment is
    // explicitly marked danger:true in the permission catalog
    // (packages/shared/src/permissions.ts:296). It is desk/admin-owned —
    // assignees and vendors can SEE the WO and its SLA but should NOT change
    // it. Codex round 1 flagged that gating on assertCanPlan alone over-grants.
    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertCanPlan(workOrderId, ctx);

      if (!ctx.has_write_all) {
        const { data: hasOverride, error: permErr } = await this.supabase.admin.rpc(
          'user_has_permission',
          {
            p_user_id: ctx.user_id,
            p_tenant_id: tenant.id,
            p_permission: 'sla.override',
          },
        );
        if (permErr) throw permErr;
        if (!hasOverride) {
          throw new ForbiddenException(
            ERR_PERM_SLA_OVERRIDE,
          );
        }
      }
    }

    const { data: current, error: loadErr } = await this.supabase.admin
      .from('work_orders')
      .select('id, tenant_id, sla_id')
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!current) {
      throw new NotFoundException(`Work order ${workOrderId} not found`);
    }
    const currentRow = current as { id: string; tenant_id: string; sla_id: string | null };
    const previousSlaId = currentRow.sla_id;

    // No-op fast-path: the FE will sometimes send the same value (e.g. when
    // the user re-selects the current option). Don't churn timers.
    if (previousSlaId === slaId) {
      const { data: full, error: refetchErr } = await this.supabase.admin
        .from('work_orders')
        .select('*')
        .eq('id', workOrderId)
        .eq('tenant_id', tenant.id)
        .single();
      if (refetchErr) throw refetchErr;
      return full as WorkOrderRow;
    }

    // Validate the target policy belongs to this tenant before mutating.
    // Avoids an FK violation surfacing as a 500; also blocks cross-tenant id
    // smuggling. `null` is a deliberate "No SLA" choice — skip validation.
    if (slaId !== null) {
      const { data: policy, error: policyErr } = await this.supabase.admin
        .from('sla_policies')
        .select('id')
        .eq('id', slaId)
        .eq('tenant_id', tenant.id)
        .maybeSingle();
      if (policyErr) throw policyErr;
      if (!policy) {
        throw new BadRequestException(
          `sla_id ${slaId} does not reference a known SLA policy in this tenant`,
        );
      }
    }

    // Bump updated_at explicitly. The work_orders table has no auto-trigger
    // for updated_at on UPDATE (the bridge-era trigger was dropped in
    // 00217_step1c3_post_review_fixes.sql:235 and never restored as a native
    // post-cutover trigger). Codex round 1 caught this — without the
    // explicit timestamp, downstream consumers (FE refetch, audit feeds,
    // Realtime) miss the change.
    const { error: updateErr } = await this.supabase.admin
      .from('work_orders')
      .update({ sla_id: slaId, updated_at: new Date().toISOString() })
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id);
    if (updateErr) throw updateErr;

    // Restart timers. SlaService.restartTimers handles null (clear-only)
    // internally and routes the row update via updateTicketOrWorkOrder.
    //
    // KNOWN DEBT (codex round 1): swallowing this error leaves sla_id and
    // active timers inconsistent. Fixing that properly requires a
    // transaction or outbox pattern in SlaService — not B1.5 scope.
    // TicketService.update has the same swallow pattern today
    // (ticket.service.ts:842). Lock-step replacement is a separate task;
    // until then, a cron tick + manual recovery can reconcile.
    try {
      await this.slaService.restartTimers(workOrderId, tenant.id, slaId);
    } catch (err) {
      console.error('[sla] restart on work_order sla_id change failed', err);
    }

    // Activity row. Mirrors the `sla_changed` event TicketService.update
    // previously wrote for child tickets. ticket_activities accepts
    // work_order ids post-1c.10c (FK to tickets dropped in 00235); the
    // activities sidecar mirrors via shadow trigger with entity_kind
    // auto-derived to 'work_order'.
    //
    // KNOWN DEBT (codex round 1): same audit-trail concern as the timer
    // swallow above. Documented for the class-wide cleanup.
    try {
      const authorPersonId = await this.resolveAuthorPersonId(actorAuthUid, tenant.id);
      const { error: activityErr } = await this.supabase.admin
        .from('ticket_activities')
        .insert({
          tenant_id: tenant.id,
          ticket_id: workOrderId,
          activity_type: 'system_event',
          author_person_id: authorPersonId,
          visibility: 'system',
          metadata: {
            event: 'sla_changed',
            from_sla_id: previousSlaId,
            to_sla_id: slaId,
          },
        });
      if (activityErr) throw activityErr;
    } catch (err) {
      console.error('[work-order] sla_changed activity failed', err);
    }

    // Refetch AFTER restartTimers so the returned row reflects any
    // SLA-derived columns the timer restart writes (due_at, breached_at,
    // sla_at_risk, etc.). Without this the FE caches a stale snapshot.
    // Codex round 1 finding #3.
    const { data: refreshed, error: refetchErr } = await this.supabase.admin
      .from('work_orders')
      .select('*')
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (refetchErr) throw refetchErr;
    if (!refreshed) {
      throw new ForbiddenException('Work order no longer accessible');
    }
    return refreshed as WorkOrderRow;
  }

  /**
   * Set the assignee-declared plan (planned_start_at + planned_duration_minutes)
   * on a work_order. Mirrors the pre-1c.10c `TicketService.setPlan` behavior;
   * the legacy method still exists at `ticket.service.ts:1082` but writes to
   * the wrong table post-cutover (case-only `tickets`) — that file is owned
   * by the plandate workstream and stays as the dead-but-isolated code their
   * cleanup will remove. The Plan SidebarGroup in the desk UI is gated to
   * `ticket_kind === 'work_order'`, so all live plan writes route here.
   *
   * Inherits the same Step 1c.10c codex round 1 pattern that `updateSla` uses:
   *  - Visibility-only gate (no `danger:true` permission gate). Plandate is
   *    the assignee's call by design — `assertCanPlan` already excludes
   *    requesters/watchers and read-only cross-domain roles. Codex round 1's
   *    finding #1 about over-grant only applied to SLA reassignment.
   *  - No-op fast-path when both fields equal current — no churn, no activity.
   *  - Explicit `updated_at` bump (work_orders has no auto-trigger post-1c.10c).
   *  - Refetch AFTER the activity write so the returned row reflects any
   *    activity-side mutations downstream consumers care about.
   */
  async setPlan(
    workOrderId: string,
    plannedStartAt: string | null,
    plannedDurationMinutes: number | null,
    actorAuthUid: string,
  ): Promise<WorkOrderRow> {
    const tenant = TenantContext.current();

    // Visibility gate. Plan changes are explicitly allowed for the WO
    // assignee, the assigned vendor, and team members of the WO/parent case
    // team — `assertCanPlan` encodes that. No additional permission check
    // (per codex round 1: SLA's danger gate doesn't apply to plan).
    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertCanPlan(workOrderId, ctx);
    }

    // Validate inputs early. Same rules as the legacy TicketService.setPlan
    // (ticket.service.ts:1106-1116) so behavior is identical for callers.
    if (plannedStartAt !== null) {
      const ts = Date.parse(plannedStartAt);
      if (Number.isNaN(ts)) {
        throw new BadRequestException(
          'planned_start_at must be a valid ISO 8601 timestamp',
        );
      }
    }
    // Upper bound: 1 year of minutes (module-level MAX_DURATION_MINUTES;
    // shared with preflight). `Number.isInteger` returns true for some
    // integral floats above 2^31 (e.g. 1e15), which would pass our
    // validation and 500 on the int4 column overflow. Codex round 1 catch.
    if (
      plannedDurationMinutes !== null &&
      (!Number.isInteger(plannedDurationMinutes) ||
        plannedDurationMinutes <= 0 ||
        plannedDurationMinutes > MAX_DURATION_MINUTES)
    ) {
      throw new BadRequestException(ERR_DURATION_INVALID());
    }
    // Duration without a start makes no sense — clear them together.
    // Mirror of the legacy method's behavior; the FE relies on this.
    const finalDuration = plannedStartAt === null ? null : plannedDurationMinutes;

    // Load current row + tenant scope. maybeSingle so an unknown id raises
    // 404 cleanly rather than throwing the supabase no-rows error.
    const { data: current, error: loadErr } = await this.supabase.admin
      .from('work_orders')
      .select('id, tenant_id, planned_start_at, planned_duration_minutes')
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!current) {
      throw new NotFoundException(`Work order ${workOrderId} not found`);
    }
    const currentRow = current as {
      id: string;
      tenant_id: string;
      planned_start_at: string | null;
      planned_duration_minutes: number | null;
    };

    const previous = {
      planned_start_at: currentRow.planned_start_at,
      planned_duration_minutes: currentRow.planned_duration_minutes,
    };
    const nextValues = {
      planned_start_at: plannedStartAt,
      planned_duration_minutes: finalDuration,
    };

    // No-op fast-path. The FE re-emits identical values for some flows
    // (e.g. opening + closing the picker without changing it). Skip the
    // write + activity row + cache invalidations.
    //
    // Codex round 2 catch: timestamps from Postgres come back in a
    // different STRING form than what the caller sent (e.g. caller sends
    // `2026-05-04T13:00:00.000Z`, DB returns `2026-05-04T13:00:00+00:00`)
    // — same instant, different string. A naive `===` would treat these
    // as different and trigger an unnecessary write + spurious activity
    // row. Normalize both sides via Date.parse before comparing.
    const sameStart =
      previous.planned_start_at === nextValues.planned_start_at ||
      (previous.planned_start_at !== null &&
        nextValues.planned_start_at !== null &&
        Date.parse(previous.planned_start_at) === Date.parse(nextValues.planned_start_at));
    if (
      sameStart &&
      previous.planned_duration_minutes === nextValues.planned_duration_minutes
    ) {
      const { data: full, error: refetchErr } = await this.supabase.admin
        .from('work_orders')
        .select('*')
        .eq('id', workOrderId)
        .eq('tenant_id', tenant.id)
        .single();
      if (refetchErr) throw refetchErr;
      return full as WorkOrderRow;
    }

    // Explicit updated_at — work_orders has no auto-trigger for it
    // post-1c.10c (the bridge-era trigger was dropped in 00217 and never
    // restored). Codex round 1 finding for updateSla applies here too.
    const { error: updateErr } = await this.supabase.admin
      .from('work_orders')
      .update({
        planned_start_at: nextValues.planned_start_at,
        planned_duration_minutes: nextValues.planned_duration_minutes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id);
    if (updateErr) throw updateErr;

    // Activity row. Same `plan_changed` event shape the legacy
    // TicketService.setPlan emitted (ticket.service.ts:1143-1156) so the
    // activity feed renderer keeps working unchanged.
    //
    // KNOWN DEBT (carried over from updateSla): swallowing the error leaves
    // the row updated but the audit trail missing. Class-wide cleanup is
    // tracked in the Step 1c.10c handoff.
    try {
      const authorPersonId = await this.resolveAuthorPersonId(actorAuthUid, tenant.id);
      const { error: activityErr } = await this.supabase.admin
        .from('ticket_activities')
        .insert({
          tenant_id: tenant.id,
          ticket_id: workOrderId,
          activity_type: 'system_event',
          author_person_id: authorPersonId,
          visibility: 'system',
          metadata: {
            event: 'plan_changed',
            previous,
            next: nextValues,
          },
        });
      if (activityErr) throw activityErr;
    } catch (err) {
      console.error('[work-order] plan_changed activity failed', err);
    }

    // Refetch AFTER the activity write so the returned row is the
    // post-mutation snapshot. Codex round 1 finding #3.
    const { data: refreshed, error: refetchErr } = await this.supabase.admin
      .from('work_orders')
      .select('*')
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (refetchErr) throw refetchErr;
    if (!refreshed) {
      throw new ForbiddenException('Work order no longer accessible');
    }
    return refreshed as WorkOrderRow;
  }

  /**
   * Probe the plandate gate for the FE — returns `{ canPlan: true }` if the
   * caller would be allowed to set a plan on this work_order, `false`
   * otherwise. Used by the desk UI to disable the affordance instead of
   * waiting for a 403 round-trip. Mirrors the existing
   * `GET /tickets/:id/can-plan` endpoint behavior.
   */
  async canPlan(
    workOrderId: string,
    actorAuthUid: string,
  ): Promise<{ canPlan: boolean }> {
    const tenant = TenantContext.current();
    if (actorAuthUid === SYSTEM_ACTOR) return { canPlan: true };
    const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
    try {
      await this.visibility.assertCanPlan(workOrderId, ctx);
      return { canPlan: true };
    } catch (err) {
      if (err instanceof ForbiddenException) return { canPlan: false };
      throw err;
    }
  }

  /**
   * Update status / status_category / waiting_reason on a work_order. Mirrors
   * the case-side `TicketService.update` status path (ticket.service.ts:880-952)
   * but writes to work_orders directly.
   *
   * Visibility gate: `assertCanPlan` (the same operator floor used by
   * `setPlan` / `updateAssignment` / `updatePriority`). No per-transition
   * close/reopen permission gate — case side doesn't have one and divergence
   * here would be a footgun for the desk UI which calls both paths
   * symmetrically.
   *
   * Side effects:
   *  - When status_category enters 'resolved', synthesize `resolved_at = now()`.
   *  - When status_category enters 'closed', synthesize `closed_at = now()`.
   *  - On waiting-state transitions, call
   *    `slaService.applyWaitingStateTransition` (the shared helper that the
   *    case-side `TicketService.update` also uses) to pause/resume SLA timers
   *    when the policy's `pause_on_waiting_reasons` matches the new
   *    waiting_reason. No double-fire risk via workflow listeners (verified
   *    against case-side code path).
   *  - Activity row: `system_event` with `metadata.event = 'status_changed'`,
   *    previous/next snapshots of the changed fields.
   *  - Domain event: `ticket_status_changed` (same name as case-side; the
   *    entity_id disambiguates).
   */
  async updateStatus(
    workOrderId: string,
    dto: { status?: string; status_category?: string; waiting_reason?: string | null },
    actorAuthUid: string,
  ): Promise<WorkOrderRow> {
    const tenant = TenantContext.current();

    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertCanPlan(workOrderId, ctx);
    }

    // Validate the DTO has at least one field to change. An empty PATCH
    // is a malformed request, not a no-op — surface it as 400 so the FE
    // sees the bug immediately rather than silently no-oping.
    const provided: Array<'status' | 'status_category' | 'waiting_reason'> = [];
    if (dto.status !== undefined) provided.push('status');
    if (dto.status_category !== undefined) provided.push('status_category');
    if (dto.waiting_reason !== undefined) provided.push('waiting_reason');
    if (provided.length === 0) {
      throw new BadRequestException(
        'updateStatus requires at least one of: status, status_category, waiting_reason',
      );
    }

    const { data: current, error: loadErr } = await this.supabase.admin
      .from('work_orders')
      .select('id, tenant_id, sla_id, status, status_category, waiting_reason, resolved_at, closed_at')
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!current) {
      throw new NotFoundException(`Work order ${workOrderId} not found`);
    }
    const currentRow = current as {
      id: string;
      tenant_id: string;
      sla_id: string | null;
      status: string;
      status_category: string;
      waiting_reason: string | null;
      resolved_at: string | null;
      closed_at: string | null;
    };

    // Compute diff. No-op fast-path: every provided field already matches
    // the current value — refetch + return without writing.
    const diff: Record<string, unknown> = {};
    const previous: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};
    for (const field of provided) {
      const cur = currentRow[field];
      const incoming = dto[field] as string | null | undefined;
      if (cur !== incoming) {
        diff[field] = incoming;
        previous[field] = cur;
        next[field] = incoming;
      }
    }

    if (Object.keys(diff).length === 0) {
      const { data: full, error: refetchErr } = await this.supabase.admin
        .from('work_orders')
        .select('*')
        .eq('id', workOrderId)
        .eq('tenant_id', tenant.id)
        .single();
      if (refetchErr) throw refetchErr;
      return full as WorkOrderRow;
    }

    // Synthesize terminal-state timestamps. Mirror of the case-side
    // ticket.service.ts:880-885 behavior. Set only if the column is
    // currently null — re-resolving an already-resolved row should not
    // overwrite the historical timestamp.
    if (diff.status_category === 'resolved' && !currentRow.resolved_at) {
      diff.resolved_at = new Date().toISOString();
    }
    if (diff.status_category === 'closed' && !currentRow.closed_at) {
      diff.closed_at = new Date().toISOString();
    }

    // Explicit updated_at — work_orders has no auto-trigger for it
    // post-1c.10c (codex round 1 finding from Session 9).
    diff.updated_at = new Date().toISOString();

    const { error: updateErr } = await this.supabase.admin
      .from('work_orders')
      .update(diff)
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id);
    if (updateErr) throw updateErr;

    // SLA pause/resume on waiting-state transitions. Only fires when the
    // status_category or waiting_reason actually changed (covered by the
    // diff check above). Delegates to SlaService.applyWaitingStateTransition,
    // the same helper TicketService.update calls on the case side — single
    // source of truth, no divergence risk if a future transition rule lands.
    if (diff.status_category !== undefined || diff.waiting_reason !== undefined) {
      try {
        const beforeRow = {
          status_category: currentRow.status_category,
          waiting_reason: currentRow.waiting_reason,
          sla_id: currentRow.sla_id,
        };
        const afterRow = {
          status_category: (diff.status_category as string | undefined) ?? currentRow.status_category,
          waiting_reason:
            diff.waiting_reason !== undefined
              ? (diff.waiting_reason as string | null)
              : currentRow.waiting_reason,
          sla_id: currentRow.sla_id,
        };
        await this.slaService.applyWaitingStateTransition(workOrderId, tenant.id, beforeRow, afterRow);
      } catch (err) {
        // KNOWN DEBT (Session 9 codex): swallowing leaves status updated but
        // SLA timer state stale. Class-wide cleanup tracked in the handoff.
        console.error('[work-order] sla pause/resume failed', err);
      }
    }

    // Activity row. Same `status_changed` event shape as the case side
    // (ticket.service.ts:925-932) so the activity feed renderer keeps
    // working uniformly across cases and work_orders.
    try {
      const authorPersonId = await this.resolveAuthorPersonId(actorAuthUid, tenant.id);
      const { error: activityErr } = await this.supabase.admin
        .from('ticket_activities')
        .insert({
          tenant_id: tenant.id,
          ticket_id: workOrderId,
          activity_type: 'system_event',
          author_person_id: authorPersonId,
          visibility: 'system',
          metadata: {
            event: 'status_changed',
            previous,
            next,
          },
        });
      if (activityErr) throw activityErr;
    } catch (err) {
      console.error('[work-order] status_changed activity failed', err);
    }

    // Domain event. Same `ticket_status_changed` name as case side; the
    // entity_id field disambiguates which kind of entity it refers to.
    try {
      await this.logDomainEvent(workOrderId, tenant.id, 'ticket_status_changed', {
        previous,
        next,
      });
    } catch (err) {
      console.error('[work-order] status_changed domain event failed', err);
    }

    const { data: refreshed, error: refetchErr } = await this.supabase.admin
      .from('work_orders')
      .select('*')
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (refetchErr) throw refetchErr;
    if (!refreshed) {
      throw new ForbiddenException('Work order no longer accessible');
    }
    return refreshed as WorkOrderRow;
  }

  /**
   * Update priority on a work_order. Two-axis gate:
   *  - Visibility: `assertCanPlan` (operator floor).
   *  - Permission: `tickets.change_priority` OR `tickets.write_all`.
   *
   * Note: priority change does NOT trigger SLA recompute on the case side
   * (ticket.service.ts:867-952 only fires SLA on status / sla_id transitions).
   * Mirror that here — no SLA churn on priority change.
   */
  async updatePriority(
    workOrderId: string,
    priority: 'low' | 'medium' | 'high' | 'critical',
    actorAuthUid: string,
  ): Promise<WorkOrderRow> {
    const tenant = TenantContext.current();

    if (!VALID_PRIORITIES.includes(priority)) {
      throw new BadRequestException(ERR_PRIORITY_INVALID);
    }

    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertCanPlan(workOrderId, ctx);

      // Per the permission catalog, tickets.change_priority is NOT a
      // danger:true gate (only tickets.write_all is). Plain permission
      // check: change_priority OR write_all.
      if (!ctx.has_write_all) {
        const { data: hasChange, error: permErr } = await this.supabase.admin.rpc(
          'user_has_permission',
          {
            p_user_id: ctx.user_id,
            p_tenant_id: tenant.id,
            p_permission: 'tickets.change_priority',
          },
        );
        if (permErr) throw permErr;
        if (!hasChange) {
          throw new ForbiddenException(
            ERR_PERM_PRIORITY_CHANGE,
          );
        }
      }
    }

    const { data: current, error: loadErr } = await this.supabase.admin
      .from('work_orders')
      .select('id, tenant_id, priority')
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!current) {
      throw new NotFoundException(`Work order ${workOrderId} not found`);
    }
    const currentRow = current as {
      id: string;
      tenant_id: string;
      priority: string;
    };

    if (currentRow.priority === priority) {
      const { data: full, error: refetchErr } = await this.supabase.admin
        .from('work_orders')
        .select('*')
        .eq('id', workOrderId)
        .eq('tenant_id', tenant.id)
        .single();
      if (refetchErr) throw refetchErr;
      return full as WorkOrderRow;
    }

    const { error: updateErr } = await this.supabase.admin
      .from('work_orders')
      .update({ priority, updated_at: new Date().toISOString() })
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id);
    if (updateErr) throw updateErr;

    try {
      const authorPersonId = await this.resolveAuthorPersonId(actorAuthUid, tenant.id);
      const { error: activityErr } = await this.supabase.admin
        .from('ticket_activities')
        .insert({
          tenant_id: tenant.id,
          ticket_id: workOrderId,
          activity_type: 'system_event',
          author_person_id: authorPersonId,
          visibility: 'system',
          metadata: {
            event: 'priority_changed',
            previous: currentRow.priority,
            next: priority,
          },
        });
      if (activityErr) throw activityErr;
    } catch (err) {
      console.error('[work-order] priority_changed activity failed', err);
    }

    const { data: refreshed, error: refetchErr } = await this.supabase.admin
      .from('work_orders')
      .select('*')
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (refetchErr) throw refetchErr;
    if (!refreshed) {
      throw new ForbiddenException('Work order no longer accessible');
    }
    return refreshed as WorkOrderRow;
  }

  /**
   * Update assignment on a work_order — silent PATCH path (no reason audit).
   * Mirrors the case-side update path (ticket.service.ts:934-948) but writes
   * to work_orders.
   *
   * Two-axis gate:
   *  - Visibility: `assertCanPlan` (operator floor).
   *  - Permission: `tickets.assign` OR `tickets.write_all`.
   *
   * Does NOT auto-promote `new → assigned` on first assignment via PATCH —
   * the case side doesn't, and quietly flipping status here would be
   * surprising. Use the resolver / dispatch paths when status implication
   * is desired.
   */
  async updateAssignment(
    workOrderId: string,
    dto: {
      assigned_team_id?: string | null;
      assigned_user_id?: string | null;
      assigned_vendor_id?: string | null;
    },
    actorAuthUid: string,
  ): Promise<WorkOrderRow> {
    const tenant = TenantContext.current();

    await this.assertAssignPermission(actorAuthUid, workOrderId, tenant.id);

    const provided: Array<'assigned_team_id' | 'assigned_user_id' | 'assigned_vendor_id'> = [];
    if (dto.assigned_team_id !== undefined) provided.push('assigned_team_id');
    if (dto.assigned_user_id !== undefined) provided.push('assigned_user_id');
    if (dto.assigned_vendor_id !== undefined) provided.push('assigned_vendor_id');
    if (provided.length === 0) {
      throw new BadRequestException(
        'updateAssignment requires at least one of: assigned_team_id, assigned_user_id, assigned_vendor_id',
      );
    }

    const { data: current, error: loadErr } = await this.supabase.admin
      .from('work_orders')
      .select('id, tenant_id, assigned_team_id, assigned_user_id, assigned_vendor_id')
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!current) {
      throw new NotFoundException(`Work order ${workOrderId} not found`);
    }
    const currentRow = current as {
      id: string;
      tenant_id: string;
      assigned_team_id: string | null;
      assigned_user_id: string | null;
      assigned_vendor_id: string | null;
    };

    const diff: Record<string, unknown> = {};
    const previous: Record<string, string | null> = {};
    const next: Record<string, string | null> = {};
    for (const field of provided) {
      const cur = currentRow[field];
      const incoming = dto[field] as string | null;
      if (cur !== incoming) {
        diff[field] = incoming;
        previous[field] = cur;
        next[field] = incoming;
      }
    }

    if (Object.keys(diff).length === 0) {
      const { data: full, error: refetchErr } = await this.supabase.admin
        .from('work_orders')
        .select('*')
        .eq('id', workOrderId)
        .eq('tenant_id', tenant.id)
        .single();
      if (refetchErr) throw refetchErr;
      return full as WorkOrderRow;
    }

    // Validate any non-null new assignee belongs to this tenant. Cross-tenant
    // id smuggling defense — without this, a malicious caller could attach a
    // foreign team / user / vendor id and the FK / RLS layers would NOT catch
    // it (assigned_vendor_id has no FK; teams + users have FKs but no tenant
    // composite check).
    await validateAssigneesInTenant(this.supabase, diff, tenant.id, {
      skipForSystemActor: actorAuthUid === SYSTEM_ACTOR,
    });

    diff.updated_at = new Date().toISOString();

    const { error: updateErr } = await this.supabase.admin
      .from('work_orders')
      .update(diff)
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id);
    if (updateErr) throw updateErr;

    try {
      const authorPersonId = await this.resolveAuthorPersonId(actorAuthUid, tenant.id);
      const { error: activityErr } = await this.supabase.admin
        .from('ticket_activities')
        .insert({
          tenant_id: tenant.id,
          ticket_id: workOrderId,
          activity_type: 'system_event',
          author_person_id: authorPersonId,
          visibility: 'system',
          metadata: {
            event: 'assignment_changed',
            previous,
            next,
          },
        });
      if (activityErr) throw activityErr;
    } catch (err) {
      console.error('[work-order] assignment_changed activity failed', err);
    }

    try {
      await this.logDomainEvent(workOrderId, tenant.id, 'ticket_assigned', {
        previous,
        next,
      });
    } catch (err) {
      console.error('[work-order] ticket_assigned domain event failed', err);
    }

    const { data: refreshed, error: refetchErr } = await this.supabase.admin
      .from('work_orders')
      .select('*')
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (refetchErr) throw refetchErr;
    if (!refreshed) {
      throw new ForbiddenException('Work order no longer accessible');
    }
    return refreshed as WorkOrderRow;
  }

  /**
   * Update metadata fields on a work_order — `title`, `description`,
   * `cost`, `tags`, `watchers`. Slice 3.1 of the WO command surface.
   *
   * Mirrors the case-side TicketService.update behaviour for these fields:
   *  - Visibility: `assertCanPlan` (operator floor; no danger-permission).
   *  - Validation: type-narrowed by the controller; this method enforces
   *    the no-empty-DTO and no-op fast-path semantics consistent with
   *    sibling methods.
   *  - Side effects: bulk `.update()` of whichever fields differ, plus an
   *    explicit `updated_at`. No timer churn, no status promotion, no
   *    activity emission.
   *
   * The case side does not emit per-field activity rows for these fields
   * (verified at ticket.service.ts:990+ — only status/assignment/sla
   * write activities). To keep parity, neither does this method. If/when
   * the audit trail is improved, both sides should grow the rows in the
   * same slice.
   */
  async updateMetadata(
    workOrderId: string,
    dto: {
      title?: string;
      description?: string | null;
      cost?: number | null;
      tags?: string[] | null;
      watchers?: string[] | null;
    },
    actorAuthUid: string,
  ): Promise<WorkOrderRow> {
    const tenant = TenantContext.current();

    // Validation lives at the service layer too — the controller catches
    // the same conditions, but internal callers (workflow engine, cron,
    // SYSTEM_ACTOR paths) bypass the controller. Service layer is the
    // trust boundary.
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException(
        'updateMetadata requires at least one of: title, description, cost, tags, watchers',
      );
    }
    if (dto.title !== undefined && dto.title.trim() === '') {
      throw new BadRequestException(ERR_TITLE_EMPTY);
    }
    if (
      dto.cost !== undefined &&
      dto.cost !== null &&
      !Number.isFinite(dto.cost)
    ) {
      throw new BadRequestException(ERR_COST_NOT_FINITE);
    }
    if (dto.tags !== undefined && dto.tags !== null) {
      if (!Array.isArray(dto.tags) || !dto.tags.every((t) => typeof t === 'string')) {
        throw new BadRequestException(ERR_TAGS_INVALID);
      }
    }
    if (dto.watchers !== undefined && dto.watchers !== null) {
      if (
        !Array.isArray(dto.watchers) ||
        !dto.watchers.every((w) => typeof w === 'string')
      ) {
        throw new BadRequestException(
          ERR_WATCHERS_SHAPE_INVALID,
        );
      }
    }

    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertCanPlan(workOrderId, ctx);
    }

    // Tenant-validate watcher uuids before the write. Closes the GHOST-uuid
    // vector — does NOT close the within-tenant unauthorized-share vector
    // (which is a product decision about subscriber semantics, not a
    // validation problem). Helper handles the SYSTEM_ACTOR bypass internally
    // to keep the gate convention consistent with the visibility checks
    // above.
    await validateWatcherIdsInTenant(
      this.supabase,
      Object.prototype.hasOwnProperty.call(dto, 'watchers') ? dto.watchers : undefined,
      tenant.id,
      { skipForSystemActor: actorAuthUid === SYSTEM_ACTOR },
    );

    const { data: current, error: loadErr } = await this.supabase.admin
      .from('work_orders')
      .select('id, tenant_id, title, description, cost, tags, watchers')
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!current) {
      throw new NotFoundException(`Work order ${workOrderId} not found`);
    }
    const currentRow = current as {
      id: string;
      tenant_id: string;
      title: string | null;
      description: string | null;
      cost: number | null;
      tags: string[] | null;
      watchers: string[] | null;
    };

    // Cost is `numeric(12,2)` in Postgres — exact 2-dp decimal. JS sends
    // IEEE-754 floats, so a UI-derived 0.1+0.2=0.30000000000000004 PATCH
    // would round to 0.30 on write but compare against 0.3 on the next
    // refetch — the no-op fast-path below would never fire and every
    // PATCH with a fractional cost would re-write the row. Round to 2 dp
    // up front so the diff and the persisted value agree.
    const costNormalized =
      dto.cost === null || dto.cost === undefined
        ? dto.cost
        : Math.round(dto.cost * 100) / 100;

    // Build the diff: only fields whose new value differs from current.
    // Array equality uses JSON.stringify — these arrays are always small
    // (tags ≤ ~20, watchers ≤ ~20) and typed as string[], so JSON
    // comparison is correct and cheap. If tags ever becomes object[], swap
    // for a structural deep-equal helper.
    const diff: Record<string, unknown> = {};
    if (dto.title !== undefined && dto.title !== currentRow.title) {
      diff.title = dto.title;
    }
    if (
      Object.prototype.hasOwnProperty.call(dto, 'description') &&
      (dto.description ?? null) !== currentRow.description
    ) {
      diff.description = dto.description ?? null;
    }
    if (
      Object.prototype.hasOwnProperty.call(dto, 'cost') &&
      (costNormalized ?? null) !== currentRow.cost
    ) {
      diff.cost = costNormalized ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(dto, 'tags')) {
      const next = dto.tags ?? null;
      const prev = currentRow.tags ?? null;
      if (JSON.stringify(next) !== JSON.stringify(prev)) {
        diff.tags = next;
      }
    }
    if (Object.prototype.hasOwnProperty.call(dto, 'watchers')) {
      const next = dto.watchers ?? null;
      const prev = currentRow.watchers ?? null;
      if (JSON.stringify(next) !== JSON.stringify(prev)) {
        diff.watchers = next;
      }
    }

    // No-op fast path: every supplied field already equals the current value.
    // Return the full row without writing — matches updateStatus / updatePriority
    // / updateAssignment behaviour and avoids spurious updated_at bumps that
    // would invalidate downstream caches and Realtime subscribers.
    if (Object.keys(diff).length === 0) {
      const { data: full, error: refetchErr } = await this.supabase.admin
        .from('work_orders')
        .select('*')
        .eq('id', workOrderId)
        .eq('tenant_id', tenant.id)
        .single();
      if (refetchErr) throw refetchErr;
      return full as WorkOrderRow;
    }

    diff.updated_at = new Date().toISOString();

    const { error: updateErr } = await this.supabase.admin
      .from('work_orders')
      .update(diff)
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id);
    if (updateErr) throw updateErr;

    // Audit row — `metadata_changed` event with per-field diff. One row
    // per call (not per field) so the audit feed stays scannable when
    // multiple fields change in a bulk PATCH. Wrapped in try/catch so
    // an activity write failure doesn't roll back the user-visible
    // change. Mirrors `assignment_changed` / `priority_changed` shape
    // from sibling methods.
    try {
      const authorPersonId = await this.resolveAuthorPersonId(actorAuthUid, tenant.id);
      const changes: Record<string, { previous: unknown; next: unknown }> = {};
      if ('title' in diff) changes.title = { previous: currentRow.title, next: diff.title };
      if ('description' in diff) changes.description = { previous: currentRow.description, next: diff.description };
      if ('cost' in diff) changes.cost = { previous: currentRow.cost, next: diff.cost };
      if ('tags' in diff) changes.tags = { previous: currentRow.tags, next: diff.tags };
      if ('watchers' in diff) changes.watchers = { previous: currentRow.watchers, next: diff.watchers };
      const { error: activityErr } = await this.supabase.admin
        .from('ticket_activities')
        .insert({
          tenant_id: tenant.id,
          ticket_id: workOrderId,
          activity_type: 'system_event',
          author_person_id: authorPersonId,
          visibility: 'system',
          metadata: { event: 'metadata_changed', changes },
        });
      if (activityErr) throw activityErr;
    } catch (err) {
      console.error('[work-order] metadata_changed activity failed', err);
    }

    const { data: refreshed, error: refetchErr } = await this.supabase.admin
      .from('work_orders')
      .select('*')
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (refetchErr) throw refetchErr;
    if (!refreshed) {
      throw new ForbiddenException('Work order no longer accessible');
    }
    return refreshed as WorkOrderRow;
  }

  /**
   * Reassign a work_order with a reason. Distinct from `updateAssignment` —
   * this writes a `routing_decisions` row tagged `chosen_by: 'manual_reassign'`
   * and a corresponding internal-visibility activity row carrying the human
   * reason in `content`. Mirrors ticket.service.ts:959-1074.
   *
   * Two-axis gate (same as updateAssignment):
   *  - Visibility: `assertCanPlan` (operator floor).
   *  - Permission: `tickets.assign` OR `tickets.write_all`.
   *
   * The current implementation is "manual" mode only (caller supplies the
   * target). The case-side has a `rerun_resolver` mode that re-invokes the
   * routing engine — wired here as a passthrough that throws BadRequest
   * because resolver-rerun on a work_order is a separate decision (which
   * routing context to use, child_dispatch vs case_owner). When the
   * planning board needs it, surface as a follow-up slice.
   *
   * Not a member of the orchestrator's preflight surface — `reassign` is
   * a single-DTO, single-write path with its own gate
   * (`assertAssignPermission`) and a routing_decisions audit insert that
   * MUST run alongside the work_orders write. Routing it through the
   * orchestrator would lose the routing_decisions semantics. If a future
   * refactor merges reassign into update(), the routing-decision write
   * needs to move into the orchestrator's post-write hook AND become
   * part of any transactional wrapper — flag for the same slice.
   */
  async reassign(
    workOrderId: string,
    dto: {
      assigned_team_id?: string | null;
      assigned_user_id?: string | null;
      assigned_vendor_id?: string | null;
      reason: string;
      actor_person_id?: string | null;
      rerun_resolver?: boolean;
    },
    actorAuthUid: string,
  ): Promise<WorkOrderRow> {
    const tenant = TenantContext.current();

    if (!dto.reason || !dto.reason.trim()) {
      throw new BadRequestException('reassignment reason is required');
    }

    if (dto.rerun_resolver) {
      // Defer until the planning board needs it — mirrors the brief
      // ("Mirror case-side reassign() implementation" but the case-side
      // resolver-rerun path uses request_type/asset/location lookups that
      // need to be re-evaluated against work_order context, not case
      // context). 501 (not 400) — the request is well-formed; the resource
      // just doesn't implement that mode yet. Surface explicitly so callers
      // know it's missing rather than silently degrade to manual mode.
      throw new NotImplementedException(
        'rerun_resolver is not yet supported for work_order reassign — pass an explicit assignee instead',
      );
    }

    await this.assertAssignPermission(actorAuthUid, workOrderId, tenant.id);

    const { data: current, error: loadErr } = await this.supabase.admin
      .from('work_orders')
      .select('id, tenant_id, assigned_team_id, assigned_user_id, assigned_vendor_id')
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!current) {
      throw new NotFoundException(`Work order ${workOrderId} not found`);
    }
    const currentRow = current as {
      id: string;
      tenant_id: string;
      assigned_team_id: string | null;
      assigned_user_id: string | null;
      assigned_vendor_id: string | null;
    };

    const prev = {
      team: currentRow.assigned_team_id,
      user: currentRow.assigned_user_id,
      vendor: currentRow.assigned_vendor_id,
    };

    let nextTarget: { kind: 'team' | 'user' | 'vendor'; id: string } | null = null;
    if (dto.assigned_team_id) nextTarget = { kind: 'team', id: dto.assigned_team_id };
    else if (dto.assigned_user_id) nextTarget = { kind: 'user', id: dto.assigned_user_id };
    else if (dto.assigned_vendor_id) nextTarget = { kind: 'vendor', id: dto.assigned_vendor_id };

    // Validate the new assignee belongs to this tenant before we reassign.
    if (nextTarget) {
      await validateAssigneesInTenant(
        this.supabase,
        nextTarget.kind === 'team'
          ? { assigned_team_id: nextTarget.id }
          : nextTarget.kind === 'user'
            ? { assigned_user_id: nextTarget.id }
            : { assigned_vendor_id: nextTarget.id },
        tenant.id,
        { skipForSystemActor: actorAuthUid === SYSTEM_ACTOR },
      );
    }

    const updates: Record<string, unknown> = {
      assigned_team_id: null,
      assigned_user_id: null,
      assigned_vendor_id: null,
      updated_at: new Date().toISOString(),
    };
    if (nextTarget?.kind === 'team') updates.assigned_team_id = nextTarget.id;
    if (nextTarget?.kind === 'user') updates.assigned_user_id = nextTarget.id;
    if (nextTarget?.kind === 'vendor') updates.assigned_vendor_id = nextTarget.id;

    const { error: updateErr } = await this.supabase.admin
      .from('work_orders')
      .update(updates)
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id);
    if (updateErr) throw updateErr;

    // Routing decision audit row. Convention (code-review C5): set the
    // polymorphic columns (entity_kind + work_order_id) explicitly on both
    // case + WO sides — the 00232 derive trigger remains as a defensive
    // fallback, but writing them here makes the audit row deterministic at
    // write time and removes the "depends on the trigger" coupling. Mirror
    // of ticket.service.ts:1133 (case-side reassign).
    const trace = [
      {
        step: 'manual_reassign',
        matched: true,
        reason: dto.reason,
        by: dto.actor_person_id ?? null,
      },
    ];
    try {
      const { error: rdErr } = await this.supabase.admin
        .from('routing_decisions')
        .insert({
          tenant_id: tenant.id,
          ticket_id: workOrderId, // legacy soft pointer; FK to tickets dropped in 00233
          entity_kind: 'work_order',
          work_order_id: workOrderId,
          strategy: 'manual',
          chosen_team_id: nextTarget?.kind === 'team' ? nextTarget.id : null,
          chosen_user_id: nextTarget?.kind === 'user' ? nextTarget.id : null,
          chosen_vendor_id: nextTarget?.kind === 'vendor' ? nextTarget.id : null,
          chosen_by: 'manual_reassign',
          trace,
          context: {
            reason: dto.reason,
            previous: prev,
            actor: dto.actor_person_id ?? null,
          },
        });
      if (rdErr) throw rdErr;
    } catch (err) {
      console.error('[work-order] reassign routing_decisions write failed', err);
    }

    // Activity row. Internal visibility (NOT 'system') because the reason
    // is human-authored and surfaces in the timeline as a note. Matches
    // ticket.service.ts:1060-1071.
    try {
      const authorPersonId =
        dto.actor_person_id ?? (await this.resolveAuthorPersonId(actorAuthUid, tenant.id));
      const { error: activityErr } = await this.supabase.admin
        .from('ticket_activities')
        .insert({
          tenant_id: tenant.id,
          ticket_id: workOrderId,
          activity_type: 'system_event',
          author_person_id: authorPersonId,
          visibility: 'internal',
          content: dto.reason,
          metadata: {
            event: 'reassigned',
            previous: prev,
            next: nextTarget,
            mode: 'manual_reassign',
            reason: dto.reason,
          },
        });
      if (activityErr) throw activityErr;
    } catch (err) {
      console.error('[work-order] reassigned activity failed', err);
    }

    const { data: refreshed, error: refetchErr } = await this.supabase.admin
      .from('work_orders')
      .select('*')
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (refetchErr) throw refetchErr;
    if (!refreshed) {
      throw new ForbiddenException('Work order no longer accessible');
    }
    return refreshed as WorkOrderRow;
  }

  /**
   * Shared two-axis gate for assignment + reassign — visibility floor
   * (`assertCanPlan`) plus the `tickets.assign` OR `tickets.write_all`
   * permission check. Per the catalog, `tickets.assign` is NOT a danger:true
   * gate, so this is a plain permission check (no danger ceremony).
   */
  private async assertAssignPermission(
    actorAuthUid: string,
    workOrderId: string,
    tenantId: string,
  ): Promise<void> {
    if (actorAuthUid === SYSTEM_ACTOR) return;
    const ctx = await this.visibility.loadContext(actorAuthUid, tenantId);
    await this.visibility.assertCanPlan(workOrderId, ctx);

    if (ctx.has_write_all) return;

    const { data: hasAssign, error: permErr } = await this.supabase.admin.rpc(
      'user_has_permission',
      {
        p_user_id: ctx.user_id,
        p_tenant_id: tenantId,
        p_permission: 'tickets.assign',
      },
    );
    if (permErr) throw permErr;
    if (!hasAssign) {
      throw new ForbiddenException(
        ERR_PERM_ASSIGN,
      );
    }
  }

  /**
   * Domain event emitter. Mirrors `TicketService.logDomainEvent` (private
   * there). Local copy so this service doesn't depend on TicketService for
   * what is effectively a one-line insert.
   */
  private async logDomainEvent(
    entityId: string,
    tenantId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.supabase.admin.from('domain_events').insert({
      tenant_id: tenantId,
      event_type: eventType,
      entity_type: 'ticket', // case-side uses 'ticket' uniformly; entity_id disambiguates
      entity_id: entityId,
      payload,
    });
  }

  /**
   * Resolve actor → persons.id for activity attribution. Falls back to null
   * (system attribution) if the actor isn't a known user in this tenant.
   */
  private async resolveAuthorPersonId(
    actorAuthUid: string,
    tenantId: string,
  ): Promise<string | null> {
    if (actorAuthUid === SYSTEM_ACTOR) return null;
    const { data } = await this.supabase.admin
      .from('users')
      .select('person_id')
      .eq('auth_uid', actorAuthUid)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    return ((data as { person_id: string | null } | null)?.person_id) ?? null;
  }
}
