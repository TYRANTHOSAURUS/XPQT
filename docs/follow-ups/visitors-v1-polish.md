# Visitor management v1 — deferred polish

Tracking the polish items the design review surfaced that we deliberately
did not implement in the must-fix pass. Source: the visitor management v1
design review reports.

## Highest-priority post-v1 polish

- **Visitor-email translation (NL + FR).** Visitor-facing surfaces ship in
  English only in v1. The largest commercial risk surfaced by the post-
  shipping product review: NL/BE wave-1 customers expect a Dutch
  invitation email, cancel landing page, and kiosk welcome. Mitigation
  for v1 is customer-expectation management at the sales conversation;
  the actual fix is a platform-wide translation pass that picks up the
  visitor module along with every other tenant-facing surface. Shipping
  visitor-only translation ahead of that pass would diverge i18n
  primitives across the app and is explicitly NOT what we want — the
  whole point of English-only-for-now is that the eventual translation
  is one mechanical pass. **Track at the platform-i18n level, not as a
  visitor-module sprint.** Visitor email is the surface that matters
  most when the platform pass runs.

## Deferred motion / polish (yellow)

These are real improvements but each is small enough on its own that we'd
rather batch them when the next visitor-stack change lands.

- **Kiosk view transitions.** React Router `unstable_viewTransition` is
  set up globally; the kiosk pages don't pass it on their inter-page
  navigations yet. Adding it would give the visitor a 240ms crossfade
  between idle → QR scan, QR scan → confirmation, etc. See the design
  polish rules in `CLAUDE.md` for the prop name.
- **Confirmation page celebratory animation.** The auto-dismiss progress
  bar covers the timing cue. A subtle one-shot fade-up on the
  CheckCircle2 icon would match the Linear/Vercel idiom but isn't
  required.
- **Curly-quote sweep.** A few visitor-facing copy strings still use
  straight quotes (`"`, `'`) where curly quotes (`"`, `'`, `'`) read
  better at the kiosk's large text sizes. Run a sweep across the kiosk
  copy in one pass.

## Deferred green items

- **Re-introduce a meeting-room picker on the standalone visitor invite
  form** (v2). The freeform "paste a UUID" input was removed in the
  must-fix pass; composer mode still inherits the room from the parent
  booking. v2 wants a proper picker bound to the selected building.
- **Bulk silent-toast UX**: when 8 visitors check in in close succession,
  we currently show no individual confirmation (the optimistic bucket
  move is the visible feedback). A future add could be a tiny "8
  checked in" rolling counter at the top of the today buckets that
  fades out after 3s — surfaces the bulk action without one-toast-per-
  visitor noise. Not required for v1.
- **Pool decommission flow.** The "How to decommission this pool"
  dialog walks the admin through manual steps. A future slice can
  back this with a real backend `decommission` endpoint that:
  retires every available pass, blocks if any pass is in use or
  reserved, opts the anchor space out atomically, and emits an audit
  event. The dialog UI is forward-compatible with a button that flips
  from "How to" to "Run decommission" once the endpoint exists.

## 2026-05-02 desk-shell rebuild — must-fix pass

### Shipped

- `/reception/*` redirects now preserve query params (building, q, etc).
- Curly-quote sweep on `/desk/visitors`, visitor-detail, expected.tsx,
  context-menu copy.
- Dropped autoFocus on the desk-visitors search input; focuses only
  when nothing else holds focus on first mount.
- spellCheck=false on email + phone inputs in the invite form;
  spellCheck=false on the visitor search input.
- Placeholders on first/last name use `e.g. Jane…` / `e.g. Smith…`.
- Search input search-debounce `useEffect` now depends on the stable
  `patch` callback, not the literal `filters` object.
- Detail panel resolves the primary host's name via `usePerson()`
  instead of showing the literal string `On record`. Falls back to
  em-dash when the lookup is empty.
- `CapturedVisitorValues` carries `co_host_persons: { id, label }[]`
  so the invite form rehydrates with human names. Backend payload
  still receives `co_host_person_ids[]` — the form maps at the edge.
- Search overlay rewritten as `Command` + `CommandList` + `CommandItem`.
  Arrow keys, Enter, Escape work natively via cmdk; we no longer hand-
  roll keyboard logic.
- `<div role="button">` row → real `<button>` in `visitor-list-row`.
  Checkbox moved out of the button so we don't nest interactives.
- Enter on a focused row → status-aware primary action:
  expected/pending → mark arrived; arrived/in_meeting → checkout
  dialog; else → open detail. Cmd/Ctrl+Enter always opens detail.
  Same wiring on the table view's TableRow.
- Walk-up button: split-button next to +Invite. Walk-up form mounts
  inline above the table (NOT a modal); supports batch entry.
- Today view renders bucketed sections (Currently arriving / Expected
  next 30 min / Expected later today / On site / Checked out today).
  Other views stay flat.
- Loose-ends panel rebuilt: counts for auto-checked-out + bounces,
  unreturned-passes table with Mark returned + Mark lost actions,
  bounce list. Replaces fabricated `'Pass #1234'` visitor rows.
- Multi-building tenants get `ReceptionBuildingPicker` in the toolbar.
- VisitorContextMenu: shared `pending` string state replaced with
  per-mutation `isPending`. Concurrent ops on different rows no
  longer block each other. Handlers wrapped in useCallback.
- Mark-left from context menu + detail panel → CheckoutDialog with
  pass-return decision.
- More-options expander on the invite form animates height + opacity
  via base-ui's `--collapsible-panel-height` var (was a broken
  transitionDuration='180ms' style).
- Detail panel fades + slides in (200ms ease-smooth, +2px offset).
- Invite form's last-name input now has its own FieldLabel (split
  the single Field row into two side-by-side fully-labeled Fields).
- Submit handlers on invite + walkup forms focus the first invalid
  field instead of just disabling the submit button. Invite form
  auto-expands the More-options collapse if the invalid field is
  inside it.
- `visitor-action-row.tsx` deleted (zero importers since the legacy
  `/reception/today` was removed in 9776fc1).

### Skipped — backend gap

- Cancel + Resend invitation actions on the portal expected page.
  No host-side cancel/resend endpoint exists today; only the
  visitor-token cancel surface is wired. The kebab menu surfaces
  these as disabled "coming soon" items so the affordance is clear
  but the click is a no-op. Backend work needed: a `POST
  /visitors/:id/cancel` (host scope) and a resend equivalent.

### Remaining yellow items

- Apply the same `<div role="button">` → `<button>` migration to
  `ticket-list-row.tsx`. Same shape as the visitor row fix;
  intentionally scoped out of this pass to avoid touching ticket
  semantics in a visitors-focused PR.
- The TableRow keyboard handler we added (Enter → primary action,
  Cmd+Enter → open) is a div-row in a `<tr>` — semantically still
  imperfect. The table view's right answer is to drop the table for
  the same `<button>`-with-flex idiom we use on the list view. That
  change is bigger and should ride with a tickets-table refactor
  rather than only the visitor table.
- The PersonPicker doesn't surface a stable id we can `.focus()`,
  so the walk-up "host required" error still relies on the inline
  FieldError text rather than focusing the picker. Fix is in
  PersonPicker (expose an `id` prop or a forwardRef target).

## Already shipped in the must-fix pass

For reference / so the next reviewer doesn't re-flag these:

- Co-host chips show display name (not UUID slice).
- Meeting-room freeform UUID input removed from standalone invite form.
- inputMode="email" / inputMode="tel" on the email + phone inputs.
- Stable crypto.randomUUID local IDs in the composer's pending visitors.
- Reception search overlay (popover anchored to input) instead of
  replacing the today buckets.
- Optimistic check-in (was already shipped pre-review; verified intact).
- Silent toasts on bulk check-in.
- Memoised ReceptionVisitorRow + ease-snap row hover transition.
- Throttled kiosk auto-lock pointermove (1s).
- Portrait orientation overlay applied at the layout, per-page
  `portrait:hidden` removed.
- Kiosk session: tenantId / buildingId widened to `string | null`;
  manual paste no longer writes the literal string `'unknown'`.
- Kiosk reset: success toast (was an error toast).
- Kiosk QR scan: "Try camera again" button on permission-denied.
- Kiosk QR scan: canvas `sr-only` (was `hidden`).
- Kiosk QR scan: mount-only camera-start effect (refs for inner fns).
- Kiosk confirmation: aria-live="polite" on the redirect notice.
- Kiosk confirmation: top-edge progress bar with REDIRECT_MS keyframe.
- /desk/visitors → SettingsPageShell.
- Pool detail "Plan decommission" → informational "How to" dialog.
- Walk-up form: FieldGroup composition violation removed.
- Shared VisitorStatusBadge / useDebouncedValue / mapBackendError.
- Daglijst dark-mode preview honors `color-scheme: light`.
