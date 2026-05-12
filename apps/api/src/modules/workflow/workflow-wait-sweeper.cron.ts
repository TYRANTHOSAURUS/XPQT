import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext, type TenantInfo } from '../../common/tenant-context';
import { WorkflowEngineService } from './workflow-engine.service';

/**
 * WorkflowWaitSweeperCron — Tier 1 durability backstop for the Universal
 * Workflow Architecture's `spawn + wait` semantics.
 *
 * Spec: docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md
 *       §3.5 (Resume mechanism — Tier 1 cron poll)
 *       §3.6 (Cancel cascade — interacts with timeout firing)
 *       §3.12 (Phase 1 codes)
 *       §7   (Sequencing — cron is Phase 1.C)
 *
 * ── What this cron does ────────────────────────────────────────────────
 *
 * Every 30 seconds:
 *
 *   1. SELECT a bounded batch of `workflow_instance_links` rows whose
 *      `wait_timeout_at` has passed (and are still unresolved + still in
 *      wait spawn-mode). Uses `idx_wil_waiting` (00370:171) which is
 *      the partial index designed for this predicate.
 *
 *   2. For each candidate, atomic per-row claim:
 *
 *        UPDATE workflow_instance_links
 *           SET resolved_at     = now(),
 *               resolution_kind = 'timeout'
 *         WHERE id = $linkId
 *           AND resolved_at IS NULL
 *           AND wait_timeout_at IS NOT NULL
 *           AND wait_timeout_at <= now()
 *      RETURNING id, parent_instance_id, on_timeout_branch
 *
 *      0 rows = Tier 2 wake handler won the race / wait was extended /
 *      wait was satisfied via a `condition_met` resolution. Skip
 *      silently — the claim is the dedup boundary.
 *
 *   3. Defense-in-depth: re-read the parent `workflow_instances` row and
 *      assert tenant equality. The link table's tenant trigger
 *      (00370:205-228) enforces this at INSERT, but the trigger only
 *      fires on INSERT — a sweep that ever encounters a mismatch
 *      means a hand-rolled SQL surgery left a corrupt row, and we
 *      MUST NOT cross-tenant resume.
 *
 *   4. Emit `link_resolved` audit event with `resolution_kind: 'timeout'`.
 *      The event_type literal lives in the CHECK constraint extended by
 *      00376 (Phase 1.B work). The emit goes through
 *      `WorkflowEngineService.emit()` under `TenantContext.run(...)`.
 *
 *   5. Resume the parent workflow_instance on `link.on_timeout_branch`.
 *      The branch label is whatever the editor authored; if null
 *      (misconfiguration), `engine.advance()` falls through to
 *      `edges[0]` at workflow-engine.service.ts:214 — we log a warning
 *      and continue. Phase 2 editor validation will reject null
 *      `on_timeout_branch` at save time.
 *
 *   6. On resume failure: UNCLAIM the row (`resolved_at = NULL,
 *      resolution_kind = NULL`). The next sweep retries. This is the
 *      same pattern as the Phase 1.A wake handler's failure path
 *      (workflow-spawn-wake.handler.ts:404-443). Plain `Error` — there
 *      is no DeadLetterError equivalent for cron because the cron has
 *      no outbox-level retry counter; the interval IS the retry.
 *
 * ── Concurrency ────────────────────────────────────────────────────────
 *
 *   - Per-row atomic claim is the dedup boundary across (a) multiple
 *     sweep workers (if ever deployed; today single-instance) and
 *     (b) Tier 1 vs Tier 2 (Phase 1.A wake handler) racing on the same
 *     row. The Tier 2 path also carries
 *     `.or('wait_timeout_at.is.null,wait_timeout_at.gt.<nowIso>')` on its
 *     UPDATE (the `<nowIso>` is a TS-side `new Date().toISOString()`
 *     captured at claim time — PostgREST does NOT accept `now()` as a
 *     literal, see the comment at workflow-spawn-wake.handler.ts:294-318)
 *     so a row whose timeout has just passed is OWNED by Tier 1. The
 *     two paths are mutually exclusive at the SQL layer.
 *
 *   - The sweep itself is serialized to one in-flight run via
 *     `this.sweeping` (mirrors outbox.worker.ts:55-79). A 30s cron
 *     firing while the previous sweep is still draining a backlog
 *     is a no-op; the previous run finishes first.
 *
 * ── Tenant context ─────────────────────────────────────────────────────
 *
 *   - The cron runs under `supabase.admin` (RLS bypass). Every SELECT
 *     and UPDATE carries `tenant_id` as a join column on `links`.
 *     Defense-in-depth tenant assertion happens on the parent SELECT.
 *   - `engine.emit()` requires `TenantContext.current()`. We resolve
 *     the tenant from `tenants` (matching the outbox worker pattern at
 *     outbox.worker.ts:332-351) and wrap the emit + resume in
 *     `TenantContext.run(...)`. A 30s-TTL cache bounds redundant
 *     lookups when many rows from the same tenant expire together.
 *
 * ── Configuration ──────────────────────────────────────────────────────
 *
 *   - `WORKFLOW_WAIT_SWEEPER_ENABLED` (default `true`) — set to
 *     `'false'` to disable the cron entirely. Mirrors
 *     `OUTBOX_WORKER_ENABLED`.
 *   - `WORKFLOW_WAIT_SWEEPER_BATCH_SIZE` (default 100) — max links per
 *     sweep. Bounds the per-sweep work so a backlog of N >> batch
 *     drains over N/batch sweeps (30 * N/batch seconds).
 *
 * ── What this cron does NOT do ─────────────────────────────────────────
 *
 *   - Does NOT handle `workflow_terminal` wait conditions. Those are
 *     resolved when the CHILD workflow_instance hits a terminal status
 *     (Phase 1.B/2 engine work via the engine's terminal hook). The
 *     timeout filter in step 1 is wait-config-agnostic; if the
 *     `workflow_terminal` wait times out before the child workflow
 *     terminates, this cron is what fires the `timeout` branch.
 *
 *   - Does NOT cascade cancellation. Engine.cancelInstance (Phase 1.B)
 *     owns that.
 *
 *   - Does NOT do multi-spawn aggregation (LOCKED v2.2, deferred).
 *     Rows with `aggregation_group_id` are skipped — they'll be
 *     handled by the future `claim_aggregation_group_resume` RPC.
 */
@Injectable()
export class WorkflowWaitSweeperCron {
  private readonly log = new Logger(WorkflowWaitSweeperCron.name);

  // Configuration knobs.
  private readonly enabled =
    process.env.WORKFLOW_WAIT_SWEEPER_ENABLED !== 'false';
  // Code-review remediation: guard against typo (e.g. WORKFLOW_WAIT_SWEEPER_BATCH_SIZE='abc')
  // landing NaN into supabase-js `.limit(NaN)`. Fall back to default on
  // non-finite or non-positive values.
  private readonly batchSize = (() => {
    const parsed = Number(process.env.WORKFLOW_WAIT_SWEEPER_BATCH_SIZE ?? 100);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 100;
  })();

  // Tenant cache (30s TTL — same shape as outbox.worker.ts:52-53). The
  // cron has no caller tenant context; reads/writes via supabase.admin
  // and resolves tenant info on the fly for `TenantContext.run(...)`.
  private readonly tenantCacheTtlMs = 30_000;
  private readonly tenantCache = new Map<
    string,
    { value: TenantInfo | null; expiresAt: number }
  >();

  private sweeping = false;

  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => WorkflowEngineService))
    private readonly engine: WorkflowEngineService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  // Cron entry point
  // ─────────────────────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweepExpiredWaits(): Promise<void> {
    if (!this.enabled) return;
    if (this.sweeping) return; // serialize self
    this.sweeping = true;
    try {
      const handled = await this.sweepOnce();
      if (handled > 0) {
        this.log.debug(
          `workflow-wait-sweeper processed ${handled} expired link(s)`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`workflow-wait-sweeper failed: ${message}`);
    } finally {
      this.sweeping = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Sweep (single pass) — public so tests can drive it deterministically.
  // ─────────────────────────────────────────────────────────────────────

  async sweepOnce(): Promise<number> {
    // Step 1: SELECT candidates. Filters match the `idx_wil_waiting`
    // partial index shape (resolved_at IS NULL AND spawn_mode = 'wait')
    // plus the timeout predicate. `wait_timeout_at <= now()` is expressed
    // via `.lte('wait_timeout_at', <iso>)`; the iso snapshot is a
    // small race window (could miss a few rows that expire mid-query)
    // — the next sweep picks them up. The PER-ROW UPDATE re-checks
    // `wait_timeout_at <= now()` at write time so a stale `nowIso`
    // can't cause a premature claim either.
    const nowIso = new Date().toISOString();
    const candidatesRes = await this.supabase.admin
      .from('workflow_instance_links')
      .select(
        'id, tenant_id, parent_instance_id, parent_node_id, on_timeout_branch, child_entity_kind, child_entity_id, wait_timeout_at',
      )
      .is('resolved_at', null)
      .eq('spawn_mode', 'wait')
      .is('aggregation_group_id', null) // multi-spawn aggregation deferred (§9.3)
      .not('wait_timeout_at', 'is', null)
      .lte('wait_timeout_at', nowIso)
      .order('wait_timeout_at', { ascending: true })
      .limit(this.batchSize);

    if (candidatesRes.error) {
      throw new Error(
        `workflow-wait-sweeper.candidates_failed: ${candidatesRes.error.message}`,
      );
    }

    const candidates = (candidatesRes.data ?? []) as Array<{
      id: string;
      tenant_id: string;
      parent_instance_id: string;
      parent_node_id: string;
      on_timeout_branch: string | null;
      child_entity_kind: 'case' | 'work_order' | 'booking';
      child_entity_id: string;
      wait_timeout_at: string;
    }>;

    if (candidates.length === 0) return 0;

    let handled = 0;

    for (const link of candidates) {
      try {
        const claimed = await this.processOne(link);
        if (claimed) handled++;
      } catch (err) {
        // Per-row defense: one transient failure (DB blip, engine
        // throw, unclaim error) must NOT abort the loop. The next
        // sweep retries this link (resolved_at still null after
        // unclaim, or the row stays claimed and ops eventually sees
        // it on a stale-claim audit query).
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(
          `workflow-wait-sweeper: per-link failure link=${link.id} parent=${link.parent_instance_id}: ${message}`,
        );
      }
    }

    return handled;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Per-row processing
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Process one expired link. Returns `true` if the claim landed (and
   * the resume call was attempted), `false` if another worker / the
   * Tier 2 handler beat us to it.
   *
   * On resume failure: unclaim the row so the next sweep retries.
   */
  private async processOne(link: {
    id: string;
    tenant_id: string;
    parent_instance_id: string;
    parent_node_id: string;
    on_timeout_branch: string | null;
    child_entity_kind: 'case' | 'work_order' | 'booking';
    child_entity_id: string;
    wait_timeout_at: string;
  }): Promise<boolean> {
    // Step 2: Atomic per-row claim. The WHERE includes the SAME
    // `wait_timeout_at IS NOT NULL AND wait_timeout_at <= now()`
    // predicate so a wait extended (or a wake that flipped
    // resolved_at) between SELECT and UPDATE results in zero rows
    // updated. supabase-js doesn't expose a fluent `column <= now()`
    // builder; .lte with an ISO string captured AT UPDATE TIME is
    // the same SQL semantics for the `<=` check (using the request's
    // now() is the trade — a microsecond window between TS clock and
    // DB clock is bounded by the existing 30s poll cadence anyway).
    const claimNowIso = new Date().toISOString();
    const claimRes = await this.supabase.admin
      .from('workflow_instance_links')
      .update({
        resolved_at: claimNowIso,
        resolution_kind: 'timeout',
      })
      .eq('id', link.id)
      .eq('tenant_id', link.tenant_id)
      .is('resolved_at', null)
      .not('wait_timeout_at', 'is', null)
      .lte('wait_timeout_at', claimNowIso)
      .select('id');

    if (claimRes.error) {
      throw new Error(
        `workflow-wait-sweeper.claim_failed: link=${link.id} parent=${link.parent_instance_id}: ${claimRes.error.message}`,
      );
    }
    if (!claimRes.data || claimRes.data.length === 0) {
      // Another worker won the race — Tier 2 wake handler resolved
      // it as `condition_met`, or a sibling sweep instance claimed
      // it first, or the wait was extended between SELECT and
      // UPDATE. Skip silently.
      this.log.debug(
        `workflow-wait-sweeper: link_already_resolved link=${link.id} parent=${link.parent_instance_id} (concurrent worker or extended wait)`,
      );
      return false;
    }

    // Step 3: Parent tenant assertion (defense-in-depth — the link
    // table's tenant trigger covers INSERTs but not hypothetical
    // post-INSERT row mutation).
    const parentRes = await this.supabase.admin
      .from('workflow_instances')
      .select('id, tenant_id')
      .eq('id', link.parent_instance_id)
      .maybeSingle();

    if (parentRes.error) {
      // Transient — unclaim so the next sweep retries.
      await this.unclaim(link, parentRes.error.message);
      throw new Error(
        `workflow-wait-sweeper.parent_read_failed: link=${link.id} parent=${link.parent_instance_id}: ${parentRes.error.message}`,
      );
    }
    if (!parentRes.data) {
      // Parent gone (CASCADE removed it between claim + read). The
      // link FK has ON DELETE CASCADE (00370:87-88) so a deleted
      // parent normally takes the link with it — reaching here means
      // the deletion happened AFTER our claim's snapshot. The claim
      // is permanent (resolved_at set), and the link row will be
      // gone the moment the CASCADE catches up. Don't unclaim, don't
      // resume; log and move on.
      this.log.warn(
        `workflow-wait-sweeper: parent_instance_missing link=${link.id} parent=${link.parent_instance_id}`,
      );
      return true;
    }

    const parentRow = parentRes.data as { id: string; tenant_id: string };
    if (parentRow.tenant_id !== link.tenant_id) {
      // Cross-tenant — terminal corruption. Don't unclaim (keeps
      // the row out of further sweeps); log error so ops sees it
      // immediately. The link row's tenant_id was already trusted
      // by the SELECT; mismatch here is hand-rolled SQL surgery
      // territory.
      this.log.error(
        `workflow-wait-sweeper.parent_tenant_mismatch: link=${link.id} parent=${link.parent_instance_id} link.tenant_id=${link.tenant_id} parent.tenant_id=${parentRow.tenant_id}`,
      );
      return true;
    }

    // Step 3.5: Resolve TenantInfo for TenantContext.run(...).
    const tenant = await this.loadTenant(link.tenant_id);
    if (!tenant) {
      // Tenant row vanished — also terminal corruption. Log + leave
      // the claim in place.
      this.log.error(
        `workflow-wait-sweeper.tenant_not_found: link=${link.id} tenant=${link.tenant_id}`,
      );
      return true;
    }

    // Step 4 + 5: Emit `link_resolved` audit event and resume on
    // the timeout branch.
    //
    // Codex IMPORTANT 1 remediation (2026-05-12 Phase 1.C): when
    // on_timeout_branch is null we now FAIL CLOSED. Previously the cron
    // resumed the parent with `branch=undefined`, which fell through to
    // `edges[0]` in engine.advance() — fail-OPEN, silently taking
    // whatever edge happened to be authored first. Spec §3.4 (line 650)
    // says on_timeout_branch is REQUIRED when wait_timeout_at is set;
    // resuming on edges[0] hides the misconfiguration.
    //
    // Fail-closed shape:
    //   - Do NOT call engine.resume.
    //   - LEAVE the link claimed (resolved_at + resolution_kind already
    //     set above) so the cron does NOT re-attempt every 30s.
    //   - Emit `link_pending_entity_cancel` with reason
    //     `on_timeout_branch_null_resume_skipped` so the misconfiguration
    //     surfaces in the timeline + ops queries.
    //   - Log error-level (not warn) — this is a hard misconfiguration
    //     requiring ops triage. Phase 2's editor validator will reject
    //     the misconfig at save time.
    //
    // Return `true` so the outer loop counts this as "handled" (the
    // claim landed; we're deliberately not resuming).
    if (link.on_timeout_branch === null) {
      this.log.error(
        `workflow-wait-sweeper: on_timeout_branch_null_resume_skipped link=${link.id} parent=${link.parent_instance_id} parent_node=${link.parent_node_id} — link left claimed; ops triage required`,
      );
      try {
        await TenantContext.run(tenant, async () => {
          await this.engine.emitForCron(link.parent_instance_id, 'link_pending_entity_cancel', {
            payload: {
              link_id: link.id,
              parent_instance_id: link.parent_instance_id,
              parent_node_id: link.parent_node_id,
              child_entity_kind: link.child_entity_kind,
              child_entity_id: link.child_entity_id,
              reason: 'on_timeout_branch_null_resume_skipped',
            },
          });
        });
      } catch (emitErr) {
        // Best-effort emit; the link is already claimed and the error
        // log above is the load-bearing alert.
        this.log.error(
          `workflow-wait-sweeper: misconfig_emit_failed link=${link.id} error="${(emitErr as Error).message}"`,
        );
      }
      return true;
    }

    // Past this point, link.on_timeout_branch is guaranteed non-null
    // (the early-return above handled the null case). Capture it in
    // a const so TS narrows the type.
    const branch = link.on_timeout_branch;

    try {
      await TenantContext.run(tenant, async () => {
        // Emit the audit row first so the timeline shows "link
        // resolved (timeout)" before "instance resumed".
        await this.engine.emitForCron(link.parent_instance_id, 'link_resolved', {
          payload: {
            link_id: link.id,
            parent_instance_id: link.parent_instance_id,
            child_entity_kind: link.child_entity_kind,
            child_entity_id: link.child_entity_id,
            resolution_kind: 'timeout',
          },
        });
        await this.engine.resume(
          link.parent_instance_id,
          link.tenant_id,
          branch ?? undefined,
        );
      });

      this.log.log(
        `workflow-wait-sweeper: resumed link=${link.id} parent=${link.parent_instance_id} branch=${branch}`,
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(
        `workflow-wait-sweeper.resume_failed: link=${link.id} parent=${link.parent_instance_id}: ${message}`,
      );
      // Step 6: Unclaim so the next sweep retries this row.
      await this.unclaim(link, message);
      throw err instanceof Error ? err : new Error(message);
    }
  }

  /**
   * Unclaim the row — set resolved_at + resolution_kind back to NULL.
   * If the unclaim itself fails, log + continue (the row sits in
   * claimed-but-not-resumed state; ops can detect this via a query
   * for `resolved_at IS NOT NULL AND resolution_kind = 'timeout'`
   * with no corresponding `instance_resumed` event).
   */
  private async unclaim(
    link: { id: string; tenant_id: string; parent_instance_id: string },
    resumeError: string,
  ): Promise<void> {
    // Plan-review remediation: explicit tenant_id filter on the unclaim
    // (every other write to workflow_instance_links carries this
    // belt-and-suspenders defense). Under supabase.admin (RLS bypassed),
    // a typo or test-fixture confusion in link.id could otherwise mutate
    // a different tenant's row.
    const unclaimRes = await this.supabase.admin
      .from('workflow_instance_links')
      .update({ resolved_at: null, resolution_kind: null })
      .eq('id', link.id)
      .eq('tenant_id', link.tenant_id);

    if (unclaimRes.error) {
      this.log.error(
        `workflow-wait-sweeper.unclaim_failed: link=${link.id} parent=${link.parent_instance_id} resume_error="${resumeError}" unclaim_error="${unclaimRes.error.message}" — link stranded; ops triage required`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Tenant cache
  // ─────────────────────────────────────────────────────────────────────

  private async loadTenant(tenantId: string): Promise<TenantInfo | null> {
    const cached = this.tenantCache.get(tenantId);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;

    const tenantRes = await this.supabase.admin
      .from('tenants')
      .select('id, slug, tier')
      .eq('id', tenantId)
      .maybeSingle();

    let value: TenantInfo | null = null;
    if (tenantRes.data) {
      const row = tenantRes.data as {
        id: string;
        slug: string;
        tier: string;
      };
      value = {
        id: row.id,
        slug: row.slug,
        tier: row.tier === 'enterprise' ? 'enterprise' : 'standard',
      };
    }
    this.tenantCache.set(tenantId, {
      value,
      expiresAt: now + this.tenantCacheTtlMs,
    });
    return value;
  }

  /** Test-only — flush the tenant cache to simulate tenant mutations. */
  clearTenantCacheForTest(): void {
    this.tenantCache.clear();
  }
}
