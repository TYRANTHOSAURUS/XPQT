# Step 1c baseline — pre-flight audit

**Date:** 2026-04-30 evening
**Source:** Remote DB (project `iwbqnyrvycqgnatratrk`)
**Captured by:** Phase 1c.0 of `docs/data-model-step1c-plan.md`

## Why this exists

Before any 1c phase ships, the gate is: capture the truth on the ground. Every later phase has a verification step that compares to these numbers. Drift between baseline and post-phase numbers is the first thing we look at when something seems off during the dual-write soak.

## Baseline metrics

| Metric | Count | Notes |
|---|---|---|
| `tickets where ticket_kind='case'` | 241 | will become `cases` table |
| `tickets where ticket_kind='work_order'` | 319 | will move to `work_orders` table |
| `sla_timers` attached to cases | 484 | ~2 timers/case (response + resolution) |
| `sla_timers` attached to work_orders | 646 | ~2 timers/WO |
| `routing_decisions` attached to cases | 243 | basically 1:1 with cases |
| `routing_decisions` attached to work_orders | 0 | no WO routing logged yet in dev |
| `ticket_activities` attached to cases | 1083 | |
| `ticket_activities` attached to work_orders | 319 | 1:1 with WOs |
| `workflow_instances` attached to cases | 216 | |
| `workflow_instances` attached to work_orders | 0 | no workflows on WOs in dev |

## Parent-link distribution for work_orders

| Shape | Count | Notes |
|---|---|---|
| `wo_with_case_parent` | 319 | all WOs case-origin via `parent_ticket_id` |
| `wo_with_bundle_parent` | 0 | no booking-origin WOs in dev |
| `wo_with_both_parents` | 0 | constraint already enforces this (00208) |
| `wo_with_neither_parent` | 0 | no orphan WOs |

**Implication:** in this dev DB, slice 2 (booking-origin work orders) is implemented in code but hasn't been exercised — every WO is case-origin. Production DBs may have a different distribution. Re-run this audit against production before phase 1c.1 if production data shape differs from dev.

## Booking-side context

| Metric | Count |
|---|---|
| `booking_bundles` | 6 |
| `tickets` with `booking_bundle_id` set | 0 |

The bundle ↔ ticket FK is wired (00145) but no rows use it yet in dev.

## What this baseline guarantees

- Phase 1c.2 backfill will copy exactly **319 rows** from `tickets where ticket_kind='work_order'` into `work_orders_new`.
- Phase 1c.3 dual-write soak's daily divergence check expects 0 difference between `count(*) from tickets where ticket_kind='work_order'` and `count(*) from work_orders_new`.
- Phase 1c.6 `sla_timers` migration will set `entity_kind='work_order'` on **646 rows** and `entity_kind='case'` on **484 rows**.
- Phase 1c.10c destructive drop will delete **319 rows** from `tickets`.

## Open audit followups

- Re-run this audit against the production database before any 1c phase ships there. Dev numbers diverge from production.
- Check `seed/centralised-example-reset` (`00100`) impact on these counts — the reset wipes data; numbers post-reset may differ.
- Verify cross-tenant integrity: `select count(distinct tenant_id) from tickets where ticket_kind='work_order'` to confirm WOs are tenant-distributed as expected.
