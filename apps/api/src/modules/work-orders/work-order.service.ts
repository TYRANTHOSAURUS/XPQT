import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
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
            'sla.override permission required to change a work order SLA',
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
    // Upper bound: 1 year of minutes. `Number.isInteger` returns true for
    // some integral floats above 2^31 (e.g. 1e15), which would pass our
    // validation and 500 on the int4 column overflow. Codex round 1 catch.
    const MAX_DURATION_MINUTES = 60 * 24 * 365;
    if (
      plannedDurationMinutes !== null &&
      (!Number.isInteger(plannedDurationMinutes) ||
        plannedDurationMinutes <= 0 ||
        plannedDurationMinutes > MAX_DURATION_MINUTES)
    ) {
      throw new BadRequestException(
        `planned_duration_minutes must be a positive integer ≤ ${MAX_DURATION_MINUTES}`,
      );
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
