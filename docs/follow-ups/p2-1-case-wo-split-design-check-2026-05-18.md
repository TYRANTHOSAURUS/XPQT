# P2-1 — case-vs-WO `TicketService` split: codex design-check + architecture prescription for the owner

**Date:** 2026-05-18
**Discovered/owned by:** the audit-02 best-in-class continuation workstream.
**Disposition:** **RE-DEFERRED** for the audit-02 engagement — codex
design-check attached, **user-acknowledged**. The shipped interim reject
guard (2026-05-17, commit `aac61b7a`) + this design-check = honest closure
for *this engagement's* bar (P2, non-completion-bar, sharp-edge already
neutralized). NOT a silent defer: routed here so the owner has an
actionable, codex-validated prescription.
**Owner:** integrator / data-model (verdict **Should-fix #16**).
**Estimate:** ~1 engineer-week (per the integrator estimate).
**Severity:** layering / ownership hygiene — **NO P0/P1 content**, **NO
latent cross-tenant hole** (codex-confirmed), **NO behavioral bug**. The
audit's "1978-line multi-day refactor" framing predates the shipped
`work-orders/` mutation-surface split and overstates what remains.

---

## The question asked of codex

The audit-02 brief mandated a codex design-check **before** any further
P2-1 action ("codex-design-first for P2-1"). The question put to codex:

> P2-1 (case-vs-WO `TicketService` split) is a P2 "cleanup", DEFERRED
> 2026-05-16 with a cheap interim guard SHIPPED 2026-05-17
> (`TicketService.update()` rejects a `work_order` id on
> `PATCH /tickets/:id` with the registered
> `ticket.work_order_id_on_case_endpoint` 400, covers bulk). Should the
> full service-layer split be executed now in this engagement, or
> re-deferred? If re-deferred, what is the precise target architecture
> the owner should implement, and what invariants must they preserve?

## The verdict — RE-DEFER (and why it is the honest call for this bar)

codex returned **RE-DEFER**. Decisive rationale:

- **The only unsafe residual the audit identified is already
  neutralized.** The audit's sole correctness sharp-edge was "a
  `work_order` id misbehaving on `PATCH /tickets/:id` (case-only
  validation on a WO row)". That is **already** closed by the shipped
  interim reject guard: `TicketService.update()` raises the registered
  `ticket.work_order_id_on_case_endpoint` 400 (covers
  `PATCH /tickets/bulk/update` as a per-id `results[]` error,
  batch not aborted) — commit `aac61b7a`.
- **The WO *mutation* surface is already fully separated.** WO mutations
  live in `apps/api/src/modules/work-orders/work-order.service.ts` (its
  own module). The audit's "1978-line multi-day `TicketService`→
  `…/WorkOrderService` re-architecture" framing **predates that split**
  — the heavy lifting is done. What actually remains is purely
  layering/ownership hygiene on the **READ** path + one misplaced WO
  factory method.
- **No latent cross-tenant hole.** codex confirmed the
  `getById`/`loadTicketRow` work_orders fallback is **tenant-scoped and
  visibility-gated** — there is no cross-tenant leak in the polymorphic
  resolver. (This is the audit-02 #0 invariant; codex was asked to
  verify it explicitly and did.)
- **Cost/benefit for *this* engagement is wrong.** What remains is a
  ~1-engineer-week READ-path extraction touching the polymorphic
  `getById` resolver + P1-5 child-visibility + cross-module consumers,
  with **regression risk to 6 shipped, reviewed, remote-pushed audit-02
  slices** (incl. 2 live RPC migrations) for **ZERO P0/P1 content**, in
  a **live multi-session shared tree**. Per the brief's "if a route
  remains intentionally interim, document the reason and risk", and per
  its #3 bar permitting "a fresh user-acknowledged re-deferral with the
  design-check attached", the disciplined call is: ship the interim
  (done), attach this design-check (this doc), route to the owner.

The user **acknowledged the re-deferral** on 2026-05-18.

## Prescribed architecture FOR THE OWNER (verbatim — apply when executed)

A **DELIBERATE HYBRID** — the audit framed the choice as a binary
("hard-split" vs "polymorphic-route") and criticized today's behavior as
"neither". codex's prescription is intentionally a *third, named* shape,
**not** the "neither":

- **Keep ONE explicit, *named* polymorphic id-resolver** for "id →
  visible entity". This is genuinely kind-agnostic: `/tickets/:id`,
  reclassify reloads, generic detail, and the activities surface do
  **not** know the entity kind a priori. This is a **named shared READ
  contract**, NOT the unprincipled fallback the audit criticized. The
  audit's complaint was that the fallback is *implicit and unowned*; the
  fix is to make it *explicit and named*, not to delete it.
- **HARD-SPLIT commands and kind-specific reads:**
  - **Stay in `TicketService` (case-only):** `list`, `update`,
    `reassign`, inbox, `create`, `bulkUpdate`.
  - **Move to `WorkOrderService`:** WO mutations, `getChildTasks`
    (child-WO listing), `createBookingOriginWorkOrder`.
- This is **consistent with the shipped reject-not-route semantics**:
  command endpoints stay hard-split (`PATCH /tickets/:id` rejects a WO
  id rather than transparently routing it — the 2026-05-17 interim).
  Only the *read* resolver is deliberately polymorphic-and-named.

## The TWO must-not-regress invariants (the owner MUST preserve both)

1. **`PATCH /tickets/:id` must keep resolving the current row and
   rejecting `ticket_kind === 'work_order'`** with the registered
   `ticket.work_order_id_on_case_endpoint` error. This is the shipped
   2026-05-17 interim sharp-edge fix; the split must not silently undo
   it (e.g. by transparently routing a WO id into `WorkOrderService`).
2. **Child-WO listing must keep the parent-case
   `assertVisible(parent, 'read')` precondition AND THEN filter children
   through `work_order_visibility_ids` (00374).** Parent-case visibility
   must **NEVER** imply child-WO visibility (this is the P1-5
   remediation — `getChildTasks` was closed precisely because it stopped
   inheriting parent visibility blindly). Moving `getChildTasks` to
   `WorkOrderService` is safe **ONLY IF** it still depends on the shared
   `TicketVisibilityService` for the parent precondition. The
   precondition is case-read logic, but **that is not a reason to keep
   the method in `TicketService`** — `WorkOrderService` may own the
   method while still calling the shared visibility service for the
   parent gate. Do not collapse the two-step gate into one.

## Precise residual surface (file:line — verify at write time)

Line numbers are approximate (the audit's 2026-05-16 ranges; the file
has grown since). Re-confirm against the tree before editing.

| What | Location | Move to | Note |
|---|---|---|---|
| `getById` tickets→work_orders fallback resolver | `apps/api/src/modules/ticket/ticket.service.ts` ~`599` (audit cited `583-624`) | **KEEP** as the explicit *named* polymorphic READ resolver | Genuinely kind-agnostic; codex-confirmed tenant-scoped + visibility-gated (no cross-tenant hole). The wart is that it is *implicit*, not that it exists — make it a named contract. |
| `getChildTasks` (child-WO listing) | `apps/api/src/modules/ticket/ticket.service.ts` ~`1656` (audit cited `1583-1588`) | **`WorkOrderService`** | Must still call the shared `TicketVisibilityService` for the parent-case `assertVisible(parent,'read')` precondition, THEN filter children via `work_order_visibility_ids` (00374). Invariant #2. |
| `createBookingOriginWorkOrder` | `apps/api/src/modules/ticket/ticket.service.ts` ~`2070` (audit cited `1872`) | **`WorkOrderService`** | **The only real layering wart** — ownership/cleanliness, NOT a behavioral bug. |
| `loadTicketRow` try-tickets-then-work_orders | `apps/api/src/modules/ticket/ticket-visibility.service.ts` (audit cited `359-394`) | collapse alongside the named resolver | Hand-rolls the WO join (no per-table FK alias for work_orders). One control flow, two implementations — consolidate when the resolver is named. |
| **The 1 cross-module consumer to rewire** | `apps/api/src/modules/service-routing/setup-work-order-trigger.service.ts:37` | repoint to `WorkOrderService` | The sole external caller of `createBookingOriginWorkOrder`; rewire when the method moves. |

## Scoped task list (for whoever picks up Should-fix #16)

1. **Name the polymorphic READ resolver.** Promote the implicit
   `getById` tickets→work_orders fallback into an explicit, documented
   "id → visible entity (kind-agnostic)" contract. Do **not** delete it.
   Collapse `ticket-visibility.service.ts` `loadTicketRow`'s try-both
   into the same named path.
2. **Move `createBookingOriginWorkOrder`** out of `TicketService` into
   `WorkOrderService`. Rewire the single consumer
   `setup-work-order-trigger.service.ts:37`.
3. **Move `getChildTasks`** into `WorkOrderService`, preserving the
   two-step gate (shared `TicketVisibilityService` parent precondition →
   `work_order_visibility_ids` child filter). Invariant #2.
4. **Keep command endpoints hard-split.** `TicketService` keeps
   case-only `list`/`update`/`reassign`/inbox/`create`/`bulkUpdate`;
   `PATCH /tickets/:id` keeps rejecting WO ids with
   `ticket.work_order_id_on_case_endpoint` (Invariant #1).
5. **Regression-gate the 6 shipped audit-02 slices.** This refactor
   touches code adjacent to P0-1/P0-2/P1-1/P1-2/P1-3/P1-5 closures —
   re-run `pnpm smoke:tickets` + `pnpm smoke:work-orders` (the mandatory
   gate for these surfaces) **isolated** (`smoke-tickets` has a
   documented FLAKE_INFRA characterization under concurrent shared-DB
   load — green in isolation; do NOT add a carve-out). Plus the full
   review cycle (codex pre-impl design-check → `/full-review` 2-agent →
   codex tertiary) since this is read-path surgery on smoke-gated code.
6. **Sync the living-contract docs** in the same change
   (`docs/visibility.md` for the `getChildTasks` move;
   `docs/assignments-routing-fulfillment.md` if the resolver naming
   touches any routing read path).

No migration is required (TS-only — service-boundary move + a named read
contract; the schema split is already complete).

## Why re-defer is honest closure for the audit-02 engagement bar

- **P2-1 is a P2 "Cleanup / nice to have"**, explicitly NOT a
  completion-bar item. The audit-02 completion bar is: no P0 raw-write
  bypass ✅; assignment-changing paths canonical/atomic-or-documented ✅;
  visibility-sensitive reads/writes code-covered ✅ + smoke ✅
  (discharged 2026-05-17); reference docs synced ✅. The service-layer
  split is **not** required by that bar.
- **The sharp-edge is already neutralized.** The single correctness
  consequence the audit identified (a WO id misbehaving on
  `PATCH /tickets/:id`) was closed by the shipped interim reject guard
  (2026-05-17, `aac61b7a`). What remains is pure module-boundary
  hygiene with **no P0/P1/cross-tenant content** (codex-confirmed).
- **The brief's #3 bar explicitly permits this.** "A fresh
  user-acknowledged re-deferral with the design-check attached" is a
  sanctioned outcome. The codex design-check was run 2026-05-18; the
  user acknowledged the re-deferral 2026-05-18; this doc is the attached
  design-check.
- **Executing it now would be net-negative for this engagement.** A
  ~1-week read-path refactor risking 6 shipped/reviewed/remote-pushed
  slices (incl. 2 live RPC migrations) for zero P0/P1, in a live
  multi-session shared tree, is exactly the kind of "gold-plating that
  endangers shipped work" the honest-ledger posture forbids. Deferring
  with a complete, codex-validated prescription routed to the owner is
  strictly better than guessing a multi-day re-arch unreviewed.

## Cross-references

- Closure Ledger row + `#### Update — 2026-05-18 — P2-1 codex
  design-check DONE → user-acknowledged RE-DEFER` narrative:
  `docs/follow-ups/audits/02-tickets-work-orders.md`.
- Original finding + 2026-05-16 deferral + 2026-05-17 interim:
  `docs/follow-ups/audits/02-tickets-work-orders.md` §P2-1 (finding,
  `#### Update — 2026-05-16`, `#### Update — 2026-05-17 — P2-1 cheap
  interim guard`).
- Integrator verdict: **Should-fix #16** in
  `docs/follow-ups/audits/00-integrator-verdict.md` (its #16
  reconciliation is folded into the final 02+00 ledger reconciliation
  step — not edited here).
- Cross-session routing register:
  `docs/follow-ups/audit-02-best-in-class-routing-2026-05-17.md`
  (P2-1 full split is already an owned line there).
- Sibling routed follow-ups from the same workstream/date (different
  mechanisms, same "route-don't-absorb" discipline):
  `docs/follow-ups/i2-sla-install-idempotency-due_at-2026-05-18.md`,
  `docs/follow-ups/i3-routing-eval-assignment-rpc-payload-drift-2026-05-18.md`.
