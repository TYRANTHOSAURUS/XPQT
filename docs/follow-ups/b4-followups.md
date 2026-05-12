# B.4 follow-ups

Deferred / known-issue index for the B.4 booking-edit-pipeline workstream.
Items here are intentional non-fixes, documented so future readers don't
re-discover them as bugs. Sibling to `docs/follow-ups/b2-followups.md`.

## Sequencing — `edit_booking` controller cutover MUST land in or after notification dispatch (B.4.A.5)

Self-review on commit `d285bc32` (the `booking.approval_required` handler
stub) flagged that the stub-now / dispatch-later split creates a
notification window if Step 2D-D (editSlot cutover) ships before
B.4.A.5 (notification dispatch). During that window:

- Admin edits a booking → §3.6.5 row 2/7/8 fires
- 00364 inserts the new approval chain rows + emits
  `booking.approval_required`
- The stub handler logs receipt and acks (no dead-letter, no
  notification)
- Approvers learn nothing until B.4.A.5 ships

Spec §7 line 270 already states the producer-before-consumer invariant,
but the spec doesn't yet name the **controller-before-dispatch**
invariant. Add to B.4.A.5's spec entry: "do NOT ship the editSlot /
editOne / editScope controller cutovers until notification dispatch is
live in the same commit, or the deferral risks silent stalls on every
approval-flipping edit."

Until B.4.A.5 ships:
- Step 2D-D (editSlot cutover) only triggers row 2/7/8 emits when the
  edit changes the rule resolver outcome (location → require_approval
  flip, attendee resize across capacity threshold, etc).
- Most editSlot calls (geometry-only edits within the same room and
  rule outcome) will NOT trigger an emit and are safe.
- A pre-flight gate at the controller level could skip the cutover when
  the plan's `approval.new_outcome === 'require_approval'`, falling back
  to a 422 with `booking.edit_requires_notification_dispatch_unavailable`
  until B.4.A.5 ships. Decision: defer that gate to Step 2D-D's
  implementation phase; not load-bearing for the handler commit.

## UUID_RE consolidation — pre-existing tech debt acknowledged but not consolidated

Code review on commit `d285bc32` flagged 5 local `const UUID_RE` definitions
across `apps/api/src/`:

- `common/tenant-validation.ts:4-5` — exported in this commit (Step 2D-B
  remediation) so the new handler can share its shape.
- `common/middleware/client-request-id.middleware.ts:32` — local copy
  predates the export.
- `modules/sla/sla-policy.controller.ts:10` — local copy predates the
  export.
- `modules/work-orders/work-order.service.ts:617` — local copy predates
  the export.
- `modules/outbox/handlers/booking-approval-required.handler.ts:2` —
  imports from tenant-validation.ts (B.4.A.4 fix).

The 4 pre-existing local copies are intentionally NOT consolidated in
this commit to keep blast radius minimal. They use the looser
`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
pattern (no version-nibble check) — same as the now-exported one — so
behavior is identical. Consolidation is a separate sweep; bundle into the
next routine refactor pass touching those files.

**Why loose vs strict:** Postgres `gen_random_uuid()` produces v4 UUIDs
today, but a future move to v7 (timestamp-prefixed, RFC 9562) MUST not
require a regex bump across the codebase. The loose pattern admits any
RFC-shaped uuid; the strict pattern (`[1-8]` version nibble + `[89ab]`
variant nibble) would reject v9-v15 (currently undefined but reserved)
and v0 (legacy). Loose is the correct choice for shape validation.

## Directory rename `reservations/` → `bookings/` — pending Phase 8 sweep

The `apps/api/src/modules/reservations/` directory is the canonical home
of booking-related TS code (post-B.0 rename of `booking_bundles` →
`bookings` table; the `reservations` table itself was renamed to
`booking_slots`). The directory name still says `reservations/` and
TS file paths in citations still reflect that.

Three citations in the B.4.A.4 handler commit (the docstring + two
comment block lines + one test docstring) reference the path
`apps/api/src/modules/reservations/event-types.ts`. These are all
honest/accurate at write time but will need updating when the directory
renames.

Consolidation candidate: rename `apps/api/src/modules/reservations/` →
`apps/api/src/modules/bookings/` in one Phase 8 commit, sweep all import
paths + docstrings, drop the B.4 section header in
`.naming-allowlist.txt` since the citations would then reference the
canonical path.

Not load-bearing for any production code path; pure naming hygiene.

## Audit_events.details augmentation — `chain_config_changed` not surfaced

Inherited from B.2.A. Self-review on 00364 (edit_booking RPC v4) surfaced
that the `audit_events.details` payload for `booking.edited` carries
approval action + outcomes + chain_id but does NOT carry the TS-computed
`chain_config_changed` boolean from the plan. Lets post-hoc auditors
detect plan-builder bugs (separating "TS plan-builder bug" from "RPC
executed correctly given input").

Migrations are immutable; defer to next v5 supersession of `edit_booking`
when a real defect requires touching the RPC. See `b2-followups.md`
section "B.4.A.4 audit payload — chain_config_changed visibility".

Low-priority — only matters when investigating a tenant complaint about
unexpected approval re-trigger.
