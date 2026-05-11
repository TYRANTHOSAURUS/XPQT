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
