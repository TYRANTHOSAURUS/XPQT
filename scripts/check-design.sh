#!/usr/bin/env bash
#
# check-design.sh — grep-based guardrails against design drift.
#
# Modes:
#   check-design.sh             scan the whole repo (CI default)
#   check-design.sh --staged    scan only staged files + diffs (pre-commit)
#
# Cheap, brittle, fast. Each check is a single grep; the script exits
# non-zero on the first violation so failures are easy to scan. Add an
# explicit allow-comment (`// design-check:allow`) to a line to whitelist
# a legitimate deviation.
#
# See CLAUDE.md §"Design polish rules" for why each rule exists.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="all"
if [ "${1:-}" = "--staged" ]; then
  MODE="staged"
fi

# Scope — everything in apps/web/src except already-approved tokens and the
# format helpers themselves (which obviously DO use Intl.*).
WEB_SRC="apps/web/src"
LIB_FORMAT="apps/web/src/lib/format.ts"
UI_DIR="apps/web/src/components/ui"
INDEX_CSS="apps/web/src/index.css"

violations=0

# In --staged mode we build the list of files to scan from the git index,
# filtering to the paths our rules care about. If nothing interesting is
# staged, exit cleanly.
STAGED_FILES=""
if [ "$MODE" = "staged" ]; then
  STAGED_FILES=$(git diff --cached --name-only --diff-filter=AM 2>/dev/null \
    | grep -E "^(apps/web/src|apps/web/index\.html)" \
    || true)
  if [ -z "$STAGED_FILES" ]; then
    echo "Design checks skipped — no web files staged."
    exit 0
  fi
fi

run_check() {
  local name="$1"
  local pattern="$2"
  local scope="$3"
  local excludes="$4"
  local hint="$5"

  local matches=""
  if [ "$MODE" = "staged" ]; then
    # Build the set of staged files that fall inside this rule's scope.
    local targets=""
    local file dir
    while IFS= read -r file; do
      [ -z "$file" ] && continue
      for dir in $scope; do
        case "$file" in "$dir"*)
          targets+="$file"$'\n'
          break
          ;;
        esac
      done
    done <<< "$STAGED_FILES"
    targets="${targets%$'\n'}"
    if [ -z "$targets" ]; then
      echo "✓ $name (no staged files in scope)"
      return
    fi
    matches=$(echo "$targets" | xargs -I{} grep -HnE "$pattern" {} 2>/dev/null \
      | grep -v "design-check:allow" \
      | { [ -n "$excludes" ] && grep -v -E "$excludes" || cat; } \
      || true)
  else
    # shellcheck disable=SC2086
    matches=$(grep -rnE "$pattern" $scope 2>/dev/null \
      | grep -v "design-check:allow" \
      | { [ -n "$excludes" ] && grep -v -E "$excludes" || cat; } \
      || true)
  fi

  if [ -n "$matches" ]; then
    echo "✗ $name"
    echo "$matches" | sed 's/^/  /'
    echo "  Fix: $hint"
    echo ""
    violations=$((violations + 1))
  else
    echo "✓ $name"
  fi
}

echo "--- Design polish checks ---"
echo ""

run_check \
  "No hand-rolled cubic-bezier in page/component code" \
  "cubic-bezier\\(" \
  "$WEB_SRC" \
  "$INDEX_CSS|$UI_DIR" \
  "Use transition-timing-function: var(--ease-snap|smooth|spring|swift-out) from index.css."

run_check \
  "No direct toLocaleString / toLocaleDateString in page code" \
  "\\.toLocale(Date)?String\\(" \
  "$WEB_SRC" \
  "$LIB_FORMAT" \
  "Use formatFullTimestamp / formatRelativeTime from @/lib/format."

run_check \
  "No ad-hoc Intl.NumberFormat outside lib/format.ts" \
  "new Intl\\.NumberFormat\\(" \
  "$WEB_SRC" \
  "$LIB_FORMAT" \
  "Use formatCount from @/lib/format."

run_check \
  "No ad-hoc Intl.RelativeTimeFormat outside lib/format.ts" \
  "new Intl\\.RelativeTimeFormat\\(" \
  "$WEB_SRC" \
  "$LIB_FORMAT" \
  "Use formatRelativeTime from @/lib/format."

run_check \
  "No arbitrary max-w-[NNNpx] on a SettingsPageShell (DialogContent widths are exempt)" \
  "<SettingsPageShell[^>]*max-w-\\[" \
  "$WEB_SRC/pages $WEB_SRC/layouts" \
  "" \
  "SettingsPageShell picks width via the \`width\` prop, never className. Pass width=\"narrow|default|wide|xwide\"."

run_check \
  "No heavy drop shadows (shadow-xl / shadow-2xl) in page or admin component code" \
  "shadow-(xl|2xl)" \
  "$WEB_SRC/pages $WEB_SRC/layouts $WEB_SRC/components/admin" \
  "" \
  "Use a border (border border-border/50 + ring-1 ring-black/5) or shadow-lg for lifted drag overlays."

run_check \
  "No active:scale-* on buttons (use translate-y-px to avoid text blur)" \
  "active:scale-" \
  "$WEB_SRC/components/ui/button\\.tsx $WEB_SRC/pages $WEB_SRC/components/admin" \
  "" \
  "Keep the Button baseline (active:translate-y-px). Don't layer scale on top."

echo ""
if [ "$violations" -eq 0 ]; then
  echo "Design checks passed."
  exit 0
else
  echo "Design checks failed — $violations rule(s) violated."
  echo "Suppress a legit deviation by adding '// design-check:allow' on the offending line."
  exit 1
fi
