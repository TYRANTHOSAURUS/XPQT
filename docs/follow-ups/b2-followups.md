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

- **Workflow engine bypass (plan-review C3, 2026-05-11) — RESOLVED by
  B.2.A.Step9 (2026-05-11).** The workflow engine's `assign` and
  `update_ticket` nodes now route through `set_entity_assignment`
  (§3.2 / 00327 v2) and `update_entity_combined` (§3.0 / 00335 v5)
  respectively. The direct `.from('tickets').update(...)` writes are
  gone. Idempotency keys are stable per (workflow_instance, node,
  entity). The `update_ticket` allowlist was tightened from 29 fields
  to 14 (the orchestrator's branch surface); 17 orphan fields are
  documented below.

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

**Engines cut over (B.2.A.Step9, 2026-05-11).** The workflow engine
now routes through the orchestrator + sub-RPCs:

- `apps/api/src/modules/workflow/workflow-engine.service.ts` `assign`
  node calls `set_entity_assignment` (§3.2 / 00327 v2) with idempotency
  key `workflow:assignment:<instance>:<node>:<entity>`.
- `apps/api/src/modules/workflow/workflow-engine.service.ts`
  `update_ticket` node calls `update_entity_combined` (§3.0 / 00335 v5)
  with idempotency key `workflow:update_ticket:<instance>:<node>:<entity>`
  and a tightened 14-field allowlist (orphan fields rejected with
  `workflow.update_ticket_field_not_allowed` @ 422 — see new entry
  below).

Idempotency keys are stable across replays (same instance + node +
entity ⇒ same key ⇒ `command_operations` short-circuits). All
audit-row + domain-event emission moves to the RPC layer.

**`WorkOrderService.reassign` and `TicketService.reassign` still remain
outside §3.0** — both write via `.from('<table>').update(...)` plus a
`routing_decisions` audit insert. Folding reassign into
`set_entity_assignment` (§3.2) is a separate follow-up, not part of
Step 9. Until then reassign is a known second write path for the
reason field.

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
and the workflow does NOT advance.

**Latent regression closed by 00366 (2026-05-12).** The `node_failed`
emit shipped in Step 8 was vacuously broken from 2026-05-11 →
2026-05-12: the original CHECK constraint on `workflow_instance_events.event_type`
(00026:7-11) didn't include `'node_failed'`, and the `emit()` helper at
`workflow-engine.service.ts:992-994` wrapped the insert in a bare
`try {} catch {}` ("best-effort"). Result: every halt-on-batch-failure
event since Step 8 hit the CHECK, was rejected by Postgres, and silently
swallowed — instances showed `status='failed'` with zero node-level
audit evidence in the timeline. The Step 8 spec test
(`workflow-engine.service.spec.ts:200-207`) only spied on the `emit()`
call, not the row landing, so CI was green. **Closed by:** migration
00366 (relaxes CHECK to include `'node_failed'`); engine `emit()` catch
now `console.warn`s so future event_type / CHECK drift surfaces in logs;
`history-timeline.tsx` renders `node_failed` with `XCircle` +
"`${node_type ?? 'Node'} failed: ${payload.reason ?? 'unknown'}`". Two
P2 polish items shipped same day (848f1915): allowlist extracted to
`packages/shared/src/workflow.ts`, design-time validation in
`update-ticket-form.tsx`, all-or-nothing notice in
`create-child-tasks-form.tsx`. Pre-remediation the engine
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

## Workflow `update_ticket` orphan fields (Step 9, 2026-05-11)

Step 9 tightened the `update_ticket` node's field allowlist to the 12
fields the §3.0 `update_entity_combined` orchestrator accepts for case-
side targets (workflow update_ticket nodes always target the parent
case via workflow_instances.ticket_id). The following 19 fields were
ACCEPTED by the pre-cutover workflow engine and are now rejected with
`workflow.update_ticket_field_not_allowed` (@ 422):

- Ticket-flavor scalars: `impact`, `urgency`, `interaction_mode`, `source_channel`
- User-driven post-resolve: `satisfaction_rating`, `satisfaction_comment`, `form_data`
- Status-transition reasons: `close_reason`, `cancelled_reason`, `reclassified_reason`
- WO-only plan fields (review-remediation 2026-05-11): `planned_start_at`, `planned_duration_minutes`. Orchestrator's plan branch is WO-only (00335:170-173 raises `plan_not_supported_on_case`); workflow update_ticket targets cases. Rejecting here surfaces the clearer `workflow.update_ticket_field_not_allowed` (422) instead of the downstream `update_entity_combined.plan_not_supported_on_case`.
- FKs: `ticket_type_id`, `parent_ticket_id`, `requester_person_id`,
  `requested_for_person_id`, `location_id`, `asset_id`, `workflow_id`

**Why not silently dropped:** failing loudly forces workflow authors to
either (a) remove the field if it was accidental, or (b) request an
orchestrator branch extension if the field is genuinely needed. Silent
drop would hide the misconfiguration until production noticed the
ticket didn't change as expected.

**Per `project_no_wave1_yet` memory** — no production tenant currently
depends on these workflows. The cutover is risk-free in customer terms.
Demo workflows seeded with orphan fields will fail at the workflow run;
they should be updated or the field demand pushed up to Product.

**Path forward (if any field becomes needed):**

- `impact` / `urgency` — extend the priority branch in a v6+ orchestrator
  migration. Likely shape: separate sub-fields under the priority
  branch (`{priority, impact, urgency}`) so the activity event captures
  the full triad.
- `interaction_mode` / `source_channel` — extend the metadata branch.
- `close_reason` / `cancelled_reason` / `reclassified_reason` — extend
  the status branch with a `reason` sub-field per terminal transition.
  Today the case-side update path doesn't surface these on PATCH either;
  reclassification has its own dedicated `reclassify_ticket` RPC.
- FKs (`location_id`, `asset_id`, `requester_person_id`,
  `requested_for_person_id`) — extend the metadata branch with tenant-FK
  validation hooks. Each needs `validate_entity_in_tenant` integration
  plus an inline branch in the orchestrator.
- `ticket_type_id` — belongs to reclassify (Step 11 / §3.10), not
  update. Reclassification recomputes routing + workflow start; a raw
  update would leave the ticket in an inconsistent state.
- `workflow_id` — reject permanently from THIS surface. A workflow
  changing its own workflow_definition_id mid-execution would invalidate
  the in-flight instance's graph. `workflow_id` IS legitimately mutated
  elsewhere (webhook ingest sets it at create; reclassify_ticket
  recomputes it) — those paths are scope-correct because they invalidate
  the workflow instance atomically.
- `parent_ticket_id` — reject permanently from THIS surface. Mutating a
  case's parent post-create is a "merge" operation (move the case into
  a different domain); it has its own future RPC.
- `planned_start_at` / `planned_duration_minutes` (added 2026-05-11
  review remediation) — reject permanently from THIS surface. The
  orchestrator's plan branch is WO-only by spec; workflow update_ticket
  is case-targeted by data model. If a workflow needs to set a child
  WO's plan, the path is `create_child_tasks` (which dispatches the WO
  with the plan as part of the dispatch payload) — not update_ticket.
- `satisfaction_rating` / `satisfaction_comment` / `form_data` — defer
  until user-driven satisfaction workflow exists. Today these are
  applied via a direct side-write in `TicketService.update` after the
  RPC commits (plan-review I4 — see "Case-side satisfaction_rating +
  satisfaction_comment atomicity gap" entry above).

The 12-field allowlist itself is in
`apps/api/src/modules/workflow/workflow-engine.service.ts` under
`UPDATE_TICKET_ALLOWED_FIELDS`. Mirror this list when extending the
orchestrator's branch surface.

## Workflow node retry with edited config (Step 9 review, 2026-05-11)

Workflow nodes mint deterministic idempotency keys via
`buildWorkflowAssignmentIdempotencyKey(instance, node, ticket)` and
`buildWorkflowUpdateTicketIdempotencyKey(instance, node, ticket)` —
the key depends only on the (instance, node, ticket) tuple, not the
node's config payload. A retry of the same node on the same instance
+ ticket therefore hits the `command_operations` cache and returns
the cached_result.

This is correct when the node retries with the SAME config (legitimate
replay-after-transient-failure). But if an admin edits a workflow's
`update_ticket` node config WHILE the instance is paused/waiting and
then resumes the instance, the next call has the SAME key but a
DIFFERENT payload — the RPC raises `command_operations.payload_mismatch`
(409) and the workflow halts.

Current behavior: workflows DO NOT support mid-run node config edits
today (the workflow editor is design-time only; instances bind to a
snapshot of the definition). So this is a latent concern, not a live
bug. When the workflow editor adds mid-run edit support, the
idempotency key shape will need a config-hash component
(`workflow:update_ticket:<instance>:<node>:<ticket>:<config_hash>`) so
config edits produce a fresh command_operations row.

## Status-code shift on workflow.update_ticket_field_not_allowed (Step 9, 2026-05-11)

The pre-Step-9 code path raised this as 400; Step 9 maps it to 422 in
`STATUS_BY_CODE` (consistent with `validate_assignees_in_tenant.*_not_in_tenant`
and other "syntactically valid but logically misconfigured" cases).
Risk: a frontend handler keyed off the legacy 400 status code (rather
than the error `code` field) regresses. The error system is code-keyed
end-to-end so risk is small, but worth a one-line cite when reviewing
any frontend that consumes workflow-misconfiguration errors.

## Step 10 (grant_ticket_approval) reland — NOT "mechanical" — RESOLVED 2026-05-11

**Status:** Shipped as B.2.A.Step10 reland. Migration `00356_grant_ticket_approval_rpc.sql`
on remote. TS cutover live in `ApprovalService.grantTicketApproval`. Dead
code (`TicketService.onApprovalDecision` + `runPostCreateAutomation`)
deleted in the same commit.

All three contract drifts addressed:

1. **Approval enum gap (v10 / C2).** Both the CAS pre-check (RPC step 6
   surfaces `'already_responded'` for any non-`pending` status, which
   includes `delegated`) AND the chain/group resolution count
   (`status in ('pending', 'delegated')` at step 8 line 295) include
   the full non-terminal set. Harness scenario 8 asserts a delegated
   peer keeps the chain open even after all `pending` peers grant.

2. **F-CRIT-1 actor resolution.** RPC step 3 resolves
   `p_actor_user_id` (auth_uid) → `v_actor_users_id` + `v_actor_person_id`
   via a single lookup against `users` (citation: 00356:215-222 mirrors
   00350:499-512). Both partial-decision (step 8) and final-decision
   (step 13) domain_events INSERTs use `v_actor_users_id`. Harness
   scenario 9 asserts the FK resolves cleanly + the persisted value is
   `users.id` not `auth_uid`.

3. **F-CRIT-2 / S12-I2 started_at semantics.** RPC step 11 emits
   `sla.timer_recompute_required` with explicit `started_at: now()` in
   the payload (citation: 00356:434). The Step-12 SlaTimerHandler
   passes that value through to `start_sla_timers(p_started_at=...)`
   which persists it. Harness scenario 10 asserts the emit payload's
   `started_at` ≈ wall clock at grant time.

The migration occupies slot 00356 (00343 dropped via 00344; 00345-00355
allocated to Steps 11/12 + their hardenings). Shipped as a fresh feature
commit — not a revert-of-revert — so the audit trail reflects the
3-drift remediation work as deliberate net-new code.

## B.4.A.4 audit payload — chain_config_changed visibility (deferred, 2026-05-12)

Self-review on 00364 (edit_booking RPC v4) surfaced that the
`audit_events.details` payload for `booking.edited` carries
`approval_action`, `approval_old_outcome`, `approval_new_outcome`,
`approval_prior_state`, and `approval_chain_id` (citation:
`supabase/migrations/00364_edit_booking_rpc_v4.sql:991-995`) but does
NOT carry the TS-computed `chain_config_changed` boolean from the plan.

Follow-up: extend `audit_events.details` for `booking.edited` events to
include `chain_config_changed` boolean from `p_plan.approval` when the
approval action is non-noop. Lets post-hoc auditors detect plan-builder
bugs: if a tenant complains "this edit shouldn't have re-triggered
approval", the audit row tells us whether TS claimed the config changed
(separating "TS plan-builder bug" from "RPC executed the table
correctly given the input").

**Why deferred, not folded into the closing commit:** migrations are
immutable in this project — every change is a new file. Creating a
~70-line v5 supersession migration of 00364 to add one jsonb key to
one event is poor cost/benefit. Bundle into the next v5 supersession
of `edit_booking` (next time a real defect requires touching the RPC).

Low-priority — only matters when investigating a tenant complaint
about unexpected approval re-trigger. No correctness impact on the
write path; cosmetic on the audit row.

## audit-02 P0-2 — SLA escalation reassign now routes through `set_entity_assignment` (closed, 2026-05-16)

**Status:** closed (code; live smoke deferred to the orchestrator).

The audit-02 P0-2 finding (`docs/follow-ups/audits/02-tickets-work-orders.md:97`)
was acknowledged **nowhere** until now (the b2-followups note at :165-170
covers only the user-driven `WorkOrderService.reassign` /
`TicketService.reassign` paths — it explicitly did not cover the
cron-driven SLA escalation path, which had *none* of that scrutiny).

The SLA escalation cron previously reassigned tickets/work_orders via a
raw `UPDATE` (`SlaService.updateTicketOrWorkOrder`): zero
`command_operations` row (no idempotency — a re-fired cron tick
re-applied), zero `routing_decisions` audit, zero `ticket_assigned`
domain event.

Closed by routing the escalation-reassign path
(`SlaService.applyReassignment`, `apps/api/src/modules/sla/sla.service.ts`)
through the canonical RPCs:

- **Assignment** → `set_entity_assignment` (00327 v2), idempotency key
  `sla:escalation:<sla_timer_id>:<at_percent>:<timer_type>` — the exact
  `crossingKey` identity (`sla-threshold.types.ts:33`), deterministic per
  *crossing*. `timer_type` is required: a `both`-scope threshold crosses
  for the response and resolution timers at the same `at_percent`; without
  it those two legitimate crossings collide on one `command_operations`
  key. A re-fired tick for the same crossing replays the cached result
  instead of re-applying. `reason` non-null ⇒ the RPC writes the
  `routing_decisions` + `reassigned` activity + `ticket_assigned` domain
  event atomically.
- **Watchers** → `update_entity_combined` (00384 v6) metadata branch,
  key `…:<timer_type>:watchers`, called only when the watcher set changes. The
  outgoing assignee's `users.id` is translated to its `persons.id`
  before being added — `tickets.watchers` is a persons.id[] column
  (00011:26) and v6 validates against `persons`; the legacy raw path
  added the raw `users.id`, a latent ID-type bug now corrected here.
- Entity kind (`case`/`work_order`) is resolved once by
  `loadTicketForFire` (now returns `entity_kind`) — no extra probe.
- The now-duplicate `writeActivity` "SLA escalated …" `system_event`
  row was removed: `set_entity_assignment` writes the canonical
  `reassigned` activity for the same logical event. With its sole
  caller gone the method was dead code and was deleted (structural
  enforcement of the single-write-path contract — same precedent as
  the "Dead code removed" note at :172).
- **Recurrence-safety (codex BLOCK fix).** Post-assignment side-effects
  in `fireThreshold` — the watcher copy AND the notification — are
  best-effort: on failure each emits telemetry
  (`sla_escalation_watcher_skipped` / `sla_escalation_notify_failed`) and
  flow continues to write the crossing row (the idempotency anchor that
  suppresses re-fire). If either threw, the committed-assignment +
  no-crossing state would make the cron re-fire forever (assignment
  replays harmlessly; the failing side-effect re-throws every tick).
  Only `writeCrossing` itself failing leaves a bounded retry window.

No migration — `set_entity_assignment` (00327) and
`update_entity_combined` (00384) already provide every guarantee. The
legitimate SLA-internal raw writes (response/resolution `due_at`,
pause/resume, restart/clear, `sla_at_risk`) still go through
`updateTicketOrWorkOrder` unchanged — only the escalation-reassign
changed.

Verified: `pnpm -C apps/api lint` (tsc --noEmit) pass ·
`pnpm errors:check-app-errors` pass (0 raw throws). Live smoke handled
by the orchestrator.

Doc synced same commit: `docs/assignments-routing-fulfillment.md`
gained a "SLA escalation reassign" subsection under §7 (closes the
audit doc-drift finding §342).
