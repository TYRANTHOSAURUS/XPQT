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
)

# Forbidden patterns. The filter handles legacy throws via `generic.*` codes,
# but inside a migrated module the AppError factory is the only sanctioned
# way to throw an HTTP error.
FORBIDDEN='throw new (BadRequest|NotFound|Forbidden|Unauthorized|Conflict|UnprocessableEntity|InternalServerError)Exception\b'

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

if [ "$violations" -gt 0 ]; then
  echo "Phase 7.A.3 ratchet: $violations migrated module(s) reintroduced raw throws."
  echo "Use AppError factories from apps/api/src/common/errors instead."
  echo "If a throw genuinely cannot use AppError (e.g. bootstrap-time errors"
  echo "before the filter is wired), add an inline ESLint override and a"
  echo "// phase-7: reason-not-app-error explanation comment."
  exit 1
fi

echo "Phase 7.A.3 ratchet: 0 raw throws across ${#MIGRATED_MODULES[@]} migrated module(s)."
