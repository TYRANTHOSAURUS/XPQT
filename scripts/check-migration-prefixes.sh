#!/usr/bin/env bash
# scripts/check-migration-prefixes.sh
#
# Detects duplicate migration prefixes in supabase/migrations/.
#
# Why: A10 (in scripts/ci-migration-asserts.sql) was supposed to prevent the
# duplicate-prefix bug class, but it can only run AFTER migrations have been
# applied — too late to catch the collision pre-merge. This shell check is
# the structural sister: it runs against the filesystem and exits non-zero
# if any prefix appears more than once.
#
# Concrete recurrence this guards against:
#   - 2026-05-01: P0 fix shipped 00248_restore_work_orders_service_role_writes.sql
#   - 2026-05-02: visitors workstream shipped 00248_visitor_types.sql
# Both landed on remote because nothing checked filesystem-level prefix
# uniqueness. Resolved post-hoc by renaming the P0 fix → 00274.
#
# Wired into pnpm lint (or a pre-commit) so a future PR with a duplicate
# fails the gate before merge.
#
# Exit codes:
#   0 — no duplicate prefixes
#   1 — at least one duplicate found

set -euo pipefail

MIGRATIONS_DIR="${1:-supabase/migrations}"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "❌ check-migration-prefixes: $MIGRATIONS_DIR not found" >&2
  exit 2
fi

# Extract the 5-digit prefix from each filename, sort, find dups.
dups="$(
  ls -1 "$MIGRATIONS_DIR" \
    | grep -E '^[0-9]{5}_' \
    | sed 's/_.*//' \
    | sort \
    | uniq -d \
    || true
)"

if [ -n "$dups" ]; then
  echo "❌ Duplicate migration prefixes detected:" >&2
  for prefix in $dups; do
    echo "" >&2
    echo "  Prefix $prefix used by:" >&2
    ls -1 "$MIGRATIONS_DIR" | grep "^${prefix}_" | sed 's/^/    /' >&2
  done
  echo "" >&2
  echo "  Rename the later-shipped one to the next free prefix." >&2
  echo "  See migration 00274 for the canonical rename pattern" >&2
  echo "  (also update doc back-references in the same commit)." >&2
  exit 1
fi

echo "✓ No duplicate migration prefixes ($(ls -1 "$MIGRATIONS_DIR" | grep -cE '^[0-9]{5}_' || echo 0) migration files)"
