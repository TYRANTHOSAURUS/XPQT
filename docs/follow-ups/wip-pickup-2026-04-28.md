# WIP pickup — 2026-04-28 main-branch dump

This file documents the uncommitted changes that were sitting on `main` at the
end of the 2026-04-28 session, committed as one bundle so the work isn't lost
and so future sessions can resume from a clean tree.

The bundle is **two coherent feature slices that were left mid-flight from
prior sessions**, plus a batch of design-spec docs that shipped through the
2026-04-28 roadmap reset (referenced from `MEMORY.md` already).

---

## Slice 1 — Routing Studio cutover (retire feature flag + legacy pages)

The `features.routingStudio` flag and the four legacy admin routing pages
(`routing-rules`, `location-teams`, `space-groups`, `domain-parents`) are now
removed; Routing Studio is the canonical surface.

**Code surface in this bundle:**

- `apps/web/src/lib/features.ts` — **deleted**. It only held the
  `routingStudio` flag; no other flags lived there. Once the flag was
  retired, the file became dead code.
- `apps/web/src/App.tsx` — flag-gated routes converted into permanent
  `Navigate` redirects (`/admin/routing-rules` → `/admin/routing-studio?tab=rules`,
  etc.) so old bookmarks land on the right Studio tab. The Studio route
  itself is no longer flag-gated.
- `apps/web/src/lib/admin-nav.ts` — the legacy "Routing rules / Location
  teams / Space groups / Domain parents" nav items are gone; "Routing Studio"
  is the single entry under the Routing nav group.
- `apps/web/src/pages/admin/{routing-rules,location-teams,space-groups,domain-parents}.tsx`
  — **deleted**.
- `apps/web/src/components/admin/routing-studio/legacy-page-banner.tsx` —
  **deleted**. It was a "this page is going away soon" banner shown on the
  legacy pages; pointless now that they're gone.

**Bonus feature in the same slice — "Routed by …" pill on ticket detail:**

> **Reverted on 2026-04-29.** The pill was removed from the ticket-detail
> sidebar — putting admin-investigation info on every operator's screen, on
> every ticket, was the wrong placement. The Routing Studio cutover above
> stays. All code listed in this subsection is gone; the Studio's audit tab
> can still be filtered by ticket id manually via its existing input.

A breadcrumb pill on the ticket detail sidebar that surfaces the latest
`routing_decisions` row for a ticket so an operator can answer "why was this
ticket routed here?" without leaving the detail view.

- `apps/api/src/modules/ticket/ticket.controller.ts` — new
  `GET /tickets/:id/routing-decision` endpoint, gated by the same visibility
  predicate as `GET /tickets/:id` (deliberately *not* requiring the admin-side
  `routing.read` permission so any operator who can see the ticket can see
  the decision).
- `apps/api/src/modules/ticket/ticket.service.ts` — new
  `getLatestRoutingDecision(id, actorAuthUid)` method that joins
  `routing_decisions` with `routing_rules` and projects a flat `{decided_at,
  strategy, chosen_by, rule_id, rule_name, target_kind, target_id}` shape.
- `apps/api/src/modules/ticket/ticket-routing-decision.spec.ts` — **new**
  spec covering the visibility gate + the rule-name join + the null-shape for
  manually-routed (no decision) tickets.
- `apps/web/src/api/tickets/keys.ts` + `queries.ts` — new key + hook
  `useTicketRoutingDecision(ticketId)`.
- `apps/web/src/components/desk/routing-decision-pill.tsx` — **new** component.
  Renders the rule name (or `humanizeChosenBy(chosen_by)` fallback for
  asset-branch / location-branch / etc), with a `<time>` rel-time, and links
  to `/admin/routing-studio?tab=audit&ticket=:id` so non-trivially-curious
  ops can dig into the full audit.
- `apps/web/src/components/desk/ticket-detail.tsx` — adds the new
  `<RoutingDecisionPill ticketId={...} />` row to the ticket-detail sidebar
  under a new `Routed by` `InlineProperty` label.
- `apps/web/src/components/admin/routing-studio/audit-tab.tsx` +
  `apps/web/src/pages/admin/routing-studio.tsx` — accept an `initialTicketId`
  prop seeded from the deep-link `?ticket=<id>` query param. When supplied,
  the Decisions sub-tab pre-fills its ticket-id filter and defaults the
  "since" window to `all` so old tickets don't disappear behind a 7-day cap.

**Pickup notes:**

- The Studio cutover and the decision pill were developed together in a prior
  session. The Studio side has tests; the pill itself doesn't have a unit
  test on the React side (the API spec covers the data path).
- The Studio's `routing.read` permission gate is unchanged — the *audit
  page* still requires admin, but the pill's own data fetch uses the
  ticket-visibility gate so operators can see the decision without
  Studio-level access.
- Run `pnpm exec jest --testPathPattern=ticket-routing-decision` as the
  smoke before relying on the pill in prod.

---

## Slice 2 — Master roadmap reset spec docs

Eleven design spec files + cross-cutting coordination docs added during the
2026-04-27/28 roadmap reset. These match the references in `MEMORY.md`
(`reference_*` entries) but were never staged.

**Spec docs (each is a self-contained design spec, ~50–200 KB):**

- `docs/superpowers/specs/2026-04-27-gdpr-baseline-design.md`
- `docs/superpowers/specs/2026-04-27-microsoft-graph-integration-design.md`
- `docs/superpowers/specs/2026-04-27-requester-rating-design.md`
- `docs/superpowers/specs/2026-04-27-vendor-execution-ux-design.md`
- `docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md`
- `docs/superpowers/specs/2026-04-27-vendor-scorecards-design.md`
- `docs/superpowers/specs/2026-04-27-visitor-management-design.md`
- `docs/superpowers/specs/2026-04-27-visual-rule-builder-design.md`

**Cross-cutting docs:**

- `docs/booking-platform-roadmap.md` — master roadmap for ALL booking
  processes (rooms / desks / asset / parking / visitors / services /
  cross-cutting) with parity gates per feature.
- `docs/competitive-benchmark.md` — Tier-A competitor benchmark
  (Planon / Eptura / deskbird) across every booking process; flags 7
  Prequest moats to defend.
- `docs/cross-spec-dependency-map.md` — orchestration view across all 9
  specs (5 waves, critical path, shared infra, validation checkpoints,
  risk register).

**Pickup notes:**

- Don't edit the daily-list spec wholesale without flagging — it's the
  spec that landed Phase A this session and any rewrite needs to
  coordinate with the running implementation in
  `apps/api/src/modules/daily-list/`.
- The cross-spec dependency map is the right starting point for any
  "what should we ship next?" question. It already accounts for the
  fact that Daily-list Phase A backend + frontend, Rule Builder
  Sprint 1B, and the mail substrate are done.

---

## Slice 3 — Smaller doc tweaks

These are short edits to existing docs that came along with the larger
slices but don't fit either of them cleanly:

- `docs/assignments-routing-fulfillment.md` — small clarification on the
  routing-decision audit log field semantics (motivated by the Routed-by
  pill work in slice 1).
- `docs/booking-services-roadmap.md` — small backlog updates and Tier
  re-tagging that came out of the 2026-04-28 roadmap reset.
- `docs/centralised-example-data-seed.md`,
  `docs/inbound-webhooks-plan-2026-04-23.md`,
  `docs/routing-studio-improvement-plan-2026-04-21.md`,
  `docs/seed-migration-chain-runbook.md` — minor wording tweaks.
- `docs/service-catalog-collapse-status-2026-04-23.md` — **deleted**;
  superseded by the service-rule-resolver work that shipped earlier
  this session.

---

## Why one bundled commit

Splitting these across 3 commits would have been cleaner, but:

- Slice 1 (Routing Studio cutover) was already coherent and tested by the
  prior author; re-deriving its split history risks introducing typos.
- Slice 2 (spec docs) is pure new content; no diff to bisect.
- Slice 3 is small enough that a per-doc commit graph would just be noise.

So we committed them as one "WIP pickup" bundle and recorded what each part
does HERE so future bisects have a navigable handle.

---

## What this bundle does NOT include

- No DB migrations (the routing-decision endpoint reads existing
  `routing_decisions` rows; no schema change).
- No new permissions / RLS policies.
- No Sprint 4 vendor-portal mail work — that's covered by the parallel
  `docs/follow-ups/vendor-portal-phase-b-sprint4-5.md` follow-up.
- No daily-list / rule-builder / mail-substrate work — those shipped in
  their own commits earlier in the session.
