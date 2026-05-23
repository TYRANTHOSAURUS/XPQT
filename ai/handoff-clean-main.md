# Handoff — finish the last issues for a clean `main`

You are a fresh agent. Goal: get `origin/main` to a clean, deployed, honest state after the RLS/security (Audit 04) work. Read this whole prompt; it is self-contained.

## State of `main` right now (verified)

- `origin/main` tip ≈ `7cf354c9` (advances under you — concurrent sessions share this repo; re-verify).
- RLS audit Slices 1–11.6 already on main via **PR #17**.
- Audit-04 2026-05-18 delta merged via **PR #30**: notification IDOR routes deleted; `00415` (revoke table write-DML from anon/authenticated, SELECT kept); `00417` (intended browser RPC-EXECUTE lockdown).
- **`00417` was a catastrophic bug** — `REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM PUBLIC, anon, authenticated`. RLS policies call `public.current_tenant_id()`; Postgres checks EXECUTE **as the querying role** (even for SECURITY DEFINER), so every browser/Realtime read on every RLS table broke (`42501 permission denied for function current_tenant_id`). Full app data "disappeared" for logged-in users.
- Reverted by **`00420`** via **PR #31** (`7cf354c9`): full revert of 00417's blanket revoke + restore Supabase-default EXECUTE to anon/authenticated, keeping ONLY the narrow correct per-function lock of the one real cross-tenant leak `public.tickets_distinct_tags(uuid)` (revoked from PUBLIC/anon/authenticated, granted service_role).
- **Remote Supabase DB is verified correct live**: all RLS reads 200; `tickets_distinct_tags(foreign tenant)` → 403 (leak closed); bearer-token trio reachable. Migrations 00415/00417/00420 applied to remote.

## Remaining issues for a clean `main` (prioritized)

1. **[P0 — ops] Production API is NOT deployed.** `.github/workflows/deploy.yml` (push to main): Validate ✓, Web→Vercel ✓, **API→Render ✗** — `Render trigger failed with HTTP 401` (`RENDER_API_KEY` secret invalid/expired; has failed every merge incl. #25/#26/#28/#29/#30/#31). The DB is correct but the **running Render API serves stale code** (still has the deleted notification IDOR routes, etc.). Fix path:
   - Fastest unblock (no key): Render dashboard → `xpqt-api-eu` service → **Manual Deploy → Deploy latest commit**.
   - Permanent: rotate `RENDER_API_KEY` (Render → avatar → Account Settings → API Keys → Create; then GitHub repo → Settings → Secrets and variables → Actions → update `RENDER_API_KEY`; sanity-check `RENDER_SERVICE_ID`). Then `gh run rerun 26101705627 --failed` (latest deploy run) or `gh workflow run deploy.yml`.
   - Alternative permanent: enable Render native Auto-Deploy (service Settings → Build & Deploy → Auto-Deploy = Yes, branch `main`) — then the GH Actions render job is redundant.
   - **Verify after**: API deploy job green AND a real authenticated browser session can read data end-to-end through `https://xpqt-api-eu.onrender.com` (the Vercel rewrite target).

2. **[P1] Validate `pnpm db:reset` from `main` ends in the CORRECT state.** The chain has `00417` (bad blanket revoke) then `00420` (revert + narrow). Confirm a clean reset runs both without ON_ERROR_STOP aborting (00417 emits WARNINGs, not errors — verify) and ends with: `has_function_privilege('authenticated','public.current_tenant_id()','EXECUTE')` = true; `has_function_privilege('authenticated','public.tickets_distinct_tags(uuid)','EXECUTE')` = false; `service_role` = true.

3. **[P1] Add a browser-path RLS regression smoke probe.** The outage slipped through because all smoke gates use the **service_role / NestJS API path** which bypasses RLS-helper EXECUTE. Add to `apps/api/scripts/smoke-cross-tenant.mjs` (or a new gate): mint a real authenticated **browser** session token (magiclink→verify, like `mintTokenFor`), do a plain `GET {SUPABASE_URL}/rest/v1/<table>?select=id&limit=1` for ≥3 RLS tables (`inbox_notifications`, `bookings`, `tickets`) → assert HTTP 200 and body does NOT contain `permission denied for function`. This catches the entire blanket-revoke / RLS-helper class. Make it part of the standard gate.

4. **[P2] Append-only incident record in the ledger on `main`.** `docs/follow-ups/audits/04-rls-security.md` on main has no entry for the 00417 outage / 00420 correction. Add an append-only block (incident, mechanism, 00420, live verification, lesson). Doc-only; clean branch off current `origin/main` → PR.

5. **[P2] Disposition PR #27.** `feature/booking-audit-remediation` is ~107+ behind main, `CONFLICTING` (38 files), carries parallel audit02/03-booking work (some uncommitted, not yours). The audit-04 portion is now independently on main via #30/#31, so **#27 is superseded for Audit 04**. Do NOT force-merge it (it would revert main work). Action: confirm with the audit02/03-booking owners; they must land their work via their own clean branches off current `origin/main`. Recommend closing #27 with a comment pointing at #30/#31 + this handoff, once owners ack.

## Do NOT touch — intentional, documented (not regressions)

- Broad browser RPC-EXECUTE surface is back to its pre-session **tracked-P2** posture (the blanket close was withdrawn as infeasible — it breaks RLS; see `00420` header + memory `feedback_never_blanket_revoke_execute_supabase`). **Never re-attempt a schema-wide `REVOKE EXECUTE`.** Lock individual proven SECURITY DEFINER leaks per-function only.
- Browser-direct SECURITY INVOKER **reads** remain RLS-gated/claim-dependent (SELECT kept for Realtime) — same latent class, fail-closed today, accepted/tracked.
- Avatar Storage cross-tenant READ (P3, GDPR/storage backlog); global `ValidationPipe` (P3, API-hardening backlog); caller-free `AdminGuard` deletion (P3 hygiene, CI-banned against reintroduction). All documented decisions.

## Rules

- Verify every security claim against **committed HEAD + live remote DB**, never the working tree alone (recurring false-green failure mode in this audit).
- Shared repo / concurrent sessions: **file-scoped explicit-pathspec commits** (`git commit <paths>` not bare); operate on **clean branches off current `origin/main`**, never the stale `feature/booking-audit-remediation`.
- **DB pushes to the remote Supabase = deploy-class: confirm with the user first.** psql fallback: `PGPASSWORD="$(grep -E '^SUPABASE_DB_PASS=' .env | cut -d= -f2-)" psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f <file>` then `notify pgrst, 'reload schema';`.
- Never `--no-verify` / skip hooks. If a pre-push hook fails from a node_modules-less worktree, push from the main repo dir (refs are shared).

## Completion bar for "clean main"

- [ ] API deploys green end-to-end (Render), production API serves current `main` code; browser end-to-end read works.
- [ ] `pnpm db:reset` from `main` yields correct RLS + leak posture (assertions in #2).
- [ ] Browser-path RLS regression smoke probe added and green.
- [ ] Ledger has the append-only 00417/00420 incident record on `main`.
- [ ] PR #27 dispositioned (closed/superseded or owners notified); no stale-monolith merge.
- [ ] Residuals above confirmed documented as intentional, not "fixed."
