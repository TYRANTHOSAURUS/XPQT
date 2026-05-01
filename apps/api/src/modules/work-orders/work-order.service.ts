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
 * Row shape returned by `updateSla`. The work_orders table mirrors most of
 * `tickets` (Step 1c.1/1c.10c) but post-cutover it is its own base table —
 * callers should not assume the field set is identical to `TicketDetail`.
 */
export type WorkOrderRow = Record<string, unknown> & {
  id: string;
  tenant_id: string;
  sla_id: string | null;
};

/**
 * WorkOrderService — the work-order command surface.
 *
 * Step 1c.10c made `TicketService.update` case-only. Any command that
 * mutates a work_order row (sla_id, plan, status, priority, assignment,
 * watchers, etc.) belongs here, NOT on TicketService. Today this service
 * exposes a single command — `updateSla` — as the scaffolding for the rest.
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
