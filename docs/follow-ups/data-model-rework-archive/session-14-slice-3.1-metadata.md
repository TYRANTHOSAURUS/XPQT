# Session 14 — Slice 3.1 metadata fields on work_orders

**Date:** 2026-05-01
**Branch:** `main`
**Commits:**
- `d9cccca feat(work-orders): Slice 3.1 — title / description / cost / tags / watchers` (initial)
- (next commit) `fix(work-orders): Slice 3.1 hardening from full-review — float normalization, service-layer guards, explicit-undefined detector`
**Closes:** exit-criteria item 1 of the data-model rework — desk-detail sidebar can mutate every WO field that's editable on the case side.

---

## What shipped

Backend:
- `UpdateWorkOrderDto` — 5 fields added: `title`, `description`, `cost`, `tags`, `watchers`. Match case-side `UpdateTicketDto`.
- `WorkOrderService.updateMetadata` — new method. Visibility gate (`assertCanPlan` operator floor — no danger-permission, mirroring `TicketService.update` for these fields). Loads current row, computes diff with deep-equal for tag/watcher arrays, no-op fast-path when every supplied field already equals current, bulk UPDATE only the differing fields, refetch and return.
- `WorkOrderService.update` orchestrator — new `metadata` branch added last in the dispatch order (sla → plan → status → priority → assignment → metadata). Metadata writes have no side effects on timers / status / cascade so order doesn't matter for them; last is the safe slot.
- Controller validation — 5 new type checks (title non-empty string, description string|null, cost finite-number|null, tags string[]|null, watchers string[]|null).

Frontend:
- `UpdateWorkOrderPayload` — 5 fields added.
- `patchWorkOrder` in `ticket-detail.tsx` — forwards all 5 fields. Existing inline editors (Title/Description) and the shared Labels SidebarGroup (Tags/Watchers/Cost) already call `patch()`; they were silently no-op'ing for work_orders before.

Activity emission: NOT added. Match case-side parity — `TicketService.update` doesn't emit per-field activity rows for these fields either. The audit-trail gap is pre-existing on the case side; if/when closed, both sides should grow the rows in the same slice.

Tests: +25 across two files.
- `work-order-update-metadata.spec.ts`: 21 unit tests covering basic writes, multi-field bulk, no-op fast-path including array deep-equal, partial no-op, empty-DTO rejection, NotFound, visibility gate, plus the 5 hardening tests (empty-title at service, non-finite cost, tags-non-string, float normalization no-op for 0.1+0.2 vs 0.3, fractional cost rounded to 2 dp).
- `work-order-update.spec.ts`: 4 orchestrator tests covering metadata-only dispatch, metadata + status mix with order assertion, explicit-undefined skip, partial explicit-undefined.

API + web lint clean. 87/87 work-order tests pass. CI A1..A12 still all pass on remote.

---

## Hardening applied from /full-review

### Critical
- Watcher uuid validation — flagged as a real but **same-on-case-side** gap. Filed as a Wave-0 follow-up: validate watcher person_ids against tenant on BOTH `TicketService.update` and `WorkOrderService.updateMetadata` in a single slice. Not in scope for Slice 3.1; documented in the "what's still open" section below.

### Important — applied this commit
1. **Cost float normalization.** Postgres `numeric(12,2)` round-trip via JSON converts `0.30000000000000004` → stored `0.30` → refetched `0.3`. Without normalization the no-op fast-path would never fire for fractional cost values and every PATCH would re-write the row. Fix: `Math.round(dto.cost * 100) / 100` before diff. Verified on remote: setting cost to `0.3` then PATCH'ing `0.1 + 0.2` no-ops (`updated_at` unchanged).
2. **Service-layer validation.** Empty-title, non-finite-cost, non-string-tag/watcher checks moved into `updateMetadata` itself (in addition to the controller). Internal callers (workflow engine, cron, SYSTEM_ACTOR paths) bypass the controller; service is the trust boundary. Codifies "validation that protects an invariant lives at the service layer."
3. **Explicit-undefined detector.** `{ status: 'new', title: undefined }` previously tripped `hasOwnProperty('title') = true` → `hasMetadata = true` → updateMetadata fired with empty inner DTO, doing an extra DB round-trip + visibility load for nothing. Worse: `{ title: 'real', cost: undefined }` would have gone via the build loop's `hasOwnProperty('cost') = true` → `metadataDto.cost = null` → cleared the cost the caller didn't intend to touch. Fix: introduced a `present()` helper that's `hasOwnProperty AND value !== undefined`; applied to all 6 detectors and all build loops.
4. **Defensive throw message** in the orchestrator updated to list all 15 fields (was missing the 5 metadata names).

### Important — deferred
5. **Browser click-through verification.** API-layer smoke test passed (9/9 + 5 hardening probes). The FE pipeline was not exercised by a human or Playwright. Same blind spot Sessions 7-12 had; flagging openly. Code path is small but "small" is not "verified."
6. **Audit rows for watchers / cost.** Plan reviewer made a reasonable case that vendor-mutating-watchers is a compliance-relevant action that warrants an audit row even in the absence of one on the case side. Defer with explicit follow-up: "audit rows for content/cost/tags/watchers — both case + WO sides, single slice." If we ship asymmetric protection it'll rot.
7. **Partial-commit on multi-branch failure.** Pre-existing orchestrator shape — each branch commits independently; a 422 on branch 3 leaves branches 1-2 written. Slice 3.1 doesn't introduce this but adds a 6th branch where it can manifest. Class-wide debt; transactional wrapper or 207-multi-status response are the two designs. Tracked alongside the activity-row swallow in the existing "transactional command pattern in SlaService" deferred item.

### Nit
8. **JSON.stringify for tag/watcher equality** — works for `string[]`, footgun for any future object[] or nested array. Note in code comment for next refactor.

---

## What's still open

- **Watcher / participant uuid validation** — both case + WO sides have the
  gap. A malicious authenticated tenant member can write arbitrary uuids
  (including other tenants' person ids) into the array. Within-tenant
  visibility predicate filters by `tenant_id` so cross-tenant data leak is
  blocked at read time, but ghost uuids pollute Realtime payloads and
  enable within-tenant unauthorized-share. Fix scope: validate
  `dto.watchers ⊆ select id from persons where tenant_id = $tenant` in
  both `TicketService.update` and `WorkOrderService.updateMetadata`.
  Same pattern as `validateAssigneesInTenant` already in use on the WO
  side. Slice it as one PR across both sides.
- **Audit rows for content/cost/tags/watchers** — both case + WO sides.
- **Browser click-through gate** — convert the existing one-off probe
  script into a checked-in vitest integration test (with current-row-XOR-
  sentinel value rule, per Session 13 lesson) OR Playwright spec, and
  wire into CI.
- **Partial-commit on orchestrator multi-branch failure** — class-wide
  debt; needs transactional wrapper or 207-multi-status response.

---

## Postmortem note

Sessions 13 and 14 both ran codex hitting quota. Both were closed with
full-review (the Anthropic two-gate adversarial review skill) as the
sole adversarial gate. Both caught real findings that would have shipped
otherwise — Session 13's A12 scope generalization, Session 14's
explicit-undefined detector + cost float normalization + service-layer
guard codification. Full-review is real signal, not theatre, when the
prompts are specific and the reviewer is given concrete pressure-test
questions rather than "review this please."

For destructive (DDL/RLS) work the codex-fragility policy still says
codex (or escalate). For additive feature work like Slice 3.1, full-
review-only is genuinely sufficient; codex would catch a different
class of bug but not necessarily more bugs.
