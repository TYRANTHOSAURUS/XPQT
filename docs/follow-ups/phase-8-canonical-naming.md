# Phase 8 — canonical naming cleanup

> **Status:** v1 plan, scoping. Implementation gated on user go-ahead.

## 0. Context

The booking-canonicalisation rewrite (in flight per `.claude/CLAUDE.md`) renamed the runtime tables to canonical names: `booking_bundles` → `bookings`, `reservations` → `booking_slots`. The schema migration shipped in 00277. **Application code has NOT been fully migrated** — there are still ~209 references to the legacy names + variable names in `apps/api/src/`. Some are intentional (column-rename comments referencing the old name), others are stale.

Plus the column-name asymmetries documented in `docs/follow-ups/b2-survey-and-design.md` §0.1:
- `tickets.ticket_type_id` (config: `request_type_id`)
- `tickets.workflow_id` (config: `workflow_definition_id`)
- `tickets.sla_id` (config: `sla_policy_id`)
- `work_orders.*` mirrors

Code passes them around inconsistently — sometimes `ticketTypeId`, sometimes `requestTypeId`, sometimes `request_type_id` in a payload that maps to `ticket_type_id` on insert. The asymmetry is necessary at the schema layer (B.2 §0.1 documents why); at the TS layer it's a mess.

## 1. Scope

**Phase 8.A — Backend variable + payload naming consistency:**
- Audit every `*.service.ts` / `*.controller.ts` for both legacy bundle/reservation names AND inconsistent ticket-type / workflow / sla naming.
- Rename TS variables / payload fields to a single canonical convention: **payload uses public-API name** (`request_type_id`, `workflow_definition_id`, `sla_policy_id`); **DB-write code maps to runtime column on INSERT/UPDATE** (`ticket_type_id`, `workflow_id`, `sla_id`).
- Update DTO interfaces, validation schemas, swagger docs (if any).
- Tests updated to match.

**Phase 8.B — Frontend variable naming (parallel track):**
- Same convention: payload field names match public API.
- React component prop names, query keys, mutation hooks all follow.
- Visual no-ops.

**Phase 8.C — Legacy table-name cleanup:**
- Find every code reference to `booking_bundles` / `reservations` that's not a literal historical comment ("renamed from `reservations` in 00277").
- Replace with canonical names.
- Update test fixtures + smoke probes.

**Phase 8.D — Deprecation of legacy SQL function names:**
- 00291 `edit_booking_slot` (replaced by B.4 `edit_booking`).
- Any other functions with `bundle_*` or `reservation_*` prefix that survive after canonicalisation.
- Drop in a single cleanup migration after caller cutover.

## 2. Today's surface

- Legacy table-name references (booking_bundle / reservation_id): **209** sites in `apps/api/src/`.
- Variable-name inconsistency (snake/camel mix on ticket_type / workflow / sla): **132** sites.
- Frontend audit pending — likely similar magnitude.
- ~5-10 SQL functions with legacy names.

## 3. Risks

1. **Cosmetic-only changes are easy to misjudge as low-risk.** A typo in a rename across 200+ files can break the API in subtle ways. Mandatory: full test suite + smoke probes + typecheck after every batch.
2. **Wire-shape compatibility.** Public API field names CANNOT change without a versioned migration. If any wire-shape rename is required, it's a breaking change.
3. **Search-and-replace footguns.** `reservation_id` is also a column on `asset_reservations` and `recurrence_series` — those are NOT renamed. Whitelist the rename targets carefully.

## 4. Wave plan

### 8.A.1 — Audit + plan (1 day)
- Run `rg` patterns to enumerate every match.
- Categorize: legacy-table-name vs naming-asymmetry vs intentional-historical-comment.
- Produce a checklist file: `apps/api/src/.naming-allowlist.txt` listing intentional historical references.

### 8.A.2 — Backend naming sweep (3-4 days)
- Module-by-module, batch the 132 + 209 sites.
- Each commit covers one module; full test suite green per commit.
- DTO renames must update tests + swagger.

### 8.B — Frontend naming sweep (2-3 days)
- Same pattern.

### 8.C — Test fixtures + smoke probes (1 day)
- Update fixtures using legacy column / variable names.

### 8.D — Legacy SQL function drop (0.5 day)
- One migration: `drop function edit_booking_slot` etc.
- Sequenced after B.4 ships (B.4 is the last caller of `edit_booking_slot`).

**Total: 7-9 working days = 1.5-2 weeks for one engineer.**

## 5. Sequencing

Phase 8 is independent of Phase 7. Can run in parallel.

Phase 8.A + 8.B are pure refactor — no behavior change. Low risk if covered by tests.
Phase 8.D ships **after** B.4 lands (B.4 deprecates `edit_booking_slot` in §7).

## 6. Out of scope

- Schema-level renames (the schema is canonicalised already in 00277).
- Wire-shape API changes.
- Frontend route renames.
- Database column drops (deferred to Phase 8 cleanup migration after all callers are gone).

## 7. Acceptance criteria

- `rg "booking_bundle\b" apps/api/src --type ts` returns only intentional historical-comment lines (in the allowlist).
- `rg "reservation_id\b" apps/api/src --type ts` returns only legitimate references to `asset_reservations.reservation_id` and equivalent.
- Variable naming for ticket_type / workflow / sla is consistent across codebase: payload fields use public-API names; DB writes map.
- All tests + smoke probes green.

---

**Status:** v1 plan. Implementation not started; awaiting user go-ahead.
