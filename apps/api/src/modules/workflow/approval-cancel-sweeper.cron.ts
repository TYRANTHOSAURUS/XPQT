import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../common/supabase/supabase.service';

/**
 * ApprovalCancelSweeperCron — backstop for any drift where a
 * `workflow_instances.status='cancelled'` row has surviving pending
 * approvals.
 *
 * Phase 1.5 sub-step 6.G.
 *
 * Spec: docs/superpowers/specs/phase-1.5-visual-approval-workflow-plan.md
 *   §6.G (lines 1306-1318) — sub-step spec.
 *   §2.6.8 (lines 599-700) — the cancel_workflow_instance_with_approvals
 *      RPC which is the primary path; this cron is the backstop.
 *
 * ── Why a backstop ──────────────────────────────────────────────────────
 *
 * The PRIMARY cancel-with-approvals path goes through the
 * `cancel_workflow_instance_with_approvals` PL/pgSQL RPC (migration 00400)
 * which wraps the claim + approvals expiry + audit emit in one transaction.
 * If the RPC body fails mid-flight, the whole tx rolls back — the
 * workflow_instance stays in ('active','waiting') and the approvals stay
 * pending. CRITICAL 4 closed.
 *
 * But two paths exist where a workflow_instance can transition to
 * 'cancelled' WITHOUT going through the RPC:
 *
 *   1. Pre-Phase-1.5 rows. Workflow_instances that were cancelled via the
 *      legacy TS-side claim (pre-Phase-1.5 path) BEFORE the 00400 RPC
 *      shipped. They have status='cancelled' but their linked approvals
 *      were never atomically expired — the TS-side code at the time only
 *      emitted the instance_cancelled audit event. Phase 1.5 6.A.X +
 *      6.A.Y + 6.B added the workflow_instance_id FK on approvals; the
 *      legacy rows have NULL there and would be missed by a strict
 *      WHERE workflow_instance_id IS NOT NULL gate, but for the SAME
 *      target_entity_id (the booking), the link exists semantically.
 *      In practice for Phase 1.5 we only sweep rows where
 *      workflow_instance_id IS NOT NULL — pre-migration rows already
 *      did their fate.
 *
 *   2. Manual SQL surgery. An operator (or a service-role script) that
 *      flips workflow_instances.status='cancelled' directly via psql
 *      bypasses the RPC. The booking flow's downstream paths assume the
 *      atomic expiry happened; if not, the linked approvals appear stale
 *      to grant_booking_approval (which would CAS-update them but never
 *      expire them).
 *
 * The cron sweeps every 5 minutes for `approvals` rows whose
 * `workflow_instance_id` points at a `workflow_instances.status=
 * 'cancelled'` row AND whose own status is 'pending'. It expires them
 * with a distinct `comments` value so the audit trail makes the drift
 * source explicit.
 *
 * ── Cadence ─────────────────────────────────────────────────────────────
 *
 * Every 5 minutes (CronExpression.EVERY_5_MINUTES). Matches Phase 1.C's
 * `WorkflowWaitSweeperCron` precedent of "frequent enough to be a real
 * safety net without flooding the DB on the happy path where most sweeps
 * find nothing". The plan §10 open question 8 raised the cadence; v4
 * recommendation locked in "match Phase 1.C cadence; revisit if
 * observability shows lag" — Phase 1.C is 30s but for approvals 30s is
 * over-eager. 5min is the sensible "backstop, not primary" interval.
 *
 * ── Tenant scoping ──────────────────────────────────────────────────────
 *
 * tenant_id is the #0 invariant per project CLAUDE.md
 * (feedback_tenant_id_ultimate_rule). The SELECT joins on approvals.
 * tenant_id = workflow_instances.tenant_id to enforce the boundary — even
 * though both tables' rows must individually have a tenant_id matching
 * the request actor, the JOIN ensures we don't expire an approval whose
 * workflow_instance points at a different tenant's row (which the 00400
 * trigger should have already rejected at INSERT, but defensive).
 *
 * ── Concurrency ─────────────────────────────────────────────────────────
 *
 * Single-instance worker (today). `this.sweeping` serialises self. The
 * UPDATE is keyed by approval id; concurrent re-runs (multi-worker
 * future) collide on the WHERE status='pending' guard — exactly one
 * worker flips a row.
 *
 * ── Configuration ───────────────────────────────────────────────────────
 *
 * `APPROVAL_CANCEL_SWEEPER_ENABLED` (default `true`) — set to `'false'`
 * to disable. Same shape as `WORKFLOW_WAIT_SWEEPER_ENABLED`.
 */
@Injectable()
export class ApprovalCancelSweeperCron {
  private readonly log = new Logger(ApprovalCancelSweeperCron.name);

  private readonly enabled =
    process.env.APPROVAL_CANCEL_SWEEPER_ENABLED !== 'false';
  private readonly batchSize = (() => {
    const parsed = Number(
      process.env.APPROVAL_CANCEL_SWEEPER_BATCH_SIZE ?? 200,
    );
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 200;
  })();

  private sweeping = false;

  constructor(private readonly supabase: SupabaseService) {}

  // ─────────────────────────────────────────────────────────────────────
  // Cron entry point
  // ─────────────────────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweepOrphanedApprovals(): Promise<void> {
    if (!this.enabled) return;
    if (this.sweeping) return; // serialize self
    this.sweeping = true;
    try {
      const result = await this.sweepOnce();
      if (result.expired > 0) {
        this.log.log(
          `approval-cancel-sweeper expired ${result.expired} pending approval(s) across ${result.tenants} tenant(s) — backstop for non-RPC workflow_instance cancellations`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`approval-cancel-sweeper failed: ${message}`);
    } finally {
      this.sweeping = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Sweep (single pass) — public so tests can drive it deterministically.
  // ─────────────────────────────────────────────────────────────────────

  async sweepOnce(): Promise<{ expired: number; tenants: number }> {
    // Two-step: SELECT the candidate ids (joined to workflow_instances for
    // the tenant + status filter) → UPDATE them by id. Two-step rather than
    // one UPDATE...FROM because supabase-js's update builder doesn't expose
    // FROM-clause syntax cleanly; SELECT + UPDATE-by-id-batch is the
    // canonical idiom in this codebase (mirrors WorkflowWaitSweeperCron's
    // claim shape).
    const { data: candidates, error: selectErr } = await this.supabase.admin
      .from('approvals')
      .select('id, tenant_id, workflow_instance_id')
      .eq('status', 'pending')
      .not('workflow_instance_id', 'is', null)
      .limit(this.batchSize);

    if (selectErr) {
      throw new Error(
        `approval-cancel-sweeper.select_failed: ${selectErr.message}`,
      );
    }

    if (!candidates || candidates.length === 0) {
      return { expired: 0, tenants: 0 };
    }

    // Pull the workflow_instance rows for the candidate workflow_instance_ids
    // — single query, tenant-filtered defensively. Only `cancelled` rows
    // matter for the sweep.
    const instanceIds = Array.from(
      new Set(candidates.map((c) => (c as { workflow_instance_id: string }).workflow_instance_id)),
    );
    const { data: instances, error: instanceErr } = await this.supabase.admin
      .from('workflow_instances')
      .select('id, tenant_id, status')
      .in('id', instanceIds);

    if (instanceErr) {
      throw new Error(
        `approval-cancel-sweeper.instance_read_failed: ${instanceErr.message}`,
      );
    }

    const cancelledInstanceIds = new Set(
      (instances ?? [])
        .filter((i) => (i as { status: string }).status === 'cancelled')
        .map((i) => (i as { id: string }).id),
    );

    if (cancelledInstanceIds.size === 0) {
      return { expired: 0, tenants: 0 };
    }

    // Group orphans by tenant for accurate audit logging. Cross-tenant
    // mismatch (an approval whose tenant_id != the cancelled instance's
    // tenant_id) means schema corruption — the 00400 trigger should have
    // rejected at INSERT. Log + skip those rows (do NOT expire).
    const tenantsAffected = new Set<string>();
    const orphans: Array<{ id: string; tenant_id: string }> = [];
    const instanceTenantById = new Map(
      (instances ?? []).map((i) => [
        (i as { id: string }).id,
        (i as { tenant_id: string }).tenant_id,
      ]),
    );

    for (const c of candidates) {
      const cand = c as {
        id: string;
        tenant_id: string;
        workflow_instance_id: string;
      };
      if (!cancelledInstanceIds.has(cand.workflow_instance_id)) continue;
      const instanceTenant = instanceTenantById.get(cand.workflow_instance_id);
      if (instanceTenant !== cand.tenant_id) {
        this.log.warn(
          `approval-cancel-sweeper.tenant_mismatch: approval=${cand.id} tenant=${cand.tenant_id} workflow_instance_tenant=${instanceTenant} — skipping (schema-corruption canary; trigger should have rejected)`,
        );
        continue;
      }
      orphans.push({ id: cand.id, tenant_id: cand.tenant_id });
      tenantsAffected.add(cand.tenant_id);
    }

    if (orphans.length === 0) {
      return { expired: 0, tenants: 0 };
    }

    // Bulk expire. Status='pending' guard keeps the UPDATE idempotent —
    // a row that flipped between the SELECT and this UPDATE (e.g. a
    // concurrent grant_booking_approval grant came in) won't be
    // double-touched.
    const { data: updated, error: updateErr } = await this.supabase.admin
      .from('approvals')
      .update({
        status: 'expired',
        responded_at: new Date().toISOString(),
        comments: 'workflow_instance_cancelled_via_cron_backstop',
      })
      .in('id', orphans.map((o) => o.id))
      .eq('status', 'pending')
      .select('id, tenant_id');

    if (updateErr) {
      throw new Error(
        `approval-cancel-sweeper.update_failed: ${updateErr.message}`,
      );
    }

    return {
      expired: (updated ?? []).length,
      tenants: tenantsAffected.size,
    };
  }
}
