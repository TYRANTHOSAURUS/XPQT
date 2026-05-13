# Phase 1.5 — Visual Approval Workflow Plan

**Status:** v4 LOCKED — Checkpoint-1 plan-review complete after 4 rounds (3 codex + 1 self). Implementation in flight.

**v4 → impl-time slot bumps (2026-05-13):** v4 originally allocated migrations 00382 + 00383. The migration sequence has bumped twice during implementation:

1. **First bump (early 2026-05-13):** planning-board cleanup consumed 00382 (`work_orders_plan_version.sql`) and 00383 (`update_entity_combined_v6.sql`). Phase 1.5 reclaimed 00399 + 00400.
2. **Second bump (mid 2026-05-13):** the parallel B.4.A.5 workstream (b4a5-step-h, "lift edit-booking gate") claimed slot 00399 (`edit_booking_scope_lift_b4a5_gate.sql`, in flight uncommitted in the working tree) before Phase 1.5 6.B finished writing its migration. **Phase 1.5 now owns 00400 + 00401** in the actual on-disk migration sequence.

**All slot references throughout this document — including the BLOCKER/CRITICAL discussions in §0 — were rewritten in two passes on 2026-05-13** (00382→00399→00400 for the schema migration; 00383→00400→00401 for the grant_booking_approval v2 supersession). The global rewrite makes some §0 phrasing read as if v3 specified 00400 or 00401; that's a rewrite artefact, not history. The real v3→v4 slot bump (which originally renumbered v3's 00381 → v4's 00382) is described in §0's "Migration slots have shifted" bullet, which is the canonical history.

**Parent spec:** [`docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md`](2026-05-12-universal-workflow-architecture-design.md) — §6 (Phase 1.5 row), §7 item 6 (B.4.A.5 gate compatibility), §9.A item 9.5 (locked: pull approval migration forward), §9.B item 3 (gate retirement vs coexistence — open), §9.B item 6 (scope-ceiling mandate). **Parent-spec invariant pulled in by v4: lines 60–67 + 801–808 — "Multi-step writes are PL/pgSQL RPCs, not TS pipelines."**

**Why now:** Phase 1 (engine extension + Tier 2 wake + cancel cascade) is shipped to main. Phase 1.5 is the first real authoring surface for booking-entity workflows; it pressure-tests the universal infra before it fans out across the five spawn directions in Phase 3 (the locked §9.5 reasoning). It is also the smallest greenfield "real customer feature" we can ship on the new infra, so we get signal from real admins before committing further.

---

## Changes from v3 → v4

Closure log against the round-3 codex review (2 BLOCKERS + 4 CRITICAL + 1 IMPORTANT). v4 ran **self-full-review BEFORE codex this time** per `feedback_self_review_in_long_spec_loops.md`.

**BLOCKER 1 — `ensureForRule()` TS multi-write violates parent spec invariant.** v3's `ensureForRule()` shape: `SELECT MAX(version) → INSERT new definition → UPDATE prior to status='archived' → UPDATE rule.workflow_definition_id`. Four separate supabase-js calls. Parent spec (2026-05-12-universal-workflow-architecture-design.md:60-67, :801-808) + project CLAUDE.md ("Multi-step writes are PL/pgSQL RPCs, not TS pipelines") forbid this shape — concurrent admin edits race on `MAX(version)`, a TS-side failure between the second INSERT and the third UPDATE leaves half-committed state, and the audit trail spans two write contexts. **Closure:** v4 moves the entire dance into a PL/pgSQL RPC `public.ensure_room_booking_rule_workflow_definition(p_rule_id uuid, p_tenant_id uuid, p_graph_definition jsonb)`. Body: `SELECT … FROM room_booking_rules WHERE id=p_rule_id AND tenant_id=p_tenant_id FOR UPDATE` (acquires row lock), then `SELECT COALESCE(MAX(version),0)+1` (under the lock — race-free), then INSERT new definition row, then UPDATE prior rows for the same `source_rule_id` to `status='archived'` WHERE no in-flight instance references them, then UPDATE the rule's FK, then RETURN the new id. All five steps in one transaction. TS-side `ApprovalConfigCompilerService` becomes **pure compile-only** (ApprovalConfig → graph_definition jsonb); persistence atomicity lives in Postgres. Ships in 00400 alongside the schema changes. Updates §2.6.5, §2.6.6, §6.A.X, §6.B, §6.E. Concurrent-update test added to §7.2. **R4 (the risk-register item that previously claimed SERIALIZABLE-isolation handled this) is rewritten — RPC + row-lock is the closure, not a TS-side isolation level.**

**BLOCKER 2 — `chain_threshold='any'` double-resolve race under concurrent grants.** v3's 00400 supersession honoured `chain_threshold='any'` but inherited 00310's lock pattern: per-approval advisory lock (00310:86-92) + per-booking advisory lock (00310:155-158). The per-booking advisory lock is acquired AFTER the self-CAS at 00310:137-149. Two approvers grant concurrently on a chain_threshold='any' chain: T1 takes per-approval lock for A, validates state (sibling B is pending), commits CAS on A → 'approved'; meanwhile T2 takes per-approval lock for B (different key — no conflict), validates state (sibling A is pending — T1's UPDATE hasn't released yet OR T2 read snapshot pre-commit), commits CAS on B → 'approved'. Both T1 and T2 then race to take the per-booking lock; the second one through sees BOTH siblings already 'approved' but the v3 'any' branch logic was "skip the count, mark resolve directly" — it didn't re-check whether a sibling already resolved the chain. Result: both T1 and T2 emit `kind='resolved'`, both UPDATE the booking to 'confirmed', both emit `approval.granted`. Double-emit. **Closure:** v4 acquires a **per-booking row lock** (`SELECT id FROM public.bookings WHERE id=v_target_id AND tenant_id=p_tenant_id FOR UPDATE`) at the **top** of the RPC body, BEFORE the self-CAS. Under that lock, re-read sibling state (`select count(*) filter (where status='approved') AS approved_siblings, count(*) filter (where status='pending') AS pending_siblings from public.approvals where tenant_id=p_tenant_id and approval_chain_id=v_approval.approval_chain_id and id != p_approval_id`). For `chain_threshold='any'`: if `approved_siblings > 0` BEFORE this CAS, this row's grant is the loser — perform the CAS on self (to `'approved'`, for correctness of audit) but RETURN `kind='already_resolved'` without re-emitting `approval.granted` and without expiring siblings; the original winner already did. If `approved_siblings = 0`, proceed to resolve: CAS self → 'approved', expire siblings, emit `approval.granted`. The booking-level row lock serialises ALL contenders through one observation point. Updates §2.6, §6.C with explicit RPC body shape. Concurrent-grant probe added to §7.4 smoke + §7.5 concurrency. **R8 rewritten** — the closure is the booking-level row lock + re-observation under it, not advisory locks.

**CRITICAL 3 — `workflow_definitions.source_rule_id` is a tenant-smuggling FK with no trigger.** v3 added tenant triggers on `approvals.workflow_instance_id` and `room_booking_rules.workflow_definition_id` (§3.2 block B) but missed the third FK: `workflow_definitions.source_rule_id`. A service-role write can insert a `workflow_definitions` row in tenant A whose `source_rule_id` points at a `room_booking_rules` row in tenant B, smuggling tenant B's rule id into tenant A's lineage chain. **Closure:** v4 adds a third trigger `assert_workflow_definitions_source_rule_tenant` following the same 00370:205-228 pattern (SECURITY DEFINER + explicit search_path + P0001 errcode). Installed in 00400 alongside the other two. §3.2 block B updated to list all three triggers. §3.4 enumerates all three tenant assertions. §7.1 adds the third-trigger refusal probe.

**CRITICAL 4 — Cancel approval expiry is best-effort post-cancel.** v3 §5.1 + §6.A specified: after the atomic claim in `cancelInstanceById` succeeds, run a TS-side UPDATE on `approvals` to expire linked pending rows. If that second UPDATE fails (network blip, lock conflict, anything), the workflow_instance is `cancelled` but the approvals stay `pending` forever — half-state with no retry. v3 framed this as "non-fatal — log + continue." That's a hand-wave. **Closure:** v4 promotes the cancel+expire pair into one PL/pgSQL RPC `public.cancel_workflow_instance_with_approvals(p_instance_id uuid, p_tenant_id uuid, p_reason text)`. Body wraps: (a) the atomic claim UPDATE on `workflow_instances` with the same `IN ('active','waiting')` filter; (b) on successful claim, the expiry UPDATE on `approvals WHERE workflow_instance_id = p_instance_id AND status='pending' AND tenant_id = p_tenant_id`; (c) the `instance_cancelled` audit emit (insert into workflow_events). Whole thing in one tx — RPC body failure rolls everything back. TS-side `cancelInstanceById` calls the RPC for these three steps then continues with the link cascade enumeration. RPC ships in 00400. **As a backstop**, v4 ALSO schedules a cron sweeper (existing pattern from Phase 1.C `WorkflowWaitSweeperCron`): every 5min, find `approvals` rows whose `workflow_instance_id` references a `workflow_instances.status='cancelled'` row but whose own status is still 'pending', and expire them. Belt-and-suspenders. Updates §5.1 + §6.A. §7 adds fault-injection test (force the approvals UPDATE to fail mid-RPC; verify the workflow_instance status stays 'waiting' — whole tx aborted).

**CRITICAL 5 — Backfill forces `chain_threshold='all'` for parallel_group=NULL rows that today encode threshold='any'.** v3 §3.2 block G sets `chain_threshold='all'` on every pre-existing pending approval. But `booking-flow.service.ts:1180` today writes `parallel_group: config.threshold === 'all' ? 'parallel-${bookingId}' : null` — so **`parallel_group IS NULL` is the today-encoded marker for threshold='any'**. v3's backfill silently rewrites those live threshold='any' chains to `chain_threshold='all'`, changing 00400's resolve semantics under tenants' feet. **Closure:** v4 backfill DERIVES `chain_threshold` from existing row shape, not a flat default. Algorithm (one SQL pass, single CTE, no per-row PL/pgSQL loop):

```sql
with chain_groups as (
  select
    tenant_id,
    target_entity_id,
    parallel_group,                                       -- distinguishes per-group within a target
    coalesce(approval_chain_id, gen_random_uuid()) as chain_id,
    count(*) as group_cardinality
  from public.approvals
  where chain_threshold is null                            -- only rows not already migrated
  group by tenant_id, target_entity_id, parallel_group, approval_chain_id
)
update public.approvals a
   set approval_chain_id = cg.chain_id,
       chain_threshold   = case
         when a.parallel_group is null and cg.group_cardinality > 1 then 'any'
         when a.parallel_group is null and cg.group_cardinality = 1 then 'all'  -- semantically identical for N=1
         else 'all'                                         -- parallel_group IS NOT NULL → today's 'all' encoding
       end
  from chain_groups cg
 where a.tenant_id        = cg.tenant_id
   and a.target_entity_id = cg.target_entity_id
   and a.parallel_group is not distinct from cg.parallel_group
   and (a.approval_chain_id is null or a.chain_threshold is null);
```

The mapping:
- `parallel_group IS NULL` AND >1 approvals in the group → `chain_threshold='any'` (matches today's `createApprovalRows` encoding for threshold='any').
- `parallel_group IS NULL` AND group_cardinality=1 → `chain_threshold='all'` (any-of-1 ≡ all-of-1; pick the deterministic default that 00400's logic shortcuts identically for either).
- `parallel_group IS NOT NULL` → `chain_threshold='all'` (today's encoding for threshold='all').

Each chain emits a NOTICE during 00400 backfill (`RAISE NOTICE 'phase 1.5 chain %: parallel_group=%, group_cardinality=%, derived chain_threshold=%', cg.chain_id, cg.parallel_group, cg.group_cardinality, derived_threshold;`) so tenants can audit post-backfill. Audit SQL probe shipped in §7.2. §3.2 backfill SQL updated with the mapping algorithm. §10 removes the open question (resolved). §7.2 adds backfill-correctness test for the three mapping cases.

**CRITICAL 6 — B.4.A.5's `old_workflow_definition_id` source is wrong for same-rule version bumps.** v3 §5.3 predicate compared `plan.approval.old_workflow_definition_id !== plan.approval.new_workflow_definition_id`, with both ids resolved from the rule resolver at edit time. **The bug:** `assemble-edit-plan.service.ts:730-759` re-runs the rule resolver to derive the OLD chain — but after an admin bumps version on the rule, the rule's `workflow_definition_id` FK now points at the NEW version. The "OLD" lookup reads the NEW version. The predicate sees `new_workflow_definition_id == new_workflow_definition_id` → false-negative on the gate. Bookings (00277:27-) do NOT store `workflow_definition_id`. **Closure:** v4 reads OLD `workflow_definition_id` from the booking's **live `workflow_instance`** — the actual definition the in-flight workflow is running on. Concretely, inside `assemble-edit-plan.service.ts` (and the equivalent surface in `reservation.service.ts:editOne`/`editSlot`):

```typescript
// Phase 1.5 — OLD workflow_definition_id sourcing for B.4.A.5 predicate.
// MUST read from the live workflow_instance, not from the rule. The rule's
// FK reflects the LATEST version after any admin recompile; the in-flight
// instance retains the version that was published when the booking started.
const { data: liveInstance } = await this.supabase.admin
  .from('workflow_instances')
  .select('workflow_definition_id')
  .eq('tenant_id', tenantId)
  .eq('booking_id', bookingId)
  .in('status', ['active', 'waiting'])
  .order('created_at', { ascending: false })
  .limit(1)
  .maybeSingle();

const oldWorkflowDefinitionId: string | null =
  liveInstance?.workflow_definition_id ?? null;
```

If `liveInstance` is non-null, that's the SoT for OLD. If it's null (no in-flight workflow — either the booking pre-dates Phase 1.5, the booking's workflow already completed, or the legacy-rows path was used), fall back to `currentMatchedRule.workflow_definition_id` — there's no in-flight comparison to false-negative on. NEW continues to come from re-resolving the rule against the post-edit booking shape. Compare. Differ → 422 `booking.edit_requires_notification_dispatch`. §5.3 updated with explicit SQL + fallback. §7.3 adds the rule-version-bump-during-in-flight case as a first-class scenario.

**IMPORTANT 7 — Start path must reject archived definitions.** v3 left `WorkflowEngineService.startForTicket` (workflow-engine.service.ts:888-895) filtering only by id+tenant. With `status='archived'` now a real state (BLOCKER 1 of v3 added it), a freshly-archived definition could still be `start()`-ed by a delayed handler or a race. resume() at :1689-1695 stays status-agnostic — in-flight instances on archived definitions must continue to advance, the immutable-graph invariant requires it — but the **start path** should refuse to spawn a new instance on an archived definition. **Closure:** the new `WorkflowEngineService.startForBooking(bookingId, definitionId)` and the existing `startForTicket(ticketId, definitionId)` both add `.eq('status', 'published')` to the SELECT. If the definition is `draft`/`archived`, raise `workflow.definition_not_published` (5-site error registration). resume() unchanged. §6.A.Y + §6.A updated. New error code added to §6.C registration list.

---

**Discipline notes for v4 (per `feedback_self_review_in_long_spec_loops.md`):**

- Self-full-review ran BEFORE this v4 lands at codex. v3 skipped this and codex caught 7 findings; v4 should land tighter.
- Every file:line citation in v4 was re-verified against `main` HEAD post-3bea158a on 2026-05-12 (the working-directory HEAD). Verification log at the bottom of the citation index.
- AppError + 5-site registration discipline for ALL new error codes (now 7: the 5 from v3 + `workflow.definition_not_published` + `workflow.cancel_with_approvals_failed`).
- tenant_id treatment audited on every new column, index, trigger, and RPC parameter.
- §10 removes the resolved open question 7 (chain_threshold backfill — now closed by CRITICAL 5 algorithm); adds new open questions only where genuinely open.
- **Migration slots have shifted (again, and again).** Between v3 plan-review and v4 plan-lock, 00381 was taken by `00381_planning_smoke_requester_seed.sql`; v4 originally allocated 00382 + 00383. Between v4 plan-lock (2026-05-12) and implementation kickoff (2026-05-13), the planning-board cleanup workstream consumed 00382 (`work_orders_plan_version.sql`) and 00383 (`update_entity_combined_v6.sql`). **Implementation-time allocation: 00400 = schema + backfill + tenant triggers + ensure-RPC + cancel-with-approvals RPC, 00401 = grant_booking_approval v2 supersession.** All operational references in §3, §6, §10, citation index rewritten 00382→00400, 00383→00401 by the impl-time bump pass; the v3→v4 BLOCKER/CRITICAL discussions above retain their original slot framing for clarity of the round-3-codex review trail. Latest-prefix discipline maintained.
- **Estimate revised UP again.** v3 → 4-5w. **v4 → 5-6w.** Reasons documented at the close of §6: (a) `ensureForRule` promotion from TS to PL/pgSQL RPC; (b) `cancel_workflow_instance_with_approvals` RPC + backstop cron; (c) backfill mapping algorithm with three semantic cases; (d) booking-level row lock + concurrent-grant probes; (e) `old_workflow_definition_id` source change + the two new test cases; (f) `workflow.definition_not_published` 5-site registration + start-path gate. Honest, not gold-plated.

---

## 0. Scope contract

### 0.1 Problem statement

Today `public.room_booking_rules.approval_config jsonb` (00121_room_booking_rules.sql:14) carries opaque hand-edited JSON that is consumed by `BookingFlowService.createApprovalRows` (booking-flow.service.ts:1173-1194) to insert rows into `public.approvals`. **What this approach cannot deliver and the visual workflow can:**

- **Audit trail of the approver topology itself.** Today `room_booking_rule_versions` (00121:38-49) snapshots the whole rule row; there is no node-level diff. Workflow_definitions are versioned objects (Phase 0 schema), and the published graph is the audit unit. v4's `source_rule_id` + `version` makes the lineage explicit.
- **Idempotent re-deploy on edit.** Today an admin edit to `approval_config` mutates the live JSONB; any in-flight booking referencing it sees the new shape next read. Workflow_definitions are immutable post-publish — in-flight instances stay on the published version they started on (the "wait-config-freeze" invariant from parent spec §0.1 carries through). v4's per-rule-version definition rows make this safe: a rule update mints a NEW definition row + flips the rule's FK; in-flight instances retain their old `workflow_definition_id` reference and the engine continues to advance them.
- **Visual preview and admin re-authoring** (Phase 4 — beyond JSONB hand-editing).
- **A polymorphic surface for service_rules / bundle_approvals / order_approvals** to re-use later (sibling specs — see §0.3).
- **Extensibility for Phase 2/3 spawn directions.** The universal workflow architecture's value is composability — once approvals run on workflow_instances, the same authoring surface fans out across the five spawn directions. Phase 1.5 is the first real consumer.

Phase 1.5 replaces the JSONB carrier with a polymorphic-booking visual workflow definition, and rewires the consumer to start a workflow instance whose `approval` node inserts approval rows. The visual workflow IS the approver-topology authoring surface from this phase forward.

### 0.2 IN scope (Phase 1.5)

1. **Single-rule, single-stage approval** semantics — the EXACT current `ApprovalConfig` shape (`{ required_approvers: Array<{ type: 'team' | 'person'; id: string }>; threshold: 'all' | 'any' }` per `apps/api/src/modules/room-booking-rules/dto/index.ts:24-27`).
2. **Forward link** from `room_booking_rules` to a new `workflow_definition_id uuid` column on the rule row, defaulting to NULL. When NULL, runtime falls back to the legacy `approval_config` reader path. Backfilled rules carry the FK; admin-authored new rules also carry the FK via the new `ensure_room_booking_rule_workflow_definition` RPC (see §2.6.5).
3. **Per-rule-version definition rows.** `workflow_definitions` gains `source_rule_id uuid NULL REFERENCES room_booking_rules(id) ON DELETE SET NULL` + reuses existing `version integer` + `status` CHECK widened to include `'archived'`. Unique index on `(tenant_id, source_rule_id, version) WHERE source_rule_id IS NOT NULL`. Migration 00400.
4. **Threshold='any' semantics on the resolve path.** Migration 00400 adds `approvals.chain_threshold text NOT NULL DEFAULT 'all' CHECK (chain_threshold IN ('all','any'))`. Migration 00401 supersedes `grant_booking_approval` to honour the threshold — `'all'` keeps current semantics; `'any'` resolves on first approve + expires siblings; **all done under a per-booking row lock** that serialises double-resolve attempts (BLOCKER 2 closure). Backfill DERIVES `chain_threshold` from existing row shape (CRITICAL 5 closure).
5. **Backfill migration (00400)** producing one `workflow_definitions` row (`version=1`) per `room_booking_rules` row with a non-null `approval_config`. Definitions are `entity_type='booking'`, `status='published'`, `source_rule_id=rule.id`, owned by the rule's `tenant_id`, immutable-as-Phase-1-engine-requires.
6. **Atomic auto-recompile via PL/pgSQL RPC** (BLOCKER 1 closure). `ensure_room_booking_rule_workflow_definition(p_rule_id, p_tenant_id, p_graph_definition)` acquires a row lock on the rule, computes the next version under the lock, inserts the new definition, archives prior versions safe to archive, and flips the rule's FK — one transaction. Ships in 00400.
7. **Atomic cancel-with-approvals via PL/pgSQL RPC** (CRITICAL 4 closure). `cancel_workflow_instance_with_approvals(p_instance_id, p_tenant_id, p_reason)` wraps the workflow_instance claim + approvals expiry + audit emit in one tx. Plus a backstop cron sweeper following the Phase 1.C `WorkflowWaitSweeperCron` pattern.
8. **Consumer cutover** at `booking-flow.service.ts:359-360`: if the matched rule has a `workflow_definition_id`, start a workflow_instance (entity_kind='booking', booking_id=the new booking) AND skip the legacy `createApprovalRows`. The workflow's `approval` node inserts the approval row(s). If the rule does NOT carry a `workflow_definition_id`, fall through to `createApprovalRows` (legacy path). Both shapes coexist until the legacy column is dropped in a follow-up spec.
9. **`resume()` polymorphization in place** (Option C extended — workflow-engine.service.ts:1645-1719). Same signature; the claim returns polymorphic ids; `advance()` is called with the right entity id for the instance's `entity_kind`. Existing case-kind path unchanged in behaviour.
10. **`startForBooking` + start-path archived-definition refusal** (IMPORTANT 7 closure). Both `startForBooking` (new) and `startForTicket` (existing) add `.eq('status', 'published')` to the definition SELECT. resume() unchanged.
11. **Cancel cascade extension via the new RPC** (CRITICAL 4 closure). `cancelInstanceById` delegates the claim + approvals expiry + emit to the new RPC.
12. **B.4.A.5 gate** decision: **COEXIST** (see §4) — gate stays as a defense-in-depth boundary, predicate UPDATED to compare `workflow_definition_id` where the OLD id is sourced from the live `workflow_instance` (CRITICAL 6 closure), not from the rule's current FK (see §5.3).
13. **Editor surfaces** for the approval-relevant node types: `approval` (existing, polymorphized for booking-entity context — see §2.4). No new node-type primitives. No `notification` node in compiled Phase 1.5 graphs. No `condition` node.
14. **Smoke probe** for the create→workflow→grant→advance pipeline (`pnpm smoke:visual-approval`). 16 probes minimum (v3's 14 + the two new ones for concurrent-grant + archived-definition rejection).

### 0.3 OUT of scope (deferred — sibling spec or future phase)

Explicit enumeration per §9.B item 6 (the scope-ceiling mandate). The temptation while pulling approval forward is "while we're here, let's also..." — these are the things we refuse:

- **`notification` node in the Phase 1.5 compiled graph.** Deferred to a future spec when the workflow's notification executor is polymorphized AND its `{subject, body}` validator is reconciled with template-driven dispatch. Closure of v2's BLOCKER 2 part 2 (carried forward). Phase 1.5 ships state tracking + post-resolution advance; notification stays on the legacy TS path (`booking-flow.service.ts:382-388` for create; `approval.service.ts:847-871` for resolve).
- **Handler graduation for `booking-approval-required.handler.ts`.** v2's sub-step 6.F stays deleted. The handler stays a B.4.A.4 stub. It graduates in the same sibling spec that polymorphizes the notification executor.
- **`service_rules.approval_config` migration.** `apps/api/src/modules/service-catalog/service-rule.service.ts:185` carries an identical JSONB shape on a different table. Sibling spec after Phase 1.5 ships. The compiler service shipped in Phase 1.5 (`ApprovalConfigCompilerService`) accepts a `rule_type` discriminator so the sibling spec can reuse it without forking.
- **`approval_routing_rules`** (separate JSONB used by booking_bundles / orders). Separate consumer, separate scope.
- **Multi-stage / sequential / quorum / escalation** approval primitives. Strictly outside Phase 1.5 — sibling spec.
- **UI authoring of approval workflows** (the visual editor surfaces in admin). Phase 1.5 ships READ + EXECUTE on visual approval workflows; full authoring UX is Phase 4 per parent spec §6. Admins can still edit `approval_config` on the rule (legacy JSONB path); the auto-recompile in §2.6.5 produces a new workflow_definition + supersedes the prior one via the atomic RPC.
- **Retiring the legacy `room_booking_rules.approval_config` jsonb column.** The column lives until 100% of in-flight rules carry `workflow_definition_id` AND notification dispatch unification ships. Drop is a follow-up migration.
- **B.4.A.5 gate retirement.** The 422 stays. Replace it in a sibling spec once notification dispatch is unified.
- **`service_rules` consumer path, ticket-side approval workflows, bundle/order approvals.** Same model, different surface — sibling specs each.
- **Cross-tenant approval-template sharing.** Each tenant gets its own workflow_definitions rows.
- **Phase 1.B.x — full executeNode/advance signature rename to (entityKind, entityId).** Phase 1.5 ships the resume() polymorphization (Option C+ in §2.4); the executeNode/advance signature rename is its own future slice when work_order workflows also need it.
- **Template strategy for `booking.approval_resolved`.** Deferred — workflow doesn't fire notifications, so no template is needed in Phase 1.5.

### 0.4 Scope ceiling

If during plan-review or implementation a reviewer says "while you're at it, also support X", the answer is: **add X to a sibling spec, ship Phase 1.5 with the locked enumeration above.** This is per §9.B item 6.

---

## 1. Current state survey

All citations re-verified against `main` HEAD post-3bea158a on 2026-05-12.

### 1.1 Shape of `room_booking_rules.approval_config`

**Schema.** `supabase/migrations/00121_room_booking_rules.sql:14`:

```sql
approval_config jsonb,  -- {required_approvers, threshold} when effect='require_approval'
```

**TypeScript type.** `apps/api/src/modules/room-booking-rules/dto/index.ts:24-27`:

```typescript
export interface ApprovalConfig {
  required_approvers?: Array<{ type: 'team' | 'person'; id: string }>;
  threshold?: 'all' | 'any';
}
```

**Seed examples.** From `supabase/migrations/00133_seed_room_booking_examples.sql`:

- :70 — `'{"required_approvers":[{"type":"person","id":"95000000-...-007"}],"threshold":"any"}'`
- :99 — `'{"required_approvers":[{"type":"person","id":"95000000-...-004"}],"threshold":"any"}'`

**Template participation.** `apps/api/src/modules/room-booking-rules/rule-templates.ts:18` exposes `'approval_config'` as a first-class template param type; templates that surface it: `off_hours_need_approval` :131, `capacity_tolerance` :236, `long_bookings_need_manager_approval` :286, `high_capacity_needs_vp_approval` :308.

The actual product surface today is intentionally tiny — **no nesting, no stages, no expressions.**

### 1.2 Consumer path

`apps/api/src/modules/reservations/booking-flow.service.ts:359-360`:

```typescript
if (status === 'pending_approval' && ruleOutcome.approvalConfig) {
  await this.createApprovalRows(bookingId, ruleOutcome.approvalConfig, tenantId);
}
```

The matched rule's `approvalConfig` (resolved by `RuleResolverService` at `apps/api/src/modules/room-booking-rules/rule-resolver.service.ts:514`) flows in as a plain object. `createApprovalRows` (booking-flow.service.ts:1173-1194) is straight inserts into `public.approvals`:

```typescript
target_entity_type: 'booking',
target_entity_id: bookingId,
parallel_group: config.threshold === 'all' ? `parallel-${bookingId}` : null,
approver_person_id: a.type === 'person' ? a.id : null,
approver_team_id:  a.type === 'team'   ? a.id : null,
status: 'pending',
```

**`parallel_group IS NULL` is today's marker for threshold='any'.** Read CRITICAL 5 closure (v3→v4 changes) for why this matters for backfill correctness.

**Notification fires** at `booking-flow.service.ts:382-388` — `this.notifications.onApprovalRequested(reservation, ruleOutcome.approvalConfig)`. Fire-and-forget. **This stays as-is in Phase 1.5** (CRITICAL 5 of v2 closure carried forward: workflow does NOT notify; legacy path is the sole owner).

**Handler reality (B.4.A.4 stub).** `apps/api/src/modules/outbox/handlers/booking-approval-required.handler.ts` is a v1 stub. v4 leaves it as a stub — handler graduation deferred to the sibling notification-unification spec.

### 1.3 Approval grant — case-kind discriminator + onApprovalDecided owner

Verified in `apps/api/src/modules/approval/approval.service.ts`:

- **`:510-518`** — `if (approval.target_entity_type === 'booking')` → `grantBookingApproval` (RPC 00310 → v4 supersedes via 00401).
- **`:532-540`** — `if (approval.target_entity_type === 'ticket')` → `grantTicketApproval` (RPC 00356).
- **`:610-624`** — visitor_invite branch.
- **`:802-879`** — `grantBookingApproval` method body. **:847-871** — post-RPC `onApprovalDecided` fan-out on `result.kind === 'resolved'`. **This stays Phase 1.5's sole owner of resolve-notifications** (v2 CRITICAL 5 closure carried forward).

`target_entity_type` CHECK is at `supabase/migrations/00278_retarget_sibling_tables.sql:165-171` (∈ `('booking','order','ticket','visitor_invite')`).

### 1.4 Workflow engine approval node — exists, lightly hardcoded to case

`apps/api/src/modules/workflow/workflow-engine.service.ts:1283-1352` is the `approval` case in the executor. It (a) tenant-validates `approver_person_id` / `approver_team_id` at :1304-1321, (b) inserts a row into `public.approvals` with `target_entity_type = projectLegacyEntityType(entityKind)` (line :1332), (c) flips the workflow_instance to `status='waiting' waiting_for='approval'`.

**Critical:** line **:1329** hardcodes `const entityKind: WorkflowEntityKind = 'case';`. The Phase 1.A polymorphization (`projectLegacyEntityType` body at :157-159) maps `'case' → 'ticket'`. **For Phase 1.5 to work, the executor must read the running instance's entity_kind so booking-kind workflows insert `target_entity_type='booking'`.** This is one load-bearing engine change for Phase 1.5 (see §2.4).

### 1.5 Engine signature reality (resume + executeNode)

The engine API surface threads `ticketId: string`, NOT `(entityKind, entityId)`. Verified at:

- **`workflow-engine.service.ts:879-923`** — `startForTicket(ticketId, workflowDefinitionId)` inserts `ticket_id: ticketId`. **No status filter on the definition SELECT** (IMPORTANT 7 surface for v4).
- **`workflow-engine.service.ts:925`** — `advance(instanceId, graph, fromNodeId, ticketId: string, edgeCondition?, ctx?)`.
- **`workflow-engine.service.ts:958`** — `executeNode(instanceId, graph, node, ticketId: string, ctx?)`.
- **`workflow-engine.service.ts:1645`** — `async resume(instanceId, tenantId, edgeCondition?)`.
- **`workflow-engine.service.ts:1660-1667`** — resume() atomic claim: `UPDATE ... WHERE status='waiting' RETURNING 'id, workflow_definition_id, current_node_id, ticket_id'`.
- **`workflow-engine.service.ts:1717`** — resume() calls `advance(instanceId, graph, instance.current_node_id, instance.ticket_id, edgeCondition)`.
- **`workflow.service.ts:44-67`** — `WorkflowService.create` exists; no `start({...})` overload.
- **`workflow.service.ts:152`** — `.select('*, definition:workflow_definitions(*)')`.

**v4 polymorphizes resume() in place.** The claim's RETURNING is extended to read all polymorphic id columns + `entity_kind`; the call to `advance()` threads the kind-correct id. No signature change on resume(), advance(), or executeNode(). See §2.4 for the exact code shape; sub-step 6.A ships it.

Phase 1.B (the polymorphization shipped 2026-05-12 in 26e4ed77 / 784d8d9c) polymorphized `cancelInstance` + helpers (`projectLegacyEntityType` at :157-159, `WorkflowEntityKind` at :76, `polymorphicIdColumn` at :91, `cancelInstance` at :209-258, `cancelInstanceById` at :281-498). It did NOT polymorphize executeNode / advance / startForTicket / resume — those still thread `ticketId`. The resume() polymorphization is now part of Phase 1.5; the executeNode/advance signature rename remains deferred.

### 1.6 Notification node — incompatible with Phase 1.5 (locked from v2 BLOCKER 2)

`workflow-engine.service.ts:1130-1153` is the `notification` case executor. It hardcodes `const entityKind: WorkflowEntityKind = 'case';` at :1139, reads `subject` and `body` from `node.config` (:1146-1147) — not `template` or `recipient`. **v4 keeps v3's closure: drop the notification node from the compiled graph entirely.**

### 1.7 Condition node reality (carried forward)

`workflow-engine.service.ts:1155-1188` is the `condition` case executor. Supports `equals` / `not_equals` / `in` only, reads `public.tickets WHERE id = $ticketId`, no approvals-table read, no `all_approved` / `any_approved` predicate. v4 routes around it entirely (see §3.3).

### 1.8 B.4.A.5 gate — where it lives

Three call sites, all throwing `new AppError('booking.edit_requires_notification_dispatch', 422, …)`:

- **`apps/api/src/modules/reservations/reservation.service.ts:1001-1011`** — `editOne` pre-flight predicate.
- **`apps/api/src/modules/reservations/reservation.service.ts:1365-1379`** — `editSlot` pre-flight predicate.
- **`apps/api/src/modules/reservations/assemble-edit-plan.service.ts:593-607`** — per-occurrence scope-edit pre-flight (verified location).

All three evaluate the same predicate:

```typescript
const wouldEmitApprovalRequired =
  plan.approval.new_outcome === 'require_approval' &&
  (plan.approval.old_outcome !== 'require_approval' ||
    plan.approval.chain_config_changed === true);
```

v4's predicate update (§5.3) adds `workflow_definition_id` comparison, with the OLD id sourced from the **live `workflow_instance`** — not the rule's current FK (CRITICAL 6 closure).

### 1.9 grant_booking_approval — threshold='all' semantics + lock topology (BLOCKER 2 verification)

`supabase/migrations/00310_grant_booking_approval_rpc.sql`:

- **:86-92** — per-approval advisory lock (only blocks concurrent grants on the SAME approval row).
- **:98-104** — `select … parallel_group, approval_chain_id, comments, status FOR UPDATE`.
- **:106-109** — refuses with `approval.not_found` on missing row.
- **:114-120** — `kind='non_booking_approved'` branch (non-booking target).
- **:125-131** — `kind='already_responded'` branch (state-machine guard).
- **:137-149** — CAS update on the self approval row.
- **:155-158** — per-booking advisory lock — acquired AFTER the self-CAS. **This is the v3 BLOCKER 2 site.** Two grants on DIFFERENT siblings of the same chain can both commit their self-CAS before either reaches this lock.
- **:162-172** — on rejection: expire all sibling pending approvals.
- **:173-187** — on approve: count siblings `where status in ('pending', 'rejected')`; if > 0 → `kind='partial_approved'`. **All-of-N semantics — no 'any' branch.**
- **:213-216** — `select public.approve_booking_setup_trigger(...)`.
- **:244-253** — `kind='resolved'` branch.

**Verified:** today the RPC fires `kind='resolved'` ONLY when (a) decision='rejected' OR (b) decision='approved' AND no siblings pending/rejected. **No path fires `kind='resolved'` on the first approve of a threshold='any' chain.** v4's 00401 (a) adds the 'any' branch under (b) a per-booking row lock (NOT advisory) acquired BEFORE the self-CAS. See §6.C.

### 1.10 approvals table — existing columns

`supabase/migrations/00012_approvals.sql`:

- :8 — `approval_chain_id uuid` — already exists.
- :10 — `parallel_group text` — already exists.
- :28 — `idx_approvals_chain on (approval_chain_id) where approval_chain_id is not null`.

**v4 ADDS to approvals:** `workflow_instance_id uuid`, `workflow_node_id text`, `chain_threshold text NOT NULL DEFAULT 'all' CHECK (chain_threshold IN ('all','any'))`. Migration 00400. Backfill DERIVES `chain_threshold` from existing row shape (CRITICAL 5 closure).

### 1.11 cancelInstanceById — leaves approvals dangling (v3 IMPORTANT 7 / v4 CRITICAL 4 surface)

`workflow-engine.service.ts:281-498` is the private `cancelInstanceById`. Verified body:

- :292-303 — visited-set short-circuit.
- :305-340 — entity-kind + entityId resolution (polymorphic).
- :346-357 — atomic claim (UPDATE workflow_instances WITH status filter; RETURNING id).
- :377 — `instance_cancelled` audit emit.
- :400-407 — enumerates `workflow_instance_links` for the cascade.
- :408+ — child cascade loop.

**No UPDATE on `approvals`.** Booking-deletion-mid-approval leaves pending approvals dangling. v3 inserted a TS-side UPDATE between the claim and the cascade; v4 moves the claim + UPDATE + emit into one PL/pgSQL RPC (CRITICAL 4 closure). See §6.A.

### 1.12 workflow_definitions schema (v3 BLOCKER 1 + status states for v4 IMPORTANT 7)

`supabase/migrations/00009_workflows.sql:8-13`:

- :8 — `entity_type text not null default 'ticket'` (widened by 00369 to include `'booking'`).
- :9 — `version integer not null default 1`.
- :10 — `status text not null default 'draft' check (status in ('draft', 'published'))`. **No `'archived'` yet.**
- :13 — `published_at timestamptz`.

**v4 needs:** widen the `status` CHECK to `('draft','published','archived')`; add `source_rule_id uuid NULL REFERENCES room_booking_rules(id) ON DELETE SET NULL`; add unique index `(tenant_id, source_rule_id, version) WHERE source_rule_id IS NOT NULL`. The pre-existing `version` column carries the lineage counter — no new column needed for `version`. Migration 00400. **Start path must reject `status != 'published'` rows** (IMPORTANT 7 closure).

### 1.13 Tenant trigger pattern (CRITICAL 3 reference)

`supabase/migrations/00370_workflow_instance_links.sql:205-233` — `assert_workflow_instance_link_tenant`. `SECURITY DEFINER`, `set search_path = public, pg_catalog`, raises explicit `tenant_mismatch_*` exceptions. v4 mirrors this pattern for THREE new FKs (approvals → workflow_instances, room_booking_rules → workflow_definitions, **and workflow_definitions → room_booking_rules via source_rule_id** — CRITICAL 3 closure for the third one).

---

## 2. Target state

### 2.1 Schema decisions

**Decision:** **coexist via a new nullable FK column.** Add `workflow_definition_id uuid REFERENCES workflow_definitions(id) ON DELETE SET NULL` to `room_booking_rules`. Legacy `approval_config jsonb` stays in place during Phase 1.5; drop is a follow-up spec.

**Why coexist not replace:** admin edits to `approval_config` must keep working, and the auto-recompile RPC in §2.6.5 keeps the two columns synchronized. The FK is the SoT signal for the consumer; the JSONB is the human-editable input.

**Workflow_definitions extensions** (v3 BLOCKER 1 closure):
- `source_rule_id uuid NULL REFERENCES room_booking_rules(id) ON DELETE SET NULL` — populated for compiled definitions; NULL for hand-authored definitions (Phase 4).
- `status` CHECK widened to allow `'archived'`. Existing rows stay on their current value (default `'draft'`); seeds at `'published'`.
- Unique index `(tenant_id, source_rule_id, version) WHERE source_rule_id IS NOT NULL` — gives "one row per rule per version".
- `id = gen_random_uuid()` (no v5 derivation).

### 2.2 One workflow_definition row per rule-version

**Decision:** **one workflow_definitions row per (rule, version)** in Phase 1.5.

The rule IS the approver topology authoring surface. Each admin edit to `approval_config` mints a NEW row via the `ensure_room_booking_rule_workflow_definition` PL/pgSQL RPC (BLOCKER 1 closure), which:

1. Acquires a `FOR UPDATE` row lock on the rule (`SELECT … FROM room_booking_rules WHERE id=$p_rule_id AND tenant_id=$p_tenant_id FOR UPDATE`).
2. Under that lock, computes `next_version = COALESCE(MAX(version), 0) + 1 FROM workflow_definitions WHERE source_rule_id = $p_rule_id`.
3. INSERTs the new definition row with `id=gen_random_uuid()`, the computed version, `status='published'`, the provided `graph_definition`.
4. UPDATEs prior `workflow_definitions` rows with the same `source_rule_id` to `status='archived'` WHERE NOT EXISTS (in-flight instance referencing that prior id).
5. UPDATEs `room_booking_rules.workflow_definition_id` to the new id.
6. RETURNs the new id (+ next_version + count of archived predecessors).

In-flight instances stay on their original `workflow_definition_id` (the engine's `resume()` always re-reads the row by id; immutability is preserved). Archived definitions are still readable by `resume()`; only the START path refuses them (IMPORTANT 7 closure).

Sharing a definition across rules is out-of-scope for Phase 1.5. Phase 4 may add "Use existing approval workflow" picker.

### 2.3 Where does the visual workflow live (entity_type)

**Decision:** **`entity_type='booking'`.** `workflow_instances.entity_kind='booking'`, `workflow_instances.booking_id` populated.

Verified infrastructure: `supabase/migrations/00369_workflow_polymorphism_booking.sql` adds `'booking'` to the `workflow_definitions_entity_type_check` CHECK and the corresponding `workflow_instances.entity_kind` CHECK. Same migration adds the `booking_id` polymorphic column with `ON DELETE SET NULL` FK. The Tier 2 wake handler (workflow-spawn-wake.handler.ts) already subscribes to `booking.created` / `booking.cancelled` / `booking.status_changed`. The Phase 1.B cancel cascade (workflow-engine.service.ts:281-498) is polymorphic and handles booking entity_kind correctly (Phase 1.5 EXTENDS it via the new RPC — see §5.1).

**Phase 1.5 needs NO new entity_type.** The infrastructure for booking-kind workflows shipped in Phase 0 + Phase 1.

### 2.4 Engine kind-dispatch decision (Option C+)

**Three options considered (carried from v2):**

**Option A — Full executeNode/advance/resume polymorphization.** Phase 1.5 absorbs the deferred Phase 1.B.x slice. Every call site updates `(entityKind, entityId)`. Massive blast radius.

**Option B — Parallel `startForBooking` / `executeNodeForBooking` / `resumeBooking` code path.** Code duplication ~30-40%.

**Option C+ (LOCKED for v3, carried into v4) — Minimal carve-out + per-executor kind-dispatch + resume() polymorphized in place.**

- **`resume()` polymorphization in place.** The atomic claim's RETURNING (workflow-engine.service.ts:1666) is extended to `id, workflow_definition_id, current_node_id, entity_kind, case_id, work_order_id, booking_id, ticket_id`. The call into `advance()` threads the polymorphic id:

  ```typescript
  // Pseudocode — implementation in 6.A. Current claim selects:
  //   'id, workflow_definition_id, current_node_id, ticket_id'
  // After 6.A:
  //   'id, workflow_definition_id, current_node_id, entity_kind,
  //    case_id, work_order_id, booking_id, ticket_id'
  const entityId =
    instance.entity_kind === 'case'       ? instance.case_id ?? instance.ticket_id
    : instance.entity_kind === 'work_order' ? instance.work_order_id
    : instance.entity_kind === 'booking'    ? instance.booking_id
    : null;
  if (!entityId) {
    throw AppErrors.server('workflow.advance_failed', {
      detail: 'missing polymorphic entityId for instance',
    });
  }
  await this.advance(instanceId, graph, instance.current_node_id, entityId, edgeCondition);
  ```

  `advance()` and `executeNode()` keep `ticketId: string` as the parameter name (mis-named for booking-kind, but the signature rename is the deferred Phase 1.B.x slice). For Phase 1.5, the parameter IS the polymorphic entityId; the only executor that reads it as a ticket is `condition`, and Phase 1.5 doesn't put `condition` nodes in compiled graphs. The `approval` executor reads `getEntityKindForInstance(instanceId)` and uses the result + the threaded entityId to insert the approval row with the right `target_entity_type` / `target_entity_id`.

- **`approval` executor extension.** `workflow-engine.service.ts:1283-1352`. Replaces hardcoded `entityKind='case'` at :1329 with `getEntityKindForInstance(instanceId).kind`. Loops over `node.config.required_approvers` (insert N rows, not 1). Sets `parallel_group`, `approval_chain_id`, `chain_threshold`, `workflow_instance_id`, `workflow_node_id` on each row.

- **No notification executor change.** No condition executor change. No executeNode signature rename. The compiled graphs Phase 1.5 emits never reference `notification` or `condition` nodes (§3.3).

- **Drift mitigation.** Sub-step 6.A adds a convention test asserting any executor calling `.from('approvals').insert(...)` also calls `getEntityKindForInstance(...)`.

### 2.5 Producer / consumer wiring

**Decision:** **synchronously in `BookingFlowService.create()`** — replacing the `createApprovalRows` call site at booking-flow.service.ts:359-360.

```typescript
// Pseudocode (planning only — implementation in 6.E).
if (status === 'pending_approval' && ruleOutcome.approvalConfig) {
  if (ruleOutcome.workflowDefinitionId) {
    // Visual workflow path — sub-step 6.A.Y surface.
    await this.workflowService.start({
      definitionId: ruleOutcome.workflowDefinitionId,
      entityKind: 'booking',
      entityId: bookingId,
      tenantId,
    });
  } else {
    // Legacy fall-through (rules without FK populated).
    await this.createApprovalRows(bookingId, ruleOutcome.approvalConfig, tenantId);
  }
}
// notification fan-out at :382-388 stays UNCONDITIONALLY — both paths fire
// onApprovalRequested. Workflow does NOT notify.
```

Synchronous, not outbox-driven, for two reasons:

1. The user-facing response needs to know whether approval was queued. Synchronous start keeps the response shape stable.
2. Outbox-driven start would conflate "this booking has a workflow" with "this booking is observed by Tier 2 wake handlers".

**RuleResolverService extension.** `MatchedRule` at `apps/api/src/modules/room-booking-rules/rule-resolver.service.ts:52` exposes `approval_config: ApprovalConfig | null`. Phase 1.5 adds sibling field `workflow_definition_id: string | null`, populated from the same row read at :514.

### 2.6 The approval-grant signal — `kind='resolved'` is the wake event (under booking-row lock)

**Verified at 00310:244-253:**

```sql
v_result := jsonb_build_object(
  'kind',                 'resolved',
  'approval_id',          p_approval_id,
  'booking_id',           v_target_id,
  'final_decision',       p_decision,
  ...
);
```

The RPC returns four kinds today: `non_booking_approved`, `already_responded`, `partial_approved`, `resolved`. **v4 extends the 00310 supersession (00401) to:** (a) honour `chain_threshold` for the `'any'` case, (b) serialise all resolution via a **per-booking ROW lock** acquired BEFORE the self-CAS (BLOCKER 2 closure), (c) re-observe sibling state under that lock to short-circuit the loser when a sibling already resolved the chain, (d) emit `outbox.emit('approval.granted', …)` on the `kind='resolved'` branch — and ONLY on that branch (no emit from the new `'already_resolved'` short-circuit path).

**New resolve semantics for chain_threshold='any':**

- Under the per-booking row lock, count `approved_siblings` in the chain (excluding self). If `approved_siblings > 0` BEFORE this CAS → a sibling already resolved the chain → CAS self → 'approved' for audit, RETURN `kind='already_resolved'`, NO sibling expiry (already done), NO `approval.granted` emit (already done).
- If `approved_siblings = 0`: proceed to resolve. CAS self → 'approved'. Expire chain siblings (`status='expired', responded_at=now(), comments='Sibling approved (any-of-N)'`). Emit `approval.granted`. Return `kind='resolved'`.

**Resolve semantics for chain_threshold='all':** unchanged from 00310 (count approach), but evaluated under the same per-booking row lock for symmetry. On rejection (either threshold): keep existing behaviour (cancel booking, expire siblings).

The chain is identified via `approval_chain_id` (existing column, populated by `createApprovalRows` + workflow `approval` executor going forward).

**Phase 1.5 adds:** the `approval.granted` outbox event with `{tenant_id, approval_id, booking_id, final_decision, workflow_instance_id, workflow_node_id}`. The `WorkflowApprovalGrantedHandler` (new — §2.6.4) consumes it, asserts cross-tenant boundary, and calls `WorkflowEngineService.resume(instanceId, tenantId, decision === 'approved' ? 'approved' : 'rejected')`.

#### 2.6.1 New columns on `approvals`

- `workflow_instance_id uuid REFERENCES workflow_instances(id) ON DELETE SET NULL` — nullable. Populated by the engine's `approval` executor when the row is created by an `approval` workflow node; NULL when the row is created by legacy `createApprovalRows`.
- `workflow_node_id text` — nullable. The graph node id within the parent workflow that produced this row.
- `chain_threshold text NOT NULL DEFAULT 'all' CHECK (chain_threshold IN ('all','any'))` — backfill DERIVES from existing row shape per CRITICAL 5 algorithm.

#### 2.6.2 New column on `room_booking_rules`

- `workflow_definition_id uuid REFERENCES workflow_definitions(id) ON DELETE SET NULL` — nullable. Populated by backfill (one-shot for legacy rules) or by the `ensure_room_booking_rule_workflow_definition` RPC on every `.create` / `.update` of a rule with non-null `approval_config`.

#### 2.6.3 Extensions on `workflow_definitions`

- `source_rule_id uuid NULL REFERENCES room_booking_rules(id) ON DELETE SET NULL` — new column. Marks the rule that generated this compiled definition.
- `status` CHECK widened to `('draft','published','archived')`. The 00009:10 check is dropped + re-added.
- Unique index `idx_workflow_definitions_rule_version on (tenant_id, source_rule_id, version) WHERE source_rule_id IS NOT NULL` — gives lineage uniqueness.

#### 2.6.4 New outbox event

- **`approval.granted`** — registered in a new `ApprovalLifecycleEventType` const at `apps/api/src/modules/approval/event-types.ts` (NEW file — sibling to `reservations/event-types.ts:87-132`). Payload typed as `ApprovalLifecyclePayload`.

#### 2.6.5 New outbox handler

- `apps/api/src/modules/outbox/handlers/workflow-approval-granted.handler.ts` (NEW). Calls `WorkflowEngineService.resume(instanceId, tenantId, decision)`. The handler does NOT add its own claim — `resume()`'s internal atomic claim gives idempotency. Tenant defense: rejects with `workflow.tenant_mismatch_approval` if `payload.tenant_id !== event.tenant_id` OR the approval's `workflow_instance_id` points at a foreign-tenant instance.

#### 2.6.6 Service shape — `ApprovalConfigCompilerService` (BLOCKER 1 closure: compile-only)

`apps/api/src/modules/approval/approval-config-compiler.service.ts` (NEW — ships in sub-step 6.A.X, BEFORE the migration that uses its output). **Pure compile only — no persistence.** Persistence lives in the PL/pgSQL `ensure_room_booking_rule_workflow_definition` RPC (§2.6.7).

```typescript
class ApprovalConfigCompilerService {
  compile(args: {
    ruleType: 'room_booking_rule' | 'service_rule';  // sibling-spec hook
    ruleId: string;                                  // for lineage seed
    ruleName: string;                                // for the workflow_definition.name
    tenantId: string;
    approvalConfig: ApprovalConfig;
  }): { graphDefinition: GraphJson; name: string };  // §3.3 shape
  // No async. No DB. No side effects. Pure function — fixture-testable.
}
```

That's the whole service. No `ensureForRule` method. Persistence happens by callers handing the compiled `graphDefinition` to the `ensure_room_booking_rule_workflow_definition` RPC.

#### 2.6.7 New PL/pgSQL RPC — `ensure_room_booking_rule_workflow_definition` (BLOCKER 1 closure)

```sql
create or replace function public.ensure_room_booking_rule_workflow_definition(
  p_rule_id          uuid,
  p_tenant_id        uuid,
  p_graph_definition jsonb,
  p_rule_name        text   default null
) returns table (
  definition_id     uuid,
  version           integer,
  archived_prior_ct integer
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_rule_name        text;
  v_next_version     integer;
  v_new_id           uuid := gen_random_uuid();
  v_archived_ct      integer := 0;
begin
  -- 1. Lock the rule row. Concurrent admin edits serialise here.
  select coalesce(p_rule_name, name)
    into v_rule_name
    from public.room_booking_rules
   where id = p_rule_id
     and tenant_id = p_tenant_id
   for update;
  if not found then
    raise exception 'ensure_workflow_definition: rule % not found in tenant %', p_rule_id, p_tenant_id
      using errcode = 'P0002';
  end if;

  -- 2. Compute next_version under the row lock — race-free.
  select coalesce(max(version), 0) + 1
    into v_next_version
    from public.workflow_definitions
   where source_rule_id = p_rule_id;

  -- 3. Insert the new definition row.
  insert into public.workflow_definitions (
    id, tenant_id, name, entity_type, status, version,
    graph_definition, source_rule_id, published_at, created_at
  )
  values (
    v_new_id, p_tenant_id, 'Approval — ' || v_rule_name,
    'booking', 'published', v_next_version,
    p_graph_definition, p_rule_id, now(), now()
  );

  -- 4. Archive prior versions safe to archive (no in-flight reference).
  with archived as (
    update public.workflow_definitions wd
       set status = 'archived'
     where wd.source_rule_id = p_rule_id
       and wd.tenant_id = p_tenant_id
       and wd.id != v_new_id
       and wd.status = 'published'
       and not exists (
         select 1
           from public.workflow_instances wi
          where wi.workflow_definition_id = wd.id
            and wi.tenant_id = p_tenant_id
            and wi.status in ('active','waiting')
       )
    returning wd.id
  )
  select count(*) into v_archived_ct from archived;

  -- 5. Flip the rule's FK.
  update public.room_booking_rules
     set workflow_definition_id = v_new_id
   where id = p_rule_id
     and tenant_id = p_tenant_id;

  return query select v_new_id, v_next_version, v_archived_ct;
end $$;

revoke execute on function public.ensure_room_booking_rule_workflow_definition(uuid, uuid, jsonb, text) from public;
grant  execute on function public.ensure_room_booking_rule_workflow_definition(uuid, uuid, jsonb, text) to service_role;
```

**Called from:**
- `RoomBookingRulesService.create` (room-booking-rules.service.ts:101-137) — after the insert succeeds, if `approval_config` is non-null: TS compiles the graph via `ApprovalConfigCompilerService.compile(...)`, then calls the RPC `ensure_room_booking_rule_workflow_definition(rule_id, tenant_id, graph_definition, rule_name)`.
- `RoomBookingRulesService.update` (room-booking-rules.service.ts:139-) — same shape when the patch changes `approval_config`.
- Migration 00400 backfill — calls the RPC directly inside the migration's backfill block (the same RPC; one tx; no separate PL/pgSQL helper function needed — the RPC IS the helper). One-shot backfill loops over rules and calls the RPC per rule.

**Why an RPC, not TS:** parent-spec invariant + project CLAUDE.md mandate that corruptible multi-step writes live in Postgres. This is corruptible — concurrent admin edits could mint duplicate `version` numbers; a TS-side failure between the INSERT and the FK flip would leave half-state. The row-level lock on the rule + same-tx semantics close both holes.

#### 2.6.8 New PL/pgSQL RPC — `cancel_workflow_instance_with_approvals` (CRITICAL 4 closure)

```sql
create or replace function public.cancel_workflow_instance_with_approvals(
  p_instance_id uuid,
  p_tenant_id   uuid,
  p_reason      text
) returns table (
  claimed      boolean,
  approvals_expired_ct integer
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_claimed   boolean := false;
  v_expired_ct integer := 0;
  v_entity_kind text;
  v_entity_id text;
begin
  -- 1. Atomic claim. UPDATE with the same IN ('active','waiting') filter as
  --    cancelInstanceById's TS-side claim (workflow-engine.service.ts:346-357).
  with claimed as (
    update public.workflow_instances
       set status = 'cancelled',
           cancelled_at = now(),
           cancelled_reason = p_reason
     where id = p_instance_id
       and tenant_id = p_tenant_id
       and status in ('active', 'waiting')
    returning id, entity_kind,
              coalesce(case_id::text, work_order_id::text, booking_id::text) as entity_id
  )
  select true, entity_kind, entity_id
    into v_claimed, v_entity_kind, v_entity_id
    from claimed;

  if not v_claimed then
    -- Lost the race — another worker cancelled. No-op.
    return query select false, 0;
    return;
  end if;

  -- 2. Expire any approvals linked to this workflow_instance.
  update public.approvals
     set status = 'expired',
         responded_at = now(),
         comments = 'workflow_instance_cancelled'
   where workflow_instance_id = p_instance_id
     and tenant_id = p_tenant_id
     and status = 'pending';
  get diagnostics v_expired_ct = row_count;

  -- 3. Emit instance_cancelled audit event.
  --    Table is workflow_instance_events (00026); column is workflow_instance_id
  --    (verified 2026-05-12). Pre-v4-fix the spec drafted workflow_events /
  --    instance_id — both wrong. 'instance_cancelled' is in the event_type CHECK
  --    set per 00376 widening.
  insert into public.workflow_instance_events (
    tenant_id, workflow_instance_id, event_type, payload, created_at
  ) values (
    p_tenant_id, p_instance_id, 'instance_cancelled',
    jsonb_build_object(
      'reason', p_reason,
      'entity_kind', v_entity_kind,
      'entity_id', v_entity_id,
      'approvals_expired_ct', v_expired_ct
    ),
    now()
  );

  return query select true, v_expired_ct;
end $$;

revoke execute on function public.cancel_workflow_instance_with_approvals(uuid, uuid, text) from public;
grant  execute on function public.cancel_workflow_instance_with_approvals(uuid, uuid, text) to service_role;
```

**Called from `cancelInstanceById`** (workflow-engine.service.ts:281-498): replaces the existing TS-side atomic claim at :346-357 + the `instance_cancelled` emit at :377 + adds the approvals expiry. The link cascade enumeration at :400+ stays TS-side (it's idempotent + the per-link error boundary it carries doesn't need atomicity).

```typescript
// Pseudocode for the cancelInstanceById delta — implementation in 6.A.
const { data: rpcRows, error: rpcErr } = await this.supabase.admin.rpc(
  'cancel_workflow_instance_with_approvals',
  { p_instance_id: instanceId, p_tenant_id: tenantId, p_reason: reason },
);
if (rpcErr) {
  throw AppErrors.server('workflow.cancel_with_approvals_failed', {
    detail: `RPC failed: ${rpcErr.message}`,
  });
}
const row = (rpcRows ?? [])[0];
if (!row?.claimed) {
  // Same semantics as the old TS-side claim losing the race — no-op.
  return;
}
// Fall through to the existing link cascade enumeration at :400+ unchanged.
```

**Backstop cron sweeper.** A new `ApprovalCancelSweeperCron` following the Phase 1.C `WorkflowWaitSweeperCron` pattern: every 5min, scan for `approvals` rows where `workflow_instance_id` references a `workflow_instances.status='cancelled'` row but `approvals.status='pending'`, expire them. The RPC closes the primary failure mode (network-failure-between-claim-and-expire is now atomically rolled back); the cron closes any remaining drift (e.g., a pre-Phase-1.5 workflow_instance manually flipped to cancelled). Lives in `apps/api/src/modules/workflow/approval-cancel-sweeper.cron.ts`.

### 2.7 Notification dispatch — one owner per surface, no overlap

The workflow's job is state tracking + post-resolution advance. Notification dispatch is **unaffected by Phase 1.5.**

| Surface | Owner | Site |
|---|---|---|
| `onApprovalRequested` — fire on booking creation when rule resolves to pending_approval | `BookingFlowService.create` | booking-flow.service.ts:382-388 |
| `onApprovalDecided` — fire on every grant resolve | `ApprovalService.grantBookingApproval` | approval.service.ts:847-871 |

The workflow's `notification` node is NOT used in Phase 1.5 compiled graphs. The `booking-approval-required.handler.ts` stub stays a stub.

### 2.8 Summary of net-new infrastructure

- **1 column on `room_booking_rules`:** `workflow_definition_id uuid`.
- **3 columns on `approvals`:** `workflow_instance_id uuid`, `workflow_node_id text`, `chain_threshold text` (CHECK).
- **1 column on `workflow_definitions`:** `source_rule_id uuid`. Plus `status` CHECK widened to include `'archived'`. Plus unique index on `(tenant_id, source_rule_id, version)`.
- **1 new outbox event type:** `approval.granted`, registered in `ApprovalLifecycleEventType` const.
- **2 new PL/pgSQL RPCs (00400):** `ensure_room_booking_rule_workflow_definition` (atomic auto-recompile — BLOCKER 1) and `cancel_workflow_instance_with_approvals` (atomic cancel+expire — CRITICAL 4).
- **1 producer migration (00401):** supersede `grant_booking_approval` to honour `chain_threshold` under a per-booking row lock with sibling re-observation (BLOCKER 2) + emit `approval.granted` on `kind='resolved'`.
- **1 schema + backfill migration (00400):** the new columns + chain_threshold backfill via derive-algorithm + 3 tenant triggers + status CHECK widen + the two new RPCs above + per-rule call to `ensure_room_booking_rule_workflow_definition` for one-shot backfill.
- **1 new consumer handler:** `WorkflowApprovalGrantedHandler`.
- **1 new shared service:** `ApprovalConfigCompilerService` — **pure compile only**, no persistence (BLOCKER 1).
- **1 new cron:** `ApprovalCancelSweeperCron` (CRITICAL 4 backstop).
- **1 new TS engine surface:** `WorkflowService.start({definitionId, entityKind, entityId, tenantId})` (sub-step 6.A.Y).
- **Engine changes (sub-step 6.A):** `resume()` polymorphization; `approval` executor extension; `cancelInstanceById` cutover to the new RPC; **`startForTicket` + `startForBooking` add `.eq('status','published')` filter** (IMPORTANT 7).
- **No new node types.**
- **7 new error codes** (each registered at 5 sites per the error-handling spec):
  - `workflow.approval_instance_not_found` (404)
  - `workflow.tenant_mismatch_approval` (403)
  - `workflow.advance_failed` (500)
  - `workflow_definition.compilation_failed` (422)
  - `chain.threshold_invalid` (422 — defense-in-depth)
  - `workflow.definition_not_published` (422 — start path refusal; IMPORTANT 7) **NEW v4**
  - `workflow.cancel_with_approvals_failed` (500 — `cancel_workflow_instance_with_approvals` RPC failure surfacing) **NEW v4**
  - `booking.edit_requires_notification_dispatch` STAYS registered (existing).
- **0 graduated handlers.**
- **3 tenant triggers** (CRITICAL 3 closure adds the third):
  - `assert_approvals_workflow_instance_tenant` on `approvals.workflow_instance_id`.
  - `assert_room_booking_rules_workflow_definition_tenant` on `room_booking_rules.workflow_definition_id`.
  - `assert_workflow_definitions_source_rule_tenant` on `workflow_definitions.source_rule_id`. **NEW v4**

---

## 3. Migration plan

### 3.1 Slots — preflight

**Preflight baseline (run before authoring 00400):**

```bash
ls supabase/migrations/ | tail -15
```

Verified on 2026-05-12 — output:

```
00372_create_booking_emit_lifecycle.sql
00373_delete_booking_emit_cancelled.sql
00374_work_orders_visibility.sql
00376_workflow_events_extend_for_cancellation.sql
00377_work_order_visibility_vendor_dormant.sql
00378_search_global_asset_branch_fix.sql
00379_drop_edit_booking_slot_rpc.sql
00380_work_orders_planning_visibility.sql
00381_planning_smoke_requester_seed.sql
```

00378, 00379, 00380, 00381 are TAKEN. 00375 is the only gap on disk — Phase 1.5 does NOT use 00375 (latest-prefix discipline). **Phase 1.5 owns 00400 + 00401.**

| # | File | Purpose |
|---|---|---|
| 00400 | `room_booking_rules_workflow_definition_fk.sql` | All schema additions (rule FK, approvals link columns, workflow_definitions lineage, chain_threshold) + status CHECK widen + 3 tenant triggers + unique index + 2 new RPCs (`ensure_room_booking_rule_workflow_definition`, `cancel_workflow_instance_with_approvals`) + chain_threshold backfill via the derive algorithm + per-rule one-shot backfill via `ensure_room_booking_rule_workflow_definition`. |
| 00401 | `grant_booking_approval_v2.sql` | Supersede 00310 to (a) acquire per-booking row lock before self-CAS, (b) re-observe sibling state under the lock, (c) honour `chain_threshold` for resolve, (d) emit `approval.granted` on `kind='resolved'` (not `'already_resolved'`). |

Split is intentional — 00400 is schema + the two new RPCs + backfill, 00401 is the supersession of the canonical grant RPC. A bug in 00401 doesn't roll back the backfill done in 00400.

### 3.2 Backfill SQL shape (00400, pseudocode)

```sql
-- ── A. Schema additions ─────────────────────────────────────────────
alter table public.room_booking_rules
  add column if not exists workflow_definition_id uuid
    references public.workflow_definitions(id) on delete set null;
create index if not exists idx_room_booking_rules_workflow_def
  on public.room_booking_rules (workflow_definition_id)
  where workflow_definition_id is not null;

alter table public.approvals
  add column if not exists workflow_instance_id uuid
    references public.workflow_instances(id) on delete set null,
  add column if not exists workflow_node_id text,
  add column if not exists chain_threshold text not null default 'all'
    check (chain_threshold in ('all','any'));
create index if not exists idx_approvals_workflow_instance
  on public.approvals (workflow_instance_id)
  where workflow_instance_id is not null;

alter table public.workflow_definitions
  add column if not exists source_rule_id uuid
    references public.room_booking_rules(id) on delete set null;

-- Widen the workflow_definitions.status CHECK to allow 'archived'.
alter table public.workflow_definitions
  drop constraint if exists workflow_definitions_status_check;
alter table public.workflow_definitions
  add constraint workflow_definitions_status_check
    check (status in ('draft','published','archived'));

create unique index if not exists idx_workflow_definitions_rule_version
  on public.workflow_definitions (tenant_id, source_rule_id, version)
  where source_rule_id is not null;

-- ── B. Three tenant triggers — CRITICAL 3 + CRITICAL 4 closure.
--    Pattern lifted from 00370:205-228. SECURITY DEFINER + explicit
--    search_path + P0001 errcode.

create or replace function public.assert_approvals_workflow_instance_tenant()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if new.workflow_instance_id is null then return new; end if;
  if not exists (
    select 1 from public.workflow_instances wi
     where wi.id = new.workflow_instance_id and wi.tenant_id = new.tenant_id
  ) then
    raise exception 'tenant_mismatch on approvals.workflow_instance_id: instance=% does not belong to tenant=%',
      new.workflow_instance_id, new.tenant_id using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists approvals_assert_workflow_instance_tenant on public.approvals;
create trigger approvals_assert_workflow_instance_tenant
  before insert or update of workflow_instance_id, tenant_id on public.approvals
  for each row execute function public.assert_approvals_workflow_instance_tenant();

create or replace function public.assert_room_booking_rules_workflow_definition_tenant()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if new.workflow_definition_id is null then return new; end if;
  if not exists (
    select 1 from public.workflow_definitions wd
     where wd.id = new.workflow_definition_id and wd.tenant_id = new.tenant_id
  ) then
    raise exception 'tenant_mismatch on room_booking_rules.workflow_definition_id: definition=% does not belong to tenant=%',
      new.workflow_definition_id, new.tenant_id using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists room_booking_rules_assert_workflow_definition_tenant on public.room_booking_rules;
create trigger room_booking_rules_assert_workflow_definition_tenant
  before insert or update of workflow_definition_id, tenant_id on public.room_booking_rules
  for each row execute function public.assert_room_booking_rules_workflow_definition_tenant();

-- NEW v4 (CRITICAL 3): tenant trigger on workflow_definitions.source_rule_id
-- so a service-role write can't link tenant A's workflow_definitions row to
-- tenant B's room_booking_rules row.
create or replace function public.assert_workflow_definitions_source_rule_tenant()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if new.source_rule_id is null then return new; end if;
  if not exists (
    select 1 from public.room_booking_rules rbr
     where rbr.id = new.source_rule_id and rbr.tenant_id = new.tenant_id
  ) then
    raise exception 'tenant_mismatch on workflow_definitions.source_rule_id: rule=% does not belong to tenant=%',
      new.source_rule_id, new.tenant_id using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists workflow_definitions_assert_source_rule_tenant on public.workflow_definitions;
create trigger workflow_definitions_assert_source_rule_tenant
  before insert or update of source_rule_id, tenant_id on public.workflow_definitions
  for each row execute function public.assert_workflow_definitions_source_rule_tenant();

-- ── C. Define the two new RPCs (BLOCKER 1 + CRITICAL 4). Bodies as in
--    §2.6.7 and §2.6.8. Both SECURITY DEFINER + explicit search_path.
--    (Full bodies omitted here; the bodies are spec'd in §2.6.7/§2.6.8 and
--    written verbatim in the migration file.)
create or replace function public.ensure_room_booking_rule_workflow_definition(...) ...;
create or replace function public.cancel_workflow_instance_with_approvals(...) ...;

-- ── D. Preflight refuse — fail if any approval_config is shaped
--    outside what we can losslessly compile.
do $$
declare v_rogue int;
begin
  select count(*) into v_rogue from public.room_booking_rules
    where approval_config is not null
      and not (
        jsonb_typeof(approval_config->'required_approvers') = 'array'
        and (approval_config->>'threshold') in ('all','any')
        and not exists (
          select 1
            from jsonb_array_elements(approval_config->'required_approvers') ap
           where not ((ap->>'type') in ('person','team') and (ap->>'id') is not null)
        )
      );
  if v_rogue > 0 then
    raise exception 'phase 1.5 backfill: % rule(s) have non-canonical approval_config shape. Inspect + normalise before re-running.', v_rogue;
  end if;
end $$;

-- ── E. Backfill via per-rule call to ensure_room_booking_rule_workflow_definition.
--    For each rule with non-null approval_config, compile the graph (using an
--    in-SQL helper jsonb assembly identical to ApprovalConfigCompilerService.compile),
--    then call the new RPC. The RPC handles version=1, FK flip, archive
--    (no-op for backfill since version=1 has no priors).
--    Idempotent: the RPC re-running on a rule whose source_rule_id already has
--    a version=1 row would attempt to insert version=2 — but the unique index
--    on (tenant_id, source_rule_id, version) prevents that ONLY for the same
--    version number, not for v=2. To stay strictly idempotent, the backfill
--    loop SKIPS rules whose workflow_definition_id is already populated.
do $$
declare
  r record;
  v_graph jsonb;
  v_approvers jsonb;
  v_threshold text;
begin
  for r in
    select id, tenant_id, name, approval_config
      from public.room_booking_rules
     where approval_config is not null
       and workflow_definition_id is null
  loop
    v_approvers := r.approval_config->'required_approvers';
    v_threshold := coalesce(r.approval_config->>'threshold', 'all');
    v_graph := jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object('id','trigger','type','trigger','config', jsonb_build_object()),
        jsonb_build_object('id','approval_main','type','approval','config',
          jsonb_build_object('required_approvers', v_approvers, 'threshold', v_threshold)),
        jsonb_build_object('id','end_success','type','end','config',
          jsonb_build_object('outcome','approved')),
        jsonb_build_object('id','end_failure','type','end','config',
          jsonb_build_object('outcome','rejected'))
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from','trigger','to','approval_main'),
        jsonb_build_object('from','approval_main','to','end_success','condition','approved'),
        jsonb_build_object('from','approval_main','to','end_failure','condition','rejected')
      )
    );
    perform public.ensure_room_booking_rule_workflow_definition(
      r.id, r.tenant_id, v_graph, r.name
    );
  end loop;
end $$;

-- ── F. Backfill chain_threshold via DERIVE algorithm (CRITICAL 5 closure).
--    parallel_group IS NULL AND group_cardinality > 1 → 'any'.
--    parallel_group IS NULL AND group_cardinality = 1 → 'all' (any-of-1 ≡ all-of-1).
--    parallel_group IS NOT NULL → 'all' (today's encoding).
--    Emits NOTICE per chain for audit.
do $$
declare
  cg record;
  v_derived text;
begin
  for cg in
    select tenant_id, target_entity_id, parallel_group,
           coalesce(approval_chain_id, gen_random_uuid()) as chain_id,
           count(*) as group_cardinality
      from public.approvals
     where chain_threshold is null  -- only rows not yet migrated
     group by tenant_id, target_entity_id, parallel_group, approval_chain_id
  loop
    v_derived := case
      when cg.parallel_group is null and cg.group_cardinality > 1 then 'any'
      when cg.parallel_group is null and cg.group_cardinality = 1 then 'all'
      else 'all'
    end;
    raise notice 'phase 1.5 chain %: parallel_group=%, group_cardinality=%, derived chain_threshold=%',
      cg.chain_id, cg.parallel_group, cg.group_cardinality, v_derived;

    update public.approvals a
       set approval_chain_id = cg.chain_id,
           chain_threshold   = v_derived
     where a.tenant_id        = cg.tenant_id
       and a.target_entity_id = cg.target_entity_id
       and a.parallel_group is not distinct from cg.parallel_group
       and (a.approval_chain_id is null or a.chain_threshold is null);
  end loop;
end $$;

-- ── G. Belt-and-suspenders — assert every rule with non-null approval_config
--    now carries a workflow_definition_id.
do $$
declare v_missing int;
begin
  select count(*) into v_missing from public.room_booking_rules
    where approval_config is not null
      and workflow_definition_id is null;
  if v_missing > 0 then
    raise exception 'phase 1.5 backfill: % rule(s) ended without a workflow_definition_id. Investigate before reload.', v_missing;
  end if;
end $$;

notify pgrst, 'reload schema';
```

**Why the per-rule backfill loop calls the RPC:** the same RPC is used at steady-state (admin edits) and at backfill. No code duplication. The unique index on `(tenant_id, source_rule_id, version)` keeps it safe; the loop's `WHERE workflow_definition_id IS NULL` keeps it idempotent across re-runs.

### 3.3 `compileApprovalConfigToGraph` — the recipe

**Path (ii) — LOCKED:** **one approval node per rule.** Compile `{required_approvers, threshold}` to ONE `approval` node carrying the same approver list + threshold in node.config. The engine's `approval` executor inserts N approval rows (one per approver) with `parallel_group` populated when threshold='all', `approval_chain_id` set on every row, and `chain_threshold` matching the rule's threshold. 00401 reads `chain_threshold` and handles all-of-N OR any-of-N resolution under a per-booking row lock.

**Compiled graph shape:**

```jsonc
{
  "nodes": [
    { "id": "trigger", "type": "trigger", "config": {} },
    { "id": "approval_main", "type": "approval", "config": {
        "required_approvers": [{"type":"person","id":"..."}, {"type":"team","id":"..."}],
        "threshold": "all"
      } },
    { "id": "end_success", "type": "end", "config": { "outcome": "approved" } },
    { "id": "end_failure", "type": "end", "config": { "outcome": "rejected" } }
  ],
  "edges": [
    { "from": "trigger",       "to": "approval_main" },
    { "from": "approval_main", "to": "end_success", "condition": "approved" },
    { "from": "approval_main", "to": "end_failure", "condition": "rejected" }
  ]
}
```

**Edge labels** — `approval` node's resume() carries `edgeCondition = decision` where decision ∈ {'approved','rejected'} (matches resume signature at workflow-engine.service.ts:1645). `advance()` picks the edge whose `condition` field matches the string.

**Implication for the `approval` executor:** today it inserts ONE row at workflow-engine.service.ts:1330-1337. Phase 1.5 extends this branch to:

- Loop over `node.config.required_approvers` (array of `{type, id}`).
- Insert N rows, each tenant-validated (existing :1304-1321 logic, looped).
- Set `parallel_group = node.config.threshold === 'all' ? 'wf-${node.id}-${instance.id}' : null`.
- Set `approval_chain_id = ${one-uuid-per-execution}` (generated once per executor invocation; same value for all N rows).
- Set `chain_threshold = node.config.threshold` (validated against `('all','any')` at compile time + DB CHECK + 00401 defense-in-depth).
- Set `workflow_instance_id = instance.id` + `workflow_node_id = node.id` on each row.
- Use polymorphic helper for `target_entity_type` / `target_entity_id`.

Single-executor change within the `approval` case. No new node primitives.

**Edge cases:**
- **Empty approver list.** Backfill RAISES at preflight (§3.2 block D). Steady-state `ApprovalConfigCompilerService.compile` throws `workflow_definition.compilation_failed` (422).
- **Single approver, threshold='all' vs 'any'.** Both compile to identical graph topology; the `chain_threshold` on inserted approval rows differs. 00401 honours the threshold and resolves correctly in both cases (single-approver-any = single-approver-all = resolve immediately on first response).
- **Mixed person + team approvers.** Single approval node with N entries in `required_approvers`; executor loops + tenant-validates each.

### 3.4 Trigger / RLS implications

- **`workflow_definitions.tenant_id`** — existing RLS. Plus the **third** tenant trigger `assert_workflow_definitions_source_rule_tenant` (CRITICAL 3 closure).
- **`approvals.workflow_instance_id`** — inherits existing approvals-row RLS. Trigger `assert_approvals_workflow_instance_tenant` is the row-level defense.
- **`approvals.chain_threshold`** — no RLS surface; CHECK constraint at DB layer + Zod validation at TS layer.
- **`workflow_definitions.source_rule_id`** — same tenant_id RLS as parent table; FK + the new trigger.
- **`room_booking_rules.workflow_definition_id`** — existing RLS + trigger `assert_room_booking_rules_workflow_definition_tenant`.
- **Status='archived' rows** — RLS unchanged. Archived definitions are still readable by in-flight `resume()` calls (which query by id, not by status). **Start path refuses** (IMPORTANT 7).
- **RPC permissions** — both new RPCs are `revoke execute … from public; grant execute … to service_role` (same shape as 00310 / 00373).

### 3.5 Re-runnability

- 00400 is idempotent. **Strategy:** unique index `(tenant_id, source_rule_id, version)` + the backfill loop's `WHERE workflow_definition_id IS NULL` guard + the chain_threshold loop's `WHERE chain_threshold IS NULL` guard. Re-running 00400 on a partially-backfilled DB finds rules already linked → skips. Existing chains with chain_threshold populated → skipped.
- 00401 (RPC supersession) is `CREATE OR REPLACE FUNCTION` — already idempotent.
- The two new RPCs (`ensure_room_booking_rule_workflow_definition`, `cancel_workflow_instance_with_approvals`) are `CREATE OR REPLACE FUNCTION` in 00400 — also idempotent.

### 3.6 db:push authorization

Phase 1.5 needs migration pushes on REMOTE. Per memory `project_universal_workflow_phase0_shipped` + `feedback_db_push_authorized`: standing user permission for the universal-workflow workstream IF BOTH review layers (full-review + codex) are green. **Phase 1.5 plan-review must NOT auto-push.** Each sub-step's implementation-review re-confirms.

---

## 4. B.4.A.5 gate decision

### 4.1 Option A — Retire the gate (REJECTED)

Replace the 422 with a workflow re-spawn. Same arguments as v3 — couples Phase 1.5 to a notification dispatch correctness story we haven't pressure-tested at scale.

### 4.2 Option B — Coexist (LOCKED)

The gate stays. Predicate UPDATED to compare `workflow_definition_id` where the OLD id is sourced from the **live `workflow_instance`** (CRITICAL 6 closure), not from the rule's FK. Error message updated to point operators at the workflow editor: `"This edit would change approval requirements. Edit the approval workflow at /admin/workflows/<id> first, or pick a different room."`

### 4.3 Implementation under Option B

- Update the 422 message at all three call sites to mention the workflow editor when the OLD instance exists with a non-null `workflow_definition_id` (§5.3 predicate update enables this).
- Error code `booking.edit_requires_notification_dispatch` STAYS registered. No new error code for the gate itself.
- Smoke probe asserts the gate fires correctly under the new predicate (§7.4 probes 9 + 10 + 11).

---

## 5. Cancel cascade + cross-entity coupling

### 5.1 In-flight approval workflows when a booking is cancelled (CRITICAL 4 closure)

**Tier 2 wake handler** subscribes to `booking.cancelled` (workflow-spawn-wake.handler.ts — booking.cancelled subscriber). **Phase 1.B cancel cascade** in `cancelInstanceById` (workflow-engine.service.ts:281-498) is polymorphic — handles booking entity_kind correctly. **v4 EXTENDS it via the new `cancel_workflow_instance_with_approvals` RPC.**

**Two paths:**

**(a) Parent-waiting-on-booking-child path** — existing, tested in Phase 1.B. Booking is a child workflow_instance_link; cancel resolves the link. **No new code needed for the link path.**

**(b) Driving-instance path — handled by v4.** The approval workflow IS the driving workflow on the booking (`workflow_instances.entity_kind='booking'`, `booking_id=$bookingId`). When `delete_booking_with_guard` (00373) cancels the booking + emits `booking.cancelled`, the wake handler routes through `cancelInstance('booking', bookingId, tenantId, 'driving_entity_cancelled')`. This terminates the in-flight approval workflow.

**v4 cancelInstanceById change (CRITICAL 4 closure):**

Replace the TS-side atomic claim at workflow-engine.service.ts:346-357 + the `instance_cancelled` emit at :377 with one call to the new RPC `cancel_workflow_instance_with_approvals`. The RPC body wraps the claim + approvals expiry + emit atomically. If the RPC fails, `cancelInstanceById` surfaces `workflow.cancel_with_approvals_failed` (500); the workflow_instance stays `waiting`, the approvals stay `pending`, and the cron backstop sweeper will re-attempt.

Pseudocode:

```typescript
// Replaces workflow-engine.service.ts:346-357 + :377 in cancelInstanceById.
const { data: rpcRows, error: rpcErr } = await this.supabase.admin.rpc(
  'cancel_workflow_instance_with_approvals',
  { p_instance_id: instanceId, p_tenant_id: tenantId, p_reason: reason },
);
if (rpcErr) {
  throw AppErrors.server('workflow.cancel_with_approvals_failed', {
    detail: `RPC failed: ${rpcErr.message}`,
  });
}
const row = (rpcRows ?? [])[0];
if (!row?.claimed) {
  return; // Lost the race — another worker cancelled. No-op (same as old TS-side claim).
}
// Continue with the existing link cascade enumeration at :400+ unchanged.
```

**Backstop cron — `ApprovalCancelSweeperCron`.** Follows Phase 1.C `WorkflowWaitSweeperCron` pattern. Every 5min: find `approvals WHERE workflow_instance_id IN (SELECT id FROM workflow_instances WHERE status='cancelled' AND tenant_id=X) AND approvals.status='pending'`. Expire them. Per-tenant scoped. Closes drift from rows that pre-date this RPC OR from a manual SQL-side workflow_instance flip that bypassed the RPC. Lives in `apps/api/src/modules/workflow/approval-cancel-sweeper.cron.ts`.

**Verification site for runWake driving-instance routing.** If `runWake` already cancels driving instances on `booking.cancelled`, no code change at the wake handler. If not, sub-step 6.A adds the call. 6.A's verify-and-extend task.

### 5.2 What Phase 1.5 surfaces that 1.B didn't catch

- **Resume-on-approval semantics** — `approval.granted` outbox event + `WorkflowApprovalGrantedHandler`. The atomic-claim pattern from parent-spec §3.5 reused via resume()'s internal claim.
- **Threshold='any' resolve path** — 00401 honours `chain_threshold` UNDER a per-booking row lock. Sibling re-observation under the lock prevents double-resolve.
- **Cross-tenant defense on three FK surfaces** (CRITICAL 3 closure adds the third). Triggers refuse cross-tenant writes at the SQL layer; handler defenses are the second layer.
- **Cancel-during-grant race.** Booking gets cancelled while an approver is mid-grant. Grant takes per-approval advisory lock at 00310:86-92. Booking row lock at 00401's top. cancel_workflow_instance_with_approvals attempts row-flip on the same workflow_instance. Either order: terminal state is consistent — if cancel wins the workflow_instances UPDATE, the grant's `resume()` claim returns null and no-ops; if grant wins, the approval expires under the cancel RPC's second UPDATE only if the grant's CAS was already committed (idempotent expiry skips 'approved' rows because of `status='pending'` filter).
- **Cancel cascade approvals expiry.** Booking deleted while approvals are pending → cancelInstance fires → RPC atomically flips instance to 'cancelled' AND expires approvals AND emits audit. Test §7.5 makes this observable.

### 5.3 Edit-path coverage (CRITICAL 6 closure)

Three edit scenarios trace through the gate at reservation.service.ts:1001-1011 / :1365-1379 / assemble-edit-plan.service.ts:593-607:

**(a) no-approval → approval-required.** Today: `plan.approval.old_outcome='allow'`, `plan.approval.new_outcome='require_approval'` → gate fires. **Phase 1.5: unchanged.**

**(b) approval-workflow-A → approval-workflow-B (different room/rule).** **Phase 1.5: predicate UPDATED.** When BOTH `old_outcome` and `new_outcome` are `'require_approval'`, the gate now ALSO compares `plan.approval.old_workflow_definition_id !== plan.approval.new_workflow_definition_id`. **The OLD id is sourced from the live `workflow_instance`** — not from the rule's current FK (CRITICAL 6 closure). NEW id continues to come from re-resolving the rule against the post-edit booking shape.

**(b') admin bumps approval_config on the active rule — version=1 → version=2.** The booking's live `workflow_instance.workflow_definition_id` STILL POINTS at version=1 (immutable per the parent spec's wait-config-freeze invariant). The rule's `workflow_definition_id` NOW POINTS at version=2 (ensure_room_booking_rule_workflow_definition flipped it). Edit triggers: re-resolve sees version=2 (the rule's current FK); load OLD from live instance sees version=1. They differ → 422 fires. Correct.

**Predicate v4 (planning shape):**

```typescript
// Sourcing OLD workflow_definition_id from the live workflow_instance,
// not from the rule's current FK (CRITICAL 6 closure).
const { data: liveInstance } = await this.supabase.admin
  .from('workflow_instances')
  .select('workflow_definition_id')
  .eq('tenant_id', tenantId)
  .eq('booking_id', bookingId)
  .in('status', ['active', 'waiting'])
  .order('created_at', { ascending: false })
  .limit(1)
  .maybeSingle();

const oldWorkflowDefinitionId: string | null =
  liveInstance?.workflow_definition_id ?? currentMatchedRule?.workflow_definition_id ?? null;

// new comes from re-resolving the rule against the post-edit booking.
const newWorkflowDefinitionId: string | null =
  newMatchedRule?.workflow_definition_id ?? null;

const wouldEmitApprovalRequired =
  plan.approval.new_outcome === 'require_approval' &&
  (plan.approval.old_outcome !== 'require_approval' ||
    plan.approval.chain_config_changed === true ||
    oldWorkflowDefinitionId !== newWorkflowDefinitionId);
```

**Fallback rationale:** when `liveInstance` is null, there's no in-flight workflow to false-negative on — fall back to the current rule's FK. This preserves the gate's behaviour for legacy bookings (`createApprovalRows` path with no workflow_instance) and for bookings whose workflow already completed (no in-flight comparison concern).

**Sub-step 6.E** ships this predicate update at all three call sites. The `plan.approval` shape adds two new fields: `old_workflow_definition_id: string | null`, `new_workflow_definition_id: string | null`. The assemble-edit-plan resolver populates them per the SQL above.

**(c) Edit during in-flight workflow wait.** Workflow is `status='waiting' waiting_for='approval'`. Operator edits the booking (e.g., shifts the time). **The workflow stays on its published graph_definition** per immutable-graph invariant. UX (Phase 4 admin): show "edit in-flight" indicator + the workflow_instance_id. **Phase 1.5: no code change needed for this case.** Gate fires only when the edit would change the approval *shape*, not when it changes other booking fields.

---

## 6. Sub-step sequencing within Phase 1.5

**Eight ordered sub-steps. 6.A.X (compiler) → 6.B (migration 00400) → 6.A (engine) → 6.A.Y (start overload) → 6.C (migration 00401 + error codes) → 6.D (handler) → 6.E (cutover + auto-recompile) → 6.G (cron backstop).** Each is a CHECKPOINT-2 implementation review (full-review + codex).

### 6.A.X — `ApprovalConfigCompilerService` (pure TS, zero migrations, compile-only)

**FIRST step.** Ships the compiler service in isolation, BEFORE any migration uses its output. Unit-tested against a fixture matrix; the migration's per-rule backfill assembly (§3.2 block E) emits byte-identical graph shapes asserted by these unit tests.

**Scope:**
- New file `apps/api/src/modules/approval/approval-config-compiler.service.ts`. Pure function `compile()` returns `{graphDefinition, name}`. **NO `ensureForRule()`** (BLOCKER 1 closure — persistence is the RPC's job).
- New file `apps/api/src/modules/approval/approval-config-compiler.service.spec.ts`. Fixture matrix: `{required_approvers: [{type:'person', id:'p1'}], threshold:'all'}` → expected graphDefinition; same for `'any'`; same for team-only; same for mixed person+team; same for 4 approvers.
- Parity test: side-by-side comparison of the TS `compile()` output vs the SQL block E backfill assembly (both produce the same `jsonb`). Implemented as a Jest test that spins up local Supabase via `pnpm db:start` and executes the SQL assembly inline.
- NOT called from any production path yet — integration ships in 6.E.

**Files:** `apps/api/src/modules/approval/approval-config-compiler.service.ts`, its spec. ~3-5 commits.

### 6.B — Schema + backfill + RPCs (migration 00400)

**Scope:** the migration in §3.2. Adds all new columns + 3 tenant triggers + status CHECK widen + unique index + **2 new RPCs** (`ensure_room_booking_rule_workflow_definition`, `cancel_workflow_instance_with_approvals`) + per-rule backfill via the first RPC + chain_threshold backfill via the DERIVE algorithm.

**Files:** `supabase/migrations/00400_room_booking_rules_workflow_definition_fk.sql`. ~5-7 commits (the migration is one file but iterations through review will be common; the two RPCs add bulk).

**Review checkpoint:** implementation-review on the migration SQL (codex MUST review SQL — both RPC bodies, all three tenant triggers, the chain_threshold DERIVE algorithm). Run `pnpm db:reset` locally for SQL validation; push to remote ONLY after both reviewers green.

### 6.A — Engine: kind-dispatch + resume polymorphization + cancel via RPC + start status filter

**Scope:**
- Add `getEntityKindForInstance(instanceId): Promise<{kind: WorkflowEntityKind; entityId: string}>` helper to `workflow-engine.service.ts`.
- Extend `approval` executor (workflow-engine.service.ts:1283-1352) per §3.3 (multi-row insert + chain_threshold + workflow_instance_id + workflow_node_id + polymorphic entity_kind).
- Polymorphize `resume()` IN PLACE (Option C+):
  - Extend atomic claim's RETURNING at workflow-engine.service.ts:1666 to include `entity_kind, case_id, work_order_id, booking_id`.
  - Resolve polymorphic entityId from `entity_kind` + the corresponding column.
  - Thread polymorphic entityId into `advance(instanceId, graph, current_node_id, entityId, edgeCondition)` at :1717.
  - Defensive `workflow.advance_failed` error if entity_kind + polymorphic ids mismatch.
- Replace `cancelInstanceById`'s TS-side claim + emit (workflow-engine.service.ts:346-357 + :377) with a single call to `cancel_workflow_instance_with_approvals` RPC. Link cascade enumeration at :400+ stays TS-side, unchanged.
- **Add `.eq('status', 'published')` to `startForTicket`** (workflow-engine.service.ts:888-895) — IMPORTANT 7 closure. Raise `workflow.definition_not_published` (422) if no row returned AND a definition with the requested id exists with a non-published status (helps debug; otherwise generic 'definition not found').
- Verify-and-extend `workflow-spawn-wake.handler.ts:runWake` for the booking-cancelled DRIVING-instance path — confirm or add the `cancelInstance('booking', bookingId)` call.
- Unit tests:
  - `approval` executor inserts `target_entity_type='booking'` + N rows + correct chain_threshold for booking-kind; case-kind regression coverage.
  - `resume()` for booking-kind advances correctly; case-kind regression coverage.
  - `cancelInstanceById` delegates to RPC; RPC failure surfaces `workflow.cancel_with_approvals_failed`.
  - `startForTicket` refuses archived definition → `workflow.definition_not_published`.
  - Convention test: any executor calling `.from('approvals').insert(...)` also calls `getEntityKindForInstance(...)`.

**Files:** `apps/api/src/modules/workflow/workflow-engine.service.ts`, `apps/api/src/modules/outbox/handlers/workflow-spawn-wake.handler.ts` (verify or extend), specs. ~12-15 commits.

### 6.A.Y — `WorkflowService.start({...})` overload + `startForBooking` (with status filter)

**Scope:**
- Add `start({definitionId, entityKind, entityId, tenantId}): Promise<WorkflowInstance>` to `workflow.service.ts`.
- Internally routes:
  - `entityKind='case'` → calls `WorkflowEngineService.startForTicket(ticketId, definitionId)`.
  - `entityKind='booking'` → adds new `startForBooking(bookingId, definitionId)` to `WorkflowEngineService`, mirroring the case-kind path but writing `booking_id` + `entity_kind='booking'`. **Adds `.eq('status', 'published')` to the definition SELECT** (IMPORTANT 7 closure).
  - `entityKind='work_order'` → unimplemented at Phase 1.5; throws `AppErrors.server('workflow.advance_failed', { detail: 'work_order start not implemented in Phase 1.5' })`.
- Unit tests: instance row written with correct `entity_kind` + correct polymorphic id column populated + archived definition refused.

**Files:** `apps/api/src/modules/workflow/workflow.service.ts`, `apps/api/src/modules/workflow/workflow-engine.service.ts`. ~5-7 commits.

### 6.C — Producer: grant_booking_approval v2 (migration 00401)

**Scope:**
- Supersession of 00310 (`CREATE OR REPLACE FUNCTION public.grant_booking_approval(...)`):
  - **NEW v4 (BLOCKER 2):** acquire `SELECT id FROM public.bookings WHERE id=v_target_id AND tenant_id=p_tenant_id FOR UPDATE` at the TOP of the body, BEFORE the per-approval advisory lock + self-CAS. This serialises all contenders on the same booking; concurrent grants on sibling rows of the same chain queue at this lock.
    - Note: the booking row lock requires `v_target_id` — read it from `approvals.target_entity_id` BEFORE this lock by doing a non-locking `SELECT target_entity_id, approval_chain_id, status, target_entity_type FROM public.approvals WHERE id=p_approval_id AND tenant_id=p_tenant_id` first (snapshot read; not a CAS). If status != 'pending', return `kind='already_responded'` cleanly. If target_entity_type != 'booking', return `kind='non_booking_approved'`. Otherwise acquire booking row lock, then do the full row-lock + CAS dance described below.
  - **NEW v4 (BLOCKER 2):** under the booking row lock, after acquiring the per-approval `FOR UPDATE` row lock, count `approved_siblings` in the same chain:
    ```sql
    select count(*) filter (where status = 'approved')
      into v_approved_siblings
      from public.approvals
     where tenant_id        = p_tenant_id
       and approval_chain_id = v_approval.approval_chain_id
       and id != p_approval_id;
    ```
  - **NEW v4 (BLOCKER 2):** branch on `chain_threshold` + the sibling state:
    - `'any'` + decision='approved' + `v_approved_siblings > 0`: a sibling already resolved. CAS self → 'approved' for audit, RETURN `kind='already_resolved'` (NEW kind), **NO** sibling expiry, **NO** `approval.granted` emit.
    - `'any'` + decision='approved' + `v_approved_siblings = 0`: this row resolves the chain. CAS self → 'approved', expire siblings (`status='expired', comments='Sibling approved (any-of-N)'`), emit `approval.granted`, return `kind='resolved'`.
    - `'all'` + decision='approved': existing 00310 count logic (recount under the booking row lock — count of `status in ('pending','rejected')` over the same `target_entity_id`). If > 0 → `kind='partial_approved'`. If = 0 → resolve.
    - Either threshold + decision='rejected': existing rejection logic (cancel booking, expire siblings), emit `approval.granted` with `final_decision='rejected'`.
  - Add `perform outbox.emit('approval.granted', jsonb_build_object('tenant_id', p_tenant_id, 'approval_id', p_approval_id, 'booking_id', v_target_id, 'final_decision', p_decision, 'workflow_instance_id', v_workflow_instance_id, 'workflow_node_id', v_workflow_node_id))` ONLY on the `kind='resolved'` branch. `v_workflow_instance_id` + `v_workflow_node_id` read from the approval row before emit.
  - Defense-in-depth: `if v_approval.chain_threshold not in ('all','any') then raise 'chain.threshold_invalid'` (CHECK enforces; raise is belt-and-suspenders).
- TS-side typed event-type const at `apps/api/src/modules/approval/event-types.ts` (NEW file).
- Error-code ratchet for the new failure modes (each registered at 5 sites):
  - `workflow.approval_instance_not_found` (404)
  - `workflow.tenant_mismatch_approval` (403)
  - `workflow.advance_failed` (500)
  - `workflow_definition.compilation_failed` (422)
  - `chain.threshold_invalid` (422)
  - **`workflow.definition_not_published` (422)** **NEW v4 (IMPORTANT 7)**
  - **`workflow.cancel_with_approvals_failed` (500)** **NEW v4 (CRITICAL 4)**
  - The 5 sites per code: TS const in `packages/shared/src/error-codes.ts`, EN message in `messages.en.ts`, NL message in `messages.nl.ts`, AppErrors factory in `apps/api/src/common/errors/app-error.ts`, downstream consumer (handler / service / executor).

**Files:** `supabase/migrations/00401_grant_booking_approval_v2.sql`, `apps/api/src/modules/approval/event-types.ts` (NEW), error-code registry (5 sites × 7 codes — though `chain.threshold_invalid` was already in v3's 5-code list; v4 adds 2 to the v3 list of 5 → 7 total). ~12-15 commits.

**Review checkpoint:** implementation-review. Codex MUST review the booking row lock placement, the re-observation count under the lock, the `'already_resolved'` no-emit semantics, and the tenant assertions.

### 6.D — Consumer: WorkflowApprovalGrantedHandler

**Scope:**
- New outbox handler at `apps/api/src/modules/outbox/handlers/workflow-approval-granted.handler.ts`. Subscribes to `ApprovalLifecycleEventType.Granted`.
  - Tenant defense: `payload.tenant_id === event.tenant_id`; mismatch → `DeadLetterError`.
  - Workflow instance lookup tenant-filtered.
  - Calls `resume(workflow_instance_id, tenant_id, decision)`; relies on resume()'s atomic claim for idempotency.
  - Defense: refuses cross-tenant link with `workflow.tenant_mismatch_approval` (DeadLetterError).
  - Cancel-during-grant race: when instance is `cancelled`, resume()'s claim returns null, handler logs + no-ops.
  - Missing parent instance: `workflow.approval_instance_not_found` (DeadLetterError).

**Files:** `apps/api/src/modules/outbox/handlers/workflow-approval-granted.handler.ts`, its spec file, `outbox.module.ts` (register handler). ~5-7 commits.

### 6.E — Consumer cutover + auto-recompile via RPC + B.4.A.5 predicate update with live-instance OLD-id source

**Scope:**
- Plumb `workflow_definition_id` through `MatchedRule` (rule-resolver.service.ts:52 type + :514 read).
- Rewire booking-flow.service.ts:359-360 to start a workflow via `WorkflowService.start({...})` if the matched rule has the FK; fall through to legacy `createApprovalRows` if not.
- Update `createApprovalRows` (booking-flow.service.ts:1173-1194) to set `approval_chain_id` + `chain_threshold` on every row (legacy path correctness).
- Update `assemble-edit-plan.service.ts` (and `reservation.service.ts:editOne`/`editSlot`) to:
  - Read `old_workflow_definition_id` from the live `workflow_instance` (CRITICAL 6 closure — SQL shape in §5.3).
  - Read `new_workflow_definition_id` from re-resolving the rule against the post-edit booking.
  - Populate the two new fields on the `EditPlanApproval` shape.
- Update B.4.A.5 gate predicate at THREE call sites (reservation.service.ts:1001-1011, :1365-1379, assemble-edit-plan.service.ts:593-607) per §5.3.
- Wire `ApprovalConfigCompilerService.compile(...)` into `RoomBookingRulesService.create` + `.update`: TS compiles graph → call `ensure_room_booking_rule_workflow_definition(rule_id, tenant_id, graph_definition, rule_name)`. RPC handles version + archive + FK flip atomically. No TS-side post-RPC writes needed.
- Smoke probe added.

**Files:** `apps/api/src/modules/room-booking-rules/rule-resolver.service.ts`, `apps/api/src/modules/room-booking-rules/room-booking-rules.service.ts`, `apps/api/src/modules/reservations/booking-flow.service.ts`, `apps/api/src/modules/reservations/reservation.service.ts`, `apps/api/src/modules/reservations/assemble-edit-plan.service.ts`, `apps/api/scripts/smoke-visual-approval.mjs` (NEW), `package.json` (new smoke script). ~14-17 commits.

### 6.G — Backstop cron: `ApprovalCancelSweeperCron` (CRITICAL 4 backstop)

**Scope:**
- New cron at `apps/api/src/modules/workflow/approval-cancel-sweeper.cron.ts`. Follows `WorkflowWaitSweeperCron` pattern from Phase 1.C. Every 5min:
  - Per-tenant: find `approvals WHERE workflow_instance_id IN (SELECT id FROM workflow_instances WHERE status='cancelled' AND tenant_id=X) AND approvals.status='pending'`.
  - Expire them (`status='expired', comments='workflow_instance_cancelled_via_cron_backstop'`).
  - Log count per tenant per sweep.
- Tenant_id scoping mandatory (per memory `feedback_tenant_id_ultimate_rule`).
- Unit test: cron picks up an orphaned pending approval whose workflow_instance is cancelled, expires it.

**Files:** `apps/api/src/modules/workflow/approval-cancel-sweeper.cron.ts`, its spec. ~3-5 commits.

### Total: ~55-75 commits, **5-6 working weeks** (revised UP from v3's 4-5w because v4 adds: (a) `ensureForRule` promotion from TS to RPC; (b) `cancel_workflow_instance_with_approvals` RPC + cron backstop; (c) backfill mapping algorithm with three semantic cases; (d) booking-level row lock + concurrent-grant probes; (e) `old_workflow_definition_id` source change + the two new test cases; (f) `workflow.definition_not_published` 5-site registration + start-path gate; (g) third tenant trigger for `workflow_definitions.source_rule_id`).

---

## 7. Test plan

### 7.1 Engine-level (unit + concurrency)

- **Approval node polymorphism.** Booking-kind workflow_instance → approvals row has `target_entity_type='booking'`, `target_entity_id=$booking_id`, `workflow_instance_id=$instance_id`, `workflow_node_id=$node_id`, `chain_threshold` matches node.config. Case-kind regression.
- **Multi-approver insert.** `node.config.required_approvers = [{type:'person',id:p1},{type:'team',id:t1}]`, threshold='all'. Assert 2 rows with same `approval_chain_id`, same `parallel_group='wf-<node>-<instance>'`, both `chain_threshold='all'`.
- **Resume polymorphization — booking kind.** Booking-kind instance → resume() reads polymorphic ids → advance() called with `booking_id`. Case-kind regression.
- **Resume polymorphization — error path.** Mismatched entity_kind + polymorphic ids → `workflow.advance_failed`.
- **Atomic claim under concurrent emits.** Two `approval.granted` events for the same instance. Only ONE resume() succeeds.
- **Three tenant triggers refuse cross-tenant writes** (CRITICAL 3 closure):
  - Foreign-tenant `approvals.workflow_instance_id` → trigger rejects at SQL layer.
  - Foreign-tenant `room_booking_rules.workflow_definition_id` → trigger rejects.
  - **Foreign-tenant `workflow_definitions.source_rule_id` → trigger rejects.** **NEW v4**
- **Cancel-during-grant race.** Workflow_instance is `cancelled` before `approval.granted` lands. Handler calls resume(); claim returns null. Handler logs + drops.
- **No double-resume.** Workflow_instance already `active`. Claim returns null. Handler no-ops.
- **Cancel cascade expires approvals via RPC** (CRITICAL 4 closure). Create booking → start workflow → workflow waits at approval node → cancel booking → `cancel_workflow_instance_with_approvals` RPC fires → workflow status='cancelled' AND approvals.status='expired' atomically. **NEW v4**: fault-injection — force the approvals expiry UPDATE inside the RPC to fail (raise an exception mid-RPC via a saboteur trigger on `approvals`) → assert the workflow_instance stays `waiting` (whole tx rolled back).
- **Start path refuses archived definition.** `startForTicket` / `startForBooking` on a `status='archived'` definition → `workflow.definition_not_published` (422). **NEW v4 (IMPORTANT 7)**

### 7.2 Migration-level (backfill correctness)

- **Every non-null `approval_config` produces a workflow_definitions row with `version=1`.** Asserted by §3.2 block G.
- **Every workflow_definitions row's graph_definition is valid.** Run `WorkflowValidatorService.validate` against each backfilled row.
- **Tenant invariant.** Every backfilled row's `workflow_definitions.tenant_id` matches the source rule's tenant_id. Three tenant triggers fire on cross-tenant manual writes.
- **chain_threshold backfill — three cases** (CRITICAL 5 closure):
  - Pre-existing chain with `parallel_group IS NULL` AND >1 approvers → derived `chain_threshold='any'`.
  - Pre-existing chain with `parallel_group IS NULL` AND 1 approver → derived `chain_threshold='all'`.
  - Pre-existing chain with `parallel_group IS NOT NULL` → derived `chain_threshold='all'`.
  - Audit query (shippable as a manual probe): `SELECT chain_id, parallel_group, group_cardinality, chain_threshold FROM (subquery) — group by chain_threshold`.
- **Idempotency.** Re-run 00400 → no new rows; backfill loop `WHERE workflow_definition_id IS NULL` skips; chain_threshold loop `WHERE chain_threshold IS NULL` skips.
- **Auto-recompile lineage via RPC** (BLOCKER 1 closure). RoomBookingRulesService.update() bumps approval_config → TS compiles graph → `ensure_room_booking_rule_workflow_definition` mints version=2 → prior version=1 archived IFF no in-flight refs → rule.workflow_definition_id flips to version=2's id. Unit test.
- **Auto-recompile preserves in-flight.** Same flow with one workflow_instance still `waiting` against version=1 → prior version=1 stays `published` (not archived) → in-flight resume() continues to resolve against version=1.
- **Concurrent auto-recompile (BLOCKER 1 race)** **NEW v4**. Two concurrent calls to `ensure_room_booking_rule_workflow_definition` on the same rule. Row lock serialises. First commits version=2; second commits version=3. Both versions present; rule FK ends at version=3. Unique index on `(tenant_id, source_rule_id, version)` is the final defense — never collides because of the lock-serialised `MAX(version)+1`.

### 7.3 Integration (real-DB)

- **Happy path (threshold='all'):** create rule with chain_threshold='all' + 2 approvers, create booking matching the rule → workflow starts → both grant → 00401 fires `kind='resolved'` → approval.granted emits → handler resumes → booking `confirmed`.
- **Happy path (threshold='any'):** rule + 3 approvers, threshold='any' → first approver grants → 00401's `'any'` branch fires `kind='resolved'` immediately → expires siblings → approval.granted emits → handler resumes → booking `confirmed`.
- **Concurrent threshold='any' grant** **NEW v4 (BLOCKER 2)**. 3 approvers race-grant 'approved'. The booking row lock serialises: exactly ONE returns `kind='resolved'`; the others return `kind='already_resolved'`; ONLY ONE `approval.granted` emit; booking `confirmed`; siblings expired exactly once. Test asserts exactly 1 outbox event row was inserted.
- **Reject path (either threshold):** rejection → workflow `end_failure` + booking `cancelled` + siblings expired.
- **Legacy fall-through.** Rule with `approval_config` but NULL `workflow_definition_id` → `createApprovalRows` fires. `chain_threshold` correctly set on inserted rows.
- **Cancel cascade — DRIVING instance.** Booking cancelled mid-approval → cancelInstance → RPC fires → workflow `cancelled` + approvals `expired` atomically.
- **Cancel cascade — fault injection** **NEW v4 (CRITICAL 4)**. Inject failure mid-RPC. Whole tx rolls back. Workflow stays `waiting`. Cron backstop picks it up on next run.
- **Edit scenario (a):** allow-rule → require-approval-rule. Gate fires 422.
- **Edit scenario (b):** workflow-A booking → workflow-B room. Gate fires 422 via OLD-id-from-live-instance comparison.
- **Edit scenario (b') — admin bumps approval_config during in-flight workflow** **NEW v4 (CRITICAL 6)**. Booking is on workflow_definition version=1 (live). Admin edits the rule → ensure_room_booking_rule_workflow_definition mints version=2 → rule FK flips. Edit the booking. OLD id read from live `workflow_instance` returns version=1; NEW id from rule resolver returns version=2 → predicate fires 422.
- **Edit scenario (c):** edit booking title only during workflow wait → 200 OK; workflow stays `waiting`.

### 7.4 Smoke probe (`pnpm smoke:visual-approval`)

Mints real Admin JWT, runs full mutation matrix against live API. **16 probes minimum (v3's 14 + 2 new):**

1. **Happy create → workflow → grant (threshold='all') → advance.**
2. **Happy create → workflow → grant (threshold='any') → advance.** Single grant resolves; others expired with `comments='Sibling approved (any-of-N)'`.
3. **Happy create → workflow → reject → cancel.**
4. **Ghost approval id.** → 404 `approval.not_found`.
5. **Malformed approval id.** → 400 (validation gate).
6. **Foreign-tenant approval id with workflow_instance_id link.** Trigger refuses at SQL layer; handler defense refuses at TS layer.
7. **Cancel-during-grant race.** Two concurrent processes; terminal state consistent.
8. **Double-emit `approval.granted`.** Idempotent.
9. **B.4.A.5 gate scenario (a)** → 422.
10. **B.4.A.5 gate scenario (b)** → 422 with workflow-editor mention.
11. **B.4.A.5 gate scenario (b') — version bump during in-flight** **NEW v4 (CRITICAL 6)** — bump approval_config on the active rule, then edit a booking whose live workflow is on version=1 → 422 fires (live-instance OLD id ≠ rule's current NEW id).
12. **B.4.A.5 gate scenario (c)** → 200 OK; workflow stays `waiting`.
13. **Missing X-Client-Request-Id header.** → 400.
14. **Cancel cascade expires approvals.** Booking deleted mid-workflow → workflow_instance cancelled + approvals expired atomically (via RPC).
15. **Concurrent threshold='any' grant** **NEW v4 (BLOCKER 2)** — 3 approvers race-grant 'approved'. Exactly ONE wins; exactly ONE `approval.granted` row in outbox; siblings expired exactly once.
16. **Start path refuses archived definition** **NEW v4 (IMPORTANT 7)** — create a rule, edit it once (so version=1 → version=2, version=1 archived), then attempt to `start()` against version=1 directly → 422 `workflow.definition_not_published`.

**Discipline shape:** mirrors `smoke-work-orders.mjs` + `smoke-edit-booking-scope.mjs`. Real Admin JWT, seeded fixture, current-row-XOR-sentinel mutations, `finally { dropFixture() }`. Exit 0/1.

### 7.5 Real-DB concurrency probes

- 50 concurrent grants of the same approval id — exactly one succeeds.
- 10 concurrent booking creations matching a rule with an approval workflow — 10 workflow_instances; no double-starts.
- 10 concurrent `booking.cancelled` events — exactly one `cancel_workflow_instance_with_approvals` call effective; approvals expire ONCE.
- 5 concurrent approval grants of a threshold='any' chain — exactly one wins under the booking row lock; others return `kind='already_resolved'` cleanly; no double-emit.
- **Concurrent auto-recompile** **NEW v4 (BLOCKER 1)** — 5 concurrent `ensure_room_booking_rule_workflow_definition` calls on the same rule. Row lock serialises. Versions monotonically increase (v=2, 3, 4, 5, 6). Unique index never collides. Rule FK ends at the last committed version.

---

## 8. Risk register

| # | Risk | Mitigation |
|---|---|---|
| R1 | Per-executor kind-dispatch drift — implementer of a future executor forgets to call `getEntityKindForInstance`. | Sub-step 6.A convention test (AST walk or grep). Phase 1.B.x signature rename eliminates surface later. |
| R2 | Approval's new `workflow_instance_id` link is forgeable by SQL-level write. | `assert_approvals_workflow_instance_tenant` trigger fires on insert AND update. Handler defense (`workflow.tenant_mismatch_approval`) second layer. |
| R3 | `WorkflowApprovalGrantedHandler` race with resume()'s atomic claim. | Handler relies on resume()'s claim — no separate handler claim needed. |
| R4 | **(REWRITTEN v4)** Auto-recompile races with admin edits → duplicate `version` numbers OR FK flip ending at a stale version. | `ensure_room_booking_rule_workflow_definition` RPC acquires `FOR UPDATE` row lock on `room_booking_rules` BEFORE computing `MAX(version)+1`. Concurrent callers serialise at the lock. The unique index `(tenant_id, source_rule_id, version)` is the final defense (never collides because of the lock). Test §7.2 + §7.5 cover. SERIALIZABLE-isolation language from v3 deleted — the row-lock is the closure. |
| R5 | Status='archived' rows accidentally resume. | resume() always re-reads workflow_definition by `id`. Archiving is a soft-delete marker for admin UI + the START path. **Start path refuses archived definitions** (IMPORTANT 7 closure). |
| R6 | Backfill produces a workflow_definition that an admin then edits the rule against — drift. | `ensure_room_booking_rule_workflow_definition` archives the prior IFF no in-flight references AND supersedes with the new one — all atomically in one tx. In-flight instances stay on archived versions (immutable invariant); new bookings start on the active version. |
| R7 | `kind='resolved'` path is the only `approval.granted` emit site. | Phase 1.5 in-scope is grant-only. Expiry / manual-close paths NOT a known path today; if they become real, sibling spec adds emit site. |
| R8 | **(REWRITTEN v4)** threshold='any' chain race — two approvers both POST 'approved' concurrently; double-resolve. | 00401 acquires **per-booking ROW lock** (`SELECT id FROM bookings WHERE id=v_target_id AND tenant_id=p_tenant_id FOR UPDATE`) at the top of the RPC body, BEFORE the per-approval advisory lock + self-CAS. Under that lock, re-read sibling state (`count(*) filter (where status='approved')`). If sibling already resolved, return `kind='already_resolved'` without re-emitting or expiring. Test §7.3 + §7.4 probe 15 cover. Advisory locks from 00310 inherited for the SAME-approval-id case; the booking row lock is the additive layer for the cross-sibling-id case. |
| R9 | **(NEW v4)** `cancel_workflow_instance_with_approvals` RPC failure mid-call leaves half-state. | RPC body is one tx — failure rolls back the claim. TS-side `cancelInstanceById` surfaces `workflow.cancel_with_approvals_failed`; caller decides retry. **ApprovalCancelSweeperCron** is the backstop for any non-RPC drift (manual SQL workflow_instance flips, pre-Phase-1.5 rows). Test §7.1 fault-injection + §7.3 cancel-cascade-fault-injection cover. |
| R10 | **(NEW v4)** `workflow_definitions.source_rule_id` is a tenant-smuggling FK with no trigger. | `assert_workflow_definitions_source_rule_tenant` trigger (CRITICAL 3 closure). Same SECURITY DEFINER pattern as the other two. Test §7.1 + smoke probe (third trigger refusal) cover. |
| R11 | **(NEW v4)** B.4.A.5 predicate false-negatives on rule version bumps during in-flight workflow. | OLD `workflow_definition_id` sourced from the live `workflow_instance`, NOT the rule's current FK (CRITICAL 6 closure). Test §7.3 scenario (b') + §7.4 smoke probe 11 cover. |
| R12 | **(NEW v4)** Start path silently spawns instances on archived definitions, breaking the auto-recompile invariant. | `startForTicket` / `startForBooking` add `.eq('status', 'published')`. resume() unchanged (so in-flight instances continue). New error code `workflow.definition_not_published`. Test §7.1 + smoke probe 16 cover. |

---

## 9. Decisions deferred to Phase 4 (UI)

- Editor palette filter showing only approval-relevant nodes for booking-entity workflows.
- Inspector polish for the `approval` node when its parent rule is a `room_booking_rules` row.
- "Use existing approval workflow" picker on the rule editor.
- Audit-chain UI showing the per-booking workflow run on the booking detail page — cross-stitch approvals table + workflow_instance_events.
- Branch label management for the compiled graph's `approved` / `rejected` edges.
- Edit-the-workflow vs edit-the-rule UX.
- Workflow version history viewer.
- Phase 1.B.x signature rename.
- Notification node graduation for booking-entity workflows.

---

## 10. Open questions for plan-review (Checkpoint 1, round 4)

1. **`ApprovalConfigCompilerService` packaging.** Should the service live under `apps/api/src/modules/approval/` or `apps/api/src/modules/room-booking-rules/`? Recommendation: `apps/api/src/modules/approval/` — compiler is approval-domain logic; consumers import.

2. **Side-by-side compiler parity test.** §6.A.X spec includes a parity test comparing the TS `compile()` to the SQL block E backfill assembly. Pressure-test target: is this sufficient, or does the project need a permanent CI gate that runs both against the fixture matrix on every PR? Recommendation: parity test for Phase 1.5; CI gate iff drift is ever observed.

3. **runWake driving-instance verification.** §5.1 mandates 6.A verifies `workflow-spawn-wake.handler.ts:runWake` cancels driving instances on `booking.cancelled`. Pressure-test target: read full body of `runWake` at impl time.

4. **Drift defense for Option C+ per-executor dispatch.** §2.4 + R1 specify a convention test. Pressure-test target: confirm AST walk OR grep test is feasible. Fallback: documentation convention + Phase 1.5 retro revisit.

5. **Service-rule sibling spec — schedule.** Compiler accepts `rule_type` discriminator. Pressure-test target: which workstream pulls the sibling spec. Recommendation: retire-the-column spec is a sibling spec AFTER both rule_types are migrated.

6. **Auto-recompile interaction with admin-authored workflow_definitions (Phase 4).** Once Phase 4 admins can write workflow_definitions by hand (no `source_rule_id`), what happens when an admin assigns one to a rule via `workflow_definition_id`? Pressure-test target: should `ensure_room_booking_rule_workflow_definition` skip when the rule's current FK references a row with `source_rule_id IS NULL`? Recommendation: yes — bake the skip into the RPC body (`if exists (select 1 from workflow_definitions wd where wd.id = current_fk and wd.source_rule_id is null) then return current_fk as definition_id; …`). Phase 4 ships the explicit UX. **Defer the exact RPC body branch to 6.E impl time; document the decision then.**

7. **(RESOLVED v4 — CRITICAL 5 closure)** ~~Backfill chain_threshold for pre-existing parallel_group=NULL chains.~~ Closed by the DERIVE algorithm in §3.2 block F. Removed from open questions.

8. **(NEW v4)** **Cron sweeper cadence.** `ApprovalCancelSweeperCron` is spec'd at every 5min. Pressure-test target: is 5min the right cadence? Phase 1.C's `WorkflowWaitSweeperCron` runs every 5min (verify at impl time). Recommendation: match Phase 1.C cadence; revisit if observability shows lag.

9. **(NEW v4)** **`cancel_workflow_instance_with_approvals` RPC return shape — `claimed=false` vs error.** Currently the RPC returns `claimed=false, approvals_expired_ct=0` when it loses the race. TS treats this as a no-op + returns. Alternative: raise an exception so the TS caller can distinguish "lost race" from "no work to do". Recommendation: keep the return shape — the no-op semantics are correct (the workflow really was already cancelled by another worker); raising an exception would force TS to swallow it. Document the contract in the RPC's comment header.

---

## Citation index

All citations re-verified against `main` HEAD post-3bea158a on 2026-05-12 IN THIS PASS (v4). Implementer MUST re-verify before quoting in commit messages.

**Verification queries used in this v4 pass:**

- `ls supabase/migrations/ | tail -15` — 00378–00381 confirmed taken. Phase 1.5 owns 00400 + 00401. (v3 owned 00381 + 00400 — bumped.)
- `grep -n "async resume\|async start\b\|case 'notification'\|case 'approval'\|case 'condition'\|cancelInstance\|cancelInstanceById\|projectLegacyEntityType\|WorkflowEntityKind\b\|polymorphicIdColumn\|startForTicket" apps/api/src/modules/workflow/workflow-engine.service.ts` — engine line locations re-verified.
- `grep -n "ticket_id\|startForTicket\|advance(\|executeNode(\|RETURNING\|workflow_definition_id" apps/api/src/modules/workflow/workflow-engine.service.ts` — resume() body lines :1645-1719 + advance() signature :925 confirmed.
- `grep -n "createApprovalRows\|onApprovalRequested\|parallel_group\|approval_chain_id\|approvalConfig" apps/api/src/modules/reservations/booking-flow.service.ts` — `:359-360` consumer, `:382-388` notify, `:1173-1194` createApprovalRows, `:1180` parallel_group encoding.
- `grep -n "grantBookingApproval\|grantTicketApproval\|target_entity_type === \|onApprovalDecided" apps/api/src/modules/approval/approval.service.ts` — `:510-518` booking branch, `:532-540` ticket branch, `:610-624` visitor branch, `:802-879` grantBookingApproval body with `:847-871` onApprovalDecided fan-out.
- `grep -n "edit_requires_notification_dispatch\|wouldEmitApprovalRequired\|chain_config_changed\|workflow_definition_id\|approval.new_outcome\|approval.old_outcome" apps/api/src/modules/reservations/reservation.service.ts apps/api/src/modules/reservations/assemble-edit-plan.service.ts` — gate sites at `reservation.service.ts:1001-1011` + `:1365-1379` + `assemble-edit-plan.service.ts:593-607` confirmed. v3 cited `:1000-1009` / `:1364-1379` / `:624-639` — **v4 citation refresh**.
- Read `apps/api/src/modules/reservations/assemble-edit-plan.service.ts:720-760` — current chain load + `chainConfigChanged` derivation site for CRITICAL 6 closure.
- Read `supabase/migrations/00310_grant_booking_approval_rpc.sql:85-260` — full RPC body for BLOCKER 2 verification.
- Read `apps/api/src/modules/workflow/workflow-engine.service.ts:281-415` — cancelInstanceById body for CRITICAL 4 verification (`:346-357` claim, `:377` emit, `:400-407` link enumeration).
- Read `apps/api/src/modules/workflow/workflow-engine.service.ts:879-923` — startForTicket body for IMPORTANT 7 verification (no status filter on definition SELECT confirmed at `:888-895`).
- Read `apps/api/src/modules/workflow/workflow-engine.service.ts:1645-1719` — resume() body for resume polymorphization site.
- Read `apps/api/src/modules/workflow/workflow.service.ts` — `WorkflowService.create` at `:44-67`; no `.start({...})` overload (6.A.Y ships net-new).
- Read `supabase/migrations/00277_create_canonical_booking_schema.sql` — confirmed `bookings` table has NO `workflow_definition_id` column → CRITICAL 6 closure correctly sources OLD from `workflow_instances`.
- Read `supabase/migrations/00370_workflow_instance_links.sql:205-228` — tenant trigger pattern confirmed for §3.2 block B's three triggers.

**Schema / migrations:**

- `supabase/migrations/00009_workflows.sql:8` — `entity_type text not null default 'ticket'`.
- `supabase/migrations/00009_workflows.sql:9` — `version integer not null default 1`.
- `supabase/migrations/00009_workflows.sql:10` — `status` CHECK = ('draft','published'). **v4 widens to ('draft','published','archived').**
- `supabase/migrations/00009_workflows.sql:13` — `published_at timestamptz`.
- `supabase/migrations/00012_approvals.sql:8` — `approval_chain_id uuid` (pre-existing).
- `supabase/migrations/00012_approvals.sql:10` — `parallel_group text` (pre-existing).
- `supabase/migrations/00012_approvals.sql:28` — index on `approval_chain_id`.
- `supabase/migrations/00121_room_booking_rules.sql:14` — `approval_config jsonb`.
- `supabase/migrations/00121_room_booking_rules.sql:38-49` — `room_booking_rule_versions` table.
- `supabase/migrations/00133_seed_room_booking_examples.sql:70, 99` — approval_config examples.
- `supabase/migrations/00277_create_canonical_booking_schema.sql:27` — `bookings` table declaration; no `workflow_definition_id` column (CRITICAL 6 closure rationale).
- `supabase/migrations/00278_retarget_sibling_tables.sql:165-171` — `approvals_target_entity_type_check`.
- `supabase/migrations/00310_grant_booking_approval_rpc.sql:86-92` — per-approval advisory lock.
- `supabase/migrations/00310_grant_booking_approval_rpc.sql:98-104` — `for update` row read.
- `supabase/migrations/00310_grant_booking_approval_rpc.sql:114-120` — `kind='non_booking_approved'`.
- `supabase/migrations/00310_grant_booking_approval_rpc.sql:125-131` — `kind='already_responded'`.
- `supabase/migrations/00310_grant_booking_approval_rpc.sql:137-149` — CAS update.
- `supabase/migrations/00310_grant_booking_approval_rpc.sql:155-158` — per-booking advisory lock (the BLOCKER 2 site — v4's 00401 replaces with row lock).
- `supabase/migrations/00310_grant_booking_approval_rpc.sql:162-172` — sibling expiry on rejection.
- `supabase/migrations/00310_grant_booking_approval_rpc.sql:173-187` — all-of-N count + `kind='partial_approved'`.
- `supabase/migrations/00310_grant_booking_approval_rpc.sql:213-216` — `approve_booking_setup_trigger` call.
- `supabase/migrations/00310_grant_booking_approval_rpc.sql:244-253` — `kind='resolved'` (v4 extends in 00401).
- `supabase/migrations/00369_workflow_polymorphism_booking.sql` — Phase 0 widening for booking entity_kind.
- `supabase/migrations/00370_workflow_instance_links.sql:205-228` — tenant trigger pattern (mirror for v4's three triggers — pattern confirmed SECURITY DEFINER + explicit search_path + P0001).
- `supabase/migrations/00372_create_booking_emit_lifecycle.sql` — `booking.created` outbox producer.
- `supabase/migrations/00373_delete_booking_emit_cancelled.sql` — `booking.cancelled` outbox producer.
- `supabase/migrations/00378_search_global_asset_branch_fix.sql` — slot taken.
- `supabase/migrations/00379_drop_edit_booking_slot_rpc.sql` — slot taken.
- `supabase/migrations/00380_work_orders_planning_visibility.sql` — slot taken.
- `supabase/migrations/00381_planning_smoke_requester_seed.sql` — slot taken **(new since v3 plan-review)**.

**TypeScript surfaces (re-verified in-place 2026-05-12 v4):**

- `apps/api/src/modules/room-booking-rules/dto/index.ts:24-27` — `ApprovalConfig` interface.
- `apps/api/src/modules/room-booking-rules/rule-templates.ts:18, 131, 236, 286, 308` — template surfaces.
- `apps/api/src/modules/room-booking-rules/room-booking-rules.service.ts:101-137` — `.create` (auto-compile hook site for 6.E).
- `apps/api/src/modules/room-booking-rules/room-booking-rules.service.ts:139-` — `.update` (auto-compile hook site).
- `apps/api/src/modules/room-booking-rules/rule-resolver.service.ts:52` — `MatchedRule.approval_config` (sibling `workflow_definition_id` added in 6.E).
- `apps/api/src/modules/room-booking-rules/rule-resolver.service.ts:514` — `approvalConfig = r.approval_config ?? null` (row-read site).
- `apps/api/src/modules/reservations/booking-flow.service.ts:359-360` — consumer site reading `ruleOutcome.approvalConfig` **(v4 citation refresh — v3 cited :358-360)**.
- `apps/api/src/modules/reservations/booking-flow.service.ts:382-388` — `notifications.onApprovalRequested` fire-and-forget **(v4 citation refresh — v3 cited :382-387)**.
- `apps/api/src/modules/reservations/booking-flow.service.ts:1173-1194` — `createApprovalRows` definition **(v4 citation refresh — v3 cited :1170-1196)**.
- `apps/api/src/modules/reservations/booking-flow.service.ts:1180` — `parallel_group` encoding (`config.threshold === 'all' ? 'parallel-${bookingId}' : null` — the CRITICAL 5 anchor that `parallel_group IS NULL` = today's threshold='any').
- `apps/api/src/modules/reservations/event-types.ts:25-57, :87-132` — `BookingEditEventType` + `BookingLifecycleEventType` (shape mirror for `ApprovalLifecycleEventType`).
- `apps/api/src/modules/reservations/reservation.service.ts:1001-1011` — `editOne` B.4.A.5 gate **(v4 citation refresh — v3 cited :1000-1009)**.
- `apps/api/src/modules/reservations/reservation.service.ts:1365-1379` — `editSlot` B.4.A.5 gate **(v4 citation refresh — v3 cited :1364-1379)**.
- `apps/api/src/modules/reservations/assemble-edit-plan.service.ts:593-607` — per-occurrence B.4.A.5 gate **(v4 citation refresh — v3 cited :380-403 + :624-639; actual gate is at :593-607)**.
- `apps/api/src/modules/reservations/assemble-edit-plan.service.ts:730-759` — `chainConfigChanged` derivation site + `currentChain` load (CRITICAL 6 surface — where v4 also sources OLD `workflow_definition_id` from `workflow_instances`).
- `apps/api/src/modules/approval/approval.service.ts:510-518` — booking branch.
- `apps/api/src/modules/approval/approval.service.ts:532-540` — ticket branch **(v4 citation refresh — v3 cited :520-540)**.
- `apps/api/src/modules/approval/approval.service.ts:610-624` — visitor_invite branch.
- `apps/api/src/modules/approval/approval.service.ts:802-879` — `grantBookingApproval` body **(v4 citation refresh — v3 cited :802 only)**.
- `apps/api/src/modules/approval/approval.service.ts:847-871` — `onApprovalDecided` fan-out on `result.kind === 'resolved'`.
- `apps/api/src/modules/workflow/workflow-engine.service.ts:76` — `WorkflowEntityKind` type.
- `apps/api/src/modules/workflow/workflow-engine.service.ts:91` — `polymorphicIdColumn` helper.
- `apps/api/src/modules/workflow/workflow-engine.service.ts:157-159` — `projectLegacyEntityType` body.
- `apps/api/src/modules/workflow/workflow-engine.service.ts:209-258` — `cancelInstance` public surface.
- `apps/api/src/modules/workflow/workflow-engine.service.ts:281-498` — `cancelInstanceById` (CRITICAL 4 surface — v4 replaces :346-357 + :377 with the new RPC).
- `apps/api/src/modules/workflow/workflow-engine.service.ts:305-340` — entityKind + entityId resolution.
- `apps/api/src/modules/workflow/workflow-engine.service.ts:346-357` — atomic claim (replaced by `cancel_workflow_instance_with_approvals` RPC in 6.A).
- `apps/api/src/modules/workflow/workflow-engine.service.ts:377` — `instance_cancelled` emit (replaced by RPC body emit).
- `apps/api/src/modules/workflow/workflow-engine.service.ts:400-407` — `workflow_instance_links` SELECT (stays TS-side, unchanged).
- `apps/api/src/modules/workflow/workflow-engine.service.ts:879-923` — `startForTicket` (IMPORTANT 7 site — v4 adds `.eq('status', 'published')` at :888-895).
- `apps/api/src/modules/workflow/workflow-engine.service.ts:888-895` — definition SELECT in startForTicket (the line v4 patches with `.eq('status', 'published')`).
- `apps/api/src/modules/workflow/workflow-engine.service.ts:909` — `ticket_id: ticketId` insert.
- `apps/api/src/modules/workflow/workflow-engine.service.ts:925` — `advance(... ticketId: string ...)` signature (unchanged in Phase 1.5).
- `apps/api/src/modules/workflow/workflow-engine.service.ts:958` — `executeNode(... ticketId: string ...)` signature (unchanged).
- `apps/api/src/modules/workflow/workflow-engine.service.ts:1130-1153` — `notification` executor (NOT used in Phase 1.5 compiled graphs).
- `apps/api/src/modules/workflow/workflow-engine.service.ts:1139` — hardcoded `entityKind = 'case'` in notification.
- `apps/api/src/modules/workflow/workflow-engine.service.ts:1155-1188` — `condition` executor (NOT used).
- `apps/api/src/modules/workflow/workflow-engine.service.ts:1283-1352` — `approval` executor (v4 extends in 6.A).
- `apps/api/src/modules/workflow/workflow-engine.service.ts:1302-1303` — `approver_person_id` / `approver_team_id` config reads.
- `apps/api/src/modules/workflow/workflow-engine.service.ts:1304-1321` — tenant validation of approver person/team (looped for multi-approver insert).
- `apps/api/src/modules/workflow/workflow-engine.service.ts:1329` — hardcoded `entityKind = 'case'` (polymorphized via `getEntityKindForInstance`).
- `apps/api/src/modules/workflow/workflow-engine.service.ts:1330-1337` — approval row insert (extended to N rows + new metadata).
- `apps/api/src/modules/workflow/workflow-engine.service.ts:1645` — `resume()` signature.
- `apps/api/src/modules/workflow/workflow-engine.service.ts:1660-1667` — `resume()` atomic claim (RETURNING extended in 6.A).
- `apps/api/src/modules/workflow/workflow-engine.service.ts:1666` — `ticket_id` in RETURNING (resume polymorphization root site).
- `apps/api/src/modules/workflow/workflow-engine.service.ts:1717` — resume() calls advance() (extended to thread polymorphic entityId).
- `apps/api/src/modules/workflow/workflow.service.ts:44-67` — `WorkflowService.create` (no `start({...})` overload — 6.A.Y ships net-new).
- `apps/api/src/modules/workflow/workflow.service.ts:152` — `.select('*, definition:workflow_definitions(*)')`.
- `apps/api/src/modules/outbox/handlers/workflow-spawn-wake.handler.ts` — `booking.created` / `booking.cancelled` / `booking.status_changed` subscribers (verify-and-extend site for 6.A).
- `apps/api/src/modules/outbox/handlers/booking-approval-required.handler.ts` — handler stub (stays a stub in v4).

**Future files (explicit "will exist after implementation"):**

- `supabase/migrations/00400_room_booking_rules_workflow_definition_fk.sql` — FUTURE (schema + backfill + 3 triggers + 2 RPCs).
- `supabase/migrations/00401_grant_booking_approval_v2.sql` — FUTURE (RPC supersession for `chain_threshold` + booking row lock + `approval.granted` emit).
- `apps/api/src/modules/approval/event-types.ts` — FUTURE, `ApprovalLifecycleEventType` const.
- `apps/api/src/modules/approval/approval-config-compiler.service.ts` — FUTURE, **pure compile** service.
- `apps/api/src/modules/approval/approval-config-compiler.service.spec.ts` — FUTURE, fixture matrix + parity test with SQL block E assembly.
- `apps/api/src/modules/outbox/handlers/workflow-approval-granted.handler.ts` — FUTURE.
- `apps/api/src/modules/workflow/approval-cancel-sweeper.cron.ts` — FUTURE, cron backstop.
- `apps/api/scripts/smoke-visual-approval.mjs` — FUTURE, 16-probe smoke.

**Pinned constants (v4):**

- **Slots owned:** 00400 (schema + 2 RPCs + backfill + 3 triggers), 00401 (grant_booking_approval v2 with booking row lock).
- **Smoke probe count:** 16 (minimum) — v3's 14 + concurrent-threshold='any' probe + start-path-archived-refusal probe.
- **Sub-steps:** 6.A.X (compiler — pure) → 6.B (migration 00400) → 6.A (engine) → 6.A.Y (start overload) → 6.C (migration 00401 + error codes) → 6.D (handler) → 6.E (cutover + auto-recompile RPC call) → 6.G (cron backstop). Sub-step 6.F (deleted in v3) stays deleted.
- **Estimate:** 5-6 working weeks, ~55-75 commits.
- **Tenant triggers count:** 3 (CRITICAL 3 closure adds the third for `workflow_definitions.source_rule_id`).
- **PL/pgSQL RPCs net-new:** 3 — `ensure_room_booking_rule_workflow_definition` (BLOCKER 1), `cancel_workflow_instance_with_approvals` (CRITICAL 4), `grant_booking_approval` v2 supersession (BLOCKER 2).
- **NO UUID v5 namespace.** Lineage tracked via `(source_rule_id, version)`.
- **OLD `workflow_definition_id` source:** live `workflow_instance` (CRITICAL 6), with fallback to current rule FK when no live instance.
- **Start path archived-definition refusal:** `workflow.definition_not_published` (IMPORTANT 7).
