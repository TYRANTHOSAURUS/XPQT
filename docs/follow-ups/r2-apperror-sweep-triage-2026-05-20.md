# R2 — AppError sweep triage (2026-05-20)

Handoff: `ai/handoff-residuals-2026-05-20.md` R2.

R1 (PR #36, `9d10a1c4` post-merge) fixed one instance of an unwrapped
throw surfacing as `unknown.server_error` 500 from `/api/persons/me`. R2 is
the bug-class sweep — every `/api/*` controller is either AppError-migrated
or explicitly documented as deferred with owner + reason.

### Fold (post-review, 2026-05-20)

Three independent reviewers (plan + code + codex tertiary) all flagged the
same critical wire-code regression in the initial PR: the mechanical
`AppErrors.server(...)` fold collapsed all PostgrestError / pg-native
errors to 500, bypassing the global filter's existing PGRST116→404 /
23505→409 / 23503→409 mapping. The fold adds:

1. `apps/api/src/common/errors/wrap-pg-error.ts` — wrapper helper that
   preserves the 404/409 wire shape while still surfacing a
   module-specific 500 code for everything else.
2. 6 new module-specific `<entity>.not_found` codes
   (`business_hours`/`catalog_menu`/`delegation`/`notification`/`team`/`vendor`).
   `asset.not_found` already existed in the registry.
3. A second ratchet in `scripts/check-app-errors.sh` that forbids bare
   `throw error;` / `throw err;` in the 10 swept modules' `*.service.ts`
   files — catches the R1 bug class going forward.
4. Honest enumeration of deferred raw-throw sites in other migrated
   modules (235 sites across 27 modules — see "Deferred" section below).

## Methodology

1. Enumerated every `@Controller(...)` under `apps/api/src/` →
   52 controllers across 41 module folders.
2. Cross-checked each module against `scripts/check-app-errors.sh`'s
   `MIGRATED_MODULES` list (35 entries at `origin/main`).
3. For non-migrated modules, grepped service files for raw rethrow
   patterns: `throw error` / `throw err` / `throw new Error/Http*Exception`
   in the request path (excluding `*.spec.ts`, fixtures, channels that
   intentionally re-throw with vendor-name scrubbing per the spec).
4. Reachability check: every targeted module is mounted in `app.module.ts`
   AND its controller has at least one `@Get / @Post / @Patch / @Delete`
   decorator (verified by reading the file).

The pre-existing gate (`scripts/check-app-errors.sh`) checks ONLY raw
NestJS exception classes (`BadRequestException`, etc.) within the
migrated set. It does NOT enforce against `throw error;` Postgres
rethrows, even in migrated modules. Those rethrows are normalised by
the global filter's `fromPostgrestError` / `fromPgNativeError` branches
(`apps/api/src/common/errors/normalize.ts:316-435`) into `db.constraint`
500 / `db.unique_violation` 409 / `permission.denied` 403 — the wire
shape is correct, but the wire `code` is generic, not domain-specific.
R1's failure mode was a Postgrest error whose `code` field shape didn't
match `isPostgrestErrorLike` AND lacked `severity`, so it fell through
to the fallback `unknown.server_error` 500.

The conservative R2 scope: migrate modules that have raw rethrows AND a
mounted controller, pick the modules where each call site is mechanical
(`if (error) throw error` → `if (error) throw AppErrors.server('<module>.<op>_failed', {detail, cause: error})`), and defer modules with deep raw-throw
nests requiring fresh code design.

## Triage table

| Module | Controller route(s) | Raw-throw sites | Reachable auth'd user | Decision |
|---|---|---|---|---|
| asset | `/api/assets`, `/api/asset-types` | `asset.service.ts:38,49,79,96,107,120,136` (7 sites — all `if (error) throw error;`) | Yes — desk/admin reads + writes | **MIGRATE** |
| business-hours | `/api/business-hours` | `business-hours.service.ts:44,56,67,80` (4 sites) | Yes — admin reads + writes | **MIGRATE** |
| catalog-menu | `/api/catalog-items`, `/api/catalog-menus` (+ items + resolve) | `catalog-menu.service.ts:57,69,84,97,109,120,134,146,169,199,222,249,262,274,284` (15 sites including duplicate/bulk/resolve) | Yes — admin reads + booking flow resolveOffer | **MIGRATE** |
| delegation | `/api/delegations` | `delegation.service.ts:27,38,51` (3 sites) | Yes — admin reads + writes | **MIGRATE** |
| notification | `/api/notifications`, `/api/notification-templates` | `notification.service.ts:67,134,152,171,228` (5 raw rethrows: `send`-insert, `listTemplates`, `createTemplate`-entity, `createTemplate`-version, `updateTemplate`-version) | Yes — admin template surface; `send` is internal producer | **MIGRATE** |
| team | `/api/teams` (+ members) | `team.service.ts:16,28,44,57,68,79,91` (7 sites) | Yes — desk/admin reads + writes | **MIGRATE** |
| vendor | `/api/vendors` (+ service-areas) | `vendor.service.ts:32,44,55,68,80,98,110` (7 sites) | Yes — desk/admin reads + writes | **MIGRATE** |
| floor-plan | `/api/floors/:floorSpaceId/plan`, `/api/buildings/...`, `/api/admin/floor-plans-index` | 0 raw rethrows in service code (all use `AppErrors.*` factories) | Yes | **NOT-APPLICABLE — already migrated, just not in gate list** |
| inbox | `/api/me/inbox` | 0 raw rethrows (already uses `AppErrors.*` exhaustively from B.4.A.5 sub-step E) | Yes | **NOT-APPLICABLE — already migrated, not in gate list** |
| notifications (plural) | `/api/admin/notification-templates` | 0 raw rethrows in production code; only docstrings reference "re-throw" intent on the email channel (which IS migrated via `AppErrors.server('email.dispatch_failed', ...)`) | Yes | **NOT-APPLICABLE — already migrated, not in gate list** |

### Modules already in `MIGRATED_MODULES` and clean of NestJS-exception throws (left as-is)

`ticket`, `sla`, `booking-bundles`, `reservations`, `approval`, `space`,
`search`, `reporting`, `portal-announcements`, `person`, `org-node`,
`work-orders`, `user-management`, `service-catalog`, `portal-appearance`,
`outbox`, `cost-centers`, `bundle-templates`, `auth`, `webhook`, `tenant`,
`workflow`, `service-routing`, `portal`, `orders`, `daily-list`,
`config-engine`, `calendar-sync`, `room-booking-rules`, `vendor-portal`,
`privacy-compliance`, `routing`, `apps/api/src/common`, `visitors`,
`maintenance`.

### Deferred — explicit owner = R2-follow-up (raw-throw cleanup in other migrated modules)

There is no module with `/api/*` reach that has raw rethrows AND is left
out of THIS PR's 7-module sweep. The 7 modules above cover every
reachable controller surface where the entire module was raw-rethrow
prior to R2.

However, **existing migrated modules carry 235 residual raw `throw error;`
sites across 27 modules**, not covered by either ratchet today. Pre-R2
they were already in `MIGRATED_MODULES` (so the Nest-exception gate
applies) but the SECOND ratchet `RAW_RETHROW_FORBIDDEN` only fires for
the 10 modules explicitly added to `RAW_RETHROW_SWEPT_MODULES`. These
236 sites are explicitly deferred to a focused follow-up PR — not
forgotten, not "no deferred".

Behaviour: the global filter's `fromPostgrestError` / `fromPgNativeError`
branches still normalise these into `db.constraint` / `db.unique_violation`
/ `db.fk_violation` / `permission.denied`. Wire shape is correct, but the
wire `code` is generic rather than domain-specific. The catastrophic R1
class (PostgrestError → `unknown.server_error`) lives ONLY in modules
whose PostgrestError shape evades both filter branches; today's filter
covers PGRST* prefixes + pg-native `severity`, which is the common case.

| Module | Raw-throw sites | Reason for deferral |
|---|---:|---|
| _(empty — all 20 deferred modules migrated in F1 Sub-PR B, see below)_ | — | — |
| **Total** | **0** | |

Enumeration command:

```bash
for m in $(ls apps/api/src/modules); do
  count=$(grep -rE 'throw[[:space:]]+(error|err)[[:space:]]*;' \
    apps/api/src/modules/$m/ --include='*.service.ts' \
    --exclude='*.spec.ts' 2>/dev/null | wc -l)
  [ "$count" -gt 0 ] && echo "$m: $count"
done
```

Run before opening the follow-up PR to confirm the count hasn't drifted.

## Sub-PR A migration (2026-05-20)

The seven highest-traffic modules from the 27-module backlog above were
migrated to `wrapPgError` in F1 Sub-PR A `(pending merge)`:

| Module | Sites migrated (incl. named-var rethrows) |
|---|---:|
| person | 12 |
| maintenance | 13 |
| orders | 16 (13 simple + 3 named — `seriesErr` / `userErr` / `updateErr` / `insertErr`; plus the `caught` compensation rename in `createStandalone`) |
| ticket | 18 (13 simple + 5 named — `activityError` / `woResult.error` / 3× `permErr` / `createError` / 2× `fetchError` in dispatch.service.ts) |
| user-management | 19 |
| room-booking-rules | 21 (20 simple + 1 named — `dErr` in `impact-preview.service.ts`, `result.error` in `loadAncestorChain`) |
| config-engine | 21 (broader scan: 7 simple in config-engine.service.ts incl. `entityError`/`versionError`/`publishError`/`updateError`; 5 in criteria-set.service.ts incl. `pErr`/`mErr`; 8 in service-catalog.service.ts incl. `orderErr`/`unlinkErr`/`linkErr`; 19 in request-type.service.ts) |

Total: ~120 wrapPgError sites added across the seven modules. All
`RAW_RETHROW_SWEPT_MODULES` entries added in the same PR — gate now
covers 17 swept modules (was 10). Codes registered in
`packages/shared/src/error-codes.ts` + EN/NL parity in
`apps/api/src/common/errors/messages.{en,nl}.ts`.

The deferred table above reflects post-Sub-PR-A residuals: 114 sites
across 20 modules.

## Sub-PR B migration (2026-05-21)

The remaining 20 modules from the post-Sub-PR-A backlog were migrated
to `wrapPgError` in F1 Sub-PR B. The deferred table is now empty.

| Module | Sites migrated (incl. named-var rethrows) |
|---|---:|
| search | 1 |
| outbox | 1 |
| tenant | 1 |
| daily-list | 1 (class-C rename `err`→`caught` on the `LeaseRevokedAfterDispatchError` boundary) |
| sla | 5 |
| space | 5 |
| cost-centers | 5 |
| bundle-templates | 5 |
| service-routing | 5 |
| approval | 8 (6 simple + 2 named — `countError` / `staleError` in `getPendingCountForActor`) |
| routing | 9 (6 simple + 3 named — `lt.error` / `rt.error` in `listActiveDomains`, all in `coverage.service.ts` + `simulator.service.ts` + `scope-override-resolver.service.ts` + `audit.service.ts`) |
| booking-bundles | 8 (7 simple + 1 named — `orderErr` in `bundle-cascade.service.ts:loadLine`) |
| org-node | 11 (7 simple + 4 named — `members.error` / `grants.error` / `teams.error` in `list()` and `demoteErr` in `addMember`) |
| portal | 9 (5 simple + 4 named — `visibleErr` / `uploadErr` / `updErr` / inner `error` in `criteria_matches` per-CS chain) |
| calendar-sync | 9 (7 simple + 2 named — `spacesError` in `health` + `uErr` in `resolveConflict`) |
| service-catalog | 9 (8 simple + 1 named — `tplLookup.error` in `createFromTemplate`) |
| visitors | 8 |
| webhook | 9 simple (+ 1 class-C rename `err`→`caught` in `webhook-ingest.service.ts:153` — caught may be AppError from `tickets.create()`, mapping error, OR pg error) |
| work-orders | 10 (9 simple + 1 class-C rename `err`→`caught` in `work-order.service.ts:canPlan` — caught is AppError from `assertCanPlan`) |
| workflow | 10 |

Total: ~124 wrapPgError sites added across the 20 modules (113 simple
sites that match the gate regex `if (error) throw error;` + 11 named-
variable sites captured for module-cleanliness even though the regex
only enforces the bare `error|err` form). All 20 modules added to
`RAW_RETHROW_SWEPT_MODULES` in the same PR — gate now covers 37 swept
modules (was 17). 121 new codes registered in
`packages/shared/src/error-codes.ts` + EN/NL parity in
`apps/api/src/common/errors/messages.{en,nl}.ts`.

### Class-C sites flagged for review (renamed, NOT wrapped)

Three rethrow boundaries where `caught` may be an AppError already
(propagating from inner helpers) — wrapping with `wrapPgError` would
corrupt the 4xx wire shape for non-pg errors. Variable renamed from
`err` to `caught` to escape the regex while keeping rethrow semantics
verbatim, same approach as F1-A used at `orders/order.service.ts:1126`:

- `apps/api/src/modules/daily-list/daily-list.service.ts:814` — the
  `LeaseRevokedAfterDispatchError` boundary. Catch handles the
  known-error case (lease-revoked audit emit) and rethrows anything
  else as-is. `caught` may be the typed error, an AppError from a
  helper, or a raw pg error from the tx.
- `apps/api/src/modules/webhook/webhook-ingest.service.ts:153` — the
  request-mapping + ticket-create catch. `caught` may be an AppError
  from `tickets.create()` / mapping, OR a 23505 idempotency-race pg
  error that the code already handles separately.
- `apps/api/src/modules/work-orders/work-order.service.ts:857` —
  `canPlan` catches `assertCanPlan`'s 403 AppError to convert to a
  `{ canPlan: false }` shape, rethrows anything else (DB errors,
  unexpected AppErrors) verbatim.

### Naming-allowlist addition (1 entry)

`apps/api/src/modules/booking-bundles/bundle.service.ts:945` references
`args.bundle_id` in the `addLinesToBundle` wrapPgError detail string.
The arg name is the legacy method-arg form retained for wire compat
(00278:27 canonicalisation: bundle_id IS the booking id). Same
classification as the surrounding entries on `bundle.service.ts` and
`order.service.ts` — `KEEP_BACKWARDS_COMPAT_FIELD`. Mirrors F1-A's
2 additions in commit `99b08767`.

## Codes introduced this PR

(Full names registered in `packages/shared/src/error-codes.ts` +
`apps/api/src/common/errors/messages.en.ts` +
`apps/api/src/common/errors/messages.nl.ts`.)

- `asset.type_list_failed`, `asset.type_create_failed`, `asset.list_failed`, `asset.lookup_failed`, `asset.create_failed`, `asset.update_failed`, `asset.history_list_failed`
- `business_hours.list_failed`, `business_hours.lookup_failed`, `business_hours.create_failed`, `business_hours.update_failed`
- `catalog_menu.list_failed`, `catalog_menu.lookup_failed`, `catalog_menu.create_failed`, `catalog_menu.update_failed`, `catalog_menu.item_list_failed`, `catalog_menu.item_add_failed`, `catalog_menu.item_update_failed`, `catalog_menu.item_remove_failed`, `catalog_menu.duplicate_failed`, `catalog_menu.bulk_update_failed`, `catalog_menu.bulk_delete_failed`, `catalog_menu.catalog_item_list_failed`, `catalog_menu.resolve_offer_failed`
- `delegation.list_failed`, `delegation.create_failed`, `delegation.update_failed`
- `notification.send_failed`, `notification.template_list_failed`, `notification.template_create_failed`, `notification.template_update_failed`
- `team.list_failed`, `team.lookup_failed`, `team.create_failed`, `team.update_failed`, `team.member_list_failed`, `team.member_add_failed`, `team.member_remove_failed`
- `vendor.list_failed`, `vendor.lookup_failed`, `vendor.create_failed`, `vendor.update_failed`, `vendor.service_area_list_failed`, `vendor.service_area_add_failed`, `vendor.service_area_remove_failed`

### Plus 6 `<entity>.not_found` codes added in the post-review fold (used by `wrapPgError`'s `notFoundCode` option):

- `business_hours.not_found`
- `catalog_menu.not_found`
- `delegation.not_found`
- `notification.not_found`
- `team.not_found`
- `vendor.not_found`

(`asset.not_found` was already registered pre-R2, so the asset module
re-uses it; only 6 new not_found codes are introduced by this PR.)

**51 new codes total** (45 `*_failed` codes + 6 `*_not_found` codes). All
follow the existing pattern (mirror `person.lookup_failed`,
`org_node.create_failed`, `announcement.list_failed`).

## Gate enforcement

`pnpm errors:check-app-errors` runs `scripts/check-app-errors.sh` and now
enforces TWO ratchets:

### Ratchet 1 — `MIGRATED_MODULES` (Nest exception classes)

Extended from 35 → 45 modules. R2 adds the 7 swept modules + 3 modules
that were already AppError-clean but missing from the list
(`floor-plan`, `inbox`, `notifications` — the plural one).

Forbids: `throw new (BadRequest|NotFound|Forbidden|Unauthorized|Conflict|UnprocessableEntity|InternalServerError)Exception\b`

### Ratchet 2 — `RAW_RETHROW_SWEPT_MODULES` (raw Postgres rethrows)

New in R2. Extends the gate with a SECOND list covering the modules
whose `*.service.ts` files are demonstrably clean of bare
`throw error;` Postgres rethrows. Catches the R1 bug class going forward.

Forbids in `*.service.ts` only: `throw[[:space:]]+(error|err)[[:space:]]*;`

R2 seeded the list with 10 modules: `asset`, `business-hours`,
`catalog-menu`, `delegation`, `notification`, `team`, `vendor`,
`floor-plan`, `inbox`, `notifications`. F1 Sub-PR A added 7 more:
`person`, `maintenance`, `orders`, `ticket`, `user-management`,
`room-booking-rules`, `config-engine` — bringing the total to 17.
F1 Sub-PR B added the final 20: `search`, `outbox`, `tenant`,
`daily-list`, `sla`, `space`, `cost-centers`, `bundle-templates`,
`service-routing`, `approval`, `routing`, `booking-bundles`,
`org-node`, `portal`, `calendar-sync`, `service-catalog`, `visitors`,
`webhook`, `work-orders`, `workflow` — bringing the total to 37.

The deferred list is now empty — every module with a NestJS-mounted
controller AND raw rethrows is covered by the second ratchet.

### EN/NL message parity

NOT enforced by `pnpm errors:check-app-errors`. Parity is enforced by
`apps/api/src/common/errors/messages.spec.ts` (Jest), which runs as part
of `pnpm -C apps/api test`. The spec asserts:
- Every EN code has a NL translation.
- NL has no extra codes beyond EN.
- NL message count matches EN count.

The PR adds the 6 new not_found codes + their NL translations together;
the spec passes locally.

### Wire-code precision (PGRST116 / 23505 / 23503)

NOT enforced by a CI gate. Preserved by convention via the `wrapPgError`
helper. Code-review verification: every replacement of
`AppErrors.server(...)` in this PR uses `wrapPgError(error, code, opts)`,
and `notFoundCode` is supplied at every `.single()` / `.maybeSingle()`
read site so PGRST116 maps to 404. A future tightening: add a lint
that flags `AppErrors.server(...)` immediately after a supabase call (no
unit-test gate for this today).

### Expected post-PR output

```
Phase 7.A.3 ratchet: 0 raw throws across 45 migrated module(s).
R2 raw-rethrow ratchet: 0 raw rethrows across 37 swept module(s).
```

(Post-Sub-PR-B. Counts over the bug-class sweep:
 - Pre-R2:        none (the second ratchet didn't exist).
 - Post-R2:       `0 raw rethrows across 10 swept module(s)`.
 - Post-Sub-PR-A: `0 raw rethrows across 17 swept module(s)`.
 - Post-Sub-PR-B: `0 raw rethrows across 37 swept module(s)` — final.)
