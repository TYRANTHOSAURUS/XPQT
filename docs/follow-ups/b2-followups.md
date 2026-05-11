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
