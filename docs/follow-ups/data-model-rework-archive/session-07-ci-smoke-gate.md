# Session 7 — 2026-05-01 — CI migration smoke gate shipped

> Archived from `docs/follow-ups/data-model-rework-full-handoff.md`. The main
> handoff is the index; this file is the full historical record.

Picked Priority 1 from the prior handoff (CI smoke tests) on the user's "make me proud" mandate. Shipped, verified end-to-end.

## What's new

- **`.github/workflows/ci.yml`** — added `migration-smoke` parallel job that boots Supabase CLI, runs `supabase db reset`, and runs the assertion script. Independent of the existing `check` job; failure on either fails the PR.
- **`scripts/ci-migration-asserts.sql`** — 10 numbered schema-integrity assertions (A1–A10). A1 is the one the prior session needed: "no CASCADE FKs to public.tickets remain". Others cover ticket_kind drop, work_orders being a base table, polymorphic FKs intact, tenant_id present on every known tenant-scoped table, canonical visibility/permission functions present, polymorphic kind triggers installed, and the renumbered 00241–00244 migrations actually took effect. Each assertion has a comment explaining what bug class it defends.
- **Pre-existing latent bugs unblocking `db:reset`** — fresh `supabase db reset` was broken on main before this session by two unrelated migrations:
  - `00106_request_type_routing_chain_handler.sql` — re-defined `request_type_coverage_matrix` with an added `routing_chain` column, but `CREATE OR REPLACE FUNCTION` rejects return-type changes (SQLSTATE 42P13). Fixed by adding `drop function if exists public.request_type_coverage_matrix(uuid, uuid);` before the recreate. Idempotent on remote (function is already in 8-col shape).
  - `00133_seed_room_booking_examples.sql` — assumed three meeting rooms with hardcoded UUIDs (`14d74559…`, `6df43476…`, `207242ea…`) exist, but on a fresh apply 00102's procedural room generation produces different UUIDs, so the FK insert fails. Fixed by gating the entire DO block on a `if not exists (select 1 from spaces where id in (...))` early-return — the seed becomes a no-op on fresh installs and unchanged on remote.
- **Renumbered 4 duplicate-prefix migrations**:
  - `00105_tenant_branding_surface_colors.sql` → `00241_…`
  - `00153_scheduler_data_rpc.sql` → `00242_…`
  - `00172_vendor_portal_status_en_route.sql` → `00243_…`
  - `00173_vendor_status_events_realtime.sql` → `00244_…`

  Verified zero forward references via grep before deferring. Remote DB doesn't track migration filenames in any `supabase_migrations.schema_migrations` table (the prior sessions all used direct psql, not `supabase db push`), so the rename is purely a local/CI concern with no remote desync.

## Verification

End-to-end loop run locally:
1. `pnpm db:reset` — applies 244 migrations cleanly, exit 0.
2. `psql -v ON_ERROR_STOP=1 -f scripts/ci-migration-asserts.sql` — 10 assertions, all OK, exit 0.
3. Created a temp migration that re-introduces the bug class (`create table … references public.tickets(id) on delete cascade`).
4. Re-ran assertions: A1 fired with the exact diagnostic (`"1 CASCADE FK(s) to public.tickets remain. Cascade-delete data-loss hazard. Drop them by EXPLICIT name…"`), exit code 3.
5. Dropped the canary, removed the temp migration, re-ran: green again, exit 0.

The gate would have caught both 2026-04-30 data-loss incidents (315 ticket_activities + 646 sla_timers) before they shipped.

## What this does NOT cover

- **Seed data integrity.** The CI gate is schema-only; demo-seed bugs (UUID-drift like 00133 had) won't fail it. The `if not exists` guard in 00133 means broken seeds become no-ops, not visible failures. Fine for CI's purpose; might want a separate "seed sanity" check later if seed bugs accumulate.
- **Runtime behaviour after migration.** A1 asserts "no CASCADE FKs structurally"; it doesn't simulate a destructive cutover and watch for cascade. The structural check is sufficient for the bug class but a future enhancement could add savepoint-rollback "would-this-actually-cascade" tests.
- **Non-Postgres invariants.** PostgREST schema cache, NOTIFY pgrst reload, the API's runtime tenant resolution — none of those are checked. Out of scope for a schema gate.
- **The rename of `00105_tenant_branding_surface_colors.sql` → `00241`** — this changes the apparent ordering in fresh installs. The migration's effect (adding 4 keys to `tenants.branding`) runs much later than originally. Anything between 00105 and 00241 that depended on those keys would silently use the old default. Grep showed zero forward references at the time of the rename, but if a future migration adds such a reference it'll fail at the wrong place. Hopefully unlikely.

## Open questions / handoff to next session

- Is the user happy with renumbering already-applied migrations vs. some other resolution (e.g., editing 00105 to do both things and dropping the secondary file)? Renumbering felt cleanest; alternative is a discussion.
- Should `pnpm db:reset` itself become a `pnpm` smoke step (not just CI)? Right now devs can still ship a migration that breaks `db:reset` if they don't run it locally first — CI catches it but the feedback loop is slow. A pre-commit or `pnpm verify` target would shift it left.
- Priority 2 (remove "Work orders" filter from desk UI) and Priority 3 (bundle visibility SQL helper rewrite) remain unchanged — see the "Open work" section in the main handoff.

## Files touched this session

```
.github/workflows/ci.yml                                     +44
scripts/ci-migration-asserts.sql                             +245 (new)
supabase/migrations/00106_request_type_routing_chain_handler.sql  +9
supabase/migrations/00133_seed_room_booking_examples.sql     +14
supabase/migrations/00105_tenant_branding_surface_colors.sql → 00241_… (renamed)
supabase/migrations/00153_scheduler_data_rpc.sql             → 00242_… (renamed)
supabase/migrations/00172_vendor_portal_status_en_route.sql  → 00243_… (renamed)
supabase/migrations/00173_vendor_status_events_realtime.sql  → 00244_… (renamed)
docs/follow-ups/data-model-rework-full-handoff.md            +this section
```

No remote DB changes. No application-code changes. CI workflow file is the user-visible artifact.
