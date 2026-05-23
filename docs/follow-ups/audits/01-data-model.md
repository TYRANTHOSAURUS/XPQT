# Data Model Architecture Audit
Date: 2026-05-13
Auditor: data-model-agent

## Executive verdict
- Status: **mostly done**
- Best-in-class: **close**
- Confidence: **high** on the schema, **medium** on legacy-mid-flight items (Step 0 polymorphic activities, role_audit_events drop, naming sweep)

The canonical schema rework is structurally complete. Booking canonicalisation (`bookings`/`booking_slots` from `booking_bundles`/`reservations` — 00276/00277/00278) shipped destructively. The tickets/work_orders split (00213→00233) shipped destructively. Tenant isolation is enforced via three layers: (1) RLS tenant_isolation policies on every domain table, (2) trigger-based tenant assertion on polymorphic / cross-table FKs that single-column FKs can't enforce (e.g. `00053_spaces_tenant_purity.sql`, `00370_workflow_instance_links.sql:205-228`, `00400_room_booking_rules_workflow_definition_fk.sql:assert_*_tenant`), (3) a `validate_entity_in_tenant` RPC helper (`00360_validate_entity_in_tenant_v5_team_kind.sql`) called from PL/pgSQL RPCs before any FK-bearing INSERT. Multi-step writes are correctly consolidated as PL/pgSQL RPCs per the spec (`create_booking_with_attach_plan`, `edit_booking`, `grant_booking_approval`, etc.). Outbox is a proper schema (`outbox.events` with idempotency_key + payload_hash), not a hand-rolled pattern on `domain_events`. The remaining gaps are: (a) ~410 migrations with **10 duplicate prefixes** in the 00367-00400 range — concurrent branches collided and were never resolved; (b) the Step-0 polymorphic activities sidecar is write-only — no app code reads from `activities`, and `ticket_activities` is still the live read+write surface kept in sync via a shadow trigger; (c) `role_audit_events` table is still present despite 00192 collapsing its writes into `audit_events`; (d) the TS naming sweep (Phase 8) has not started — 1053 entries in the API allowlist; (e) older tables (bookings, tickets, work_orders) still use single-column UUID FKs to persons/spaces/cost_centers without composite `(tenant_id, id)` constraints, while newer tables (maintenance_plans 00386, work_orders PM cols 00387) correctly use composite tenant FKs. This pattern inconsistency is the largest remaining architectural debt.

## P0 findings (correctness/security risks)

### [P0] Migrations — Ten duplicate prefix collisions in the 00367-00400 range
Evidence: `supabase/migrations/00367_edit_booking_scope_rpc.sql` + `supabase/migrations/00367_spaces_floor_plan_render_hint.sql`; same for 00368, 00369, 00370, 00371, 00372, 00373, 00374, 00376, 00400. Confirmed via `ls supabase/migrations | awk -F_ '{print $1}' | sort | uniq -d` (10 hits).
Why it matters: Supabase migrations are applied in filename-sort order. When two files share a numeric prefix, they run in alphabetical order of the suffix — but the original author's intended ordering was inferred from spec headers ("originally drafted at slot 00374; landed at 00376"). On a fresh `db:reset`, the alphabetical order on the suffix may differ from the order the workstreams expected, and a future migration that lists "after 00370" loses determinism about whether it means the floor-plan or the workflow-link 00370. `supabase/migrations/00370_workflow_instance_links.sql:7-16` and `supabase/migrations/00376_workflow_events_extend_for_cancellation.sql:8-15` both document slot-renumber incidents at execution time — proof the team has hit this. Not yet a correctness bug because the two halves of each duplicate touch disjoint tables, but it is a P0 ordering-determinism risk: the moment a future migration depends on a specific 00370/floor-plan vs. 00370/workflow ordering, the chain becomes non-deterministic across environments.
Recommended fix: Renumber the floor-plan branch upward into the 00370-00410 unused slots and add a `scripts/check-migration-prefix-unique.sh` CI guard. The team already has a slot-collision RFC pattern in migration headers — formalise it.

### [P0] Composite (tenant_id, id) FKs are inconsistent — older tables can be smuggled cross-tenant
Evidence: `00277_create_canonical_booking_schema.sql:36` (`requester_person_id uuid not null references public.persons(id)`), `:41` (`location_id uuid not null references public.spaces(id)`), `:61` (`cost_center_id uuid references public.cost_centers(id)`). All single-column FKs without `(tenant_id, X)` composite constraint. Same pattern on `tickets` (`00011_tickets.sql:6-23`) and `work_orders`. Compare to `maintenance_plans` (`00386_maintenance_plans_schema.sql:76-90`) and `work_orders` PM columns (`00387_work_orders_pm_columns.sql:28-34`) which DO use composite tenant FKs.
Why it matters: With single-column FKs, the database cannot enforce that a `booking.location_id` belongs to `booking.tenant_id`. RLS prevents reads, and `validate_entity_in_tenant` catches RPC writes, but **direct `supabase.admin` writes from TS code bypass RLS AND don't go through the helper**. The team has shipped a regression test (`apps/api/src/modules/cross-tenant-fk-leak-writes.spec.ts`, 14 sites) and a sibling read-side spec to catch missing `.eq('tenant_id', ...)` filters — but tests are a TS-side guard, not a schema-side guard. The composite FK is the only schema-level guarantee.
Recommended fix: Migration sweep adding `unique (tenant_id, id)` to every domain table + retargeting every FK on bookings/tickets/work_orders/booking_slots/visitors/orders/approvals to use composite `(tenant_id, X)` FKs. Pattern is already proven in 00386/00387 — copy it. Pair with a CI check that fails on new single-column UUID FKs to tenant-scoped tables.

## P1 findings (architectural debt)

### [P1] Step-0 polymorphic activities sidecar is write-only — never read
Evidence: `00202_activities_polymorphic_sidecar.sql:25` creates `public.activities` with the entity_kind discriminator. Shadow trigger at `00204` / repaired at `00235_step1c10c_followup_ticket_activities.sql:32` copies every `ticket_activities` INSERT into `activities`. **Zero hits** for `.from('activities')` across `apps/api/src/modules/` — confirmed by `grep -rln "\.from\('activities'\)" apps/api/src/modules/`. Meanwhile `ticket_activities` is still actively read/written by `ticket.service.ts:399`, `:457`, `:1424`, `:1507`, `work-order.service.ts:1031`, `sla.service.ts:824`, `routing-evaluation.handler.ts:361`.
Why it matters: The "polymorphic timeline" promise from `docs/data-model-redesign-2026-04-30.md:88-93` is half-built. Every byte of `activities` is duplicated, indexed, and RLS-protected — paying full storage + write cost for zero read benefit. Worse, the shadow trigger still uses `entity_kind = 'ticket'` as a fallback when the source row can't be classified (`00235:48-49`), guaranteeing some rows in `activities` are mis-classified. The polymorphic table also still admits `entity_kind = 'ticket'` (umbrella, pre-step1 legacy — 00288:73) and `'service_order'` (never used). Reads on case detail / work_order detail / booking detail UIs all UNION from ticket_activities or query the per-entity surface — the redesign's "one timeline projection" benefit is unrealised.
Recommended fix: Cut readers over to `activities` (this is the work the doc said was the whole point); drop the shadow trigger; drop `ticket_activities` and re-FK every column to the right kind; tighten the CHECK constraint to remove `'ticket'` and `'service_order'`.

### [P1] role_audit_events table still exists — was supposed to be dropped after API rollout
Evidence: `00192_collapse_role_audit_events.sql` has Phase-1 backfill but explicitly defers the table drop ("PHASE 2 (follow-up migration, after every API instance is on the new code): drop role_audit_events"). `apps/api/src/modules/user-management/user-management.service.ts:508` confirms the API is on the new code. Memory item `role_audit_events table drop pending` flags this.
Why it matters: Dormant table with active RLS policy, distinct indexes, and a stale CHECK shape. It also fragments the audit story — a forensic reader needs to know that pre-cutover events live in one table, post-cutover events in another.
Recommended fix: One-migration drop: `drop table public.role_audit_events cascade; notify pgrst, 'reload schema';`.

### [P1] Phase 8 TS naming sweep not started — 1053 allowlist entries hide silent contract drift
Evidence: `apps/api/src/.naming-allowlist.txt` is 1053 lines (`wc -l`). `apps/web/src/.naming-allowlist.txt` is 191. The Phase 8 plan at `docs/follow-ups/phase-8-canonical-naming.md` is v1 status, no implementation. Concrete examples of stale references in production paths:
- `apps/api/src/modules/ticket/ticket.service.ts:1876` still names the argument `booking_bundle_id` (function comment at :1868 claims "kept for caller-signature stability"). Forwarded as `booking_id: args.booking_bundle_id` at :1922.
- `apps/api/src/modules/service-routing/setup-work-order-trigger.service.ts:105` calls `createBookingOriginWorkOrder({ booking_bundle_id: args.bundleId, … })` — production code, not a comment.
- `apps/api/src/modules/visitors/dto/create-invitation.dto.ts:48-49` keeps `booking_bundle_id?: string` as a documented `@deprecated` alias accepted on the wire.
- Comment at `ticket.service.ts:1917`: "Reverse shadow trigger keeps tickets in sync" — **stale**: the work_orders↔tickets shadow triggers were dropped in `00233_step1c10c_destructive_cutover.sql:54-55`. Future contributors will read this comment and reason from a model that no longer matches the schema.
Why it matters: 209 + 132 + likely 200+ frontend sites carry inconsistent vocabulary. Every new feature inherits the inconsistency. The naming-allowlist diff CI guard described in `phase-8-canonical-naming.md` §2 hasn't been built — drift is invisible.
Recommended fix: Phase 8.A.2 sweep + the diff-CI guard. Strictly TS-only refactor; schema asymmetries (`tickets.ticket_type_id` ↔ config `request_type_id`) are documented as intentional in B.2 §0.1 and stay.

### [P1] asset_reservations exclusion constraint lacks tenant_id
Evidence: `00142_asset_reservations.sql:27-31`:
```
exclude using gist (
  asset_id with =,
  time_range with &&
) where (status = 'confirmed')
```
Compare to `00277_create_canonical_booking_schema.sql:211-217` which correctly includes `tenant_id with =`.
Why it matters: Today UUIDs collide-resistantly so cross-tenant asset_id collision is astronomically rare. But the *pattern* is asymmetric and a future schema change (e.g. an asset migrating tenants during a re-tenant operation, or pre-seeded fixture UUIDs) would silently allow double-bookings or, worse, raise conflict errors across tenant boundaries. The booking_slots version uses the correct pattern; asset_reservations should match.
Recommended fix: One additive `alter table … add constraint … exclude using gist (tenant_id with =, asset_id with =, time_range with &&) where (status='confirmed');` + drop the old constraint. Trivial migration; closes a defense-in-depth gap.

### [P1] approvals.target_entity_id is polymorphic but has no FK and no validate-in-tenant
Evidence: `00012_approvals.sql:6-7` (`target_entity_type text`, `target_entity_id uuid` — both untyped), narrowed to `('booking','order','ticket','visitor_invite')` in `00278:170-172`. No trigger asserts that `target_entity_id` actually exists in the named table and shares `tenant_id`.
Why it matters: `validate_entity_in_tenant` (00360) covers approver_team_id / approver_person_id, but **not** the target. The same class of cross-tenant smuggling that drove the v3/v4/v5 expansion of `validate_entity_in_tenant` applies here. A privileged caller could insert an approval row pointing at another tenant's booking; the post-decision RPC would then write back into the wrong tenant.
Recommended fix: Add a trigger or extend the polymorphism-validate pattern from `validate_workflow_instance_polymorphism` (00369:394+) to assert (target_entity_type, target_entity_id, tenant_id) match.

## P2 findings

### [P2] activities.entity_kind CHECK still admits 'ticket' (umbrella) and 'service_order' (unused)
Evidence: `00288_tighten_legacy_enum_values.sql:70-80` admits `('ticket','case','work_order','booking','order','service_order')`. The `'ticket'` value is documented as "legacy umbrella; pre-step1 split". The `'service_order'` value never appears in any code path — confirmed by `grep -rn "service_order" apps/api/src/`.
Why it matters: Stale CHECK allows mis-classified writes. Defense-in-depth shrinks the allowed set to what the code actually uses.
Recommended fix: Tighten in one migration to `('case','work_order','booking','order')` once Step-0 reader cutover happens (P1 #1). They go together.

### [P2] recurrence_series.parent_booking_id is nullable + no composite tenant FK
Evidence: `00278_retarget_sibling_tables.sql:179-184` adds `foreign key (parent_booking_id) references public.bookings(id)` — single-column. The original column was renamed from `parent_reservation_id` in the canonicalisation. Trigger-based tenant assertion would be needed; none exists.
Why it matters: Same class as P0 #2. Less critical because recurrence_series writes go through the recurrence service which is well-scoped.

### [P2] tickets table retains SLA columns alongside sla_timers — dual source of truth
Evidence: `00011_tickets.sql:32-39` defines `sla_response_due_at`, `sla_resolution_due_at`, `sla_response_breached_at`, `sla_resolution_breached_at`, `sla_at_risk`, `sla_paused`, `sla_paused_at`, `sla_total_paused_minutes` directly on tickets. `00011_tickets.sql:90-106` ALSO defines `public.sla_timers` with the same conceptual data normalised. The comment at :31 says "updated by SLA engine, never calculated at query time" — i.e. denormalisation for queue-list perf.
Why it matters: Denormalisation for perf is fine when documented. The risk is silent divergence: a code path that updates the timer but not the ticket flag, or vice versa. `00227_step1c6_sla_timers_polymorphic.sql` made timers polymorphic across tickets+work_orders, doubling the surface. Worth a one-pass SoT audit: which writes touch which columns, in what order, and what invariants hold across both.

### [P2] booking_slots vs bookings status enum duplication with no enforced equality
Evidence: `00277_create_canonical_booking_schema.sql:49-51` (bookings.status enum) and `:142-144` (booking_slots.status enum) — both admit the same 7 values but no trigger or CHECK asserts that booking_slots.status is consistent with bookings.status. The comment says "multi-room can have one slot cancelled while others continue" — so they CAN diverge, by design. Still, a "bookings.status='cancelled' but a slot is status='confirmed'" pair is semantically invalid; no constraint enforces.
Why it matters: Today's auto-release worker / scheduler likely cleans this up. Future regressions could leave dangling confirmed slots on cancelled bookings. Worth a CHECK or trigger to forbid invalid pairings.

## P3 findings

### [P3] `bundle_is_visible_to_user` SQL function lingers but is unreferenced from app code
Evidence: `00245_bundle_visibility_parity_with_ts.sql:38` defines it. `apps/api/src/modules/booking-bundles/bundle-visibility.service.ts:18,110` only mentions it in comments — the TS code does its own query.
Why it matters: Dead function with legacy naming. Cosmetic.

### [P3] target_model `booking_visibility_ids` SQL function not implemented
Evidence: `docs/data-model-redesign-2026-04-30.md:55-57` promised `booking_visibility_ids(user_id, tenant_id)`. Confirmed missing via `grep`. Today bookings reads use `bundle_is_visible_to_user` + ad-hoc TS query.
Why it matters: The redesign target is half-realised — `ticket_visibility_ids` / `work_order_visibility_ids` / `visitor_visibility_ids` exist; `booking_visibility_ids` doesn't. Cleaner symmetry would help future authors.

## Data model assessment

### Canonical entities (with file:line for CREATE TABLE)
- `bookings` — `00277_create_canonical_booking_schema.sql:27` (replaces `booking_bundles`)
- `booking_slots` — `00277_create_canonical_booking_schema.sql:116` (replaces `reservations`)
- `tickets` (cases-only post-1c.10c) — `00011_tickets.sql:3`
- `work_orders` — created as `work_orders_new` in `00213_step1c1_work_orders_new_table.sql:21`, renamed atomically in `00222_step1c36_atomic_rename.sql:33`
- `recurrence_series` — `00124_recurrence_series.sql:5`, retargeted to bookings in 00278
- `orders` + `order_line_items` + `catalog_items` — `00013_orders_catalog.sql`
- `asset_reservations` — `00142_asset_reservations.sql:7`
- `approvals` — `00012_approvals.sql:3` (target_entity_id polymorphic uuid; allowed types tightened in 00278:170)
- `activities` (polymorphic timeline) — `00202_activities_polymorphic_sidecar.sql:25`
- `audit_events` / `domain_events` — `00019_events_audit.sql:24` / `:4`
- `outbox.events` + `outbox.events_dead_letter` — `00299_outbox_foundation.sql` (separate schema; idempotency_key + payload_hash)
- `workflow_definitions` / `workflow_instances` (polymorphic) — `00009_workflows.sql`; polymorphism added in `00369_workflow_polymorphism_booking.sql`
- `workflow_instance_links` — `00370_workflow_instance_links.sql:79` (parent-child spawn audit + resume registry)
- `maintenance_plans` — `00386_maintenance_plans_schema.sql:62`
- `visitors` + `visitor_hosts` + `visitor_pass_pool` + `visit_invitation_tokens` — visitors v1 (00248-00272)
- `spaces` (rooms/desks/buildings/sites — single recursive tree) — `00004_spaces.sql:3`
- `floor_plans` + `floor_plan_drafts` — 00368-00374 floor-plan branch

### Legacy remnants still in use
1. `role_audit_events` table (00111) — dormant after 00192 backfilled to audit_events; drop pending per memory.
2. `ticket_activities` table (00011_tickets.sql:69) — still actively read/written by ticket / work-order / sla / approval / routing services even though `activities` is supposed to be the polymorphic SoT.
3. The reverse shadow function `shadow_ticket_activity_to_activities` (00235) — write-amplifying triggers from `ticket_activities` into `activities`.
4. `booking_bundle_id` as **function argument name** on `ticket.service.ts:1876` and the `linked_order_line_item_id` callsite at `setup-work-order-trigger.service.ts:105`. Kept "for caller-signature stability" but used in live writes.
5. `booking_bundle_id` as **deprecated DTO alias** on `create-invitation.dto.ts:49`.
6. `bundle_is_visible_to_user` SQL function (00245) — function exists but no live caller.

### Duplicated sources of truth
1. **tickets.sla_* columns** (denormalised) vs **sla_timers** (normalised) — see P2 #3. Documented as intentional denormalisation for queue-list perf, but no invariant enforces consistency.
2. **bookings.status** vs **booking_slots.status** — see P2 #4. Allowed to diverge by design (multi-room) but invalid combinations not constrained.
3. **ticket_activities** vs **activities** — see P1 #1. Shadow trigger writes both, only the legacy one is read.
4. **domain_events** vs **outbox.events** — both are append-only event tables but serve different roles (analytics audit vs delivery queue). Confirmed disjoint usage by inspection — `outbox.events` for delivery, `domain_events` for behaviour analytics. Not actually duplicated, just easy to confuse.

### Tables/functions that should be retired
- `role_audit_events` (table + RLS + indexes) — P1.
- `ticket_activities` (table + shadow trigger + all TS callsites) — P1.
- `bundle_is_visible_to_user` (function) — P3.
- `entity_kind = 'ticket'` and `'service_order'` from `activities.entity_kind` CHECK — P2.

## Migration chain assessment

- **410 migrations**, prefixes 00001–00402. Generally clean chronological ordering with rich migration headers that cite source migrations and spec sections. The team has good migration discipline.
- **10 duplicate prefixes** in the 00367–00400 range: 00367, 00368, 00369, 00370, 00371, 00372, 00373, 00374, 00376, 00400. Caused by concurrent floor-plan + workflow-architecture branches landing the same week. Each pair touches disjoint objects so no current correctness bug, but ordering determinism is at risk. **This is the P0 finding.**
- **Stale function definitions**: `create or replace function public.shadow_ticket_to_work_orders_new()` is redefined 6 times across 00215, 00217, 00218, 00220, 00222, 00223 before being dropped in 00233. Standard pattern for migration-period code; not a problem post-drop. But a one-shot consolidation migration could clarify which trigger functions are still live (`shadow_ticket_activity_to_activities` is the only one that persists past 00233).
- **No conflicting redefinitions detected** — every `create or replace function` properly supersedes the prior version. `drop function if exists` is used at the right cutover points.
- **Multiple v-N RPC revisions** (e.g. `update_entity_combined` 00331→00332→00333→00334→00335→00383→00384; `edit_booking` 00361→00362→00363→00364→00394; `create_pm_work_order` 00389→00397→00398; `validate_entity_in_tenant` 00318→00321→00340→00359→00360) — this is the intended pattern under codex remediation review loop. Each header cites the prior version and what's added/fixed. Fine architecturally; just generates volume.

## Tenant-isolation findings

### FKs without composite tenant constraint (single-column UUID — relies on RLS + trigger + RPC helper)
Confirmed via `grep -E "tenant_id uuid not null references public.tenants" supabase/migrations/*.sql | wc -l = 66` vs `grep -E "foreign key \(tenant_id," supabase/migrations/*.sql | wc -l = 10` and `grep -E "unique \(tenant_id, id\)" supabase/migrations/*.sql | wc -l = 12`. So 66 tables have tenant_id, only ~12 have composite uniqueness, only ~10 use composite FKs.

Highest-value tables with the gap:
- `bookings`: FKs to persons, spaces, cost_centers, bundle_templates, recurrence_series, users — all single-column (`00277:36-80`).
- `booking_slots`: FK to spaces, bookings — single-column (`00277:118-124`). The booking_id FK is fine because cascades from booking are tenant-correct, but the space_id FK has the same gap as bookings.
- `tickets`: FKs to request_types, persons, spaces, assets, teams, users, workflow_definitions, sla_policies — all single-column (`00011:6-23`).
- `work_orders`: FKs to spaces, teams, vendors — single-column. PM additions (00387) DID use composite. Inconsistent.
- `approvals`: target_entity_id has no FK at all; approver_person_id / approver_team_id are single-column (P1 #4).
- `orders`: requester_person_id, delivery_location_id, approval_id — all single-column (`00013:47-56`).

### Tables without tenant_id where they should have one
None found. Every domain table audited had `tenant_id uuid not null references public.tenants(id)`. The team's tenant_id #0-invariant discipline is strong at the column level. The gap is at the FK level (single-column UUIDs trust the writer).

### Mitigation pattern in use (works, but reactive)
The codebase compensates for missing composite FKs with three TS+SQL guards:
1. RLS policies (`tenant_isolation`) on read.
2. Trigger-based tenant assertions on a handful of high-risk FKs (`enforce_spaces_parent_tenant` 00053, `assert_workflow_instance_link_tenant` 00370, `assert_approvals_workflow_instance_tenant` / `assert_room_booking_rules_workflow_definition_tenant` / `assert_workflow_definitions_source_rule_tenant` 00400).
3. `public.validate_entity_in_tenant` PL/pgSQL helper (00318→00360 v5) called from every multi-step write RPC before any FK-bearing INSERT.
4. TS regression specs (`apps/api/src/modules/cross-tenant-fk-leak-writes.spec.ts` covers 14 write sites; sibling read-side spec covers query paths).

This works today. It's not best-in-class because schema-side guarantees beat runtime-side guarantees. The newer tables (maintenance_plans 00386, work_orders PM cols 00387) show the team has adopted the composite-FK pattern; the older tables haven't been retrofitted.

## Best-in-class target model (delta from current)

What's already best-in-class:
- Canonical entity model (bookings/booking_slots/tickets/work_orders/orders/approvals/visitors/floor_plans) cleanly split with destructive cutovers — no `_v2` table pollution.
- Outbox is a proper dedicated schema with idempotency_key + payload_hash, not a hand-rolled pattern.
- Workflow_instances polymorphism done correctly: per-kind partial unique indexes for the active-uniqueness invariant + a derive trigger to fill entity_kind from legacy ticket_id callers + a validate trigger that runs after derive (alphabetical ordering documented at `00369:384-393`).
- Multi-step writes consolidated as PL/pgSQL RPCs — the architectural rule from CLAUDE.md is being followed.
- Trigger-based tenant assertion on high-risk polymorphic FKs.
- Smoke probes (`pnpm smoke:work-orders`, `pnpm smoke:edit-booking`, `pnpm smoke:edit-booking-scope`, `pnpm smoke:floor-plans`) that exercise live RPCs against a real DB — closes the "mocked tests pass but RPC fails" gap.

Delta to get to fully best-in-class:
1. **Composite (tenant_id, id) FK pattern everywhere** — retrofit bookings, booking_slots, tickets, work_orders, orders, approvals, asset_reservations, recurrence_series. Pair with a CI check that fails any new single-column UUID FK to a tenant-scoped table. This eliminates the "service-role write bypasses RLS and the writer forgot the helper" leak class entirely at the schema level. (P0 #2.)
2. **Migration prefix uniqueness CI guard** — `scripts/check-migration-prefix-unique.sh` and rename existing duplicates upward. (P0 #1.)
3. **Finish the polymorphic activities migration** — cut readers over to `activities`, drop the shadow trigger, drop `ticket_activities`. Removes a P1 storage + write-amp tax. (P1 #1.)
4. **Drop role_audit_events** — one-line migration. (P1 #2.)
5. **Run Phase 8 TS naming sweep + ship the diff-CI guard** — closes the 1053-line allowlist debt. (P1 #3.)
6. **asset_reservations tenant_id in exclusion constraint** — defense-in-depth parity with booking_slots. (P1 #4.)
7. **approvals.target_entity tenant validation** — extend the polymorphism-validate pattern from workflow_instances. (P1 #5.)
8. **Tighten activities.entity_kind CHECK** to drop 'ticket' + 'service_order'. (P2 #1.)
9. **Implement `booking_visibility_ids` SQL function** matching the ticket/work_order/visitor pattern. (P3 #2.)
10. **Audit + document the tickets.sla_* ↔ sla_timers SoT contract** — confirm denormalisation invariants are enforced somewhere (trigger? RPC?). (P2 #3.)

## Migration plan to close the gap (sequenced)

Numbered for execution order. Each step ships independently; later steps don't depend on earlier ones unless noted.

1. **Migration prefix unification** (½ day, mechanical)
   - Rename floor-plan branch migrations 00367→00403, 00368→00404, 00369→00405, etc. New unique prefixes.
   - Add `scripts/check-migration-prefix-unique.sh` + CI hook.
   - Verify with `pnpm db:reset` locally; should be a no-op.

2. **role_audit_events drop** (½ day)
   - One destructive migration: `drop table public.role_audit_events cascade; notify pgrst, 'reload schema';`.
   - Update `user-management.service.ts:508` comment.

3. **asset_reservations tenant_id in exclusion** (½ day)
   - Additive migration: `alter table public.asset_reservations add constraint asset_reservations_no_overlap_v2 exclude using gist (tenant_id with =, asset_id with =, time_range with &&) where (status='confirmed'); alter table … drop constraint asset_reservations_<old>_excl;`.

4. **activities.entity_kind tighten + approvals target validation** (1 day, paired)
   - Drop 'ticket' + 'service_order' from activities check.
   - Add `validate_approvals_target_in_tenant` trigger mirroring `validate_workflow_instance_polymorphism` (00369:394+).

5. **Composite (tenant_id, id) retrofit — bookings + booking_slots first** (2 days)
   - Add `unique (tenant_id, id)` on persons, spaces, cost_centers, bundle_templates, recurrence_series.
   - Replace FKs on bookings + booking_slots with composite versions.
   - Cross-tenant write-leak regression spec to verify nothing regresses.

6. **Composite (tenant_id, id) retrofit — tickets, work_orders, orders, approvals, asset_reservations** (3 days)
   - Same pattern as step 5, broader sweep.
   - Pair with CI guard that fails new single-column UUID FKs to tenant-scoped tables.

7. **Phase 8 TS naming sweep + diff-CI guard** (1.5-2 weeks)
   - Per the existing plan in `docs/follow-ups/phase-8-canonical-naming.md`.
   - Backend first (8.A.2), then frontend (8.B), then test fixtures (8.C), then SQL function drops (8.D).

8. **Polymorphic activities reader cutover** (1-2 weeks)
   - Pick a target entity_kind (case-detail first), switch its activity reads from `ticket_activities` to `activities`.
   - Repeat for work_order, booking, order.
   - Drop `shadow_ticket_activity_to_activities` trigger.
   - Drop `ticket_activities` table.

9. **Add `booking_visibility_ids` SQL function** (½ day)
   - Cleanup; bring booking visibility in line with the ticket/work_order/visitor pattern.

10. **Document tickets.sla_* ↔ sla_timers SoT contract** (½ day)
    - Audit which writes update which columns.
    - Add a trigger or test to enforce the invariant.

Total estimated effort: **4-6 weeks** for a single engineer to close every gap above and land the schema in fully best-in-class shape. The P0 items (1, 5, 6) are ~1 week of focused work; the rest is incremental hygiene.

---

## Closure Ledger

Maintainer rule: every agent that closes, partially closes, or deliberately defers a finding from this data-model audit must update this ledger in the same change. Do not rely on chat history as the record of truth. Add concrete evidence: changed files, migration numbers, tests/smokes run, and any residual risk.

| Date | Finding / Slice | Status | Evidence | Verification | Notes |
|---|---|---|---|---|---|
| 2026-05-13 | Handoff prompt added | tracking | `docs/follow-ups/audits/01-data-model.md` | Not run | All findings remain open unless a later row says otherwise. |

## Agent Handoff Prompt

```text
You are the lead data-model remediation agent for:
docs/follow-ups/audits/01-data-model.md

Goal:
Autonomously close every actionable finding in this audit file, but ship the work as a sequence of small, reviewable slices. Do not create one mega-change. Own the entire file until every P0/P1/P2/P3 finding is fixed, verified, or explicitly deferred with evidence.

Read first:
- AGENTS.md / CLAUDE.md
- docs/follow-ups/audits/01-data-model.md
- docs/follow-ups/audits/00-integrator-verdict.md
- docs/data-model-redesign-2026-04-30.md
- docs/data-model-step1c-plan.md
- docs/follow-ups/phase-8-canonical-naming.md
- supabase/migrations/**

Recommended slice order:
1. Migration prefix cleanup: renumber duplicate prefixes, update back-references, and run `bash scripts/check-migration-prefixes.sh`.
2. Small schema hygiene: drop truly dormant `role_audit_events`; fix `asset_reservations` exclusion parity; tighten small checks only when safe.
3. Approval target validation: add tenant-aware validation for polymorphic `approvals.target_entity_*` and regression tests.
4. Composite FK retrofit phase 1: bookings + booking_slots and their highest-risk referenced tables.
5. Composite FK retrofit phase 2: tickets + work_orders.
6. Composite FK retrofit phase 3: orders + approvals + asset_reservations + recurrence_series.
7. Phase 8 naming sweep and allowlist guard.
8. Polymorphic activities reader cutover, then retire shadow trigger/table only after readers are proven.
9. Add `booking_visibility_ids` if still missing.
10. Document and test the `tickets.sla_*` versus `sla_timers` source-of-truth contract.

Execution rules:
- Before editing, create a checklist from every finding in this file.
- Work one slice at a time; do not mix composite-FK retrofit with unrelated cleanup.
- Use parallel agents only for read-only investigation or disjoint write scopes.
- Every migration must be locally validated. Do not push or apply to remote without explicit user approval.
- For broad schema changes, add regression tests before claiming closure.
- If a finding is too large to close in one slice, add a partial ledger row with the exact remaining work.

Required closure behavior:
- Update this file's Closure Ledger after every slice.
- If a finding is fully closed, mark the original finding text or add a note near it pointing to the ledger row.
- Update any affected docs in the same change.
- Record migration numbers, tests run, and residual risk.

Completion bar:
- `bash scripts/check-migration-prefixes.sh` passes.
- No known duplicate migration prefixes remain.
- High-blast-radius tenant FKs are schema-enforced or explicitly deferred with a phased plan.
- Legacy data-model remnants are removed or documented as intentionally retained.
- Final response includes changed files, migrations, verification, and remaining deferrals.
```
