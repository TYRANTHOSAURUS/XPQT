# B.2 follow-ups

Deferred / known-issue index for the B.2.A workstream (orchestrator
RPCs + controller cutover). Items here are intentional non-fixes,
documented so future readers don't re-discover them as bugs.

## §3.0 update_entity_combined — review-deferred items

Items surfaced in the post-Commit-A self full-review (2026-05-11) that
were intentionally not folded into v2 (00332) or v3 (00333):

- **Watcher validation parity with TS reached at 00333** — RPC now
  matches `tenant-validation.ts:271-302` contract (active + anonymized_at
  IS NULL + left_at IS NULL + 200 unique-uuid size cap). Closed by
  codex F9.

- **Sub-RPC error code leakage to API surface.** Spec §3.0 line
  1867-1873 documents that §3.1-3.3 stay as public RPCs called
  directly by cron / workflow engine / reclassify. Their error
  codes (`transition_entity_status.has_open_children` etc.) are
  therefore intentionally part of the public contract, not internal.
  Commit B's controller cutover passes them through unchanged; the
  error-codes registry has had them registered since Step 3-5. No
  action needed.

- **No terminal-state guard on inline priority/plan/metadata
  branches.** The TS surface today doesn't block mutations on a
  closed/resolved entity for priority/title/cost/watchers either
  (see ticket.service.ts mutation methods). The orchestrator
  preserves that behaviour for parity. If we want to close this
  gap, it's a spec change first (need to enumerate which mutations
  remain valid on terminal entities — likely `title`, `watchers`,
  `tags`; not `priority`).

- **`branches_applied` array ordering as leaked contract.** The
  array reports branches in execution order (status, priority,
  assignment, sla, plan, metadata). If C3 above is ever resolved
  via reordering, the array order changes too. Document at the
  controller-cutover layer or sort alphabetically there.

- **Sub-RPC `noop` key not asserted.** The orchestrator reads
  `(result->>'noop')::boolean` and short-circuits if true. If a
  future v-N of a sibling RPC removes the key, the orchestrator
  silently treats it as noop. Low risk (sibling RPCs are battle-
  tested); add an assertion when next touching the file.

## §3.0 update_entity_combined — Commit B (controller cutover) review-deferred items

Items surfaced in the post-Commit-B self full-review (2026-05-11) that
were intentionally not folded into the Commit-B remediation pass
(00334 v4 + TS fixes):

- **Workflow engine bypass (plan-review C3, 2026-05-11).** The
  workflow engine's `assign` node at `workflow-engine.service.ts:273-278`
  and `update_ticket` node at `:362-367` write to `tickets` via direct
  `.from('tickets').update(...)` calls, bypassing §3.0 and the sub-RPCs.
  Spec lines 1870-1873 explicitly say workflow-engine `assign` MUST go
  through §3.2 `set_entity_assignment`. This is Step 9 in the B.2.A
  roadmap. Cutover happens there; until then §3.0 is the ONLY HTTP
  write path, not the only write path absolutely.

- **Case-side satisfaction_rating + satisfaction_comment atomicity
  gap (plan-review I4, 2026-05-11).** These fields are not in the
  metadata branch of §3.0 RPC; case-side update() preserves the API
  surface via a direct `.from('tickets').update({satisfaction_rating,
  satisfaction_comment})` call AFTER the orchestrator commits. This
  means satisfaction write can succeed while RPC fails (or vice
  versa) — no audit row, no idempotency. Fix is to fold these into
  the metadata branch of a future orchestrator version OR accept the
  gap and document it on the satisfaction-survey workflow page. Not
  P0 because satisfaction submissions are infrequent + non-critical
  for SLA correctness.

- **clientRequestId un-underscoring consistency (plan-review I1,
  2026-05-11).** Commit B un-underscored 2 of 8 Step-2 params (the
  PATCH paths). The other 6 (create / dispatch / reassign /
  reclassify / portal-tickets / approvals) stay underscored awaiting
  their respective §3.x cutovers. Mixed naming convention is
  intentional; each future cutover un-underscores its own param.

- **Refetch-after-RPC stale-read window (plan-review I2,
  2026-05-11).** Both PATCH handlers do RPC then refetch via
  separate .select('*'). Between RPC commit and refetch, another
  writer can mutate the row. Mitigation path: have the orchestrator
  return the full updated row in cached_result (currently it returns
  only branch-specific subset). Defer to a 00335+ migration alongside
  Step 7 (smoke probe extension).

## §3.0 update_entity_combined — Commit B codex remediation (v5)

Items shipped as 00335 (v5 supersedes 00334) and TS-side fixes
following the post-Commit-B codex review (2026-05-11):

- **00335 v5 supersedes 00334 v4.** v4's post-SLA recompute hook
  (00334:744-766) fired whenever the sla branch was present, but the
  sla sub-RPC has a no-op fast path (00330:179-194) that returns
  `noop=true, timers_inserted=0` without writing rows. Under v4 the
  hook emitted a spurious outbox event with action=
  'post_sla_install_in_waiting' that didn't describe reality (no
  fresh timers installed) + redundantly UPDATEd recompute_pending=true
  on whatever timers already existed. v5 gates the hook on
  `coalesce((v_sla_result->>'timers_inserted')::int, 0) > 0`
  (00335:737-738) so it only fires when fresh rows were actually
  installed. Verified by harness scenarios 17 + 18.

- **`sla.policy_has_no_targets` registered (codex CODEX-B-3,
  2026-05-11).** sla_policies.response_time_minutes +
  resolution_time_minutes are BOTH nullable in schema (00008:8-9);
  the admin POST/PATCH accepts that shape. Pre-fix, assigning such a
  no-target policy to an entity resulted in `buildTimersForRpc`
  returning `[]`, the RPC raising `update_entity_sla.timers_required`,
  which mapped to 500 (a programmer-error code). The actual problem is
  user/admin configuration → fix is to reject in
  `SlaService.buildTimersForRpc` with the new `sla.policy_has_no_targets`
  code (400 with curated copy: "This SLA policy has no response or
  resolution targets configured. Set at least one before assigning
  it."). Registered in `packages/shared/src/error-codes.ts` +
  `messages.{en,nl}.ts` (both apps/api + apps/web) +
  `STATUS_BY_CODE['sla.policy_has_no_targets'] = 400`.

- **AppError detail leak on registered codes (codex CODEX-B-1,
  2026-05-11).** `mapRpcErrorToAppError` previously passed
  `detail: stripCodePrefix(message)` into every AppError factory when
  the RPC raised a registered code. `normalize.ts:181-189` prefers an
  explicit detail override over the registry copy from messages.en/nl,
  so the operator-only SQL raise tail (`kind=case id=<uuid>`,
  `case=<uuid> open_children=3`) leaked onto the wire instead of the
  curated user-facing copy. Fix: when the code is REGISTERED, do NOT
  pass `detail` to the factory — let the renderer fall through to the
  registry copy. The original PostgrestError stays attached as `cause`
  for server-side logging. Only the fallback / unknown-code path keeps
  `detail: message`. Reference: `apps/api/src/common/errors/map-rpc-error.ts`.

## §3.0 closeout — what's actually shipped (Commit C remediation, 2026-05-11)

The §3.0 update_entity_combined work landed across three commits
(A: orchestrator RPC, B: controller cutover, C: remediation). What
the cutover means in practice:

**Controllers cut over.** `PATCH /tickets/:id` and `PATCH /work-orders/:id`
write exclusively through the `update_entity_combined` RPC (v5 / 00335).
The orchestrator preflight (visibility + per-field permission +
tenant validation + sla policy existence + format/enum/range) runs in
TS; the actual writes — every branch in one transaction — happen
inside the RPC. The legacy per-field TS dispatch chain is gone.

**Engines NOT cut over.** The workflow engine continues to write to
`tickets` directly at:
- `apps/api/src/modules/workflow/workflow-engine.service.ts:273-278`
  (`assign` node)
- `apps/api/src/modules/workflow/workflow-engine.service.ts:355-365`
  (`update_ticket` node)

These bypass the orchestrator, the sub-RPCs, audit emission, and the
`command_operations` idempotency table. Spec lines 1870-1873 explicitly
say the workflow engine's `assign` node must go through §3.2
`set_entity_assignment`. The cutover happens in B.2.A Step 9
(§1.21 workflow-engine cutover). Until then: **§3.0 is the only HTTP
write path, not the only write path absolutely.**

`WorkOrderService.reassign` and `TicketService.reassign` also remain
outside §3.0 — both write via `.from('<table>').update(...)` plus a
`routing_decisions` audit insert. Step 9 (workflow-engine cutover)
also folds reassign into `set_entity_assignment` (§3.2). Until then
reassign is a known second write path.

**Dead code removed (Commit C remediation, 2026-05-11).** The
per-field `WorkOrderService` methods (`updateSla` / `setPlan` /
`updateStatus` / `updatePriority` / `updateAssignment` /
`updateMetadata`) plus the private `logDomainEvent` helper they
relied on were deleted in `work-order.service.ts`. Six dedicated
spec files (`work-order-{sla-edit,set-plan,update-status,
update-priority,update-assignment,update-metadata}.spec.ts`) were
deleted alongside. Plan + code reviewers flagged the prior subagent's
rationale ("they validate preflight") as false — preflight runs in
`update()` directly, not via the per-field methods.

Future multi-table writes on work_orders MUST go through `update()`
→ `update_entity_combined`. The class-level docstring in
`work-order.service.ts` enforces this contract in prose; the absence
of the methods enforces it structurally. The CLAUDE.md project rule
is explicit: multi-step writes are PL/pgSQL RPCs, not TS pipelines.

**Test-shape correction (Commit C remediation, 2026-05-11).** The
`buildTimersForRpc` mock in `work-order-update.spec.ts:182-187`
previously returned `{kind, deadline_at}` with a comment claiming
parity with 00330:279-284. The actual `jsonb_to_recordset` schema
is `(timer_type text, target_minutes int, due_at timestamptz,
business_hours_calendar_id uuid)`. The test passed tautologically —
the orchestrator forwards whatever the mock returns into the RPC's
`p_patches.sla.timers` array; the spec only re-asserted what the
mock produced. Code reviewer flagged. Fixed to mirror the real shape
so a future drift between `SlaService.buildTimersForRpc` and the
RPC's recordset schema would surface as a failing unit test.

## §3.4 batch semantic shift (Step 8, 2026-05-11)

Pre-cutover, `WorkflowEngineService.create_child_tasks`
(`workflow-engine.service.ts:425-488`) silently swallowed per-task
failures inside a Promise.all-with-catch pattern — half-fanouts
shipped without an error surface. Post-cutover (00337 / 00339 batch
RPC), failures roll back the entire batch.

**Audit performed.** A grep of `workflow_definitions` in remote
shows that workflows with `create_child_tasks` nodes are authored
either:

- through the visual editor (where the `config.tasks` array is built
  click-by-click; the editor has no notion of "partial-fanout
  tolerance"), or
- via seed migrations under `supabase/migrations/` that ship the same
  static `tasks` array — no run-time decision logic to "tolerate"
  failure.

The silent swallow was a property of the legacy code path, not a
deliberate contract. No tenant surface was discovered authoring
workflows under explicit partial-fanout tolerance.

**Risk mitigation.** A future flag `node.config.fanout_mode:
all_or_nothing | best_effort` can re-introduce partial-fanout if any
tenant surface needs it. Not built yet — wait for concrete demand.

**If you hit the new behavior unexpectedly:** the failure mode is N
tasks DEFINED in a workflow, ZERO created on a partial-fail. Post
Codex-S8-I3 remediation (2026-05-11) the workflow_instance HALTS at
the `create_child_tasks` node — `status` flips to `'failed'`, a
`node_failed` audit event is emitted (reason `dispatch_batch_failed`),
and the workflow does NOT advance. Pre-remediation the engine
`console.error`'d and advanced as if children had been created,
producing an audit-log lie. The new shape exposes the same per-task
error codes to ops:
`dispatch_child_work_orders_batch.<reason>` or
`dispatch_child_work_order.invalid_payload`,
`validate_assignees_in_tenant.assigned_*_id_not_in_tenant`,
`validate_entity_in_tenant.<kind>_not_in_tenant`,
`dispatch_child_work_order.timers_required`, etc. — investigate the
failing task's payload (assignee, sla_id, routing_rule_id, request_type).

## §3.4 Step 8 self-review remediation (2026-05-11)

The Step 8 plan + code reviewers surfaced 4 criticals + 8 important
findings against `6e9102cf`. Resolved in a single follow-up commit
with migration v2 supersessions (00338 + 00339):

- **F-CRIT-1 sla_timers polymorphic columns.** 00227 added
  `(entity_kind, case_id, work_order_id)` to `sla_timers`. The v1
  RPCs (00336 / 00337) INSERTed without setting them — every read
  filtering `entity_kind='work_order' AND work_order_id=X` MISSED
  dispatch-emitted rows (silent read-side regression). 00338 / 00339
  mirror 00330:259-277 exactly. Harness scenarios assert the columns.
- **F-CRIT-2 actor dropped from dispatch idempotency key.** Same
  parent + same `clientRequestId` + two different actors used to
  yield two `command_operations` rows + two committed children
  (double-dispatch hazard). The clientRequestId is the deduplication
  boundary; `buildDispatchIdempotencyKey` / `buildDispatchBatchIdempotencyKey`
  now take only `(parentId, clientRequestId)`.
- **F-CRIT-3 `DISPATCH_CHILD_ID_NAMESPACE` moved to shared package.**
  Previously inlined at `dispatch.service.ts:25`. A regen via
  refactor would silently break retry-safety. Now in
  `packages/shared/src/idempotency.ts` with `buildDispatchChildId`
  helper; both single + batch use it.
- **F-CRIT-4 batch all-or-nothing documented** (this section).
- **F-IMP-2 `parent_not_case` registered code removed.** Post
  step1c.10c `public.tickets` only holds case rows, so the RPC's
  parent SELECT already returns `parent_not_found` for a work_order
  id — the `parent_not_case` arm was unreachable.
- **F-IMP-3 batch per-task FK validation verified.** Already present
  in v1's per-task loop; harness scenario 2 (cross-tenant assignee
  in task #2) was already asserting the all-or-nothing rollback.
- **F-IMP-4 `validate_assignees_in_tenant.*` codes registered.** The
  helper at 00317 raises codes that were NOT in `KNOWN_ERROR_CODES`;
  the RPC-side defense-in-depth raise fell through to
  `unknown.server_error` 500. Now registered with 422 status. Three
  codes: `assigned_team_id_not_in_tenant`,
  `assigned_user_id_not_in_tenant`, `assigned_vendor_id_not_in_tenant`.
- **F-IMP-5 `buildDispatchBatchIdempotencyKey` now used.** The
  helper was exported but the service built the key inline. Switched
  to the helper for symmetry with the single path.
- **F-IMP-6 randomUUID fallback dropped.** Mirrors §3.0 Commit B —
  no random-uuid fallback for SYSTEM_ACTOR. Workflow-engine + cron
  callers must pass an explicit `clientRequestId`.
- **F-IMP-7 dead coalesce arm dropped.** `coalesce(v_priority,
  v_parent.priority, 'medium')` — `tickets.priority` is NOT NULL
  DEFAULT 'medium' (00011:14), the third arg is unreachable.

**routing_trace embedded id validation — documented limitation
(F-IMP-1).** The trace's schema
(`apps/api/src/modules/routing/resolver.types.ts:87-92`) is
`{ step, matched, reason, target: AssignmentTarget | null }`. The
only embedded ids are per-step `target.team_id|user_id|vendor_id`
on matched steps. The final pick lands in the
`work_orders.assigned_*_id` columns and goes through
`validate_assignees_in_tenant`. Intermediate-step trace targets
(non-final picks) are audit-only — they describe what the resolver
considered, not what it wrote. Top-level `chosen_*_id` (mirrored from
`work_orders.assigned_*_id`) are tenant-validated. The trace is stored
verbatim; embedded ids are NOT re-validated.

`routing_rule_id` is now ALSO tenant-validated as of the Codex-S8-I1
remediation (2026-05-11) — see the §3.4 Step 8 codex remediation
section below. Pre-remediation only the assignee fields had a tenant
check; the routing_rule_id passed through into
`routing_decisions.rule_id` unvalidated. The FK on that column is
GLOBAL (00027:67), so a forged payload could leak across tenants in
the audit row.

## §3.4 Step 8 codex remediation (2026-05-11)

Codex-S8 surfaced three Important findings + one nit on top of the
self-review remediation. Resolved in one follow-up commit with
migration v3 supersessions (00340 helper + 00341 single + 00342 batch):

- **F-IMP-1 (codex-S8-I1) routing_rule_id tenant validation.**
  `routing_decisions.rule_id` has a GLOBAL FK (00027:67) — no tenant
  composite — so a forged dispatch payload could write tenant A's
  audit row pointing at tenant B's rule. v2 dispatched without a
  check. `validate_entity_in_tenant` v3 (00340) adds `'routing_rule'`
  to the allowlist; 00341 (single) + 00342 (batch) call it after the
  other top-level FK validations + before the `routing_decisions`
  INSERT. The batch path checks per-task — a single failure rolls
  back the whole batch (all-or-nothing contract preserved).
- **F-IMP-2 (codex-S8-I2) validate_entity_in_tenant.* codes
  registered.** The helper at 00321/00340 raises one code per kind
  + `unknown_kind` + `dispatch_missing`. None were in
  `KNOWN_ERROR_CODES`, so the defense-in-depth path
  (`mapRpcErrorToAppError`) fell through to `unknown.server_error`
  500. Now 12 codes registered: `case_not_in_tenant`,
  `work_order_not_in_tenant`, `asset_not_in_tenant`,
  `space_not_in_tenant`, `request_type_not_in_tenant`,
  `scope_override_not_in_tenant`, `workflow_definition_not_in_tenant`,
  `sla_policy_not_in_tenant`, `person_not_in_tenant`,
  `routing_rule_not_in_tenant` (404), plus `unknown_kind` and
  `dispatch_missing` (400). EN + NL message coverage in all 4 message
  files (api + web).
- **F-IMP-3 (codex-S8-I3) workflow batch failure halts.**
  `workflow-engine.service.ts:468-486` previously caught dispatch
  batch errors, `console.error`'d, and advanced the workflow as if
  children had been created. With all-or-nothing batch semantics
  (F-CRIT-4) this was an audit-log lie. Fix: on catch, flip
  `workflow_instances.status` to `'failed'`, emit a `node_failed`
  event (reason `dispatch_batch_failed` + task count + raw message),
  do NOT call `advance()`. Workflow halts at the node so ops can
  triage from the audit feed. Spec at
  `workflow-engine.service.spec.ts:130` rewritten to assert HALT
  (no advance, status='failed', node_failed event).
- **F-NIT-1 (codex-S8-N1) controller-layer mapping assertion.**
  Added a TS unit test in `dispatch.service.spec.ts` that exercises
  `mapRpcErrorToAppError` against the
  `validate_assignees_in_tenant.assigned_user_id_not_in_tenant`
  raise shape, asserting AppError(422) with the registered code.
  The harness scenario 8 still asserts the raise text from the
  database; this new test proves the wire shape ships correctly.
