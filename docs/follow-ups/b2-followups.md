# B.2 follow-ups

Deferred / known-issue index for the B.2.A workstream (orchestrator
RPCs + controller cutover). Items here are intentional non-fixes,
documented so future readers don't re-discover them as bugs.

## §3.0 update_entity_combined — review-deferred items

Items surfaced in the post-Commit-A self full-review (2026-05-11) that
were intentionally not folded into v2 (00332):

- **Branch ordering: status→sla wasted outbox emit.** If a single
  call patches both `waiting_reason` and `sla_id`, the status branch
  sets `recompute_pending=true` on the existing timers, then the sla
  branch stops those timers (`stopped_at=now()`) and inserts fresh
  ones with `recompute_pending=false`. End state is correct (fresh
  timers under the new SLA); the only impact is one wasted
  `sla.timer_recompute_required` outbox emit per (status+sla)
  combined call. The worker queries `recompute_pending=true AND
  stopped_at IS NULL` and finds none, no-ops. Cosmetic; revisit if
  the worker's cost-per-event grows. Spec line 1816-1837 explicitly
  orders status first.

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
