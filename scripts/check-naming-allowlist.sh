#!/usr/bin/env bash
#
# check-naming-allowlist.sh — Phase 8.A.2.6 naming-allowlist drift gate.
#
# Greps for legacy table/column refs (`booking_bundle*`, `bundle_member`,
# `bundle_id`, `reservation_id`, bare `reservations`) under apps/api/src
# and diffs the result against `apps/api/src/.naming-allowlist.txt`.
#
# Per docs/follow-ups/phase-8-naming-audit.md:
#   - Most legacy refs in the codebase are intentional (historical comments,
#     sibling-table columns like `asset_reservations`, backwards-compat
#     method-arg field names like `cancelBundle({ bundle_id })`, audit-event
#     entity_type literals).
#   - The allowlist file pins those intentional refs.
#   - Any NEW raw ref in `apps/api/src` that isn't on the allowlist is either
#     stale (rename it) or another intentional case (add to allowlist with a
#     classification — KEEP_HISTORICAL_COMMENT / KEEP_LEGITIMATE_OTHER_TABLE
#     / KEEP_BACKWARDS_COMPAT_FIELD / KEEP_AUDIT_ENTITY_TYPE).
#
# This script is content-keyed (compares `path:content`, ignoring line
# numbers) so a refactor that shifts lines without changing meaning doesn't
# false-fail. A refactor that adds a NEW raw ref OR changes the content of
# an existing one will fail and require the reviewer to either fix the call
# site or update the allowlist.
#
# Modes:
#   check-naming-allowlist.sh           scan + diff (CI default)
#   check-naming-allowlist.sh --staged  same scan, but skip cleanly if no
#                                       apps/api/src TS files are staged
#                                       (pre-commit hook mode)
#   check-naming-allowlist.sh --gen     regenerate the allowlist (use when
#                                       a legitimate refactor shifted lines
#                                       or added new intentional refs)

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# In --staged mode skip cleanly if no apps/api/src TS source files are staged.
if [ "${1:-}" = "--staged" ]; then
  STAGED=$(git diff --cached --name-only --diff-filter=AM 2>/dev/null \
    | grep -E "^apps/api/src/.*\.ts$" \
    || true)
  ALLOWLIST_STAGED=$(git diff --cached --name-only --diff-filter=AM 2>/dev/null \
    | grep -E "^apps/api/src/\.naming-allowlist\.txt$" \
    || true)
  if [ -z "$STAGED" ] && [ -z "$ALLOWLIST_STAGED" ]; then
    echo "Naming allowlist check skipped — no apps/api/src TS files staged."
    exit 0
  fi
  shift
fi

ALLOWLIST="apps/api/src/.naming-allowlist.txt"
# Same pattern that was used to generate the allowlist baseline. Note:
# `reservation_id\b` is intentionally NOT \b-anchored on the left so that
# sibling-table column names like `linked_asset_reservation_id` and
# `parent_reservation_id` are also captured (these belong on the allowlist
# under KEEP_LEGITIMATE_OTHER_TABLE).
PATTERN='booking_bundle|bundle_member|bundle_id|reservation_id\b|\breservations\b'
SCOPE="apps/api/src"

# Emit `path:line:content` triples for every matching line.
generate_raw() {
  rg --type ts --no-heading -n "$PATTERN" "$SCOPE" 2>/dev/null | sort -u
}

if [ "${1:-}" = "--gen" ]; then
  echo "Regenerating $ALLOWLIST from current tree..."
  # Preserve the existing header by extracting comment lines until the first
  # entry, then re-emit only the section headers + sorted entries.
  HEADER_END=$(grep -n -m1 "^apps/" "$ALLOWLIST" | cut -d: -f1)
  if [ -z "$HEADER_END" ]; then
    HEADER_END=1
  fi
  HEADER=$(head -n $((HEADER_END - 1)) "$ALLOWLIST")
  TMP=$(mktemp)
  trap "rm -f $TMP" EXIT
  generate_raw > "$TMP"
  {
    printf '%s\n' "$HEADER"
    cat "$TMP"
  } > "$ALLOWLIST"
  echo "Wrote $(wc -l < "$ALLOWLIST" | tr -d ' ') lines to $ALLOWLIST"
  echo "Note: --gen captures EVERY current ref. If you want classification"
  echo "headers (KEEP_HISTORICAL_COMMENT etc.) preserved, re-add them by"
  echo "hand. The CI check itself does not require the headers."
  exit 0
fi

if [ ! -f "$ALLOWLIST" ]; then
  echo "ERROR: $ALLOWLIST does not exist. Run with --gen to bootstrap." >&2
  exit 1
fi

CURRENT=$(mktemp)
ALLOWED=$(mktemp)
trap "rm -f $CURRENT $ALLOWED" EXIT

# Compare on `path:content`, dropping the line number. This makes the check
# robust to refactors that shift lines without changing semantic content.
strip_line_no() {
  sed -E 's/^([^:]+):[0-9]+:/\1:/'
}

generate_raw | strip_line_no | sort -u > "$CURRENT"

# Strip comments + blank lines from allowlist, drop line numbers, sort.
grep -v "^#" "$ALLOWLIST" \
  | grep -v "^$" \
  | strip_line_no \
  | sort -u > "$ALLOWED"

# Subset gate: every CURRENT ref must appear in the allowlist (content-keyed,
# line-number agnostic). Allowlist entries that no longer correspond to
# anything in the source are not flagged here — those are stale entries that
# `--gen` will prune. The guard's job is to catch NEW unblessed refs.
NEW_REFS=$(comm -23 "$CURRENT" "$ALLOWED")

if [ -z "$NEW_REFS" ]; then
  echo "Naming allowlist: OK ($(wc -l < "$CURRENT" | tr -d ' ') refs scanned)"
  exit 0
fi

echo "FAIL: New legacy-name references found that are not on the allowlist."
echo
printf '%s\n' "$NEW_REFS" | head -40
echo
echo "Either:"
echo "  - Rename the call site to the canonical name (e.g. booking_bundle_id"
echo "    → booking_id) AND update the test fixture/spec it lives in."
echo "  - Add an entry to $ALLOWLIST classifying the ref as one of:"
echo "      KEEP_HISTORICAL_COMMENT      (rename rationale / column-rename docs)"
echo "      KEEP_LEGITIMATE_OTHER_TABLE  (asset_reservations / recurrence_series)"
echo "      KEEP_BACKWARDS_COMPAT_FIELD  (method-arg / return-shape field name)"
echo "      KEEP_AUDIT_ENTITY_TYPE       ('booking_bundle' literal in audit/outbox)"
echo "    Format: <path>:<line>:<exact source line>"
echo "    Then re-run this check."
echo
echo "Reference: docs/follow-ups/phase-8-naming-audit.md"
exit 1
