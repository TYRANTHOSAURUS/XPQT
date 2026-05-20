# R2 — AppError sweep triage (2026-05-20)

Handoff: `ai/handoff-residuals-2026-05-20.md` R2.

R1 (PR #36, `9d10a1c4` post-merge) fixed one instance of an unwrapped
throw surfacing as `unknown.server_error` 500 from `/api/persons/me`. R2 is
the bug-class sweep — every `/api/*` controller is either AppError-migrated
or explicitly documented as deferred with owner + reason.

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
| catalog-menu | `/api/catalog-items`, `/api/catalog-menus` (+ items + resolve) | `catalog-menu.service.ts:57,69,84,97,109,120,134,146,169,199,222,249,262,274,284` (13 sites including duplicate/bulk/resolve) | Yes — admin reads + booking flow resolveOffer | **MIGRATE** |
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

### Deferred — none

There is no module with `/api/*` reach that has raw rethrows and is left
out of this PR. The 7 modules listed above cover every reachable
controller surface with raw `throw error` Postgres rethrows.

Future tightening (NOT in scope for R2 — proposed as a follow-up):

| Item | Owner | Reason | Risk |
|---|---|---|---|
| Extend `scripts/check-app-errors.sh` to also forbid bare `throw error;` in migrated modules | `(R2-follow-up)` | Today's gate only catches `throw new BadRequestException(...)`-style sites. A migrated module can still raw-rethrow PostgrestError. Wider gate = stricter contract. | Low — likely catches dozens of "still works because the filter maps it" sites in migrated modules. Each needs a typed code. Lots of mechanical work. Out of scope for R2 because R2's DoD is reachable controllers covered, not gate hardening. |
| Migrate residual raw rethrows inside existing migrated modules (e.g. `room-booking-rules` 20 sites, `config-engine` 30 sites, `user-management` 19 sites — uncovered by today's gate) | `(R2-follow-up)` | The filter normalises these to `db.constraint`/`db.unique_violation`/etc. — wire shape is correct but the wire `code` is generic, not domain-specific. R1's specific failure (R1 PostgrestError → `unknown.server_error`) was the catastrophic case; the residuals are best-practice tightening. | Low — current behaviour ships `db.constraint` 500 which the renderer copy treats correctly; the client just doesn't see a precise code. |

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

42 new codes total. All follow the existing pattern (mirror `person.lookup_failed`, `org_node.create_failed`, `announcement.list_failed`).

## Gate update

`scripts/check-app-errors.sh` `MIGRATED_MODULES` extended from 35 → 42:
+ `apps/api/src/modules/asset`
+ `apps/api/src/modules/business-hours`
+ `apps/api/src/modules/catalog-menu`
+ `apps/api/src/modules/delegation`
+ `apps/api/src/modules/notification`
+ `apps/api/src/modules/team`
+ `apps/api/src/modules/vendor`

Post-PR expected output:
`Phase 7.A.3 ratchet: 0 raw throws across 42 migrated module(s).`
