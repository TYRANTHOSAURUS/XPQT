# Handoff — Finish B.4.A.5 (notification dispatch substrate)

You are picking up the tail end of **B.4.A.5 — notification dispatch substrate** in the XPQT repo. The main work is shipped to `origin/main`. Your job is to close the deferred follow-ups + run the unverified live smoke probes + keep iterating until everything is genuinely done.

Work autonomously. Standing authorizations apply (memories `feedback_db_push_booking_modal`, `feedback_autonomous_with_codex`). Honest reports beat optimistic ones — flag every blocker, don't hide deferrals.

---

## 0 — Required reading (in order, before touching anything)

These are all in `/Users/x/.claude/projects/-Users-x-Desktop-XPQT/memory/`:

1. **`project_b4a5_shipped.md`** — the retrospective. Architecture summary (3 parallel write paths + Realtime channel shape + trigger fan-out + admin overrides). Every finding from the 3-layer review (full-review + codex + main-thread). All deferred items with concrete fix recipes.
2. **`feedback_codex_long_argv_hang.md`** — codex hangs on >2KB inline ARGV. Mitigation: write prompts to `/tmp/codex-<slug>.md` and pass a 1-sentence "Read this file" ARGV.
3. **`feedback_migration_number_collision.md`** — parallel workstreams claim migration slots concurrently. Run `ls supabase/migrations/ | tail -5` immediately before authoring; auto-rebase to next free slot.
4. **`feedback_review_loop_protocol.md`** — two-checkpoint review pattern (plan + code, full-review first then conditional codex).
5. **`project_b4_workstream_state.md`** — parent B.4 booking-edit-pipeline context.

Then read `docs/follow-ups/b4a5-followups.md` (in the repo) for the canonical deferred-items list with full design context.

---

## 1 — Current state (verified 2026-05-13 → carry over to your start)

- **Branch:** `main`. Latest B.4.A.5 commit: `e4caab56`.
- **Migrations on remote** (verified via psql): `00391, 00392, 00394, 00395, 00399, 00401, 00402, 00404`.
- **All CRITICAL + IMPORTANT findings** from the 3-layer review are resolved.
- **Working tree dirty** with parallel-workstream WIP (floor-plan, Phase 1.5 6.E, possibly more by the time you start). **DO NOT STAGE** these files in your commits — explicit list in §3.
- **Gates green** for unit + build paths: `errors:check-app-errors` (0 raw throws), reservation specs (244/244), outbox+inbox+approval+workflow specs (320/320), web build (~9s).
- **One known un-verified path:** live smoke probes. See P0 below.

Before doing anything else, run these checks to ground yourself:
```bash
git status                                     # know what dirty files NOT to touch
git log --oneline -5                           # confirm HEAD is e4caab56 or later
ls supabase/migrations/ | tail -5              # know which slot to claim next
```

---

## 2 — Priority-ordered work backlog

Address P0 → P4 in order. After each, run `/full-review` (per `feedback_review_loop_protocol`), fold findings, conditional codex if available.

### P0 — Run the live smoke probes

**Why this is P0:** `CLAUDE.md` calls smoke gates "mandatory before claiming ship." The B.4.A.5 step-H + Plan-C1+C2 commits added 2 new approval-flipping scenarios to `apps/api/scripts/smoke-edit-booking.mjs` and `apps/api/scripts/smoke-edit-booking-scope.mjs`. Neither has run live — every previous attempt was blocked by Cloudflare HTTPS to `*.supabase.co` timing out from the terminal.

**Pre-check** (3 seconds):
```bash
curl -sI -o /dev/null -w '%{http_code}\n' https://iwbqnyrvycqgnatratrk.supabase.co/rest/v1/
```
- Expect `401` or `200` quickly. If `000` / hangs, you have the same env block. **Do not modify network state** to fix it (per memory: "Never modify network/VPN/routing state on user's behalf"). Surface to the user and skip to P1.
- If the curl returns quickly, proceed.

**Run** (with API dev server up — `pnpm dev:api` in another shell, wait ~10s):
```bash
pnpm --filter @prequest/api smoke:edit-booking
pnpm --filter @prequest/api smoke:edit-booking-scope
```

**Expected:** exit 0 on both. Each new approval-flipping scenario asserts HTTP 200 + new `approvals` row + new `inbox_notifications` row + new outbox event. Cleanup happens in `finally`.

**If a smoke fails with a non-network error:** it's a real regression. The most likely site is the 00402 trigger + 00404 backfill interaction with chain_id-bearing rows from `createApprovalRows`. Investigate root cause, fix, re-run. Don't band-aid.

**If the smoke fails with a network error:** document the env block, move to P1.

### P1 — Locale fallback hardening

**Where:** `apps/api/src/modules/outbox/handlers/booking-approval-required.handler.ts` — `BookingApprovalRequiredHandler.handle`. The handler reads each approver's `users.locale_preference` (column doesn't exist), so it always falls back to `tenants.locale_default`. NL-default tenants get correct NL emails; EN-default tenants where individual users prefer NL still get EN.

**Fix path** (per `b4a5-followups.md` §"Per-user locale_preference override"):

1. **Migration: add `locale_preference text null` to `public.users`.** Claim next free slot (likely 00405+ depending on what's landed in parallel). Add a check constraint `locale_preference IN ('en','nl')` matching the template-overrides schema. No RLS change (existing user RLS covers it).

2. **Push the migration** via psql fallback (see `.claude/CLAUDE.md` for the exact command), then `notify pgrst, 'reload schema';`.

3. **Update the handler:** find the two SELECTs in `handle()` that fetch user rows (marked with TODO comments per `b4a5-followups.md`). Add `locale_preference` to the column list. Plumb the per-user value into the `userMap`. Switch the dispatch loop to prefer per-user → fall back to `resolveTenantLocale()` for users with NULL preference.

4. **Test:** add a scenario in `booking-approval-required.handler.spec.ts` covering "user with `locale_preference='nl'` in an EN-default tenant gets a NL email." Existing per-tenant fallback tests stay green.

**LOC estimate:** ~80 across 1 migration + handler updates + 1 new spec scenario.

### P2 — Admin live-preview pane

**Where:** `apps/web/src/pages/admin/notification-templates/[event-kind].tsx`. The editor at `width="xwide"` has an empty right pane — plan v2 §Sub-step G named this as a live preview of the rendered email HTML with the override applied.

**Fix path** (per `b4a5-followups.md` §"Live preview pane (deferred)"):

1. **Backend:** add `POST /admin/notification-templates/:eventKind/preview` endpoint to the existing `template-overrides.controller.ts`. Body: `{ locale, subject_override?, cta_text_override?, body_intro_override? }`. Calls a new `TemplateResolverService.previewWithDraftOverrides(...)` that skips the DB lookup and uses the supplied draft. Returns `{ subject, html, text, ctaText }`. Gate via `notifications.manage_templates` (same as the existing PUT endpoint).

2. **Mock payload:** a static fixture in `apps/api/src/modules/notifications/templates/preview-fixtures.ts` for each event kind (`booking.approval_required` v1). The admin can't pick a real booking — preview is for copy-review only.

3. **Frontend:** add `useNotificationTemplatePreviewMutation` to `apps/web/src/api/notification-templates/mutations.ts`. In `[event-kind].tsx`, mount an `iframe srcDoc={previewHtml}` on the right side of the two-column layout. Debounce the preview call ~600ms after the latest edit so admin doesn't spam the endpoint.

4. **Test:** controller spec for the new endpoint (validation + permission gate); frontend test for the mutation hook + debounce.

**LOC estimate:** ~200 across backend endpoint + frontend integration + tests.

**Risk:** the iframe `srcDoc` approach sandboxes the rendered HTML cleanly; don't fall back to `dangerouslySetInnerHTML` in the host page (XSS vector if a template override contains crafted markup).

### P3 — CTA URL swap (when `/desk/approvals` Sprint 2 lands)

**Where:** `apps/api/src/modules/outbox/handlers/booking-approval-required.handler.ts` → `buildApprovalCtaUrl()`.

**Pre-check:** `grep -rn "/desk/approvals/" apps/web/src/ | head` — if the route exists, swap is safe; if not, **leave this deferral alone** until approvals Sprint 2 lands (it's not in B.4.A.5 scope).

**If the route exists:** change `buildApprovalCtaUrl()` to return `/desk/approvals/<chainId>` (the `chainId` param is already passed in; was `void chainId;` placeholder). Update the single happy-path assertion in `booking-approval-required.handler.spec.ts` (search for `?tab=approval`).

**If portal-only approvers still need a separate URL:** add role-based branching in `buildApprovalCtaUrl()` — read the approver's user role (operator vs requester-only) and pick the path. Don't ship a "common URL works for both" claim unless you verified the route actually works for portal-only users.

**LOC:** ~5-30 depending on whether role-branching is needed.

### P4 — JSX runtime build-time smoke (step C deferral)

**Where:** new npm script + small node test.

**Why:** the API tsconfig has `module: CommonJS + jsx: react-jsx`, which produces `_jsx`/`_jsxs` calls in compiled `.js`. The `@react-email/render` integration test gated by `NOTIFICATIONS_REAL_RENDER=1` runs against the SOURCE `.tsx` via ts-jest, not against the BUILT `dist/`. JSX-runtime config drift would slip past.

**Fix path** (per `b4a5-followups.md` §"I7 — TS build-time JSX runtime smoke"):

1. Add `apps/api/package.json` script `test:notifications:dist`:
   ```json
   "test:notifications:dist": "pnpm --filter @prequest/api build && node ./test/notifications-render-dist-smoke.mjs"
   ```

2. Author `apps/api/test/notifications-render-dist-smoke.mjs`:
   - Import the built `dist/modules/notifications/templates/booking-approval-required.en.js`.
   - `React.createElement(...)` with a fixture payload.
   - Pipe through real `@react-email/render`.
   - Assert HTML + text non-empty, contains expected copy ("approval", a CTA button), contains `style=` attributes.

3. Wire into CI (`.github/workflows/*.yml` or whichever the project uses) as a parallel job alongside the existing test gates.

**LOC:** ~80 (script + CI wire-up).

### Deferred (DO NOT pick up unless conditions change)

- **Dormant `approvals.delegated_to_person_id` column.** Zero references in `apps/api/src` + `apps/web/src` (re-verify before claiming dormant). If/when a feature SETs it via UPDATE, add the trigger described in `b4a5-followups.md` §"Dormant column" — but **not preemptively**. YAGNI.

---

## 3 — Files to NEVER stage in your commits

`git status` will show dirty WIP from parallel workstreams running in other sessions. Use **explicit `git add <path>`** — never `git add .` or `-A`. Verify with `git status` immediately before every commit.

**Cross-workstream — leave alone:**

- `CLAUDE.md` (user's own manual refactor; not your work)
- Anything under:
  - `apps/web/src/components/floor-plan/**`
  - `apps/web/src/pages/portal/book-floor/**`
  - `apps/web/src/pages/desk/scheduler/**` (floor-view scheduler edits)
  - `apps/web/src/components/admin/space-detail/**`
  - `apps/web/src/api/floor-plans/**`
  - `apps/api/src/modules/floor-plan/**`
  - `apps/api/scripts/smoke-floor-plans.mjs`
- `apps/api/src/modules/room-booking-rules/**` (Phase 1.5 6.E in-flight)
- `apps/api/src/modules/approval/approval-config-compiler.service.ts` (Phase 1.5 6.A — might already be committed by the time you start, in which case it'll be clean; if dirty, leave it)
- `apps/api/src/common/errors/messages.{en,nl}.ts` (UNLESS your fix needs to register a new error code in the same edit — then stage only the line you added)
- `packages/shared/src/error-codes.ts` (same caveat)
- `supabase/migrations/00378_search_global_asset_branch_fix.sql` (pre-existing untracked, unrelated)
- `supabase/migrations/00400_*` (Phase 1.5 — already on origin)
- `docs/admin-page-conventions.md`, `docs/smoke-gates.md` (user's own docs)
- `apps/web/src/test-setup.ts` (already on origin)

**B.4.A.5 surface — owned by you:**

- `apps/api/src/modules/outbox/handlers/booking-approval-required.handler.ts`
- `apps/api/src/modules/notifications/**` (your additions only — don't refactor existing)
- `apps/api/src/modules/inbox/**` (likewise)
- `apps/api/scripts/smoke-edit-booking.mjs` + `smoke-edit-booking-scope.mjs`
- `apps/web/src/pages/admin/notification-templates/**`
- `apps/web/src/api/notification-templates/**`
- `apps/web/src/api/inbox/**`
- `apps/web/src/components/app-shell/inbox-bell.tsx`
- `apps/web/src/lib/realtime/inbox-subscription.ts`
- `apps/web/src/pages/me/inbox.tsx`
- New migrations you author (next-free-slot)
- `docs/follow-ups/b4a5-followups.md` — APPEND new entries; never modify existing ones

---

## 4 — Working pattern (one cycle per P-item)

1. **Verify pre-condition** for the P-item (e.g. P0's curl check, P3's grep for the route).
2. **Brainstorm** if any design decision is non-obvious (per `superpowers:brainstorming` skill). If the design is mechanical and the b4a5-followups entry already names the fix, skip brainstorming.
3. **Delegate implementation** to a fresh general-purpose Agent subagent. Brief tightly:
   - State of play (what's already done; HEAD; relevant memories to read)
   - Specific files + line numbers to touch
   - Files NOT to stage (paste the §3 list)
   - Standing authorization for DB pushes
   - Commit message convention (`fix(b4a5):` or `feat(b4a5):`)
   - Stop-and-ask conditions (scope creep, unexpected regressions, network blocks)
4. **Run `/full-review`** (parallel plan + code adversarial subagents per the skill).
5. **Fold findings.** CRITICAL fixes are mandatory; IMPORTANTs you can fix or document.
6. **Conditional codex review.** Per `feedback_codex_long_argv_hang`, write the prompt to `/tmp/codex-<slug>.md` and pass a short ARGV. Set a 6-min watchdog (per spec R6): if zero TCP + ~0s CPU + 0-byte output buffer at 6 min, kill the codex process tree (3 PIDs: shell wrapper, node wrapper, native binary) and skip codex for this item — `/full-review` is the qualifying second reviewer.
7. **Fold any new findings.**
8. **Commit + push** with explicit file paths.
9. **Update `docs/follow-ups/b4a5-followups.md`** — strike-through the entry you just closed; never delete entries (auditability).
10. **Update memory** — append a one-liner to `project_b4a5_shipped.md` "Final state on origin/main" with the new commit + migration.

---

## 5 — When you're done with everything

After P0-P4 are addressed or definitively blocked:

1. **Refresh memory** — update `project_b4a5_shipped.md` "Open follow-ups" section to mark each item shipped or document why it's still deferred.
2. **Update `MEMORY.md` index** if any new pattern emerged worth a separate feedback memory (don't proliferate; only if genuinely new).
3. **Report to the user** with:
   - List of commits shipped (hash + 1-line subject)
   - List of items still deferred (with concrete blocker)
   - Any new pattern worth capturing
   - Whether the smoke probes ran live (the single most-important signal — was the gate satisfied or still env-blocked?)

---

## 6 — Hard rules

- **Never modify network/VPN/routing state.** Read-only diagnostics OK. Per memory `feedback_no_network_state_changes` — even "want me to run it for you?" is the violation. Surface the env block, let the user resolve.
- **Never `git add .` or `-A`.** Always explicit paths.
- **Never skip a smoke gate without surfacing it.** Documented deferral is fine; silent skip is not.
- **Never commit on someone else's behalf.** If you discover a parallel-workstream file is dirty, leave it. The owner will deal with it.
- **Never invent migration numbers.** Run `ls supabase/migrations/ | tail -5` immediately before authoring.
- **Never run `/full-review` or codex from inside an implementation subagent.** The orchestrator handles those.
- **Never bypass pre-push hooks with `--no-verify`** unless the user explicitly authorizes it for that exact push.
- **Stop and ask** if: a planned migration number is taken AND you can't deduce the next free slot; an existing test fixture breaks in a way that suggests upstream regression; a finding implies a refactor >150 LOC outside the P-item's scope.

---

## 7 — Done criteria

You can claim B.4.A.5 fully done when ALL of:

- [ ] P0 smoke probes ran green OR explicitly documented as env-blocked with the diagnostic
- [ ] P1 locale fallback shipped with the migration on remote + test scenario
- [ ] P2 admin live-preview shipped with backend endpoint + frontend integration
- [ ] P3 CTA URL — either swapped (if `/desk/approvals` is live) or explicitly noted as still-deferred
- [ ] P4 JSX dist smoke wired into CI
- [ ] `b4a5-followups.md` reflects all closures
- [ ] `project_b4a5_shipped.md` memory updated
- [ ] `git status` shows clean (your B.4.A.5 work; the cross-workstream WIP can still be dirty — that's their owner's problem)

Until those check-boxes are real (not just claimed), keep working.

---

**End of handoff.** Start with §0 reading, then §1 state-grounding, then P0.
