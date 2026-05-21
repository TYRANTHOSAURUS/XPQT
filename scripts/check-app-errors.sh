#!/usr/bin/env bash
# Phase 7.A.3 — AppError migration ratchet.
#
# Once a module has been migrated to AppError factories (Phase 7.A.2), any
# subsequent `throw new BadRequestException(...)` / `NotFoundException(...)`
# / `ForbiddenException(...)` / `UnauthorizedException(...)` /
# `ConflictException(...)` / `UnprocessableEntityException(...)` /
# `InternalServerErrorException(...)` in that module is a regression. This
# gate fails CI when one appears.
#
# The list of migrated modules grows with each Phase 7.A.2 wave. Add the
# directory below when its migration ships.
#
# Spec: docs/superpowers/specs/2026-05-02-error-handling-system-design.md §3.2
# Plan: docs/follow-ups/phase-7-implementation-plan.md §7.A.3

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Modules that have been migrated to AppError. Adding a directory here is
# a one-way ratchet — the gate enforces it from that moment forward.
MIGRATED_MODULES=(
  "apps/api/src/modules/ticket"
  "apps/api/src/modules/sla"
  "apps/api/src/modules/booking-bundles"
  "apps/api/src/modules/reservations"
  "apps/api/src/modules/approval"
  "apps/api/src/modules/space"
  "apps/api/src/modules/search"
  "apps/api/src/modules/reporting"
  "apps/api/src/modules/portal-announcements"
  "apps/api/src/modules/person"
  "apps/api/src/modules/org-node"
  "apps/api/src/modules/work-orders"
  "apps/api/src/modules/user-management"
  "apps/api/src/modules/service-catalog"
  "apps/api/src/modules/portal-appearance"
  "apps/api/src/modules/outbox"
  "apps/api/src/modules/cost-centers"
  "apps/api/src/modules/bundle-templates"
  "apps/api/src/modules/auth"
  "apps/api/src/modules/webhook"
  "apps/api/src/modules/tenant"
  "apps/api/src/modules/workflow"
  "apps/api/src/modules/service-routing"
  "apps/api/src/modules/portal"
  "apps/api/src/modules/orders"
  "apps/api/src/modules/daily-list"
  "apps/api/src/modules/config-engine"
  "apps/api/src/modules/calendar-sync"
  "apps/api/src/modules/room-booking-rules"
  "apps/api/src/modules/vendor-portal"
  "apps/api/src/modules/privacy-compliance"
  "apps/api/src/modules/routing"
  "apps/api/src/common"
  "apps/api/src/modules/visitors"
  "apps/api/src/modules/maintenance"
  # R2 AppError sweep (2026-05-20) — handoff residual R2.
  # Triage: docs/follow-ups/r2-apperror-sweep-triage-2026-05-20.md.
  "apps/api/src/modules/asset"
  "apps/api/src/modules/business-hours"
  "apps/api/src/modules/catalog-menu"
  "apps/api/src/modules/delegation"
  "apps/api/src/modules/notification"
  "apps/api/src/modules/team"
  "apps/api/src/modules/vendor"
  # R2 follow-up — already-clean modules folded into the gate as a
  # one-line ratchet improvement (they were AppError-migrated organically
  # but never added to MIGRATED_MODULES).
  "apps/api/src/modules/floor-plan"
  "apps/api/src/modules/inbox"
  "apps/api/src/modules/notifications"
)

# Modules with the SWEPT raw-rethrow class (`if (error) throw error;`).
# These get a SECOND ratchet (RAW_RETHROW_FORBIDDEN) on top of the Nest-
# exception ratchet, so the R1/R2 bug class (a fresh raw rethrow in one
# of these specific modules) is caught by CI going forward.
#
# Scope is intentionally narrower than MIGRATED_MODULES — adding a module
# here is a promise that its service files are clean today. F1-A
# (2026-05-20) added the next 7 high-traffic modules; ~20 still have
# residual raw rethrows and are tracked in the triage doc "Deferred"
# section for F1-B. Don't add a module here without a matching cleanup
# PR.
RAW_RETHROW_SWEPT_MODULES=(
  "apps/api/src/modules/asset"
  "apps/api/src/modules/business-hours"
  "apps/api/src/modules/catalog-menu"
  "apps/api/src/modules/delegation"
  "apps/api/src/modules/notification"
  "apps/api/src/modules/team"
  "apps/api/src/modules/vendor"
  "apps/api/src/modules/floor-plan"
  "apps/api/src/modules/inbox"
  "apps/api/src/modules/notifications"
  # F1 Sub-PR A — top-7 wrapPgError sweep (2026-05-20).
  # Triage: docs/follow-ups/r2-apperror-sweep-triage-2026-05-20.md §Sub-PR A.
  "apps/api/src/modules/person"
  "apps/api/src/modules/maintenance"
  "apps/api/src/modules/orders"
  "apps/api/src/modules/ticket"
  "apps/api/src/modules/user-management"
  "apps/api/src/modules/room-booking-rules"
  "apps/api/src/modules/config-engine"
  # F1 Sub-PR B — remaining 20 modules wrapPgError sweep (2026-05-21).
  # Triage: docs/follow-ups/r2-apperror-sweep-triage-2026-05-20.md §Sub-PR B.
  "apps/api/src/modules/search"
  "apps/api/src/modules/outbox"
  "apps/api/src/modules/tenant"
  "apps/api/src/modules/daily-list"
  "apps/api/src/modules/sla"
  "apps/api/src/modules/space"
  "apps/api/src/modules/cost-centers"
  "apps/api/src/modules/bundle-templates"
  "apps/api/src/modules/service-routing"
  "apps/api/src/modules/approval"
  "apps/api/src/modules/routing"
  "apps/api/src/modules/booking-bundles"
  "apps/api/src/modules/org-node"
  "apps/api/src/modules/portal"
  "apps/api/src/modules/calendar-sync"
  "apps/api/src/modules/service-catalog"
  "apps/api/src/modules/visitors"
  "apps/api/src/modules/webhook"
  "apps/api/src/modules/work-orders"
  "apps/api/src/modules/workflow"
)

# Forbidden patterns. The filter handles legacy throws via `generic.*` codes,
# but inside a migrated module the AppError factory is the only sanctioned
# way to throw an HTTP error.
FORBIDDEN='throw new (BadRequest|NotFound|Forbidden|Unauthorized|Conflict|UnprocessableEntity|InternalServerError)Exception\b'

# Additional forbidden pattern for swept modules: bare `throw error;` /
# `throw err;` Postgres rethrows. These bypass the AppError → typed-code
# path, so the wire `code` collapses to a generic `db.constraint` /
# `unknown.server_error` rather than a domain code. R1 (PR #36) demonstrated
# the R1 bug class — a PostgrestError shape that wasn't caught by either
# normalize branch and surfaced as `unknown.server_error` 500.
RAW_RETHROW_FORBIDDEN='throw[[:space:]]+(error|err)[[:space:]]*;'

violations=0
for module in "${MIGRATED_MODULES[@]}"; do
  if [ ! -d "$module" ]; then
    echo "warn: migrated module not found: $module" >&2
    continue
  fi

  # Exclude .spec.ts files — tests may instantiate Nest exceptions for
  # legacy-shape assertions while the underlying production code still
  # throws raw exceptions (e.g. tenant-validation.ts, not yet migrated).
  # Exclude common/errors/ — those are foundation files that legitimately
  # throw raw exceptions (the filter normalizes them).
  matches=$(grep -rEn "$FORBIDDEN" "$module" --include='*.ts' --exclude='*.spec.ts' --exclude-dir='errors' || true)
  if [ -n "$matches" ]; then
    echo "[FAIL] Raw NestJS exception throws found in migrated module: $module"
    echo "$matches"
    echo
    violations=$((violations + 1))
  fi
done

# Second ratchet — raw `throw error;` Postgres rethrows in swept modules.
# Scope: *.service.ts only (controllers don't catch supabase errors; the
# rethrow class only appears at the service layer). Excludes .spec.ts as
# above.
rethrow_violations=0
for module in "${RAW_RETHROW_SWEPT_MODULES[@]}"; do
  if [ ! -d "$module" ]; then
    echo "warn: rethrow-swept module not found: $module" >&2
    continue
  fi

  matches=$(grep -rEn "$RAW_RETHROW_FORBIDDEN" "$module" --include='*.service.ts' --exclude='*.spec.ts' || true)
  if [ -n "$matches" ]; then
    echo "[FAIL] Raw Postgres rethrow found in swept module: $module"
    echo "Use wrapPgError(error, '<module>.<op>_failed', { detail, notFoundCode? })"
    echo "from apps/api/src/common/errors/wrap-pg-error.ts to preserve wire-code"
    echo "precision (PGRST116→404, 23505/23503→409)."
    echo "$matches"
    echo
    rethrow_violations=$((rethrow_violations + 1))
  fi
done

if [ "$violations" -gt 0 ] || [ "$rethrow_violations" -gt 0 ]; then
  if [ "$violations" -gt 0 ]; then
    echo "Phase 7.A.3 ratchet: $violations migrated module(s) reintroduced raw throws."
    echo "Use AppError factories from apps/api/src/common/errors instead."
    echo "If a throw genuinely cannot use AppError (e.g. bootstrap-time errors"
    echo "before the filter is wired), add an inline ESLint override and a"
    echo "// phase-7: reason-not-app-error explanation comment."
  fi
  if [ "$rethrow_violations" -gt 0 ]; then
    echo "R2 raw-rethrow ratchet: $rethrow_violations swept module(s) reintroduced"
    echo "the R1 bug class (bare \`throw error;\` from Postgres). Use wrapPgError"
    echo "from apps/api/src/common/errors instead."
  fi
  exit 1
fi

echo "Phase 7.A.3 ratchet: 0 raw throws across ${#MIGRATED_MODULES[@]} migrated module(s)."
echo "R2 raw-rethrow ratchet: 0 raw rethrows across ${#RAW_RETHROW_SWEPT_MODULES[@]} swept module(s)."
