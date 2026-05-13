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
