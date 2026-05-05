# B.0 follow-up: §16.1 legacy cleanup

> Tracked from spec §16.1 (cleanup commit). Created 2026-05-04 alongside
> the B.0.F closing slice. Tags applied in commit `<this commit>`; actual
> deletions scheduled for ~30 days post-cutover once production has
> stabilised.
>
> Spec ref: `docs/superpowers/specs/2026-05-04-domain-outbox-design.md`
> §16.1 (cleanup scope), §10X (Phase 6 backlog the multi-step writes
> are blocked on).

After B.0 cutover, the following code is **unused on the new path** but
remains for legacy callers (multi-room, standalone-order) that haven't
migrated yet. All entries below are tagged `@deprecated` so the
compiler / IDE flags them; deletions go in a follow-up commit once the
blockers below clear.

## Symbols tagged @deprecated

| Symbol | File | Why kept (blocker) | Replaced by |
|---|---|---|---|
| `OutboxService.markConsumed` | `apps/api/src/modules/outbox/outbox.service.ts:67` | Zero callers in non-test code (verified `grep -r markConsumed apps/api/src` 2026-05-04 — only tests + own def). Safe to delete in the cleanup commit. | Lease-era flow retired entirely; producer RPCs emit `outbox.events` rows in their own tx. |
| `SetupWorkOrderTriggerService.trigger` / `.triggerMany` | `apps/api/src/modules/service-routing/setup-work-order-trigger.service.ts:46,154` | Two real callers: `bundle.service.ts:531` (legacy `attachServicesToBooking`) + `order.service.ts:1049` (`createStandaloneOrder`). Both are Phase 6 backlog per §10X.2 / multi-room flow. | `setup_work_order.create_required` outbox event → `SetupWorkOrderHandler` → `create_setup_work_order_from_event` RPC. |
| `BundleService` `Cleanup` class | `apps/api/src/modules/booking-bundles/bundle.service.ts:2252` | Used by `attachServicesToBooking`; multi-room still calls that method (multi-room-booking.service.ts:300-329). | `create_booking_with_attach_plan` RPC handles atomicity at the Postgres layer; no in-process compensation needed. |

## Symbols NOT tagged (intentionally)

- **`SetupWorkOrderTriggerService.triggerStrict`** — never existed as a
  method in this repo; spec described it as a v6 design intermediate
  that was superseded by `SetupWorkOrderRowBuilder` before any code
  was written. Comments in `setup-work-order.handler.ts:19` and
  `setup-work-order-row-builder.service.ts:11` cite the historical
  name; those are docs, not symbols, so the CI grep guard's
  exclusions cover them.
- **`BookingTransactionBoundary` / `InProcessBookingTransactionBoundary`**
  — still actively used by `multi-room-booking.service.ts:311` for
  the post-create attach + compensation pattern. Not deprecated until
  multi-room cuts over to a combined RPC (Phase 6 backlog §10X).
- **`outbox_emit_via_rpc` PostgREST wrapper** — referenced by
  `OutboxService.emit()` (which has zero callers but is documented
  as fire-and-forget infra for future use per spec §11 open question
  4). Drop when `OutboxService.emit` itself is removed.
- **`booking.create_attempted` event-type strings in outbox-handler
  registry tests** — used as synthetic placeholder event-type names
  to test the registry's generic dispatch logic, not the v3/v4
  contract the name originated from. Could be renamed
  `'test.synthetic'` for clarity but the tests are valid; not a
  cleanup-commit blocker.

## Process for cleanup

After the cutover stabilises (≥30 days, no `setup_work_order.create
_required` dead-letters in production):

1. **Verify zero non-test callers** for each `@deprecated` symbol:
   ```bash
   for sym in markConsumed 'setupTrigger\.\(trigger\|triggerMany\)' 'new Cleanup'; do
     echo "=== $sym ==="
     grep -rEn "$sym" apps/api/src --include='*.ts' \
       --exclude-dir=__tests__ \
       --exclude='*.spec.ts'
   done
   ```
2. **For symbols with non-test callers**, surface as new follow-ups
   (might be edge cases B.0 didn't cover — admin batch tooling, recovery
   scripts).
3. **Delete in this order** (each is its own commit):
   - `OutboxService.markConsumed` + the v3/v4 lease prose in the
     module docstring + the related tests.
   - The `setup_work_order_emissions` cancel-race block at
     `bundle.service.ts:1550-1614` (per spec §16.1 step 7, dead code
     once `grant_booking_approval` lock subsumes it — confirm via
     §15.5 + §15.6 tests still green).
   - The legacy `attachServicesToBooking` method + `Cleanup` class +
     the bundle-side `setupTrigger.triggerMany` call site, but ONLY
     after multi-room cuts over to a combined RPC (Phase 6).
   - `SetupWorkOrderTriggerService` (the whole file) once both bundle
     and order cut over.
4. **Update the CI grep guard** in `.github/workflows/ci.yml` per
   spec §16.1 step 4 — add the now-deleted symbols to the banned
   list so a regression PR can't reintroduce them.
5. **Sync the docs**:
   - `docs/assignments-routing-fulfillment.md` — drop the audit-event
     taxonomy entries that reference deleted methods.
   - `docs/superpowers/specs/2026-05-04-domain-outbox-design.md`
     §16.1 — mark each step done with the commit hash.

## Multi-month timeline

Realistic ordering for the §16.1 cleanup as a whole:

1. **Now** (B.0.F): tag `@deprecated`, write this doc.
2. **B.0 + 30 days**: production stable, no dead-letters →
   `markConsumed` + the test cleanup (~1 commit).
3. **Phase 6 hardening sprint** (multi-week): cut over multi-room to a
   combined RPC + cut over `createStandaloneOrder` to
   `create_standalone_order_with_attach_plan` (spec §10X.2).
4. **Phase 6 + 30 days**: production stable on the new paths → delete
   `triggerMany` / `trigger` / `Cleanup` / `attachServicesToBooking`
   (~1 commit).
5. **Phase 7+** (subsequent backlog item per spec §11 open question 4):
   re-evaluate whether `OutboxService.emit` has any production callers
   yet. If not, delete it + the `outbox_emit_via_rpc` PostgREST
   wrapper.

## CI guard reminder

The grep guard in spec §16.1 step 4 already covers most banned
symbols; add the new ones (`OutboxService\\.markConsumed`,
`SetupWorkOrderTriggerService\\.trigger\\b`,
`SetupWorkOrderTriggerService\\.triggerMany`,
`BundleService.*Cleanup`) at the time each is deleted. Don't add them
ahead of deletion — the guard would block the very PR that does the
deletion otherwise.
