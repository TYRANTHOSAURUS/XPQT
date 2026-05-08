# Phase 7 — implementation plan

> **Status:** v1 plan, scoping. Implementation gated on the user's go-ahead.
>
> **Reading order:**
> 1. `docs/superpowers/specs/2026-05-02-error-handling-system-design.md` — the contract.
> 2. `docs/follow-ups/phase-7-error-codes.md` — registered codes from Phase 1.
> 3. This doc — incremental wave plan.

## 0. Scope

Phase 7 lands the AppError + classifier + messages catalog described in the design spec. v1 is **server-side only** — `apps/api/`. Client-side renderer / hooks / per-route ErrorBoundary is Phase 7.B (separate wave).

**Today's state (audited 2026-05-08):**
- 834 raw `throw new <Nest>Exception(...)` / `throw new Error(...)` sites in `apps/api/src` (excluding specs).
- Zero `*.filter.ts` files. Zero `@Catch` decorators.
- One coded error globally (`permission_denied` in `permission-guard.ts:45`).
- No `AppError` class. No `error-codes.ts`. No `messages.en.ts`.
- Frontend `ApiError` exists at `apps/web/src/lib/api.ts` but only with `is*Error` boolean predicates; no classification.

**Phase 7.A scope (this plan):**
- `AppError` class in `apps/api/src/common/errors/`.
- `AllExceptionsFilter` — global Nest filter.
- `error-codes.ts` shared registry in `packages/shared/src/`.
- `messages.en.ts` server-side mapping (English-only for v1; Dutch in Phase 7.B).
- Migrate first wave of throws (~150 sites in the highest-leverage modules: ticket, sla, booking, approval).
- CI guard: every new throw must use AppError.

**Phase 7.B (deferred to follow-up):**
- Migrate remaining ~684 throws across other modules.
- Frontend `classify()` + 11 ClassifiedError surfaces + per-route ErrorBoundary.
- Dutch localization.
- AccessRequest button (deferred per design spec decision #8).

## 1. Wave plan

### 7.A.1 Foundation (single commit)
- `apps/api/src/common/errors/app-error.ts` — AppError class with code/status/fields/cause/docsUrl.
- `apps/api/src/common/errors/error-codes.ts` — register Phase 1 codes from `phase-7-error-codes.md`.
- `apps/api/src/common/errors/messages.en.ts` — English mapping.
- `packages/shared/src/error-codes.ts` — shared union type for client.
- `apps/api/src/common/errors/all-exceptions.filter.ts` — global filter normalising every throw to wire shape.
- `apps/api/src/main.ts` — wire the filter as global.
- Tests: 30+ specs covering AppError factory + filter normalisation of HttpException / ZodError / pg / PostgrestError / unknown.

**Output:** every throw in main now produces RFC 9457-shaped responses with `code`, `title`, `detail`, `status`, `traceId`. Legacy `BadRequestException(string)` maps to `generic.bad_request`.

### 7.A.2 First migration wave (one commit per module, 4 commits)
Migrate raw throws in:
- `apps/api/src/modules/ticket/` (~60 sites)
- `apps/api/src/modules/sla/` (~40 sites)
- `apps/api/src/modules/booking-bundles/` + `reservations/` (~30 sites)
- `apps/api/src/modules/approval/` (~20 sites)

Pattern per site:
```ts
// Before:
throw new BadRequestException('Ticket not in tenant');
// After:
throw AppErrors.notFound('ticket.not_in_tenant', { ticket_id: id });
```

Each module's migration:
1. Read every raw throw.
2. Map to a code in `error-codes.ts`. Reuse existing if one fits; add new if not.
3. Add English message to `messages.en.ts`.
4. Replace throw with `AppErrors.<class>(<code>, ...)`.
5. Update tests that asserted on the old message text.

### 7.A.3 CI guard
- Add `scripts/check-app-errors.sh` — fails CI if it finds `throw new BadRequestException` / `NotFoundException` / `ForbiddenException` / `ConflictException` / `InternalServerErrorException` / `Error` in `apps/api/src/modules/{migrated_modules}/`.
- Allowlist for sites we explicitly chose not to migrate (e.g., bootstrap-time errors that fire before TenantContext is set).

### 7.A.4 Tests + smoke
- Add `pnpm smoke:errors` — drive every wire shape variant against the live API and assert response shape.
- Existing test suite must stay green (the filter changes wire shape, so any test that asserted on `error.message` or `error.statusCode` may need updates).

### 7.A.5 Docs
- Update CLAUDE.md "Error handling (mandatory)" section to point at the new AppError factories + the migrated modules.
- Mark `phase-7-error-codes.md` Phase 1 entries as "registered in 7.A.1" with their final code.

## 2. Estimated effort

- 7.A.1 foundation: 1-2 days (mostly mechanical; the design spec is concrete).
- 7.A.2 four module migrations: 1 day each = 4 days.
- 7.A.3 CI guard: 0.5 day.
- 7.A.4 tests + smoke: 1-2 days.
- 7.A.5 docs: 0.5 day.

**Total: 7-9 working days = 1.5-2 weeks** for one engineer focused.

## 3. Dependencies

- B.0 (shipped): the spec's filter normalises B.0's atomic-RPC error codes.
- B.2.A (planned): when B.2 RPCs ship, their AppErrors land already-coded. No retrofit.
- Phase 8 (canonical naming): orthogonal — Phase 7 doesn't depend on naming changes.

## 4. Risks

1. **Test churn.** Tests asserting on error message text or status code will break. The filter standardises status (e.g. legacy `400` for "not found" → `404`). Estimate: 50-80 spec edits.
2. **Wire-shape breaking change for clients.** Frontend currently parses `ApiError` loosely. If client expects `error.message` and we send `error.detail`, a UI refresh is needed. Mitigate by keeping the legacy field synthesised in the filter for one release cycle.
3. **Vendor name leakage in messages.en.ts.** Decision #13 forbids vendor names in user-visible copy. Reviewer must scrub messages before merge.

## 5. Cutover sequence

1. Land 7.A.1 foundation. Filter is global; every throw now emits the new shape.
2. **No breaking change yet** — legacy throws are normalised by the filter to `generic.<class>` codes; clients still see the same surface.
3. Land 7.A.2 wave 1 (ticket / sla / booking / approval). Their throws now emit specific codes.
4. Frontend can start consuming codes per Phase 7.B (separate wave; not in this plan).
5. Phase 7.A is "done" when the first 4 modules are migrated + CI guard active for those modules.

## 6. Out of scope

- Phase 7.B (frontend renderer + per-route ErrorBoundary + Dutch localization).
- Migrating the remaining ~684 throws across non-priority modules.
- AccessRequest ticket type + routing (deferred per design spec).
- Sentry-style modal-with-comment dialog (deferred to v2 per design spec).

## 7. Open questions

1. **Where should `AppErrors.<class>` factories live?** `apps/api/src/common/errors/factories.ts` or co-located in `app-error.ts`? Recommend co-located for v1.
2. **Should AppError carry the locale?** Or always English on the server, and the client localizes? Design spec says client-side. Confirm.
3. **Wire-shape backwards compat for one release cycle?** Synthesise a legacy `message` field alongside the new `detail` to avoid breaking the frontend before Phase 7.B lands. Recommend yes.

---

**Status:** v1 plan ready. Awaiting user go-ahead before starting 7.A.1.
