import {
  Inject,
  Injectable,
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
import { AppErrors, mapRpcErrorToAppError } from '../../common/errors';
import { hasOwnDefined } from '../../common/has-own-defined';

export const SYSTEM_ACTOR = '__system__';

/**
 * Row shape returned by the public command surface (`update`, `reassign`,
 * `canPlan`). The work_orders table mirrors most of `tickets`
 * (Step 1c.1/1c.10c) but post-cutover it is its own base table — callers
 * should not assume the field set is identical to `TicketDetail`.
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
 * field is optional; the orchestrator builds a `p_patches` payload (one
 * branch per field group: sla / plan / status / priority / assignment /
 * metadata) and submits a single `update_entity_combined` RPC. At least
 * one field must be present — an empty DTO is rejected as `BadRequest`.
 *
 * See `docs/assignments-routing-fulfillment.md` §7 for the per-field gates
 * that fire inside the orchestrator preflight (`preflightValidateUpdate`).
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

// Module-level shared constants — used by the orchestrator's preflight
// (and historically by the legacy per-field methods deleted in
// C-remediation, where divergence between the two surfaces caused real
// bugs). Single source of truth so a future tweak to any bound or enum
// can't drift between validation sites. Full-review on commit 4b2f6e0
// originally caught a divergent duration cap (preflight 30d vs the
// since-removed `setPlan` 1y); the constant stays here as the structural
// fix.
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
 * watchers, etc.) belongs here, NOT on TicketService.
 *
 * Post-B.2.A §3.0 (Commit C, 2026-05-11): the canonical mutation surface
 * is `update()` — a single orchestrator that builds a `p_patches` payload
 * and commits every branch atomically via the `update_entity_combined`
 * RPC (00335 v5). The legacy per-field service methods
 * (`updateSla` / `setPlan` / `updateStatus` / `updatePriority` /
 * `updateAssignment` / `updateMetadata`) were deleted in C-remediation:
 * they had zero production callers post-cutover and conflicted with the
 * CLAUDE.md rule that multi-table writes go through PL/pgSQL RPCs, not
 * TS pipelines. Future single-field convenience entrypoints are welcome
 * but MUST funnel through `update()` so they inherit the orchestrator's
 * atomicity / audit / idempotency guarantees.
 *
 * `reassign()` stays as its own write path (routing_decisions audit
 * insert + manual-mode assignment) until Step 9 (workflow-engine
 * cutover) folds it into `set_entity_assignment` (§3.2).
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
   * `/plan`, `/status`, `/priority`, `/assignment`) accreted as Slice 2
   * grew — each new field adds another route, hook, gate. The right shape
   * is one endpoint that accepts a union DTO and a single RPC that
   * commits every branch atomically. This method is that orchestrator.
   *
   * Behavior:
   * - Accepts any subset of `UpdateWorkOrderDto`. At least one field must
   *   be present — empty DTO rejects as `BadRequest`.
   * - Runs `preflightValidateUpdate` to gate visibility, per-field
   *   permission RPCs (`sla.override`, `tickets.change_priority`,
   *   `tickets.assign`), tenant validation for assignees + watchers,
   *   SLA-policy existence, and stateless format / enum / range checks.
   *   If preflight throws, NO write happens (validation-atomic).
   * - Builds the `p_patches` payload (sla / plan / status / priority /
   *   assignment / metadata branches as needed) via
   *   `buildPatchesPayloadForWorkOrder`. SLA branch includes
   *   TS-computed timer due_at values from `SlaService.buildTimersForRpc`
   *   (the RPC requires pre-computed timers — 00330:202-205).
   * - Commits via a single `update_entity_combined` RPC call (00335 v5).
   *   The RPC writes every branch in one transaction, emits all activity
   *   rows + domain events, and is idempotent via the
   *   `patch:work_order:<id>:<clientRequestId>` outer key (spec 1892).
   * - Refetches the row after the RPC returns so the response reflects
   *   every RPC-side side effect (resolved_at / closed_at synthesised
   *   by status branch, sla_response_due_at / sla_resolution_due_at
   *   from sla branch).
   * - SYSTEM_ACTOR collapses `p_actor_user_id` to null (00325:89-94) and
   *   skips visibility + per-field permission checks in preflight. The
   *   stateless tier-1 checks (format / enum / range / shape) still
   *   apply — workflow + cron writes shouldn't be able to land malformed
   *   data either.
   * - `clientRequestId` is required (F-CRIT-1) — internal callers that
   *   bypass the controller's `RequireClientRequestIdGuard` would
   *   otherwise mint a fresh randomUUID per call and lose idempotency.
   */
  async update(
    workOrderId: string,
    dto: UpdateWorkOrderDto,
    actorAuthUid: string,
    // B.2.A Commit B (§3.0 controller cutover) — threaded from
    // RequireClientRequestIdGuard via the controller for
    // `PATCH /work-orders/:id`. Mints the orchestrator idempotency key as
    //   `patch:work_order:${id}:${clientRequestId}`
    // per spec line 1892. Un-underscored from `_clientRequestId` (Step 2
    // placeholder) now that the value is actually consumed.
    clientRequestId?: string,
  ): Promise<WorkOrderRow> {
    if (!dto || typeof dto !== 'object') {
      throw AppErrors.validationFailed('work_order.body_required', { detail: 'body required' });
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
      throw AppErrors.validationFailed('work_order.empty_update', {
        detail:
          'update requires at least one of: sla_id, planned_start_at, planned_duration_minutes, status, status_category, waiting_reason, priority, assigned_team_id, assigned_user_id, assigned_vendor_id, title, description, cost, tags, watchers',
      });
    }

    // Pre-flight validation. Runs every check that could reject the
    // write (visibility, tenant-validation, permission RPCs, format / enum
    // / range) BEFORE the RPC is invoked. If it throws, the
    // `update_entity_combined` call below never happens and no partial
    // state lands. Post-§3.0 cutover (Commit B, 2026-05-11) the RPC owns
    // the multi-table write atomically, so the partial-commit hazards
    // documented in the pre-cutover version of this comment no longer
    // apply — they were the failure mode the orchestrator RPC was built
    // to close.
    await this.preflightValidateUpdate(workOrderId, dto, actorAuthUid, {
      hasSla, hasPlan, hasStatus, hasPriority, hasAssignment, hasMetadata,
    });

    // ──────────────────────────────────────────────────────────────────
    // Plan-branch preflight (kept from the per-field dispatcher era —
    // the §3.0 RPC does NOT enforce "duration requires start" and would
    // silently persist a duration alongside a null start).
    //
    // The RPC's plan branch (00333:397-503) is partial-update friendly:
    // present keys override, absent keys preserve. So we don't pre-merge
    // here; we just sanity-check that the eventual row state isn't a
    // duration-without-start. To do that we need the current row when
    // only one of the two keys is in the patch.
    // ──────────────────────────────────────────────────────────────────
    const tenant = TenantContext.current();

    // F-IMP-3 (plan-review 2026-05-11): build a normalized clone up-front
    // so subsequent normalisation steps (plan-clear gesture + cost rounding)
    // operate on `dtoNormalized` rather than mutating the caller's input
    // dto. Previously the plan-clear branch mutated `dto.planned_duration_minutes
    // = null` directly, which silently rewrote the caller's object.
    const dtoNormalized: UpdateWorkOrderDto = { ...dto };

    if (hasPlan) {
      let currentStart: string | null = null;
      let currentDuration: number | null = null;
      // Read current row only when we need it: i.e., one of the two plan
      // keys is missing from the dto. If both are present, dto values
      // decide the post-write state without consulting current.
      const needCurrent =
        !present('planned_start_at') || !present('planned_duration_minutes');
      if (needCurrent) {
        const { data: cur, error: curErr } = await this.supabase.admin
          .from('work_orders')
          .select('planned_start_at, planned_duration_minutes')
          .eq('id', workOrderId)
          .eq('tenant_id', tenant.id)
          .maybeSingle();
        if (curErr) throw curErr;
        if (!cur) {
          throw AppErrors.notFound('work_order', workOrderId);
        }
        const curRow = cur as {
          planned_start_at: string | null;
          planned_duration_minutes: number | null;
        };
        currentStart = curRow.planned_start_at ?? null;
        currentDuration = curRow.planned_duration_minutes ?? null;
      }

      const finalStart = present('planned_start_at')
        ? (dto.planned_start_at ?? null)
        : currentStart;
      // Honour the established "clear plan" gesture: explicit start=null
      // with no duration in the dto collapses duration to null too.
      let finalDuration: number | null;
      if (present('planned_duration_minutes')) {
        finalDuration = dto.planned_duration_minutes ?? null;
      } else if (present('planned_start_at') && finalStart === null) {
        finalDuration = null;
        // F-IMP-3 fix: write the explicit-null clear onto the clone,
        // not the caller's input. The RPC's UPDATE uses
        // `case when v_plan_has_duration_key then ... else
        // planned_duration_minutes end` (00333:462); without marking
        // the key present on the patch we send, an explicit start=null
        // patch with no duration key would leave the prior duration
        // on the row.
        dtoNormalized.planned_duration_minutes = null;
      } else {
        finalDuration = currentDuration;
      }

      if (finalDuration !== null && finalStart === null) {
        throw AppErrors.validationFailed('work_order.plan_invalid', {
          detail: 'planned_duration_minutes requires planned_start_at',
        });
      }
    }

    // Cost normalization — numeric(12,2) round-trip parity. The RPC also
    // rounds (00333:542) but normalising at the TS boundary stabilises
    // the orchestrator's payload_hash across replays. Mirrors the case-
    // side normalisation at ticket.service.ts:1082-1088.
    if (
      Object.prototype.hasOwnProperty.call(dto, 'cost') &&
      typeof dto.cost === 'number' &&
      Number.isFinite(dto.cost)
    ) {
      dtoNormalized.cost = Math.round(dto.cost * 100) / 100;
    }

    // ──────────────────────────────────────────────────────────────────
    // B.2.A Commit B (§3.0 controller cutover) — the per-field dispatch
    // chain (updateSla → setPlan → updateStatus → updatePriority →
    // updateAssignment → updateMetadata) was replaced by one
    // `update_entity_combined` RPC call. The RPC commits every branch in
    // one transaction, emits the same activity rows + domain events the
    // legacy per-field methods emitted, and removes the
    // validation-atomic-only / activity-row-swallow caveats called out
    // above.
    //
    // Commit C remediation (2026-05-11): the legacy per-field service
    // methods had zero production callers post-cutover and were deleted.
    // Internal callers (cron, workflow engine, SYSTEM_ACTOR paths) must
    // come through `update()` so they inherit the orchestrator's atomic
    // commit + audit + idempotency guarantees. The workflow-engine
    // cutover happens in B.2.A Step 9 (§3.2 `set_entity_assignment`).
    //
    // SLA branch needs TS-computed timers (the RPC raises
    // update_entity_sla.timers_required if sla_id is non-null and
    // timers[] is missing — 00330:202-205). buildTimersForRpc owns the
    // business-hours calendar lookup + `addBusinessMinutes` arithmetic.
    //
    // Citations: 00333 (orchestrator) + 00325/00327/00330 (sub-RPCs)
    //          + spec line 1892 (idempotency key shape).
    // ──────────────────────────────────────────────────────────────────
    const patches = await this.buildPatchesPayloadForWorkOrder(
      dtoNormalized,
      tenant.id,
      { hasSla, hasPlan, hasStatus, hasPriority, hasAssignment, hasMetadata },
    );

    // F-CRIT-1 (plan-review 2026-05-11): explicit defense-in-depth.
    // The controller's RequireClientRequestIdGuard (I1) normally
    // ensures clientRequestId is present at the HTTP boundary, but
    // internal callers that bypass the controller (e.g. the future
    // workflow-engine cutover in Step 9) would silently get a fresh
    // randomUUID per call — a real idempotency footgun where "retry"
    // mints a new key. Reject explicitly here so any non-HTTP caller
    // surfaces the missing-id error instead of corrupting replay
    // semantics.
    if (!clientRequestId) {
      throw AppErrors.badRequest(
        'command_operations.client_request_id_required',
        'PATCH /work-orders/:id requires X-Client-Request-Id header per I1 (RequireClientRequestIdGuard).',
      );
    }

    const { error: rpcErr } = await this.supabase.admin.rpc(
      'update_entity_combined',
      {
        p_entity_kind: 'work_order',
        p_entity_id: workOrderId,
        p_tenant_id: tenant.id,
        // 00325:89-94 — p_actor_user_id is the auth UID, not users.id.
        p_actor_user_id: actorAuthUid === SYSTEM_ACTOR ? null : actorAuthUid,
        p_idempotency_key: this.combinedIdempotencyKey(workOrderId, clientRequestId),
        p_patches: patches,
      },
    );
    if (rpcErr) throw mapRpcErrorToAppError(rpcErr);

    // Refetch the row so the response shape matches what the per-field
    // methods used to return (with every RPC-side side effect — resolved_at,
    // closed_at, sla_response_due_at, sla_resolution_due_at — applied).
    const { data: refreshed, error: refetchErr } = await this.supabase.admin
      .from('work_orders')
      .select('*')
      .eq('id', workOrderId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (refetchErr) throw refetchErr;
    if (!refreshed) {
      // F-IMP-1 (plan-review 2026-05-11): not `forbidden`. The RPC
      // committed under service_role + tenant_id matches — a null
      // refetch means the row was deleted concurrently or the
      // PostgREST cache is stale. `notFound` is the correct shape.
      // Previously this threw `forbidden('work_order.no_longer_accessible')`
      // which misleadingly suggested a permission failure.
      throw AppErrors.notFound('work_order', workOrderId);
    }
    return refreshed as WorkOrderRow;
  }

  /**
   * Build the `p_patches` jsonb payload for `update_entity_combined`
   * (00333) from an UpdateWorkOrderDto. Uses key-presence (hasOwnProperty
   * + `!== undefined`) — absent key ⇒ no branch; present key with `null`
   * ⇒ explicit clear (where the column allows).
   *
   * Citations mirror the case-side helper. The SLA branch additionally
   * computes the `timers[]` payload (00330:279-284) via
   * SlaService.buildTimersForRpc — the RPC needs pre-computed timer
   * due_at values because the business-hours calendar resolution lives
   * in TS (apps/api/src/modules/sla/business-hours.service.ts).
   */
  private async buildPatchesPayloadForWorkOrder(
    dto: UpdateWorkOrderDto,
    tenantId: string,
    flags: {
      hasSla: boolean;
      hasPlan: boolean;
      hasStatus: boolean;
      hasPriority: boolean;
      hasAssignment: boolean;
      hasMetadata: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const patches: Record<string, unknown> = {};
    // F-IMP-2 (plan-review 2026-05-11): canonical presence helper used
    // by both case-side + WO-side payload builders so semantics agree
    // by construction.
    const has = (k: keyof UpdateWorkOrderDto) => hasOwnDefined(dto, k);

    // Status branch (00333:182, 277-303).
    if (flags.hasStatus) {
      if (has('status')) patches.status = dto.status;
      if (has('status_category')) patches.status_category = dto.status_category;
      if (has('waiting_reason')) patches.waiting_reason = dto.waiting_reason ?? null;
    }

    // Priority — top-level (00333:185, 305-359).
    if (flags.hasPriority) {
      patches.priority = dto.priority;
    }

    // Assignment grouped (00333:183, 361-377).
    if (flags.hasAssignment) {
      const assignment: Record<string, unknown> = {};
      for (const f of ASSIGNMENT_FIELDS) {
        if (has(f)) {
          assignment[f] = (dto as Record<string, unknown>)[f] ?? null;
        }
      }
      patches.assignment = assignment;
    }

    // Plan grouped (00333:186, 397-503).
    if (flags.hasPlan) {
      const plan: Record<string, unknown> = {};
      if (has('planned_start_at')) plan.planned_start_at = dto.planned_start_at;
      if (has('planned_duration_minutes'))
        plan.planned_duration_minutes = dto.planned_duration_minutes;
      patches.plan = plan;
    }

    // SLA grouped (00333:184, 379-395). The RPC's payload schema is
    // `{ sla_id, timers? }` per 00330:98-108 + 00330:140-145.
    // - null sla_id ⇒ clear (RPC's stop-only path; timers[] omitted).
    // - non-null sla_id ⇒ install (RPC requires timers[], else raises
    //   update_entity_sla.timers_required).
    if (flags.hasSla) {
      const slaPayload: Record<string, unknown> = {
        sla_id: dto.sla_id ?? null,
      };
      if (dto.sla_id) {
        slaPayload.timers = await this.slaService.buildTimersForRpc(
          dto.sla_id,
          tenantId,
        );
      }
      patches.sla = slaPayload;
    }

    // Metadata grouped (00333:187, 505-732).
    if (flags.hasMetadata) {
      const metadata: Record<string, unknown> = {};
      if (has('title')) metadata.title = dto.title;
      if (has('description')) metadata.description = dto.description ?? null;
      if (has('cost')) metadata.cost = dto.cost ?? null;
      if (has('tags')) metadata.tags = dto.tags ?? null;
      if (has('watchers')) metadata.watchers = dto.watchers ?? null;
      patches.metadata = metadata;
    }

    return patches;
  }

  /**
   * Mint the outer idempotency key for `update_entity_combined` per spec
   * line 1892.
   *
   * F-CRIT-1 (plan-review 2026-05-11): the caller (update()) guards
   * against a missing clientRequestId by throwing
   * `command_operations.client_request_id_required` BEFORE this helper
   * is reached. The legacy randomUUID() fallback has been removed — a
   * fresh UUID per call was a real footgun (every retry mints a new
   * key → idempotency is meaningless).
   */
  private combinedIdempotencyKey(
    workOrderId: string,
    clientRequestId: string,
  ): string {
    return `patch:work_order:${workOrderId}:${clientRequestId}`;
  }

  /**
   * Pre-flight validation for the §3.0 `update_entity_combined` RPC.
   * Runs every check that could reject the eventual write — but performs
   * no writes itself. If any check fails, `update()` throws BEFORE the
   * RPC call lands, so no partial state can result from a multi-field
   * PATCH with one bad field.
   *
   * What it checks:
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
   * SYSTEM_ACTOR bypass — workflow engine + cron writes pass through
   * without paying for the preflight DB round-trips. The RPC itself
   * still enforces the same invariants server-side as defense-in-depth.
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
          throw AppErrors.validationFailed('work_order.planned_start_invalid', { detail: ERR_PLANNED_START_INVALID });
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
          throw AppErrors.validationFailed('work_order.duration_invalid', { detail: ERR_DURATION_INVALID() });
        }
      }
    }
    if (flags.hasPriority) {
      if (!VALID_PRIORITIES.includes(dto.priority as Priority)) {
        throw AppErrors.validationFailed('work_order.priority_invalid', { detail: ERR_PRIORITY_INVALID });
      }
    }
    if (flags.hasMetadata) {
      if (dto.title !== undefined && dto.title.trim() === '') {
        throw AppErrors.validationFailed('work_order.title_empty', { detail: ERR_TITLE_EMPTY });
      }
      if (
        Object.prototype.hasOwnProperty.call(dto, 'cost') &&
        dto.cost !== null &&
        dto.cost !== undefined &&
        !Number.isFinite(dto.cost)
      ) {
        throw AppErrors.validationFailed('work_order.cost_invalid', { detail: ERR_COST_NOT_FINITE });
      }
      if (
        Object.prototype.hasOwnProperty.call(dto, 'tags') &&
        dto.tags !== null &&
        dto.tags !== undefined &&
        (!Array.isArray(dto.tags) || !dto.tags.every((t) => typeof t === 'string'))
      ) {
        throw AppErrors.validationFailed('work_order.tags_invalid', { detail: ERR_TAGS_INVALID });
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
        throw AppErrors.validationFailed('work_order.watchers_invalid', { detail: ERR_WATCHERS_SHAPE_INVALID });
      }
    }

    // Stateless assignee uuid format check.
    if (flags.hasAssignment) {
      const UUID_RE =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      for (const f of ASSIGNMENT_FIELDS) {
        const v = (dto as Record<string, unknown>)[f];
        if (typeof v === 'string' && !UUID_RE.test(v)) {
          throw AppErrors.validationFailed('work_order.assignee_uuid_invalid', { detail: `${f} is not a valid uuid: ${v}` });
        }
      }
    }

    // SLA policy existence in tenant (full-review #3 critical fix).
    // Pre-fix this lived in tier-2 and was skipped for SYSTEM_ACTOR.
    // Pre-cutover the legacy per-field `updateSla` validated this for
    // SYSTEM_ACTOR too, so a SYSTEM_ACTOR multi-field PATCH with a bad
    // sla_id + good other fields could commit the others and then reject
    // — partial commit. Even though the combined RPC is now atomic and
    // would NOT partial-commit, we keep the tier-1 check so the failure
    // surfaces as a registered `work_order.sla_unknown` (400) instead of
    // the RPC's programmer-error code `update_entity_sla.invalid_sla_id`.
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
        throw AppErrors.validationFailed('work_order.sla_unknown', {
          detail: `sla_id ${dto.sla_id} does not reference a known SLA policy in this tenant`,
        });
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
        throw AppErrors.forbidden('work_order.permission_sla_override', ERR_PERM_SLA_OVERRIDE);
      }
    }
    if (flags.hasPriority && !ctx.has_write_all) {
      if (!(await checkPermission('tickets.change_priority'))) {
        throw AppErrors.forbidden('work_order.permission_priority_change', ERR_PERM_PRIORITY_CHANGE);
      }
    }
    if (flags.hasAssignment && !ctx.has_write_all) {
      if (!(await checkPermission('tickets.assign'))) {
        throw AppErrors.forbidden('work_order.permission_assign', ERR_PERM_ASSIGN);
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
    // for SYSTEM_ACTOR too because the orchestrator must reject an
    // unknown sla_id before submitting the combined RPC, where the
    // failure would surface as a programmer-error code from the inner
    // SQL function instead of a registered validation code).
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
      // Visibility helpers throw AppError (status 403). Anything else
      // (DB error, etc) re-throws unchanged.
      if (
        err instanceof Error &&
        (err as { status?: number }).status === 403
      ) {
        return { canPlan: false };
      }
      throw err;
    }
  }

  /**
   * Reassign a work_order with a reason. Distinct from the `update()`
   * orchestrator's `assignment` branch — `reassign` writes a
   * `routing_decisions` row tagged `chosen_by: 'manual_reassign'` and a
   * corresponding internal-visibility activity row carrying the human
   * reason in `content`. Mirrors ticket.service.ts:959-1074.
   *
   * Two-axis gate (same as the orchestrator's assignment branch):
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
    // B.2.A I1 — threaded from RequireClientRequestIdGuard via the
    // controller for `POST /work-orders/:id/reassign`. Plumbed only today;
    // Step 3+ uses it as the idempotency-key seed for the
    // set_entity_assignment RPC (spec §3.2 + §3.9.1).
    _clientRequestId?: string,
  ): Promise<WorkOrderRow> {
    const tenant = TenantContext.current();

    if (!dto.reason || !dto.reason.trim()) {
      throw AppErrors.validationFailed('work_order.reassign_reason_required', { detail: 'reassignment reason is required' });
    }

    if (dto.rerun_resolver) {
      // Defer until the planning board needs it — mirrors the brief
      // ("Mirror case-side reassign() implementation" but the case-side
      // resolver-rerun path uses request_type/asset/location lookups that
      // need to be re-evaluated against work_order context, not case
      // context). 501 (not 400) — the request is well-formed; the resource
      // just doesn't implement that mode yet. Surface explicitly so callers
      // know it's missing rather than silently degrade to manual mode.
      throw AppErrors.validationFailed('work_order.rerun_resolver_unsupported', {
        detail: 'rerun_resolver is not yet supported for work_order reassign — pass an explicit assignee instead',
      });
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
      throw AppErrors.notFound('work_order', workOrderId);
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
      throw AppErrors.forbidden('work_order.no_longer_accessible', 'Work order no longer accessible');
    }
    return refreshed as WorkOrderRow;
  }

  /**
   * Two-axis gate for `reassign()` — visibility floor (`assertCanPlan`)
   * plus the `tickets.assign` OR `tickets.write_all` permission check.
   * Per the catalog, `tickets.assign` is NOT a danger:true gate, so this
   * is a plain permission check (no danger ceremony).
   *
   * `update()`'s assignment branch goes through `preflightValidateUpdate`,
   * which runs the same checks inline; this helper exists for `reassign`'s
   * separate write path (routing_decisions audit) which stays outside the
   * orchestrator until Step 9 (workflow-engine cutover, §3.2).
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
      throw AppErrors.forbidden('work_order.permission_assign', ERR_PERM_ASSIGN);
    }
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
