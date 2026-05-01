# Visitor management v1 — known tech debt + lessons

Companion to `docs/follow-ups/visitors-v1-polish.md`. That file tracks
deferred UX polish; this file tracks intentional tech-debt decisions,
schema notes that can't be edited in-place, and lessons from the
post-shipping review pass for future planning runs.

## Intentional v1 debt

### `rejected` ↔ `denied` vocabulary seam

**Where:** `apps/api/src/modules/visitors/visitor.service.ts`,
inside `onApprovalDecided`, at the line marked `// SEAM:`.

**What:** the approval module's outcome enum is `'approved' | 'rejected'`
(approver-domain words). The visitor module's terminal status for
refused invites is `'denied'` (visitor-domain word). The translation
happens at the visitor module boundary. The approval dispatcher branch
stays a one-line passthrough that matches every other target type's
branch shape.

**Why we shipped it like this:** unifying the vocabulary across domains
would have required either renaming the approval enum (touches every
other approval target type — unrelated blast radius for v1) or coining
a third word (worse). The translation map is one line and the seam is
isolated to a single function.

**When the seam matters:** if the approval domain ever refactors its
outcome enum (e.g. adds `'cancelled'` as a third outcome, or splits
`'rejected'` into `'rejected'`/`'auto_rejected'`), the translation in
`visitor.service.ts` needs updating in lockstep. The `SEAM:` comment
points back here.

**Spec reference:** §11 of
`docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md`.

### `host_person_id` denormalization (visitor adapter)

**Where:** `apps/api/src/modules/privacy-compliance/adapters/visitor-records.adapter.ts`
reads `visitors.host_person_id`. Multi-host data lives in
`visitor_hosts` junction.

**What:** v1 chose to keep `host_person_id` populated as a denormalized
mirror of `visitors.primary_host_person_id` so the GDPR adapter keeps
working without rewrite. `VisitorService.transitionStatus` and create/
update paths write both columns.

**Why:** the GDPR baseline pipeline is foundational and shipped earlier;
rewriting the adapter to JOIN through `visitor_hosts` was a v2 risk,
not v1.

**v2 cleanup:** rewrite the adapter to JOIN through `visitor_hosts`,
drop `host_person_id` from the visitor row, and remove the
synchronization writes.

**Spec reference:** §14.2.

### English-only visitor surfaces

**Where:** invitation email template, kiosk welcome flow, cancel
landing page.

**What:** all visitor-facing copy is English regardless of tenant
locale. Strings flow through proper i18n primitives so the eventual
platform-wide pass is mechanical.

**Why:** translating before the surface stabilizes throws work away
when iterations happen. The platform-wide translation pass is the
right place to land NL + FR for visitor email.

**Risk acknowledged:** wave-1 NL/BE customers may push back at sales/
migration time. Mitigation is sales-conversation expectation
management.

**Spec reference:** §1 Languages.

## Schema notes that can't be in-place fixed

These are clarifications about migrations that have already been
pushed to the remote DB. The migration files cannot be edited (we
treat applied migrations as immutable history); document the
clarification here instead.

### `task_leases` has RLS enabled with no policy — intentional

**File:** `supabase/migrations/00262_task_leases.sql`.

**Reviewer concern:** `enable row level security` + `revoke from
authenticated` but no explicit policy looks accidental.

**Clarification:** RLS enabled with no policy is intentional —
`task_leases` is service-role-only. All access goes through the
worker code (`DbService` → postgres role). The `revoke ... from
authenticated, anon, public` is the actual access control; RLS-
enabled-with-no-policy means "any authenticated/anon caller would
get zero rows even if they bypassed grants somehow", which is the
defense-in-depth posture we want for a service-role-only table.

If a future change adds an authenticated-side access path (e.g.
admins listing in-flight leases for an ops dashboard), that path
must add a policy here.

**Why the clarifying comment isn't in the SQL file:** the migration
has already been applied to remote. Editing it now would diverge
local from remote and break replay on a fresh environment.

## Lessons for future planning runs

### Same-model self-review rarely catches its own typos

**Observation:** the visitor v1 plan's self-review section
(2026-05-01-visitor-management-v1.md, lines 945–977) did not catch
the migration block drift. The spec's self-review did not catch the
colon-vs-dot permission key mismatch or the §4.9 SQL bug.

**Why this happens:** when the same model produces a plan and then
self-reviews it, both passes operate against the same internal
representation of "what I just wrote", so typos and code-block
errors that the model doesn't model in its head don't surface.

**Lesson:** future plans benefit from a separate adversarial review
pass — codex-driven or a separate-context Agent subagent — that
reads the plan/spec fresh against the actual codebase. The existing
`/full-review` two-gate pattern is the right tool; run it on plans
*before* implementation, not just on shipped code.

**Action:** for any plan that includes ≥5 migration files or ≥10
SQL/TS code blocks, run a fresh-context adversarial review of the
plan before kicking off implementation. The cost (one subagent
turn) is much smaller than the cost of finding the drift after
shipping.
