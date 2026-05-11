import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { buildDispatchIdempotencyKey } from '@prequest/shared';
import { AppErrors } from '../../common/errors';
import { mapRpcErrorToAppError } from '../../common/errors/map-rpc-error';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import {
  assertTenantOwned,
  validateAssigneesInTenant,
} from '../../common/tenant-validation';
import { RoutingService } from '../routing/routing.service';
import { ScopeOverrideResolverService } from '../routing/scope-override-resolver.service';
import { SlaService } from '../sla/sla.service';
import { TicketService, SYSTEM_ACTOR } from './ticket.service';
import { TicketVisibilityService } from './ticket-visibility.service';

/**
 * Stable namespace for deterministic child_id minting (uuidv5). The
 * value is a one-off random uuid generated for this codebase; pinning
 * it as a constant means `uuidv5(idempotencyKey, NS)` is reproducible
 * across processes + retries. RFC 4122 §4.3.
 */
const DISPATCH_CHILD_ID_NAMESPACE = 'a3f4b21e-7c5d-4e6f-9a8b-1c2d3e4f5061';

/**
 * Naming asymmetry — intentional (B.2 §0.1).
 *
 * Runtime row columns use the SHORT form: `tickets.ticket_type_id`,
 * `tickets.workflow_id`, `tickets.sla_id`. Configuration tables and
 * the public API use the LONG form: `request_type_id`,
 * `workflow_definition_id`, `sla_policy_id`.
 *
 * This file uses both forms — short when reading/writing the runtime
 * row, long when reading/writing config (request_types,
 * workflow_definitions, sla_policies). DO NOT "normalise" them.
 *
 * Audit: docs/follow-ups/phase-8-naming-audit.md §2.C/D/E.
 */

export interface DispatchDto {
  title: string;
  description?: string;
  assigned_team_id?: string;
  assigned_user_id?: string;
  assigned_vendor_id?: string;
  priority?: string;
  interaction_mode?: 'internal' | 'external';
  ticket_type_id?: string;
  asset_id?: string;
  location_id?: string;
  /**
   * Executor's SLA policy. `undefined` = fall through to vendor/team defaults.
   * Explicit `null` = "No SLA" — dispatch with no SLA timers running.
   */
  sla_id?: string | null;
}

@Injectable()
export class DispatchService {
  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => TicketService)) private readonly tickets: TicketService,
    private readonly routingService: RoutingService,
    private readonly slaService: SlaService,
    private readonly visibility: TicketVisibilityService,
    private readonly scopeOverrides: ScopeOverrideResolverService,
  ) {}

  async dispatch(
    parentId: string,
    dto: DispatchDto,
    actorAuthUid: string,
    // B.2.A.Step8 — threaded from RequireClientRequestIdGuard via the
    // controller for `POST /tickets/:id/dispatch`. Used as the
    // idempotency-key seed for `dispatch_child_work_order` (00336) per
    // spec §3.4 + §3.9.1. Internal callers (workflow engine, cron) must
    // pass a stable id derived from the originating operation — see
    // F-CRIT-1 guard below.
    clientRequestId?: string,
  ) {
    const tenant = TenantContext.current();

    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertVisible(parentId, ctx, 'write');
    }

    if (!dto.title?.trim()) {
      throw AppErrors.validationFailed('dispatch.title_required', {
        detail: 'dispatch requires a non-empty title',
      });
    }

    // getById throws AppError(ticket.not_found) on miss — no null guard needed
    const parent = await this.tickets.getById(parentId, SYSTEM_ACTOR) as Record<string, unknown>;
    if (parent.ticket_kind === 'work_order') {
      throw AppErrors.validationFailed('dispatch.from_work_order', {
        detail: 'cannot dispatch from a work_order; dispatch from the parent case',
      });
    }

    if (parent.status_category === 'pending_approval') {
      throw AppErrors.validationFailed('dispatch.parent_pending_approval', {
        detail: 'cannot dispatch while parent is pending approval',
      });
    }
    // The parent-close trigger (00134) rejects child inserts under terminal
    // parents at the DB level. Catch it here for a friendly 400 instead of
    // a generic 500.
    if (parent.status_category === 'resolved' || parent.status_category === 'closed') {
      throw AppErrors.validationFailed('dispatch.parent_terminal', {
        detail: `cannot dispatch a work order on a ${parent.status_category as string} case`,
      });
    }

    const ticketTypeId = dto.ticket_type_id ?? (parent.ticket_type_id as string | null);
    const locationId = dto.location_id ?? (parent.location_id as string | null);
    const assetId = dto.asset_id ?? (parent.asset_id as string | null);
    const priority = dto.priority ?? ((parent.priority as string | null) ?? 'medium');

    // Plan A.2 — gap map §dispatch.service.ts:69,97-99,186. The dispatched
    // row will write ticket_type_id + assigned_*_id + sla_id as FKs to
    // tenant-owned tables; FKs prove existence globally but NOT tenant
    // ownership. Validate every uuid that came from `dto` BEFORE the row
    // insert at line 87 (and BEFORE resolveChildSla returns dto.sla_id).
    //
    // Plan A.4 / Commit 2 (C1) — system actor MUST validate FK refs.
    // The pre-A.4 code passed `skipForSystemActor: actorAuthUid ===
    // SYSTEM_ACTOR` on these calls. That was wrong: system actor should
    // bypass visibility/permission gates (the workflow engine + cron jobs
    // legitimately operate on rows they couldn't otherwise see), but it
    // must NEVER bypass data-integrity validation. Workflow node configs,
    // routing config, and templates are user-authored JSONB — a forged or
    // malformed definition can carry a foreign-tenant uuid and the system
    // actor would write it blind. The dispatch path is the primary
    // entry-point for create_child_tasks; this is the right place to
    // enforce. (Round-4 codex flag: dispatch.service.ts:94, 108, 121, 270.)
    //
    // ticket_type_id only when it came from the DTO — when inherited from
    // parent it was already tenant-loaded by getById's visibility check.
    if (dto.ticket_type_id !== undefined && dto.ticket_type_id !== null) {
      await assertTenantOwned(
        this.supabase,
        'request_types',
        dto.ticket_type_id,
        tenant.id,
        { entityName: 'request type' },
      );
    }
    // Assignees: assigned_team_id / assigned_user_id / assigned_vendor_id.
    // Mirror of TicketService.update + WorkOrderService.update preflight.
    await validateAssigneesInTenant(
      this.supabase,
      {
        assigned_team_id: dto.assigned_team_id,
        assigned_user_id: dto.assigned_user_id,
        assigned_vendor_id: dto.assigned_vendor_id,
      },
      tenant.id,
    );
    // Explicit dto.sla_id — null is "No SLA" (valid); a string must be a
    // policy in this tenant. resolveChildSla will return this value blind
    // at line 186 below if we don't validate here first.
    if (typeof dto.sla_id === 'string') {
      await assertTenantOwned(
        this.supabase,
        'sla_policies',
        dto.sla_id,
        tenant.id,
        { entityName: 'SLA policy' },
      );
    }
    // Plan A.4 / Commit 5 (I1) / round-4 codex flag dispatch.service.ts:73-75,144-145.
    // location_id + asset_id are written to work_orders.location_id and
    // work_orders.asset_id below (lines 144-145 in the row insert). Both
    // FK to tenant-owned tables. Inherited values from the parent are
    // already tenant-loaded via getById's visibility check; only DTO-
    // sourced ids need pre-flight here. Keep the DTO check tight:
    // dto.location_id !== undefined means the caller explicitly set it
    // (vs. omitted, which falls back to parent.location_id).
    if (dto.location_id !== undefined && dto.location_id !== null) {
      await assertTenantOwned(
        this.supabase,
        'spaces',
        dto.location_id,
        tenant.id,
        { entityName: 'location' },
      );
    }
    if (dto.asset_id !== undefined && dto.asset_id !== null) {
      await assertTenantOwned(
        this.supabase,
        'assets',
        dto.asset_id,
        tenant.id,
        { entityName: 'asset' },
      );
    }

    // Load request type for routing domain only (NOT for SLA — child SLAs are independent).
    const rtCfg = ticketTypeId
      ? await this.loadRequestTypeConfig(ticketTypeId)
      : { domain: null };

    // ──────────────────────────────────────────────────────────────────
    // B.2.A.Step8 — TS plan-build phase for `dispatch_child_work_order`
    // (00336). Resolver evaluation + SLA resolution stay in TS (they're
    // read-only / config lookups). The multi-table WRITE phase moves
    // entirely into the RPC: work_orders INSERT + routing_decisions
    // INSERT + sla_timers INSERT + work_orders UPDATE (due-dates) +
    // ticket_activities INSERT on parent — all in one tx. See spec
    // §3.4 (docs/follow-ups/b2-survey-and-design.md lines 2165-2234).
    //
    // Pre-resolved assignee container (no longer the row literal).
    let chosenTeamId   = dto.assigned_team_id   ?? null;
    let chosenUserId   = dto.assigned_user_id   ?? null;
    let chosenVendorId = dto.assigned_vendor_id ?? null;

    // Routing: evaluate read-only when no explicit assignees. The RPC
    // gets the resolver target via the pre-set `assigned_*_id` columns
    // and the trace/strategy/rule_id via routing_trace + routing_chosen_by.
    let routingCtx: Parameters<RoutingService['evaluate']>[0] | null = null;
    let routingEvaluation: Awaited<ReturnType<RoutingService['evaluate']>> | null = null;
    if (!chosenTeamId && !chosenUserId && !chosenVendorId && ticketTypeId) {
      routingCtx = {
        tenant_id: tenant.id,
        ticket_id: 'pending',
        request_type_id: ticketTypeId,
        domain: rtCfg.domain,
        priority,
        asset_id: assetId,
        location_id: locationId,
      };
      routingEvaluation = await this.routingService.evaluate(routingCtx, 'child_dispatch');
      if (routingEvaluation.target) {
        if (routingEvaluation.target.kind === 'team')   chosenTeamId   = routingEvaluation.target.team_id;
        if (routingEvaluation.target.kind === 'user')   chosenUserId   = routingEvaluation.target.user_id;
        if (routingEvaluation.target.kind === 'vendor') chosenVendorId = routingEvaluation.target.vendor_id;
      }
    }

    // SLA resolution — read-only TS path. The RPC writes the result.
    const rowForSla: Record<string, unknown> = {
      ticket_type_id: ticketTypeId,
      location_id: locationId,
      asset_id: assetId,
      assigned_team_id: chosenTeamId,
      assigned_user_id: chosenUserId,
      assigned_vendor_id: chosenVendorId,
    };
    const resolvedSlaId = await this.resolveChildSla(dto, rowForSla);

    // SLA timers: TS pre-computes business-hours-adjusted due_at per
    // timer (the RPC just INSERTs). When resolvedSlaId is null we
    // pass an empty array → no timer writes.
    let timers: Array<{
      timer_type: 'response' | 'resolution';
      target_minutes: number;
      due_at: string;
      business_hours_calendar_id: string | null;
    }> = [];
    if (resolvedSlaId) {
      timers = await this.slaService.buildTimersForRpc(resolvedSlaId, tenant.id);
    }

    // F-CRIT-1 parity with TicketService.update — internal callers
    // bypassing the controller's RequireClientRequestIdGuard MUST
    // supply a stable clientRequestId. Workflow-engine + cron paths
    // pass one explicitly; HTTP path gets one from the guard. A
    // randomUUID fallback for SYSTEM_ACTOR keeps tests working today
    // (deterministic-per-call) while making the missing-key story
    // explicit for non-system callers. F-CRIT-1 retro logged in
    // b2-a-interim-retro-2026-05-11.md.
    let effectiveClientRequestId = clientRequestId;
    if (!effectiveClientRequestId) {
      if (actorAuthUid === SYSTEM_ACTOR) {
        // System actor without an explicit id: fresh uuid per call.
        // Workflow-engine cutover at workflow-engine.service.ts uses
        // the batch RPC with a derived id; the single-RPC system
        // callers (today: none) get a per-invocation fresh id.
        effectiveClientRequestId = randomUUID();
      } else {
        throw AppErrors.badRequest(
          'command_operations.client_request_id_required',
          'POST /tickets/:id/dispatch requires X-Client-Request-Id header per I1 (RequireClientRequestIdGuard).',
        );
      }
    }

    const idempotencyKey = buildDispatchIdempotencyKey(
      parentId,
      actorAuthUid === SYSTEM_ACTOR ? SYSTEM_ACTOR : actorAuthUid,
      effectiveClientRequestId,
    );

    // Deterministic child_id (uuidv5 of the idempotency_key) — replay
    // of the same key produces the same row, not a new one.
    const childId = uuidv5(idempotencyKey, DISPATCH_CHILD_ID_NAMESPACE);

    // Payload shape per spec §3.4 (lines 2180-2197).
    const payload: Record<string, unknown> = {
      child_id: childId,
      title: dto.title,
      description: dto.description ?? null,
      priority,
      interaction_mode: dto.interaction_mode ?? 'internal',
      ticket_type_id: ticketTypeId,
      asset_id: assetId,
      location_id: locationId,
      assigned_team_id: chosenTeamId,
      assigned_user_id: chosenUserId,
      assigned_vendor_id: chosenVendorId,
      // sla_id: when resolveChildSla returns null we DON'T include the key
      // (RPC reads "absent" as null). When non-null we pass the uuid.
      // Either way TS owns the resolution outcome.
      ...(resolvedSlaId ? { sla_id: resolvedSlaId, timers } : {}),
      // Routing trace snapshot — the RPC writes the audit row in-tx.
      ...(routingEvaluation
        ? {
            routing_trace:    routingEvaluation.trace ?? [],
            routing_chosen_by: routingEvaluation.chosen_by,
            routing_strategy:  routingEvaluation.strategy,
            routing_rule_id:   routingEvaluation.rule_id ?? null,
            routing_context: routingCtx
              ? {
                  request_type_id: routingCtx.request_type_id,
                  domain:          routingCtx.domain,
                  priority:        routingCtx.priority,
                  asset_id:        routingCtx.asset_id,
                  location_id:     routingCtx.location_id,
                }
              : {},
          }
        : {
            routing_trace:    [],
            routing_chosen_by: 'manual',
            routing_strategy:  'manual',
          }),
    };

    const { error: rpcError } = await this.supabase.admin.rpc('dispatch_child_work_order', {
      p_parent_id: parentId,
      p_tenant_id: tenant.id,
      p_actor_user_id: actorAuthUid === SYSTEM_ACTOR ? null : actorAuthUid,
      p_idempotency_key: idempotencyKey,
      p_payload: payload,
    });
    if (rpcError) throw mapRpcErrorToAppError(rpcError);

    // Refetch — the RPC's return value is a summary; controllers expect
    // the full work_orders row (joined columns the desk UI consumes).
    // Tenant-scoped lookup; we just wrote this id so it must exist.
    const { data: child, error: fetchError } = await this.supabase.admin
      .from('work_orders')
      .select('*')
      .eq('id', childId)
      .eq('tenant_id', tenant.id)
      .single();
    if (fetchError) throw fetchError;
    return child as Record<string, unknown>;
  }

  /**
   * Batch sibling of `dispatch()`. Replaces §1.18
   * (workflow-engine.service.ts:425-469 per-task loop) by dispatching
   * N children atomically via `dispatch_child_work_orders_batch` (00337).
   * One transaction commits all N or none — eliminates the
   * partial-fanout failure mode where a workflow advances after dispatch
   * #3 of 5 failed.
   *
   * Behaviour:
   *   - TS preflight runs once for the PARENT (visibility +
   *     dispatchability gates).
   *   - For each task: SLA + routing resolution + tenant-FK validation
   *     happen in TS plan-build, just like the single path.
   *   - The RPC re-validates server-side and writes all N children +
   *     routing_decisions + sla_timers + ticket_activities rows in one
   *     tx.
   *   - clientRequestId is required and seeds the batch idempotency key.
   *     The deterministic child_id per task is uuidv5(idempotencyKey +
   *     ':' + taskIndex, NS) so a retry produces the same N rows.
   *
   * Returns the array of dispatched work_order rows in input order.
   */
  async dispatchBatch(
    parentId: string,
    tasks: DispatchDto[],
    actorAuthUid: string,
    clientRequestId: string,
  ): Promise<Array<Record<string, unknown>>> {
    if (!clientRequestId) {
      throw AppErrors.badRequest(
        'command_operations.client_request_id_required',
        'dispatchBatch requires a stable clientRequestId per I1 (RequireClientRequestIdGuard).',
      );
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
      // Surface at the TS boundary so the workflow engine doesn't burn
      // an RPC round-trip for an empty batch.
      throw AppErrors.validationFailed('dispatch_child_work_orders_batch.empty_tasks', {
        detail: 'dispatchBatch requires at least one task',
      });
    }

    const tenant = TenantContext.current();

    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertVisible(parentId, ctx, 'write');
    }

    // Parent lookup once (used by all tasks). Same shape as dispatch():
    // getById throws AppError(ticket.not_found) on miss.
    const parent = await this.tickets.getById(parentId, SYSTEM_ACTOR) as Record<string, unknown>;
    if (parent.ticket_kind === 'work_order') {
      throw AppErrors.validationFailed('dispatch.from_work_order', {
        detail: 'cannot dispatch from a work_order; dispatch from the parent case',
      });
    }
    if (parent.status_category === 'pending_approval') {
      throw AppErrors.validationFailed('dispatch.parent_pending_approval', {
        detail: 'cannot dispatch while parent is pending approval',
      });
    }
    if (parent.status_category === 'resolved' || parent.status_category === 'closed') {
      throw AppErrors.validationFailed('dispatch.parent_terminal', {
        detail: `cannot dispatch a work order on a ${parent.status_category as string} case`,
      });
    }

    const batchKey = `dispatch_batch:${parentId}:${actorAuthUid === SYSTEM_ACTOR ? SYSTEM_ACTOR : actorAuthUid}:${clientRequestId}`;

    // Build the per-task payload array.
    const taskPayloads: Array<Record<string, unknown>> = [];
    const childIds: string[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const dto = tasks[i];
      if (!dto.title?.trim()) {
        throw AppErrors.validationFailed('dispatch.title_required', {
          detail: `dispatchBatch[${i}] requires a non-empty title`,
        });
      }

      // Per-task preflight FK validation (mirror the single path).
      if (dto.ticket_type_id !== undefined && dto.ticket_type_id !== null) {
        await assertTenantOwned(
          this.supabase,
          'request_types',
          dto.ticket_type_id,
          tenant.id,
          { entityName: 'request type' },
        );
      }
      await validateAssigneesInTenant(
        this.supabase,
        {
          assigned_team_id: dto.assigned_team_id,
          assigned_user_id: dto.assigned_user_id,
          assigned_vendor_id: dto.assigned_vendor_id,
        },
        tenant.id,
      );
      if (typeof dto.sla_id === 'string') {
        await assertTenantOwned(
          this.supabase,
          'sla_policies',
          dto.sla_id,
          tenant.id,
          { entityName: 'SLA policy' },
        );
      }
      if (dto.location_id !== undefined && dto.location_id !== null) {
        await assertTenantOwned(
          this.supabase,
          'spaces',
          dto.location_id,
          tenant.id,
          { entityName: 'location' },
        );
      }
      if (dto.asset_id !== undefined && dto.asset_id !== null) {
        await assertTenantOwned(
          this.supabase,
          'assets',
          dto.asset_id,
          tenant.id,
          { entityName: 'asset' },
        );
      }

      const ticketTypeId = dto.ticket_type_id ?? (parent.ticket_type_id as string | null);
      const locationId   = dto.location_id   ?? (parent.location_id   as string | null);
      const assetId      = dto.asset_id      ?? (parent.asset_id      as string | null);
      const priority     = dto.priority      ?? ((parent.priority     as string | null) ?? 'medium');

      const rtCfg = ticketTypeId ? await this.loadRequestTypeConfig(ticketTypeId) : { domain: null };

      let chosenTeamId   = dto.assigned_team_id   ?? null;
      let chosenUserId   = dto.assigned_user_id   ?? null;
      let chosenVendorId = dto.assigned_vendor_id ?? null;

      let routingCtx: Parameters<RoutingService['evaluate']>[0] | null = null;
      let routingEvaluation: Awaited<ReturnType<RoutingService['evaluate']>> | null = null;
      if (!chosenTeamId && !chosenUserId && !chosenVendorId && ticketTypeId) {
        routingCtx = {
          tenant_id: tenant.id,
          ticket_id: 'pending',
          request_type_id: ticketTypeId,
          domain: rtCfg.domain,
          priority,
          asset_id: assetId,
          location_id: locationId,
        };
        routingEvaluation = await this.routingService.evaluate(routingCtx, 'child_dispatch');
        if (routingEvaluation.target) {
          if (routingEvaluation.target.kind === 'team')   chosenTeamId   = routingEvaluation.target.team_id;
          if (routingEvaluation.target.kind === 'user')   chosenUserId   = routingEvaluation.target.user_id;
          if (routingEvaluation.target.kind === 'vendor') chosenVendorId = routingEvaluation.target.vendor_id;
        }
      }

      const rowForSla: Record<string, unknown> = {
        ticket_type_id: ticketTypeId,
        location_id: locationId,
        asset_id: assetId,
        assigned_team_id: chosenTeamId,
        assigned_user_id: chosenUserId,
        assigned_vendor_id: chosenVendorId,
      };
      const resolvedSlaId = await this.resolveChildSla(dto, rowForSla);

      let timers: Array<{
        timer_type: 'response' | 'resolution';
        target_minutes: number;
        due_at: string;
        business_hours_calendar_id: string | null;
      }> = [];
      if (resolvedSlaId) {
        timers = await this.slaService.buildTimersForRpc(resolvedSlaId, tenant.id);
      }

      // Per-task child_id derived from (batchKey, index). Same key + same
      // index → same child uuid on retry.
      const childId = uuidv5(`${batchKey}:${i}`, DISPATCH_CHILD_ID_NAMESPACE);
      childIds.push(childId);

      taskPayloads.push({
        child_id: childId,
        title: dto.title,
        description: dto.description ?? null,
        priority,
        interaction_mode: dto.interaction_mode ?? 'internal',
        ticket_type_id: ticketTypeId,
        asset_id: assetId,
        location_id: locationId,
        assigned_team_id: chosenTeamId,
        assigned_user_id: chosenUserId,
        assigned_vendor_id: chosenVendorId,
        ...(resolvedSlaId ? { sla_id: resolvedSlaId, timers } : {}),
        ...(routingEvaluation
          ? {
              routing_trace:    routingEvaluation.trace ?? [],
              routing_chosen_by: routingEvaluation.chosen_by,
              routing_strategy:  routingEvaluation.strategy,
              routing_rule_id:   routingEvaluation.rule_id ?? null,
              routing_context: routingCtx
                ? {
                    request_type_id: routingCtx.request_type_id,
                    domain:          routingCtx.domain,
                    priority:        routingCtx.priority,
                    asset_id:        routingCtx.asset_id,
                    location_id:     routingCtx.location_id,
                  }
                : {},
            }
          : {
              routing_trace:    [],
              routing_chosen_by: 'manual',
              routing_strategy:  'manual',
            }),
      });
    }

    const { error: rpcError } = await this.supabase.admin.rpc('dispatch_child_work_orders_batch', {
      p_parent_id: parentId,
      p_tenant_id: tenant.id,
      p_actor_user_id: actorAuthUid === SYSTEM_ACTOR ? null : actorAuthUid,
      p_idempotency_key: batchKey,
      p_tasks: taskPayloads,
    });
    if (rpcError) throw mapRpcErrorToAppError(rpcError);

    // Refetch all N children in one query (order preserved by inserting
    // the array index column via a CTE-style approach is overkill — the
    // childIds list is already in insert order; sort by it client-side).
    const { data: children, error: fetchError } = await this.supabase.admin
      .from('work_orders')
      .select('*')
      .in('id', childIds)
      .eq('tenant_id', tenant.id);
    if (fetchError) throw fetchError;

    const byId = new Map<string, Record<string, unknown>>();
    for (const row of (children ?? []) as Array<Record<string, unknown>>) {
      byId.set(row.id as string, row);
    }
    return childIds.map((id) => byId.get(id) as Record<string, unknown>).filter((r) => !!r);
  }

  /**
   * Resolve which sla_policy_id to attach to a child work order.
   * Order: explicit dto.sla_id → scope-override executor_sla_policy_id →
   * vendor default → team default → user.team default → null.
   * `dto.sla_id === null` is a deliberate "No SLA" choice and short-circuits.
   *
   * Scope override is looked up against the child's location (falls back to
   * parent location when the child inherits). See live-doc §5.5 + §7.4.
   */
  private async resolveChildSla(
    dto: DispatchDto,
    row: Record<string, unknown>,
  ): Promise<string | null> {
    if (dto.sla_id !== undefined) return dto.sla_id; // explicit (string | null)

    const tenantId = TenantContext.current().id;

    const requestTypeId = row.ticket_type_id as string | null;
    if (requestTypeId) {
      // Asset-only children (no row.location_id but row.asset_id set) must
      // still hit the executor-SLA override — delegate to the centralized
      // effective-location derivation in ScopeOverrideResolverService.
      const override = await this.scopeOverrides.resolve(tenantId, requestTypeId, {
        locationId: (row.location_id as string | null) ?? null,
        assetId: (row.asset_id as string | null) ?? null,
      });
      if (override?.executor_sla_policy_id) {
        // Plan A.2 / Commit 7 / gap map §MEDIUM dispatch.service.ts:199.
        // The scope-override resolver IS tenant-scoped today (its loader
        // filters by tenantId — see scope-override-resolver.service.ts),
        // but defense-in-depth here means a future change to the resolver
        // can't silently re-introduce a cross-tenant FK write. Cheap
        // round-trip; only fires when an override is found.
        //
        // Plan A.4 / Commit 2 (C1) — drop skipForSystemActor. Scope
        // overrides are user-authored config, not pre-trusted system
        // data — system-actor execution paths (create_child_tasks +
        // post-create automation) MUST validate the FK ref. The defense-
        // in-depth guard exists exactly for the system path that bypasses
        // dto-level validation; skipping it for system actor was the
        // bug-class round-4 codex flagged.
        await assertTenantOwned(
          this.supabase,
          'sla_policies',
          override.executor_sla_policy_id,
          tenantId,
          { entityName: 'override executor SLA policy' },
        );
        return override.executor_sla_policy_id;
      }
    }

    const vendorId = row.assigned_vendor_id as string | null;
    if (vendorId) {
      const { data } = await this.supabase.admin
        .from('vendors')
        .select('default_sla_policy_id')
        .eq('id', vendorId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      const id = (data as { default_sla_policy_id: string | null } | null)?.default_sla_policy_id;
      if (id) return id;
    }

    const teamId = row.assigned_team_id as string | null;
    if (teamId) {
      const { data } = await this.supabase.admin
        .from('teams')
        .select('default_sla_policy_id')
        .eq('id', teamId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      const id = (data as { default_sla_policy_id: string | null } | null)?.default_sla_policy_id;
      if (id) return id;
    }

    const userId = row.assigned_user_id as string | null;
    if (userId) {
      const { data: user } = await this.supabase.admin
        .from('users')
        .select('team_id')
        .eq('id', userId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      const userTeamId = (user as { team_id: string | null } | null)?.team_id;
      if (userTeamId) {
        const { data: team } = await this.supabase.admin
          .from('teams')
          .select('default_sla_policy_id')
          .eq('id', userTeamId)
          .eq('tenant_id', tenantId)
          .maybeSingle();
        const id = (team as { default_sla_policy_id: string | null } | null)?.default_sla_policy_id;
        if (id) return id;
      }
    }

    return null;
  }

  // Consolidated single request-type loader — domain only (SLA resolved
  // separately via resolveChildSla). Tenant-filtered as defense-in-depth:
  // a foreign-tenant id passed via dto.ticket_type_id is rejected by the
  // assertTenantOwned check above, but inherited values from
  // parent.ticket_type_id were already trust-anchored to the parent's
  // tenant (visibility loadContext + getById). Filtering here too means
  // even if a future caller bypasses dispatch() (or the parent has been
  // mutated mid-call), the loader can't leak a foreign-tenant config.
  private async loadRequestTypeConfig(id: string): Promise<{ domain: string | null }> {
    const tenantId = TenantContext.current().id;
    const { data } = await this.supabase.admin
      .from('request_types')
      .select('domain')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    const d = data as { domain: string | null } | null;
    return { domain: d?.domain ?? null };
  }
}
