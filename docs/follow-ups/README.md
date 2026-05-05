# Follow-ups index

Each file here tracks a piece of work that was deferred from a shipped
slice — context, risk, and what to do when revisiting. New follow-ups
go here, NOT inline in random spec docs (which become unfindable).
The format is loose — a single page per topic, dated heading, "why
deferred" + "what to do" + "when to revisit". Don't bloat.

## Active

### Outbox / B.0

- [`b0-real-db-concurrency-harness.md`](./b0-real-db-concurrency-harness.md) —
  pgTAP / two-connection `pg.Pool` harness for advisory-lock concurrency
  tests across the four B.0 RPCs. Cutover gate per spec §16.2 #20a.
- [`b0-legacy-cleanup.md`](./b0-legacy-cleanup.md) — `@deprecated`
  symbols queued for §16.1 cleanup once B.0 stabilises in production.
- [`outbox-integration-tests.md`](./outbox-integration-tests.md) —
  broader outbox integration-test scaffolding (deferred from Plan B.1
  foundation; predates B.0). The B.0 harness above is a subset.

### Errors / shape

- [`phase-7-error-codes.md`](./phase-7-error-codes.md) — Phase 1 error
  codes that need to land in the AppError catalog in Phase 7.
- [`ci-assertion-strategy.md`](./ci-assertion-strategy.md) — CI
  assertion approach for the error system.

### Visitors v1

- [`visitors-v1-polish.md`](./visitors-v1-polish.md) — UX polish.
- [`visitors-v1-tech-debt.md`](./visitors-v1-tech-debt.md) — tech debt.

### Data-model rework

- [`data-model-rework-full-handoff.md`](./data-model-rework-full-handoff.md)
- [`data-model-overnight-handoff.md`](./data-model-overnight-handoff.md)
- [`data-model-rework-archive/`](./data-model-rework-archive) —
  archived per-session handoffs.

### Booking / tickets

- [`phase-1-booking-smoke.md`](./phase-1-booking-smoke.md)
- [`phase-1-deferred-polish.md`](./phase-1-deferred-polish.md)
- [`phase-1-3-blocker-map.md`](./phase-1-3-blocker-map.md)
- [`phase-2-list-split.md`](./phase-2-list-split.md)
- [`step1c-baseline.md`](./step1c-baseline.md)

### Cross-cutting

- [`plan-a-tenant-validation-gap-map.md`](./plan-a-tenant-validation-gap-map.md)
- [`vendor-portal-phase-b-sprint4-5.md`](./vendor-portal-phase-b-sprint4-5.md)
- [`wip-pickup-2026-04-28.md`](./wip-pickup-2026-04-28.md)

## Conventions

- File names use kebab-case + a short topic slug. Prefix with the
  related slice/phase (`b0-`, `phase-1-`, `visitors-v1-`) so groups
  cluster alphabetically.
- Each file starts with a one-line "Tracked from <where>" cite so
  the reader can find the original commit / spec section.
- Keep "shipped" follow-ups: when work lands, move the file to a
  `done/` subfolder with a closing date or delete it. Don't leave
  stale entries in this index.
