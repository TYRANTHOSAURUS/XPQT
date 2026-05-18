#!/usr/bin/env bash
#
# check-naming-allowlist.sh — Phase 8 naming-allowlist drift gate.
#
# Greps for legacy table/column refs (`booking_bundle*`, `bundle_member`,
# `bundle_id`, `reservation_id`, bare `reservations`) under two scopes
# and diffs each result against its own allowlist:
#
#   - apps/api/src   ↔  apps/api/src/.naming-allowlist.txt   (Phase 8.A.2.6)
#   - apps/web/src   ↔  apps/web/src/.naming-allowlist.txt   (Phase 8.B.3)
#
# Per docs/follow-ups/phase-8-naming-audit.md +
# docs/follow-ups/phase-8-frontend-rename-triage.md:
#   - Most legacy refs in the codebase are intentional (historical comments,
#     sibling-table columns like `asset_reservations`, backwards-compat
#     method-arg field names like `cancelBundle({ bundle_id })`, audit-event
#     entity_type literals, wire-shape pinned response fields, query-key
#     segments that double as cross-hook cache bridges).
#   - The two allowlist files pin those intentional refs.
#   - Any NEW raw ref in either scope that isn't on the matching allowlist
#     is either stale (rename it) or another intentional case (add to the
#     allowlist with a classification — KEEP_HISTORICAL_COMMENT /
#     KEEP_LEGITIMATE_OTHER_TABLE / KEEP_BACKWARDS_COMPAT_FIELD /
#     KEEP_AUDIT_ENTITY_TYPE / KEEP_WIRE_SHAPE).
#
# This script is content-keyed (compares `path:content`, ignoring line
# numbers) so a refactor that shifts lines without changing meaning doesn't
# false-fail. A refactor that adds a NEW raw ref OR changes the content of
# an existing one will fail and require the reviewer to either fix the call
# site or update the allowlist.
#
# Modes:
#   check-naming-allowlist.sh           scan + diff both scopes (CI default)
#   check-naming-allowlist.sh --staged  same scan, but per-scope skip when
#                                       no files in that scope are staged
#                                       (pre-commit hook mode)
#   check-naming-allowlist.sh --gen     regenerate both allowlists (use when
#                                       a legitimate refactor shifted lines
#                                       or added new intentional refs)

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Fail LOUDLY if ripgrep is missing. This script uses `set -uo pipefail`
# without `set -e`, so a missing `rg` would otherwise silently yield an
# empty scan and `comm -23` would report every allowlisted ref as a "new"
# violation — a spurious failure that misdirects diagnosis. Exit 2 makes
# the real cause unambiguous (CI installs rg before this runs).
if ! command -v rg >/dev/null 2>&1; then
  echo "ERROR: ripgrep (rg) is required but not found on PATH." >&2
  echo "  Install it (CI: apt-get install -y ripgrep; macOS: brew install ripgrep)." >&2
  exit 2
fi

# Same pattern for both scopes. Note: `reservation_id\b` is intentionally
# NOT \b-anchored on the left so that sibling-table column names like
# `linked_asset_reservation_id` and `parent_reservation_id` are also
# captured (these belong on the api-scope allowlist under
# KEEP_LEGITIMATE_OTHER_TABLE).
PATTERN='booking_bundle|bundle_member|bundle_id|reservation_id\b|\breservations\b'

# Two scopes share the same gate logic. Each is a tuple of
# (label · scope dirs (csv) · allowlist path · staged-source regex ·
#  staged-allowlist regex · rg type flags). Fields are tab-separated
# since the staged regexes contain `|` and rg flags contain spaces
# and braces.
DELIM=$'\t'
SCOPES=(
  "api${DELIM}apps/api/src${DELIM}apps/api/src/.naming-allowlist.txt${DELIM}^apps/api/src/.*\.ts\$${DELIM}^apps/api/src/\.naming-allowlist\.txt\$${DELIM}--type ts"
  "web${DELIM}apps/web/src,packages/shared/src${DELIM}apps/web/src/.naming-allowlist.txt${DELIM}^(apps/web/src|packages/shared/src)/.*\.tsx?\$${DELIM}^apps/web/src/\.naming-allowlist\.txt\$${DELIM}--type-add tsfiles:*.{ts,tsx} -t tsfiles"
)

STAGED_MODE=0
if [ "${1:-}" = "--staged" ]; then
  STAGED_MODE=1
  shift
fi

# Compare on `path:content`, dropping the line number. This makes the check
# robust to refactors that shift lines without changing semantic content.
strip_line_no() {
  sed -E 's/^([^:]+):[0-9]+:/\1:/'
}

# Emit `path:line:content` triples for every matching line in a scope.
# Args: <scope-dirs (comma-separated)> <rg-type-args>
generate_raw() {
  local scope_csv="$1"
  local rg_type_args="$2"
  # rg accepts multiple paths; split the csv on commas and pass each.
  local scope_args=()
  IFS=',' read -ra scope_args <<< "$scope_csv"
  # shellcheck disable=SC2086
  rg $rg_type_args --no-heading -n "$PATTERN" "${scope_args[@]}" 2>/dev/null | sort -u
}

# Regen mode: rebuild allowlist files in place, preserving the human-
# readable header (everything until the first non-comment entry).
if [ "${1:-}" = "--gen" ]; then
  for tuple in "${SCOPES[@]}"; do
    IFS="$DELIM" read -r label scope_csv allowlist staged_re allowlist_staged_re rg_type_args <<< "$tuple"
    echo "Regenerating $allowlist from current tree..."
    if [ -f "$allowlist" ]; then
      HEADER_END=$(grep -nE "^(apps|packages)/" "$allowlist" | head -1 | cut -d: -f1 || true)
      if [ -z "$HEADER_END" ]; then HEADER_END=1; fi
      HEADER=$(head -n $((HEADER_END - 1)) "$allowlist")
    else
      HEADER="# Phase 8 — naming canonicalization allowlist (auto-generated)"
    fi
    TMP=$(mktemp)
    generate_raw "$scope_csv" "$rg_type_args" > "$TMP"
    {
      printf '%s\n' "$HEADER"
      cat "$TMP"
    } > "$allowlist"
    rm -f "$TMP"
    echo "Wrote $(wc -l < "$allowlist" | tr -d ' ') lines to $allowlist"
  done
  echo "Note: --gen captures EVERY current ref. If you want classification"
  echo "headers (KEEP_HISTORICAL_COMMENT etc.) preserved, re-add them by"
  echo "hand. The CI check itself does not require the headers."
  exit 0
fi

# Default mode: scan + diff each scope.
EXIT_CODE=0
for tuple in "${SCOPES[@]}"; do
  IFS="$DELIM" read -r label scope_csv allowlist staged_re allowlist_staged_re rg_type_args <<< "$tuple"

  # Per-scope --staged skip: if the user is in --staged mode and no files
  # in this scope are staged, skip cleanly.
  if [ "$STAGED_MODE" = "1" ]; then
    STAGED=$(git diff --cached --name-only --diff-filter=AM 2>/dev/null \
      | grep -E "$staged_re" \
      || true)
    ALLOWLIST_STAGED=$(git diff --cached --name-only --diff-filter=AM 2>/dev/null \
      | grep -E "$allowlist_staged_re" \
      || true)
    if [ -z "$STAGED" ] && [ -z "$ALLOWLIST_STAGED" ]; then
      echo "Naming allowlist [$label]: skipped — no in-scope TS files staged."
      continue
    fi
  fi

  if [ ! -f "$allowlist" ]; then
    echo "ERROR: $allowlist does not exist. Run with --gen to bootstrap." >&2
    EXIT_CODE=1
    continue
  fi

  CURRENT=$(mktemp)
  ALLOWED=$(mktemp)
  generate_raw "$scope_csv" "$rg_type_args" | strip_line_no | sort -u > "$CURRENT"
  grep -v "^#" "$allowlist" \
    | grep -v "^$" \
    | strip_line_no \
    | sort -u > "$ALLOWED"

  # Subset gate: every CURRENT ref must appear in the allowlist (content-keyed,
  # line-number agnostic). Allowlist entries that no longer correspond to
  # anything in the source are not flagged here — those are stale entries that
  # `--gen` will prune. The guard's job is to catch NEW unblessed refs.
  NEW_REFS=$(comm -23 "$CURRENT" "$ALLOWED")

  if [ -z "$NEW_REFS" ]; then
    echo "Naming allowlist [$label]: OK ($(wc -l < "$CURRENT" | tr -d ' ') refs scanned)"
    rm -f "$CURRENT" "$ALLOWED"
    continue
  fi

  echo "FAIL [$label]: New legacy-name references found that are not on $allowlist."
  echo
  printf '%s\n' "$NEW_REFS" | head -40
  echo
  echo "Either:"
  echo "  - Rename the call site to the canonical name (e.g. booking_bundle_id"
  echo "    → booking_id) AND update the test fixture/spec it lives in."
  echo "  - Add an entry to $allowlist classifying the ref as one of:"
  echo "      KEEP_HISTORICAL_COMMENT      (rename rationale / column-rename docs)"
  echo "      KEEP_LEGITIMATE_OTHER_TABLE  (asset_reservations / recurrence_series)"
  echo "      KEEP_BACKWARDS_COMPAT_FIELD  (method-arg / return-shape field name)"
  echo "      KEEP_AUDIT_ENTITY_TYPE       ('booking_bundle' literal in audit/outbox)"
  echo "      KEEP_WIRE_SHAPE              (response field, request payload key,"
  echo "                                    URL path string, query-key segment)"
  echo "    Format: <path>:<line>:<exact source line>"
  echo "    Then re-run this check."
  echo
  if [ "$label" = "api" ]; then
    echo "Reference: docs/follow-ups/phase-8-naming-audit.md"
  else
    echo "Reference: docs/follow-ups/phase-8-frontend-rename-triage.md"
  fi
  rm -f "$CURRENT" "$ALLOWED"
  EXIT_CODE=1
done

exit $EXIT_CODE
