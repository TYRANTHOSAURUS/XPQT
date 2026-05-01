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
