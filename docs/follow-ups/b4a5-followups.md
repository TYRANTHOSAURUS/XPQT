# B.4.A.5 follow-ups

Deferred items from B.4.A.5 (notification dispatch substrate). Each entry
documents a known gap — pull off this list when the cost of leaving it
deferred outweighs the cost of fixing it.

## Sub-step C — notifications module backend

### I7 — TS build-time JSX runtime smoke (deferred)

**Status:** logged; defer until the substrate has a real production
exercise (sub-step D + H smoke probe is the natural pickup point).

**The gap.** The API tsconfig has `module: CommonJS + jsx: react-jsx`,
which produces `_jsx`/`_jsxs` calls in the compiled `.js`. The
`@react-email/render` integration test
(`apps/api/src/modules/notifications/templates/template-resolver.integration.spec.ts`,
gated by `NOTIFICATIONS_REAL_RENDER=1`) runs against the SOURCE `.tsx`
files via ts-jest, not against the BUILT `dist/` output. A breaking
change in the JSX runtime resolution (e.g. mismatched `react-jsx` vs
`react-jsxdev`, missing `jsx-runtime` package, esModuleInterop drift)
that only manifests after `tsc` would slip past the test gate.

**The fix when picked up.** Add an npm script `test:notifications:dist`
that:
  1. Runs `pnpm --filter @prequest/api build`.
  2. Runs a small node script that imports a built template module
     (`dist/modules/notifications/templates/booking-approval-required.en.js`),
     calls `React.createElement(...)`, and pipes through the real
     `@react-email/render`.
  3. Asserts the same shape the integration spec asserts (HTML + text
     non-empty, contains expected copy, contains `style=` attributes).

The smoke probe in sub-step D + H is the natural pickup point — those
scripts already build + run against the dist output for real Resend
dispatches. Adding a "render-only" smoke before the full E2E is cheap.

**Not blocking sub-step C.** The integration test (run with
`NOTIFICATIONS_REAL_RENDER=1`) exercises the source-layer render and
catches `@react-email/render` upgrade regressions. The TypeScript
compiler catches JSX-runtime config drift at build time. The remaining
risk is "the runtime config is fine, ts-jest agrees, but `tsc` produces
a different module shape" — narrow enough to defer.

## Sub-step D — outbox handler dispatch

### CTA URL — swap to `/desk/approvals/<chainId>` once Sprint 2 ships

**Status:** logged; current handler falls back to
`/desk/bookings/<bookingId>?tab=approval`.

**The gap.** `BookingApprovalRequiredHandler.buildApprovalCtaUrl()`
builds the CTA URL targeting the booking detail surface because
`/desk/approvals/<chainId>` does not exist on `main` — approvals
Sprint 2 hasn't shipped. The current fallback works (the booking detail
page surfaces the inline approval panel via `?tab=approval`), but the
"approvals workspace" is the proper destination.

**The fix when picked up.** In `buildApprovalCtaUrl`, swap the path
from `/desk/bookings/<bookingId>?tab=approval` to
`/desk/approvals/<chainId>` and drop the `bookingId` arg. The signature
is already prepared with `void chainId;` for the swap. Update the
single happy-path assertion in
`booking-approval-required.handler.spec.ts` (search for
`?tab=approval`).

### Outbox max-attempts vs Resend 24h dedupe window

**Status:** verified safe at current defaults; revisit on any env-knob
bump.

**The window.** `OutboxWorker.maxAttempts` defaults to `5`; backoff is
`[30s, 2m, 10m, 1h]`. Worst-case time-to-dead-letter is
~70 minutes — well inside the Resend `Idempotency-Key` 24h dedupe
window.

**Why this matters.** `BookingApprovalRequiredHandler` passes
`<eventId>:<userId>` as the dispatch idempotencyKey. Resend dedupes
on (key + payload) for 24 hours. After 24h the dedupe stops, so a
retry past that window would deliver a duplicate email per approver.

**When to re-check.**
- `OUTBOX_MAX_ATTEMPTS` env override pushes attempts >5.
- `OUTBOX_BACKOFF_MS` env override extends the schedule to >>1h
  per attempt or adds a many-hour final retry.
- Resend changes their dedupe window (currently documented as 24h —
  re-verify when the SDK is bumped).

If any of those happen, either cap retries to stay inside Resend's
window, or add an internal idempotency cache on this handler that
short-circuits beyond N attempts.

### Per-user `users.locale_preference` override

**Status:** logged; current handler reads `tenants.locale_default`
once per event and applies that locale to every approver.

**The gap.** No per-user locale override exists today — a Dutch user
in an EN-default tenant gets EN emails. NL-primary tenants
(`tenants.locale_default = 'nl'`) get NL across the board, which is
the realistic shape for the Benelux market.

**The fix when picked up.** When `users.locale_preference` lands on
the `users` table:
  1. Add `locale_preference` to both SELECTs in steps 4 + 5 of
     `BookingApprovalRequiredHandler.handle` (marked with TODO
     comments).
  2. Plumb the per-user value into the userMap.
  3. Switch the dispatch loop to prefer per-user locale, falling back
     to the tenant locale resolved by `resolveTenantLocale()`.
  4. Add a test scenario in `booking-approval-required.handler.spec.ts`
     covering "user prefers NL inside EN tenant → NL email".

The plumbing keeps the single tenants read as the fallback so the
N+1 risk doesn't reappear.

## Sub-step G — admin UI for template overrides

### Live preview pane (deferred)

**Status:** plan v2 §Sub-step G named a right-pane live preview of the
rendered email HTML; sub-step G shipped the editor without it.

**The gap.** The `[event-kind].tsx` editor surfaces the three override
fields per locale but does NOT show what the final email body will
look like with the override applied. Today the admin has to send a
test booking through the dispatch path to see the rendered output.

**Why deferred.** Real React Email render in the browser would either:
  1. Bundle `@react-email/render` + every template TSX into the web
     build (adds ~200KB and makes admin pages depend on server-side
     rendering libraries), OR
  2. Add a server endpoint `POST /admin/notification-templates/:eventKind/preview`
     that takes draft override fields + sample payload and returns
     rendered HTML.

Option 2 is the cleaner pickup; it's straightforward — `TemplateResolverService.resolve()`
already does the work, the new endpoint just calls it with a draft
overrides map instead of loading from the DB.

**The fix when picked up.**
  1. Add `POST /admin/notification-templates/:eventKind/preview` —
     body shape `{ locale, subject_override?, cta_text_override?,
     body_intro_override? }`. Calls a new
     `TemplateResolverService.previewWithDraftOverrides(...)` that
     skips the DB lookup and uses the supplied draft. Returns
     `{ subject, html, text, ctaText }`.
  2. Switch `[event-kind].tsx` to `width="xwide"` two-column layout:
     left = the existing FieldGroup, right = an iframe rendering
     the latest preview HTML (debounced ~600ms after the last edit
     so we don't spam the endpoint).
  3. Mock booking payload comes from a static fixture in the
     frontend (`mockBookingApprovalPayload`) — admin doesn't pick a
     real booking; the preview is for copy-review, not data validation.

The editor was shipped at `width="xwide"` with the right side empty
so swapping in the preview doesn't require a layout change.

