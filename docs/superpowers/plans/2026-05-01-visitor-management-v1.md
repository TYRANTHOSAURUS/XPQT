# Visitor Management v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v1 visitor management subsystem from `docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md` as a single coherent release: persons-as-truth identity, kiosk-lite, reception workspace, pass pool, multi-host, bundle cascade, GDPR alignment, three new permissions.

**Architecture:** New NestJS module `apps/api/src/modules/visitors/` consuming PersonsModule, BookingBundlesModule, ApprovalModule, NotificationModule, PrivacyComplianceModule. New top-level workspace `/reception/*` (peer of `/desk/*`); kiosk-lite at `/kiosk/:buildingId` with anonymous building-bound token. All cross-tenant FKs use composite refs. State machine routes through a single `VisitorService.transitionStatus` path with DB trigger as defense-in-depth.

**Tech stack:** NestJS · TypeScript · React 19 · Vite · Tailwind · shadcn/ui · Supabase (PostgreSQL + RLS + Auth + Storage) · React Query for server state · `@react-pdf/renderer` for daglijst print.

**Reference docs (subagents MUST read before starting their slice):**
- Spec: `docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md` (canonical design)
- Project rules: `CLAUDE.md` (mandatory: form composition with Field primitives, toast conventions, settings page layout, design polish rules)
- Visibility model: `docs/visibility.md`
- GDPR baseline (already-shipped): `docs/superpowers/specs/2026-04-27-gdpr-baseline-design.md`
- Existing migrations cited as patterns: `00160` (RLS-per-verb), `00177` (lease pattern), `00183` (mail_delivery_events), `00187` (visibility function pattern)

**Migration number block (actuals):** `00248`–`00272`. The original
plan reserved `00211`–`00220`, but `main` shipped `00211`–`00247` in
parallel while this worktree was in flight, so the visitor migrations
were renumbered at apply time. The shipped breakdown:

- `00248`–`00257` — Slice 1 schema (visitor_types, pass pool, tokens,
  multi-host, visitors extensions, status state machine, helper
  functions, default-types seed). Shipped in commits `2026-04-29` →
  `2026-04-30`.
- `00258` — kiosk_tokens (added during Slice 4 when kiosk auth was wired).
- `00259`–`00261` — Slice 1/2 fixes (visibility empty-scope leak, token
  errcodes, pass pool null safety).
- `00262`–`00264` — Slice 2 follow-ups (task leases, mail delivery
  events, search trigram indexes + denorm columns).
- `00265` — peek invitation token function (Slice 5 email worker).
- `00266`–`00269` — **Post-shipping fixes** (this round): missing PII
  columns, visibility null-leak, persons→visitors PII sync trigger,
  domain_events authz lockdown.
- `00270`–`00272` — Subagent B's reserved range for status-INSERT
  validation + bundle cascade hardening.

**Rework rate:** 4 of 18 originally-shipped migrations (00266–00269)
required follow-up fixes for missing columns, two visibility leaks, a
denorm sync invariant, and a PostgreSQL grant. Worth surfacing in
post-mortem — a third of the visitor migrations needed a second pass.

The reservation pattern (`00211`–`00220`) is retained below for
historical reference; ignore the literal numbers and read by intent.

**Branch state:** working in worktree `worktree-visitors`. The spec is already committed (commit `07b3cc0`). Each slice produces commits; pushes to remote happen at the end of slices that include migrations (per memory `feedback_db_push_authorized` — standing permission for this workstream).

**Key invariants enforced throughout (subagents must verify per-task):**
- **Tenant isolation:** every new table has RLS-per-verb + tenant_isolation policy + `revoke from anon, authenticated` + `grant ... to service_role`. Every FK across tenant-scoped tables uses composite `(tenant_id, x_id)`. Per memory `feedback_tenant_id_ultimate_rule` — missing tenant filter = P0 leak.
- **State machine integrity:** `VisitorService.transitionStatus()` is the **only** code path that writes `visitors.status`. DB trigger `assert_visitor_status_transition` is defense-in-depth.
- **Test coverage:** every slice has tests for happy path + cross-tenant block + edge cases per spec §16. Run `pnpm test:api` and `pnpm test:web` before commit.
- **No hardcoded strings on user-facing surfaces:** all visitor-facing text via i18n primitives (English-only locale; keys ready for later platform translation pass).

---

## Pre-flight (run once before Slice 1)

- [ ] **P1: Verify branch + worktree clean**

```bash
cd /Users/x/Desktop/XPQT/.claude/worktrees/visitors
git status                  # expected: clean
git log --oneline -3        # expected: 07b3cc0 docs(visitors): v1 design ...
```

- [ ] **P2: Verify Supabase local is up**

```bash
pnpm db:start
# wait for "supabase local started" output
```

- [ ] **P3: Verify last migration number**

```bash
ls supabase/migrations/ | tail -3
# Expected: 00210_step1b_booking_bundle_status_v_cutover.sql is the latest.
# Visitor migrations begin at 00211.
```

- [ ] **P4: Verify SUPABASE_DB_PASS env var present** (per memory `supabase_remote_push`)

```bash
grep -q '^SUPABASE_DB_PASS=' .env && echo "ok" || echo "missing — abort"
```

---

## Slice 1 — Schema migrations

**Goal:** Land all DB schema for v1 (extensions to `visitors` + new tables + functions + triggers + RLS) in a contiguous migration block. Cross-tenant safety verified before Slice 2 starts.

**Files:**
- Create: `supabase/migrations/00211_visitor_types.sql`
- Create: `supabase/migrations/00212_visitor_pass_pool.sql`
- Create: `supabase/migrations/00213_visit_invitation_tokens.sql`
- Create: `supabase/migrations/00214_visitor_hosts_multi_host.sql`
- Create: `supabase/migrations/00215_visitors_v1_extensions.sql`
- Create: `supabase/migrations/00216_visitor_status_state_machine.sql`
- Create: `supabase/migrations/00217_pass_pool_for_space_function.sql`
- Create: `supabase/migrations/00218_visitor_visibility_ids_function.sql`
- Create: `supabase/migrations/00219_validate_invitation_token_function.sql`
- Create: `supabase/migrations/00220_seed_default_visitor_types.sql`
- Test: `apps/api/test/migrations/visitors-v1.spec.ts`

### Task 1.1 — `visitor_types` (tenant-configurable lookup)

- [ ] **Step 1: Read spec §4.2** — `docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md` lines 281-310.

- [ ] **Step 2: Write migration `00211_visitor_types.sql`** — table + RLS-per-verb + tenant_isolation policy + indexes. Mirror the pattern in `00160_reservation_visitors_rls_hardening.sql` lines 38-76 for grant/revoke. Schema per spec §4.2.

- [ ] **Step 3: Apply locally**

```bash
pnpm db:reset
# Expected: migrations apply cleanly through 00220
```

- [ ] **Step 4: Smoke-test the table is queryable as service_role**

```bash
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2 | tr -d \")" \
  -c "SELECT * FROM public.visitor_types LIMIT 1;"
# Expected: empty result, no error
```

### Task 1.2 — `visitor_pass_pool` with composite FKs + space_kind constraint

- [ ] **Step 1: Read spec §4.4 and §4.5**.

- [ ] **Step 2: Add unique constraint on `visitors(tenant_id, id)`** as a prerequisite (composite FKs need a target). Include in migration `00215`. Spec §4.4 explicitly notes: `alter table public.visitors add constraint visitors_pkey_tenant unique (tenant_id, id);`

- [ ] **Step 3: Write migration `00212_visitor_pass_pool.sql`** — table + composite FKs to `visitors(tenant_id, id)` + `pool_state_consistency` check + `sync_pool_space_kind` trigger + RLS-per-verb + indexes. The trigger MUST raise on non-`(site|building)` space kinds.

- [ ] **Step 4: Write the `pass_pool_for_space()` recursive CTE function** in `00217_pass_pool_for_space_function.sql` — security_invoker, walks `spaces.parent_id` ancestry, returns most-specific pool, respects `spaces.uses_visitor_passes=false` opt-out per spec §4.5.

- [ ] **Step 5: Add `spaces.uses_visitor_passes boolean`** in the same migration as `pass_pool_for_space()` (or a separate one — choose `00212`).

- [ ] **Step 6: Apply locally** — `pnpm db:reset` succeeds.

- [ ] **Step 7: Manual cross-tenant test**

```sql
-- create two tenants, one pool in tenant A, one visitor in tenant B
-- attempt to set pool.current_visitor_id to tenant B's visitor — must fail FK
```

### Task 1.3 — `visit_invitation_tokens` + `validate_invitation_token()`

- [ ] **Step 1: Read spec §4.6 and §4.7**.

- [ ] **Step 2: Write migration `00213_visit_invitation_tokens.sql`** per spec §4.6 — table with `token_hash` unique, `purpose` check, `used_at` for single-use enforcement, RLS service_role-only.

- [ ] **Step 3: Write `validate_invitation_token(p_token text, p_purpose text)` SECURITY DEFINER function** in `00219_validate_invitation_token_function.sql` — uses `digest(token, 'sha256')` for hash compare, `for update` lock, raises distinct exceptions (`invalid_token`, `token_already_used`, `token_expired`), single-use `update set used_at = now()` on success, returns `(visitor_id, tenant_id)`.

- [ ] **Step 4: Grant execute to anon + authenticated** (other rights revoked).

- [ ] **Step 5: Apply + run unit test of token lifecycle** — create token → validate succeeds → re-validate fails (`token_already_used`).

### Task 1.4 — `visitor_hosts` (multi-host junction)

- [ ] **Step 1: Read spec §4.3**.

- [ ] **Step 2: Write migration `00214_visitor_hosts_multi_host.sql`** — junction table with `tenant_id` (defense-in-depth), `assert_visitor_host_tenant` BEFORE INSERT/UPDATE trigger that compares to `visitors.tenant_id`, RLS-per-verb, indexes. Spec §4.3 explicitly notes: NO `is_primary` flag (canonical primary is `visitors.primary_host_person_id`).

### Task 1.5 — `visitors` table v1 extensions + status backfill

- [ ] **Step 1: Read spec §4.1 carefully**. The status backfill MUST run before the new check constraint.

- [ ] **Step 2: Write migration `00215_visitors_v1_extensions.sql`** in this exact order:

  1. Add new columns (`expected_at`, `expected_until`, `building_id`, `auto_checked_out`, `visitor_pass_id`, `primary_host_person_id`, `visitor_type_id`, `booking_bundle_id`, `reservation_id`, `checkout_source`, `logged_at`).
  2. Backfill: `update public.visitors set status = case when status='pre_registered' then 'expected' when status='approved' then 'expected' when status='checked_in' then 'arrived' else status end;`
  3. Drop old check constraint, add new check with widened enum.
  4. Add unique `visitors(tenant_id, id)` for composite FK targets.
  5. Add `visitors_logged_after_arrived` check.
  6. Add `visitors_checkout_source_required` check.
  7. Backfill `host_person_id` from `primary_host_person_id` for adapter alignment (spec §14.2): `update visitors set host_person_id = primary_host_person_id where host_person_id is null and primary_host_person_id is not null;`
  8. Add FK indexes per reviewer C12: on `building_id`, `booking_bundle_id`, `reservation_id`, `visitor_pass_id`, `primary_host_person_id`.

- [ ] **Step 3: Add `spaces.timezone text default 'Europe/Amsterdam'`** in this migration (used by EOD sweep per spec §4.8 and §12).

- [ ] **Step 4: Apply locally** — `pnpm db:reset` succeeds.

- [ ] **Step 5: Verify backfill ran** — query `select status, count(*) from visitors group by status` post-reset and confirm only new statuses present.

### Task 1.6 — Status state machine trigger

- [ ] **Step 1: Read spec §5**.

- [ ] **Step 2: Write migration `00216_visitor_status_state_machine.sql`** — `assert_visitor_status_transition()` trigger function with the transition matrix from spec §5. BEFORE UPDATE OF status trigger.

- [ ] **Step 3: Test invalid transitions raise** —

```sql
-- start a visitor in 'expected'
update visitors set status='checked_out' where id=<v>;  -- must raise
update visitors set status='arrived' where id=<v>;       -- must succeed
update visitors set status='pending_approval' where id=<v>; -- must raise (no backward arrow)
```

### Task 1.7 — `visitor_visibility_ids()` SQL function

- [ ] **Step 1: Read spec §4.9 and `docs/visibility.md`**.

- [ ] **Step 2: Read existing pattern at** `supabase/migrations/00187_tickets_visible_for_actor.sql` for shape reference.

- [ ] **Step 3: Write migration `00218_visitor_visibility_ids_function.sql`** — UNION of three tiers: hosts (Tier 1), operators with `visitors:reception` permission in their location scope (Tier 2), `visitors:read_all` override (Tier 3). Joins `org_node_location_grants` per spec §4.9.

- [ ] **Step 4: Test with three users**: a host (sees only their visit), a reception user with HQ Amsterdam scope (sees only HQ visitors), an admin with `visitors:read_all` (sees everything).

### Task 1.8 — Seed default visitor types

- [ ] **Step 1: Write migration `00220_seed_default_visitor_types.sql`** — for each existing tenant, insert 6 default types (guest, contractor, interview, delivery, vendor, other) with the per-type config matrix from spec §11.4 / §4.2 (`requires_approval` defaults to false, `allow_walk_up` defaults to true, `requires_id_scan`/`requires_nda`/`requires_photo` all false). Add a tenant-creation trigger that seeds these for new tenants going forward.

### Task 1.9 — Cross-tenant + state machine + FK index integration test

**Files:** `apps/api/test/migrations/visitors-v1.spec.ts`

- [ ] **Step 1: Write the cross-tenant leak test** — for each new table (`visitor_types`, `visitor_hosts`, `visitor_pass_pool`, `visit_invitation_tokens`), assert that a row inserted by tenant A is not selectable by `set local request.jwt.claims = '{"tenant_id":"<tenant-B>"}'`. Use existing `assertCrossTenantBlocked` test helper if present; otherwise hand-roll.

- [ ] **Step 2: Write the composite-FK guard test** — attempt to set `visitor_pass_pool.current_visitor_id` to a visitor with a different `tenant_id`. Must raise `foreign_key_violation`.

- [ ] **Step 3: Write the state machine test** — insert visitor with status='expected'; attempt update to 'checked_out' (must raise); update to 'arrived' (must succeed); update to 'pending_approval' (must raise — backward arrow).

- [ ] **Step 4: Run tests** — `pnpm test:api -- visitors-v1`. Expected: all green.

### Task 1.10 — Push migrations to remote

- [ ] **Step 1: Show migrations to be pushed**

```bash
# Generic glob — matches whatever range the visitor work actually shipped
# in (the reservation block was 00211-00220 but main shipped concurrently
# and we ended up at 00248-00272). Don't hardcode the prefix.
ls supabase/migrations/ | sort | sed -n '/visitor\|kiosk/Ip'
```

- [ ] **Step 2: Push via psql fallback** (per `CLAUDE.md` and memory `supabase_remote_push`):

```bash
# Apply each unpushed visitor migration in numeric order. The list lives
# in the working tree under supabase/migrations/; sort is by filename so
# the numeric prefix preserves order.
for f in $(ls supabase/migrations/ | sort | grep -E '^002(48|49|5[0-9]|6[0-9]|7[0-2])_.*\.sql$'); do
  echo "=== applying $f ==="
  PGPASSWORD="$SUPABASE_DB_PASS" psql \
    "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
    -v ON_ERROR_STOP=1 -f "supabase/migrations/$f" || break
done
```

If a future fix lands at `00273+`, extend the regex (`^002(4[8-9]|...)$`)
or replace it with a list. The lesson from the original plan: do NOT
hardcode the numeric range in places that must agree with whatever
`ls supabase/migrations/` reports.

- [ ] **Step 3: Notify PostgREST**

```bash
PGPASSWORD="$SUPABASE_DB_PASS" psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -c "NOTIFY pgrst, 'reload schema';"
```

- [ ] **Step 4: Smoke-query the running API** — hit `GET /visitors` (or equivalent) and confirm no `PGRST205` error.

### Task 1.11 — Commit + checkpoint

- [ ] **Step 1: Commit migrations**

```bash
# Stage every visitor migration that isn't already committed. The exact
# numeric range depends on what main shipped in the meantime (we ended up
# at 00248-00272). git status filters out main-only files.
git add $(git ls-files -o --exclude-standard supabase/migrations/ | grep -E 'visitor|kiosk')
git add apps/api/test/migrations/visitors-v1.spec.ts
git commit -m "feat(visitors): v1 schema — extensions + multi-host + pass pool + tokens + functions"
```

- [ ] **Step 2: Run full-review skill** — adversarial review of migrations against spec.

---

## Slice 2 — VisitorsModule backend

**Goal:** Build the `VisitorsModule` with all services from spec §2 + EOD sweep worker. Every visitor-status write routes through `VisitorService.transitionStatus`.

**Files:**
- Create: `apps/api/src/modules/visitors/visitors.module.ts`
- Create: `apps/api/src/modules/visitors/visitor.service.ts` (state machine)
- Create: `apps/api/src/modules/visitors/invitation.service.ts`
- Create: `apps/api/src/modules/visitors/host-notification.service.ts`
- Create: `apps/api/src/modules/visitors/visitor-pass-pool.service.ts`
- Create: `apps/api/src/modules/visitors/reception.service.ts`
- Create: `apps/api/src/modules/visitors/kiosk.service.ts`
- Create: `apps/api/src/modules/visitors/eod-sweep.worker.ts`
- Create: `apps/api/src/modules/visitors/bundle-cascade.adapter.ts`
- Create: `apps/api/src/modules/visitors/visitor-mail-delivery.adapter.ts`
- Create: `apps/api/src/modules/visitors/dto/*.dto.ts`
- Create: `apps/api/src/modules/visitors/visitors.controller.ts`
- Create: `apps/api/src/modules/visitors/reception.controller.ts`
- Create: `apps/api/src/modules/visitors/kiosk.controller.ts`
- Create: `apps/api/src/modules/visitors/admin.controller.ts`
- Modify: `apps/api/src/app.module.ts` (register `VisitorsModule`)
- Test: `apps/api/test/visitors/*.spec.ts`

### Task 2.1 — Module + DTOs scaffold

- [ ] **Step 1: Read spec §2 and §6**.

- [ ] **Step 2: Create `visitors.module.ts`** importing PersonsModule, BookingBundlesModule, ApprovalModule (via forwardRef — see slice 3), NotificationModule, PrivacyComplianceModule, SpacesModule. Provide all services + controllers + the EOD worker.

- [ ] **Step 3: Define DTOs** in `dto/`:
  - `create-invitation.dto.ts` — visitor-first invite payload (first/last/email/phone/company/visitor_type_id/expected_at/expected_until/building_id/meeting_room_id/booking_bundle_id/co_hosts/notes_for_visitor/notes_for_reception)
  - `transition-status.dto.ts` — status + arrived_at + checkout_source + visitor_pass_id (optional)
  - `assign-pass.dto.ts`, `return-pass.dto.ts`, `mark-pass-missing.dto.ts`
  - `quick-add-walkup.dto.ts` — minimal fields for reception walk-up
  - `kiosk-checkin.dto.ts` — token (QR) OR (first_name + last_name match)
  - `cancel-by-token.dto.ts` — visitor self-cancel

- [ ] **Step 4: Write a DTO unit test** verifying class-validator decorators reject malformed input.

- [ ] **Step 5: Commit**.

### Task 2.2 — VisitorService.transitionStatus (state machine path)

- [ ] **Step 1: Read spec §5 again**. The transition matrix is the source of truth.

- [ ] **Step 2: Write the failing test** — `apps/api/test/visitors/visitor-state-machine.spec.ts`:
  - test_expected_to_arrived_succeeds_and_records_arrived_at
  - test_arrived_to_checked_out_with_reception_source_succeeds
  - test_expected_to_checked_out_skipping_arrived_raises (must fail at app layer + DB layer)
  - test_pending_approval_to_expected_via_approval_succeeds
  - test_pending_approval_to_denied_succeeds
  - test_status_write_outside_transitionStatus_is_blocked_in_review (covered by lint + code review; no test asserts this directly)

- [ ] **Step 3: Implement `VisitorService.transitionStatus()`** — load the row with `for update`, validate transition, update with audit fields (arrived_at on `arrived`, checked_out_at + checkout_source on `checked_out`, etc.), emit audit event, trigger downstream effects (host notif on arrived, pass return on checked_out, cascade on cancelled).

- [ ] **Step 4: Run tests** — `pnpm test:api -- visitor-state-machine`. Expected: green.

- [ ] **Step 5: Commit**.

### Task 2.3 — InvitationService

- [ ] **Step 1: Read spec §6**.

- [ ] **Step 2: Write tests** — `apps/api/test/visitors/invitation.spec.ts`:
  - test_create_invitation_creates_persons_row_with_visitor_type
  - test_create_invitation_creates_visitor_row_with_expected_status
  - test_create_invitation_with_approval_required_creates_pending_approval
  - test_create_invitation_with_walk_up_disallowed_for_type_raises
  - test_create_invitation_cross_building_blocked_when_inviter_lacks_scope
  - test_create_invitation_creates_visitor_hosts_for_each_co_host
  - test_create_invitation_creates_invitation_token_for_cancel
  - test_create_invitation_dedup_when_tenant_setting_on_reuses_persons_row
  - test_create_invitation_dedup_when_tenant_setting_off_creates_new_persons_row

- [ ] **Step 3: Implement `InvitationService.create()`** per spec §6. Uses `PersonsService` to create/find persons row; calls `VisitorService.transitionStatus` for status setting (NOT direct UPDATE); handles approval routing (returns approval_id when status is pending_approval); enqueues email job only when status is `expected`.

- [ ] **Step 4: Run tests** — green.

- [ ] **Step 5: Commit**.

### Task 2.4 — VisitorPassPoolService

- [ ] **Step 1: Read spec §4.4, §4.5, §7.6**.

- [ ] **Step 2: Write tests** — `apps/api/test/visitors/pass-pool.spec.ts`:
  - test_passPoolForSpace_returns_building_pool_when_present
  - test_passPoolForSpace_walks_up_to_site_when_no_building_pool
  - test_passPoolForSpace_returns_empty_when_uses_visitor_passes_false
  - test_assignPass_marks_in_use_with_current_visitor_id
  - test_assignPass_with_reserved_visitor_promotes_reservation_to_in_use
  - test_returnPass_clears_visitor_refs_and_marks_available
  - test_markPassMissing_records_audit
  - test_assignPass_cross_tenant_blocked

- [ ] **Step 3: Implement** wrapping the `pass_pool_for_space()` SQL function call + per-action transactions.

- [ ] **Step 4: Run tests** — green.

- [ ] **Step 5: Commit**.

### Task 2.5 — HostNotificationService (fan-out)

- [ ] **Step 1: Read spec §9**.

- [ ] **Step 2: Write tests** — `apps/api/test/visitors/host-notification.spec.ts`:
  - test_notifyArrival_fans_out_to_all_hosts_in_visitor_hosts
  - test_notifyArrival_records_notified_at_per_host
  - test_acknowledge_records_acknowledged_at_and_dismisses_others

- [ ] **Step 3: Implement** — uses `NotificationModule` for email + in-app inbox; emits Server-Sent Event (SSE) for browser Notification API delivery (subscribed to by hosts' open portal tabs).

- [ ] **Step 4: Run tests** — green.

- [ ] **Step 5: Commit**.

### Task 2.6 — ReceptionService (today-view + quick-add + backdated)

- [ ] **Step 1: Read spec §7**.

- [ ] **Step 2: Write tests** — `apps/api/test/visitors/reception.spec.ts`:
  - test_today_returns_visitors_in_buckets (currently_arriving / expected / on_site / yesterday_loose_ends)
  - test_today_filters_by_visibility (only visible visitors per `visitor_visibility_ids`)
  - test_search_fuzzy_matches_first_name
  - test_search_fuzzy_matches_host_name
  - test_search_returns_under_3_seconds_for_today_only
  - test_quickAddWalkup_creates_arrived_visitor_pings_host
  - test_quickAddWalkup_blocked_when_type_disallows_walk_up
  - test_quickAddWalkup_blocked_when_type_requires_approval
  - test_backdatedArrival_sets_arrived_at_and_logged_at_distinctly
  - test_yesterdayLooseEnds_aggregates_auto_checked_out_count_and_unreturned_passes

- [ ] **Step 3: Implement** all today-view aggregations, search via Postgres `pg_trgm` similarity on first_name + last_name + host_name + company. Quick-add walkup calls `InvitationService.create()` with `arrived_at = expected_at = now()` then `transitionStatus(arrived)`.

- [ ] **Step 4: Run tests** — green.

- [ ] **Step 5: Commit**.

### Task 2.7 — KioskService (anonymous building-bound auth)

- [ ] **Step 1: Read spec §8**. Auth pattern reference: `apps/api/src/modules/vendor-portal/` for token-based anonymous auth.

- [ ] **Step 2: Write tests** — `apps/api/test/visitors/kiosk.spec.ts`:
  - test_kioskToken_can_only_access_its_tenant_and_building
  - test_kioskToken_rotation_invalidates_old_token
  - test_checkInWithQrToken_validates_via_validate_invitation_token
  - test_checkInWithQrToken_transitions_visitor_to_arrived
  - test_checkInByName_fuzzy_matches_today_expected_only
  - test_checkInByName_with_no_match_offers_walkup_for_allowed_types
  - test_kioskWalkup_blocked_for_approval_required_types

- [ ] **Step 3: Implement** the KioskAuthGuard (validates building-bound JWT against `kiosk_tokens` table — see Task 2.7a below) + check-in endpoints.

- [ ] **Step 3a: Migration `00221_kiosk_tokens.sql`** (added retroactively to slice 1 if not already there — verify before running):

```sql
create table public.kiosk_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  building_id uuid not null references public.spaces(id),
  token_hash text not null unique,
  active boolean not null default true,
  rotated_at timestamptz,
  expires_at timestamptz not null default (now() + interval '90 days'),
  created_at timestamptz not null default now()
);
-- RLS service_role only
```

If this migration was missed in slice 1, add it now — it's a foundation table for kiosk auth and must exist before kiosk.service.ts can be tested.

- [ ] **Step 4: Run tests** — green.

- [ ] **Step 5: Commit**.

### Task 2.8 — EodSweepWorker

- [ ] **Step 1: Read spec §12 and** `supabase/migrations/00177_daglijst_lease_fence.sql` for lease pattern.

- [ ] **Step 2: Write tests** — `apps/api/test/visitors/eod-sweep.spec.ts`:
  - test_sweep_at_18_local_flips_expected_to_no_show
  - test_sweep_flips_arrived_to_checked_out_with_auto_flag_true
  - test_sweep_with_unreturned_pass_marks_pass_lost
  - test_sweep_idempotent_re_run_no_op
  - test_sweep_lease_blocks_concurrent_runs
  - test_sweep_respects_per_building_timezone

- [ ] **Step 3: Implement** EodSweepWorker as a NestJS scheduled task running every 15 min from 17:30-19:00 (cron); checks per-building local time against `spaces.timezone`; acquires lease via `daglijst_lease_fence` pattern (same shape, different lease-key namespace `visitor.eod`); transitions statuses via `VisitorService.transitionStatus`.

- [ ] **Step 4: Commit**.

### Task 2.9 — BundleCascadeAdapter (event subscriber stub)

- [ ] **Step 1: Read spec §10**.

- [ ] **Step 2: Implement the adapter as a subscriber to events** (event emission is added in Slice 4 to BundleCascadeService). Adapter handlers:
  - `bundle.line.moved` → if visitor.status='expected' update expected_at + send "moved" email; if status='arrived'+ alert host
  - `bundle.line.room_changed` → status-aware update + email/host alert
  - `bundle.line.cancelled` → cancel visitor invite (status→cancelled) + send cancellation email
  - `bundle.cancelled` → cancel all linked visitors

- [ ] **Step 3: Write integration tests** — emit events programmatically, assert visitor table state changes per matrix in spec §10.2.

- [ ] **Step 4: Commit**.

### Task 2.10 — VisitorMailDeliveryAdapter

- [ ] **Step 1: Read** `supabase/migrations/00183_mail_delivery_events.sql` for the existing pattern.

- [ ] **Step 2: Implement** wrappers around `mail_delivery_events` keyed by `(entity_type='visitor_invite', entity_id=visitors.id)`. Reception today-view JOINs to surface bounce status. Methods: `recordSent`, `recordBounced`, `lastDeliveryStatus`.

- [ ] **Step 3: Test** — green.

- [ ] **Step 4: Commit**.

### Task 2.11 — Controllers (REST endpoints)

- [ ] **Step 1: Read spec §2 frontend surfaces table** — endpoints map roughly to:

```
POST   /visitors/invitations              -- InvitationService.create
GET    /visitors/expected                 -- host's "my upcoming"
POST   /visitors/:id/cancel               -- visitor self-cancel via token (uses validate_invitation_token)
POST   /visitors/:id/transition           -- internal-only state transitions

GET    /reception/today                   -- ReceptionService.today
POST   /reception/walk-up                 -- ReceptionService.quickAddWalkup
POST   /reception/visitors/:id/checkin    -- ReceptionService.markArrived(backdatable)
POST   /reception/visitors/:id/checkout   -- ReceptionService.markCheckedOut(with pass return)
POST   /reception/visitors/:id/no-show    -- ReceptionService.markNoShow
POST   /reception/passes/:id/assign       -- VisitorPassPoolService.assignPass
POST   /reception/passes/:id/return       -- VisitorPassPoolService.returnPass
POST   /reception/passes/:id/missing      -- VisitorPassPoolService.markPassMissing
GET    /reception/yesterday               -- ReceptionService.yesterdayLooseEnds
GET    /reception/daglijst                -- ReceptionService.dailyListPdf

POST   /kiosk/checkin                     -- KioskService.checkIn (QR or name)
POST   /kiosk/walkup                      -- KioskService.walkup

POST   /admin/visitor-types               -- AdminController CRUD
POST   /admin/pass-pool                   -- pool CRUD with space-tree picker
```

- [ ] **Step 2: Implement controllers** with `@UseGuards(AuthGuard, PermissionGuard)` per spec §13. KioskController uses `KioskAuthGuard` instead.

- [ ] **Step 3: Wire `visitors:invite` / `visitors:reception` / `visitors:read_all` permission checks** via the catalog SoT (memory `project_permission_catalog_enforcement_shipped`).

- [ ] **Step 4: Register the three new keys** in the catalog source-of-truth file.

- [ ] **Step 5: Run integration test suite** for controller layer — pass.

- [ ] **Step 6: Commit**.

### Task 2.12 — Slice 2 verification

- [ ] **Step 1: Full test pass** — `pnpm test:api`. Expected: all green.

- [ ] **Step 2: Run full-review skill** — adversarial review of backend module against spec + slice 1 schema.

- [ ] **Step 3: Apply critical/important fixes if any** — recommit.

---

## Slice 3 — Approval dispatcher edit

**Goal:** Add `visitor_invite` target type to ApprovalService.respond() so approval grants/denials trigger `VisitorService.onApprovalDecided`.

**Files:**
- Modify: `apps/api/src/modules/approval/approval.service.ts` (lines 310-340 area; new branch in respond() switch)
- Modify: `apps/api/src/modules/approval/approval.module.ts` (forwardRef for VisitorService)
- Test: `apps/api/test/visitors/approval-flow.spec.ts`

### Task 3.1 — Wire VisitorService into ApprovalModule

- [ ] **Step 1: Read** `apps/api/src/modules/approval/approval.module.ts` lines 33-38 (existing forwardRef pattern).

- [ ] **Step 2: Add `forwardRef(() => VisitorsModule)`** to ApprovalModule's imports.

- [ ] **Step 3: Inject `VisitorService`** into `ApprovalService` constructor with `@Inject(forwardRef(() => VisitorService))`.

### Task 3.2 — Dispatcher branch

- [ ] **Step 1: Locate the switch in `ApprovalService.respond()`** (approval.service.ts:310-340).

- [ ] **Step 2: Add the case**:

```typescript
case 'visitor_invite':
  await this.visitorService.onApprovalDecided(approval.target_id, approval.outcome);
  break;
```

- [ ] **Step 3: Implement `VisitorService.onApprovalDecided(visitor_id, outcome)`**:
  - if outcome='approved' → `transitionStatus(v, 'expected')` + enqueue invitation email
  - if outcome='denied' → `transitionStatus(v, 'denied')` + notify host

### Task 3.3 — Tests

- [ ] **Step 1: Write integration test** — visitor invited with approval-required type → status='pending_approval' → approval responded 'approved' → status flips to 'expected' → email enqueued. Reverse case for denial.

- [ ] **Step 2: Test cross-tenant** — approval in tenant A cannot affect visitor in tenant B (composite FK + RLS handle this; verify).

- [ ] **Step 3: Run tests** — green.

- [ ] **Step 4: Commit**.

---

## Slice 4 — Bundle cascade events

**Goal:** Add domain event emission to BundleCascadeService for visitor cascade adapter to subscribe to.

**Files:**
- Modify: `apps/api/src/modules/booking-bundles/bundle-cascade.service.ts` (emit events on cancelLine, editLine, cancelBundle)
- Modify: `apps/api/src/modules/booking-bundles/bundle.service.ts` (move/reschedule emits bundle.line.moved / bundle.line.room_changed)
- Test: `apps/api/test/visitors/bundle-cascade-integration.spec.ts`

### Task 4.1 — Identify event emission points

- [ ] **Step 1: Read** `apps/api/src/modules/booking-bundles/bundle-cascade.service.ts` and `bundle.service.ts` to find the `cancelLine`, `editLine`, `cancelBundle` methods.

- [ ] **Step 2: Identify the existing event-bus mechanism** (likely NestJS EventEmitter). Confirm by searching for existing `@OnEvent` decorators.

- [ ] **Step 3: Define event types** in a shared location:
  - `bundle.line.moved` — payload `{ bundle_id, line_id, old_expected_at, new_expected_at }`
  - `bundle.line.room_changed` — `{ bundle_id, line_id, old_room_id, new_room_id }`
  - `bundle.line.cancelled` — `{ bundle_id, line_id, line_kind }`
  - `bundle.cancelled` — `{ bundle_id }`

### Task 4.2 — Emit events

- [ ] **Step 1: Add emit calls** at the right points in BundleCascadeService + BundleService. Events fire AFTER successful DB transaction commits to avoid downstream side effects on rollback.

- [ ] **Step 2: Write integration tests** — programmatically modify a bundle, assert events emitted with correct payload.

### Task 4.3 — End-to-end cascade verification

- [ ] **Step 1: Write integration test in `apps/api/test/visitors/bundle-cascade-integration.spec.ts`**:
  - Create a bundle with a visitor line.
  - Move the bundle's time → assert visitor's expected_at updated AND visitor email enqueued.
  - Repeat with visitor.status='arrived' → assert visitor record updated BUT NO email enqueued (host alert instead).
  - Cancel a bundle line → assert visitor cancelled.
  - Cancel whole bundle → assert all visitors cancelled.

- [ ] **Step 2: Run** — green.

- [ ] **Step 3: Commit**.

---

## Slice 5 — Email + cancel-link infrastructure

**Goal:** Branded English visitor invitation email + cancel-link generation + day-before reminder cron + change-only emails. mail_delivery_events captures lifecycle.

**Files:**
- Create: `apps/api/src/modules/visitors/templates/visitor-invitation.template.tsx` (or .hbs depending on existing pattern)
- Create: `apps/api/src/modules/visitors/templates/visitor-reminder.template.tsx`
- Create: `apps/api/src/modules/visitors/templates/visitor-cancellation.template.tsx`
- Create: `apps/api/src/modules/visitors/templates/visitor-moved.template.tsx`
- Create: `apps/api/src/modules/visitors/templates/visitor-room-changed.template.tsx`
- Create: `apps/api/src/modules/visitors/email-jobs/*.job.ts`
- Test: `apps/api/test/visitors/email-templates.spec.ts`

### Task 5.1 — Identify existing email pattern

- [ ] **Step 1: Read** `apps/api/src/modules/notification/` to find the email rendering + delivery pattern. Check for existing `@react-email` or Handlebars or MJML usage.

### Task 5.2 — Invite email template

- [ ] **Step 1: Implement template** (branded HTML, English) per spec §6's email content:
  - Tenant logo
  - "You're invited to visit [Building] on [Date]"
  - Host first name only
  - Meeting room (if any)
  - Reception phone
  - "What to expect" — language/i18n key, even though only English shipped
  - Cancel link: `/visit/cancel/:token` — token generated via InvitationService at create time

- [ ] **Step 2: Render-to-HTML test** — assert HTML output matches snapshot; assert all i18n keys resolve.

- [ ] **Step 3: Commit**.

### Task 5.3 — Reminder + cancellation + change emails

- [ ] **Step 1: Implement** `visitor-reminder.template`, `visitor-cancellation.template`, `visitor-moved.template`, `visitor-room-changed.template`.

- [ ] **Step 2: Snapshot tests** for each.

- [ ] **Step 3: Implement day-before reminder cron** — every hour, find visitors with `expected_at` in the next 24-25 hours that haven't been reminded; send reminder; record in audit.

- [ ] **Step 4: Commit**.

### Task 5.4 — Cancel landing endpoint

- [ ] **Step 1: Implement controller `POST /visit/cancel/:token`** — calls `validate_invitation_token(token, 'cancel')` SECURITY DEFINER function, on success transitions visitor to `cancelled`, returns "ok" page payload. Frontend (Slice 10) handles UX.

- [ ] **Step 2: Test the full token lifecycle** — token issued at invite, click link → status='cancelled' → re-click same link → 410 (already used).

### Task 5.5 — mail_delivery_events integration

- [ ] **Step 1: Wire VisitorMailDeliveryAdapter into all email send sites** so each send creates a `mail_delivery_events` row.

- [ ] **Step 2: Wire bounce webhook handler** (already exists in NotificationModule? — verify; if so, ensure it dispatches by entity_type='visitor_invite').

- [ ] **Step 3: Run end-to-end** — invite a visitor with a known-bouncing address → mail_delivery_events shows bounced → reception today-view surfaces "⚠ email bounced".

- [ ] **Step 4: Commit + run full-review skill on backend (slices 2-5)**.

---

## Slice 6 — Frontend portal + composer

**Goal:** Host invite UI (visitor-first standalone form + booking-first composer line) using shadcn Field primitives + React Query.

**Files:**
- Create: `apps/web/src/api/visitors/index.ts` (React Query hooks per `docs/react-query-guidelines.md`)
- Create: `apps/web/src/pages/portal/visitors/invite.tsx`
- Create: `apps/web/src/pages/portal/visitors/expected.tsx`
- Create: `apps/web/src/components/portal/visitor-invite-form.tsx` (reused in standalone + composer)
- Modify: `apps/web/src/pages/portal/booking-create.tsx` (add Visitor section)
- Test: `apps/web/test/portal/visitors/invite.spec.tsx`

### Task 6.1 — React Query module

- [ ] **Step 1: Read `docs/react-query-guidelines.md`**.

- [ ] **Step 2: Implement** `apps/web/src/api/visitors/index.ts` per guidelines — key factory, queryOptions helpers, mutations with onMutate optimistic updates.

### Task 6.2 — VisitorInviteForm component

- [ ] **Step 1: Read `CLAUDE.md` Form composition section**. Mandatory `<Field>` primitives.

- [ ] **Step 2: Implement** the form with all fields per spec §6.1. Field primitives only; no hand-rolled `<div className="grid gap-1.5">` patterns.

- [ ] **Step 3: Cross-building scope check** — when host selects a building outside their location grants, form shows a `<FieldError>` ("You don't have access to invite at HQ Rotterdam").

- [ ] **Step 4: Multi-host picker** — uses existing persons picker pattern, restricted to tenant employees.

- [ ] **Step 5: Test the form** — happy path + cross-building denial + multi-host + walk-up disabled visitor type → form shows preventive message.

- [ ] **Step 6: Commit**.

### Task 6.3 — Standalone invite page

- [ ] **Step 1: Implement `/portal/visitors/invite`** page using `SettingsPageShell` + `SettingsPageHeader` per `CLAUDE.md` settings layout, then mount `VisitorInviteForm`.

- [ ] **Step 2: Toast on success** via `toastCreated('visitor invitation', { onView: '/portal/visitors/expected' })` per `CLAUDE.md` toast conventions.

- [ ] **Step 3: Commit**.

### Task 6.4 — "My expected visitors" page

- [ ] **Step 1: Implement `/portal/visitors/expected`** — list of host's upcoming visits with status, expected_at, visitor first name, company. Click row → details panel.

- [ ] **Step 2: Commit**.

### Task 6.5 — Composer "Visitor" line

- [ ] **Step 1: Read existing composer pattern** — `apps/web/src/pages/portal/booking-create.tsx` and `apps/web/src/components/portal/booking-composer/*`.

- [ ] **Step 2: Add a "Visitors" section** to the composer alongside Catering/AV/Cleaning. Reuses VisitorInviteForm but in a smaller drawer/dialog form.

- [ ] **Step 3: Visitor line items inherit bundle's expected_at, building_id, meeting_room_id, booking_bundle_id** automatically.

- [ ] **Step 4: Test composer happy path** — create bundle with visitor line → both reservation + visitor created → cancellation cascades on bundle cancel.

- [ ] **Step 5: Commit**.

---

## Slice 7 — Reception workspace

**Goal:** New top-level `/reception/*` workspace with today-view + quick-add + backdated arrival + batch-entry + yesterday loose ends + daglijst print.

**Files:**
- Create: `apps/web/src/pages/reception/_layout.tsx` (workspace shell)
- Create: `apps/web/src/pages/reception/today.tsx`
- Create: `apps/web/src/pages/reception/passes.tsx`
- Create: `apps/web/src/pages/reception/yesterday.tsx`
- Create: `apps/web/src/pages/reception/daglijst.tsx` (printable)
- Create: `apps/web/src/components/reception/visitor-search.tsx` (autofocused fuzzy search)
- Create: `apps/web/src/components/reception/quick-add-walkup.tsx` (inline form, batch-clear-on-submit)
- Create: `apps/web/src/components/reception/checkout-with-pass.tsx` (return-or-missing modal)
- Modify: `apps/web/src/App.tsx` (mount /reception/* routes; gate via `visitors:reception` permission)
- Test: `apps/web/test/reception/*.spec.tsx`

### Task 7.1 — Workspace shell

- [ ] **Step 1: Read** how `/desk/*` shell is structured — `apps/web/src/pages/desk/_layout.tsx`. Mirror the pattern.

- [ ] **Step 2: Implement `/reception/_layout.tsx`** with own top-nav (Today / Passes / Yesterday / Print). Permission gate: `visitors:reception` required to enter.

### Task 7.2 — Today-view + autofocused search

- [ ] **Step 1: Implement `/reception/today`** with the layout from spec §7.3 (Currently arriving · Expected next 30 min · On site · Yesterday's loose ends).

- [ ] **Step 2: Search input** — autofocused on mount, fuzzy-matches first/last name + host + company; arrow keys + Enter for selection.

- [ ] **Step 3: Per-visitor row actions** — Mark arrived (with backdated picker) · Assign pass · Mark left (with pass-return modal) · No-show.

- [ ] **Step 4: Browser-print friendly Daglijst link** in the header.

### Task 7.3 — Quick-add walkup component

- [ ] **Step 1: Implement** `quick-add-walkup.tsx` — minimal inline form (first name + host picker + visitor type), submit creates walk-up record + clears form + refocuses first input (batch-entry mode).

- [ ] **Step 2: Show preventive error message** when type disallows walk-up or requires approval.

- [ ] **Step 3: Test** — submitting 3 walk-ups in a row preserves form-clear-on-submit; backdated arrival picker exposes the actually-arrived-at time.

### Task 7.4 — Pass actions inline

- [ ] **Step 1: Implement** the pass assignment inline drawer per spec §7.6. Quick-pick from available passes; pre-reserved passes prominent.

- [ ] **Step 2: Implement checkout-with-pass modal** — confirms return, prompts "Mark missing or skip?" if not returned, audit captured.

### Task 7.5 — Yesterday's loose ends

- [ ] **Step 1: Implement `/reception/yesterday`** — count + drilldown for `auto_checked_out=true` visits + unreturned passes. Actions: Mark recovered / Mark lost.

### Task 7.6 — Daglijst print page

- [ ] **Step 1: Implement** `/reception/daglijst` — A4-friendly browser-print layout, multiple visitors per page, signature column.

- [ ] **Step 2: Use `@react-pdf/renderer`** if existing daglijst (vendor portal) uses it; otherwise plain HTML with print CSS.

### Task 7.7 — Verification

- [ ] **Step 1: Spec §16 acceptance criteria 7-11, 21, 23** — verify each by manual test in browser + automated test where feasible.

- [ ] **Step 2: Commit**.

---

## Slice 8 — Kiosk-lite

**Goal:** `/kiosk/:buildingId` PWA-installable, building-bound token auth, QR scan + name-typed fallback, walk-up flow.

**Files:**
- Create: `apps/web/src/pages/kiosk/_layout.tsx` (no portal nav; large-text + tenant brand)
- Create: `apps/web/src/pages/kiosk/index.tsx`
- Create: `apps/web/src/pages/kiosk/qr-scan.tsx`
- Create: `apps/web/src/pages/kiosk/name-fallback.tsx`
- Create: `apps/web/src/pages/kiosk/walkup.tsx`
- Create: `apps/web/src/pages/kiosk/confirmation.tsx`
- Create: `apps/web/src/lib/kiosk-auth.ts` (token storage + rotation)
- Create: `apps/web/src/lib/kiosk-offline-queue.ts` (IndexedDB queue for offline check-ins)
- Test: `apps/web/test/kiosk/*.spec.tsx`

### Task 8.1 — Auth + provisioning

- [ ] **Step 1: Read** vendor-portal auth pattern.

- [ ] **Step 2: Implement** kiosk token storage in localStorage; reads `tenant_id` + `building_id` from token claims; calls API with `Authorization: Bearer <token>`.

- [ ] **Step 3: Provisioning flow** — admin's `/admin/visitors/passes` page (slice 9) has "Provision kiosk for building" button → returns one-time setup URL with embedded token; kiosk on first visit calls `/kiosk/setup?token=...` to bind.

### Task 8.2 — Idle screen + QR scan

- [ ] **Step 1: Implement idle screen** per spec §8.2 — large welcome + two paths.

- [ ] **Step 2: QR scan** uses browser camera API (`navigator.mediaDevices.getUserMedia`) + a JS QR decoder (e.g., `jsqr` or `@zxing/browser`).

- [ ] **Step 3: On scan** call `POST /kiosk/checkin` with the QR token; on success transition to confirmation screen.

### Task 8.3 — Name-typed fallback

- [ ] **Step 1: Large on-screen keyboard** — tenant-branded.

- [ ] **Step 2: Search calls `GET /kiosk/search?q=...`** — returns today's expected at this building only (no cross-tenant leak by construction since kiosk token is bound).

- [ ] **Step 3: Confirmation prompt** — "I'm here to see [host first initial + last name]?" → tap to confirm.

### Task 8.4 — Walk-up at kiosk

- [ ] **Step 1: When name doesn't match**, present visitor type picker (only `allow_walk_up=true and requires_approval=false` types).

- [ ] **Step 2: If at least one type qualifies** — first name + host picker + (optional) email/company → submit creates walk-up.

- [ ] **Step 3: If no types qualify** — "Please see reception" deny screen.

### Task 8.5 — Offline behavior

- [ ] **Step 1: IndexedDB queue** — when API call fails (network), queue the action; show "Reception will be with you shortly".

- [ ] **Step 2: Sync on reconnect** — flush queue; reception today-view shows "queued" badge until synced.

### Task 8.6 — Tests + commit

- [ ] **Step 1: Run kiosk tests** — green.

- [ ] **Step 2: Manual test in browser at staging URL with real token** — QR + name + walk-up paths all work.

- [ ] **Step 3: Commit**.

---

## Slice 9 — Frontend admin + service desk lens

**Goal:** Admin pages for visitor type config + pool management; desk lens at `/desk/visitors` (focused subset).

**Files:**
- Create: `apps/web/src/pages/admin/visitors/types.tsx`
- Create: `apps/web/src/pages/admin/visitors/types/[id].tsx` (per-type detail with auto-save SettingsRow pattern)
- Create: `apps/web/src/pages/admin/visitors/passes.tsx` (pool list)
- Create: `apps/web/src/pages/admin/visitors/passes/[id].tsx` (per-pool detail)
- Create: `apps/web/src/components/admin/space-tree-picker.tsx` (reusable)
- Create: `apps/web/src/pages/desk/visitors.tsx` (focused lens)

### Task 9.1 — Visitor types admin

- [ ] **Step 1: Index page** — Settings shell, list of types, "+ New type" dialog.

- [ ] **Step 2: Detail page** — `SettingsPageShell` + `SettingsGroup` blocks (Identity / Per-type config matrix / Danger zone). Uses `SettingsRow` pattern with auto-save per `CLAUDE.md` Settings page layout.

### Task 9.2 — Pool management

- [ ] **Step 1: Pool list at `/admin/visitors/passes`** — list of pools with anchor space label, pass count, opt-out flags.

- [ ] **Step 2: Detail at `/admin/visitors/passes/[id]`** — Identity (where this pool applies via space-tree picker) / Pass list (CRUD) / Inheritance preview ("This pool covers Building A, Building B; Building D opts out") / Provision kiosk button / Danger zone.

- [ ] **Step 3: Space-tree picker** — reusable component showing campus → site → building tree; only `kind='site'|'building'` selectable.

### Task 9.3 — `/desk/visitors` focused lens

- [ ] **Step 1: Implement** the lens per spec §7.9 — three sections:
  - Visitors with `visitor_type = contractor` AND active service ticket
  - All visitors in `pending_approval`
  - Today's escalations: `email_bounced`, `host_not_yet_acknowledged > 5min`, `unreturned_passes`

- [ ] **Step 2: Commit**.

---

## Slice 10 — Visitor cancel landing

**Goal:** Public `/visit/cancel/:token` page that calls validate_invitation_token + confirms cancellation.

**Files:**
- Create: `apps/web/src/pages/public/visit-cancel.tsx`
- Create: `apps/web/src/api/public-cancel/index.ts`

### Task 10.1 — Cancel landing UX

- [ ] **Step 1: Token landing** — interstitial: "You're cancelling your visit on [date] at [building]. Are you sure?" → Cancel button → confirmation page.

- [ ] **Step 2: Confirmation** — "Your visit has been cancelled. We've notified [host first name]."

- [ ] **Step 3: Error state** — token invalid/used/expired → friendly message + reception phone.

- [ ] **Step 4: One-time-use enforcement** — re-loading the page after cancel shows "Already cancelled — no further action needed".

- [ ] **Step 5: Commit + run full-review skill on frontend (slices 6-10)**.

---

## Slice 11 — Final design-review polish

**Goal:** Run `/design-review` on the visitor surfaces; apply polish findings.

### Task 11.1 — Run design review

- [ ] **Step 1: Invoke `/design-review` skill** with target = visitor surfaces (`/portal/visitors/*`, `/reception/*`, `/kiosk/*`, `/admin/visitors/*`, `/visit/cancel/:token`).

- [ ] **Step 2: Review findings** — typically 5-phase pipeline (persona alignment / composition / motion / a11y / code quality).

### Task 11.2 — Apply polish

- [ ] **Step 1: Apply critical/important findings** — typically: focus management on dialogs, keyboard navigation in reception search, motion easing tokens, contrast ratios on lobby panel display.

- [ ] **Step 2: Re-run design review on changes** if substantial.

- [ ] **Step 3: Commit final polish**.

---

## Acceptance — checklist against spec §16

Run through each numbered acceptance criterion in spec §16 once all slices have landed. Every item must pass or have a documented v2 deferral note in the commit log.

- [ ] §16.1 — host invites visitor → email received with cancel link
- [ ] §16.2 — composer line cascade
- [ ] §16.3 — kiosk QR <30s
- [ ] §16.4 — kiosk name fallback <60s
- [ ] §16.5 — walkup allowed types
- [ ] §16.6 — walkup denied for approval-required
- [ ] §16.7 — reception search <3s
- [ ] §16.8 — backdated arrival audit
- [ ] §16.9 — quick-add walk-up
- [ ] §16.10 — pass assign in_use
- [ ] §16.11 — pass return → available
- [ ] §16.12 — pass not returned → mark missing modal
- [ ] §16.13 — EOD sweep transitions
- [ ] §16.14 — multi-host fan-out + first-to-ack
- [ ] §16.15 — approval flow
- [ ] §16.16 — bundle move cascade
- [ ] §16.17 — visitor cancel via email link
- [ ] §16.18 — pool inheritance
- [ ] §16.19 — cross-building invite scope check
- [ ] §16.20 — GDPR retention anonymization
- [ ] §16.21 — yesterday's loose ends tile
- [ ] §16.22 — cross-tenant blocked
- [ ] §16.23 — daglijst A4 print

---

## Self-review — verifying the plan against spec

This plan covers spec sections:
- §1 Goals + non-goals — covered (slices 1-10 implement goals; non-goals deferred).
- §2 Architecture — covered (slice 2 module + slices 6-10 frontend).
- §3 Identity model — covered (slice 1.5 + slice 2.3 InvitationService).
- §4 Data model — covered (slice 1).
- §5 State machine — covered (slice 1.6 + slice 2.2).
- §6 Invite flow — covered (slice 6).
- §7 Reception workspace — covered (slice 7).
- §8 Kiosk-lite — covered (slice 8).
- §9 Multi-host + notifications — covered (slice 2.5).
- §10 Bundle cascade — covered (slice 4 events + slice 2.9 adapter).
- §11 Approval routing — covered (slice 3).
- §12 EOD sweep — covered (slice 2.8).
- §13 Permissions + visibility — covered (slice 1.7 visibility function + slice 2.11 controllers + catalog SoT registration).
- §14 GDPR integration — covered (slice 1.5 backfill of host_person_id keeps adapter working; no rewrite needed in v1).
- §15 Slice/phasing — this plan IS the slicing.
- §16 Acceptance criteria — checklist above.
- §17 Risks — flagged in spec; mitigations baked into plan.
- §18 Rollback — flagged in plan slice 1 commits.
- §19 v2 backlog — out of scope by definition.

Type consistency:
- `transitionStatus` is consistently named across plan.
- `passPoolForSpace` (TS) calls `pass_pool_for_space()` (SQL).
- `validate_invitation_token` is the SQL function; client/api wrappers consistently named.

Placeholders:
- No "TBD/TODO/maybe/might" in the plan.
- Some "v2 deferral notes" are explicit references to spec §19, not placeholders.

---

**Plan complete.** Ready for subagent-driven execution.
