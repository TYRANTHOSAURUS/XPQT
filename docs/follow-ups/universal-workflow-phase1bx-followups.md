# Universal Workflow — Phase 1.B.x follow-ups

Phase 1.B (commit `d73d31fc`, 2026-05-12) shipped the engine
polymorphization at the **emit-site** layer plus the cancellation cascade
+ spawn-link safety check. It deliberately stopped short of full
polymorphization at the **dispatch** layer; this doc tracks that
deferral.

## 1. `executeNode` kind-polymorphization at the dispatch layer

**Status:** deferred. Inline TODOs at:

- `apps/api/src/modules/workflow/workflow-engine.service.ts:959` —
  notification node hardcodes `entityKind: 'case'` and projects via
  `projectLegacyEntityType` to `'ticket'`. The literal works for case-
  kind workflows; booking / work_order workflows that reach this branch
  would mis-emit `related_entity_type='ticket'` against a non-ticket
  entity.
- `apps/api/src/modules/workflow/workflow-engine.service.ts:1149` —
  approval node has the same shape: hardcodes `entityKind: 'case'` and
  projects to `'ticket'` so `ApprovalService.respond` keeps routing to
  the §3.5 `grant_ticket_approval` RPC.

**Why the deferral was intentional:** the dispatch-layer rewrite is
wider than Phase 1.B's scope. The full change shape is:

1. `executeNode(node, instanceId, graph, ticketId, ctx)` becomes
   `executeNode(node, instanceId, graph, entityKind, entityId, ctx)`.
2. Each call site that today passes `ticketId` (workflow controller
   surfaces, `startForTicket`, `resume`, advance/dispatch helpers) gets
   updated to thread the polymorphic kind alongside the id.
3. Per-domain `startForX` methods (`startForCase`, `startForBooking`,
   `startForWorkOrder`) replace the case-only `startForTicket` once they
   exist.
4. Each branch in `executeNode` that today hardcodes `'case'` or
   `ticketId` updates to use the resolved (entityKind, entityId) pair.

That's a multi-file refactor with audit-feed implications (every emit
shape changes shape on booking/work_order workflows). Phase 1.B shipped
the helpers (`projectLegacyEntityType`, `WorkflowEntityKind`, the
polymorphic id-column resolver, the cascade infrastructure) so the
dispatch rewrite has a clean foundation; the rewrite itself is the
Phase 1.B.x slice.

**Pre-conditions before opening 1.B.x:**

- Booking-only and work_order-only workflows have a real consumer (a
  feature actually triggers them). Today only case-kind workflows run
  in production tenants, so the `'case'` hardcode is functionally
  correct — the dispatch rewrite is paying down design debt for a
  future demand, not closing a live bug.
- A `startForX` method exists for at least one non-case kind, so the
  refactor has a concrete second caller (otherwise the polymorphism is
  speculative).

When both pre-conditions hold, the rewrite is mechanical: split
`executeNode`'s case-only references, thread `entityKind` through, and
delete the hardcoded `'case'` literals at :966 and :1156.
