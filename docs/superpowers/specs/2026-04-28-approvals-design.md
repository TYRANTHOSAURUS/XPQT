# Approvals — Design Spec

**Date:** 2026-04-28
**Status:** Design — pending implementation
**Owner:** TBD
**Estimated effort:** ~5-6 weeks across 4 sprints
**Roadmap location:** `docs/booking-platform-roadmap.md` §G3-G6, §F17.

**Why this spec exists:** the platform roadmap labels approvals Tier 1 across §G3-G6 (cost-center approval routing, manager-chain resolution, delegation, dashboard, mobile/Teams approve-in-place). The codex review of the orchestration plan on 2026-04-28 surfaced the gap that no design spec existed for it. Approvals are a daily-driver workflow for any tenant >50 employees; without a coherent design we ship N variants of "approval" across services / room booking / visitor management, drift between them, and create the same N audit-log query that ServiceNow has.

This spec consolidates what already ships (see §2.1 below) and specifies what's missing: the **manager-chain resolver**, real **sequential-step gating + chain advance** (the schema is there; the logic isn't), **durable delegation** (currently re-resolved at request time, not pre-baked at chain creation), the **approver dashboard UI**, the **mobile + Teams approve-in-place flow**, and the **escalation-on-timeout policy**. It also extends — not duplicates — the existing `ApprovalRoutingService` in `apps/api/src/modules/orders/approval-routing.service.ts`; that service's scope_breakdown dedup is preserved and rehomed into the new resolver.

**Context:**
- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §G3-G6 + §F17.
- [`docs/booking-services-roadmap.md`](../../booking-services-roadmap.md) §9.2.6 (approver inbox).
- [`docs/cross-spec-dependency-map.md`](../../cross-spec-dependency-map.md) §13.3 (coverage gap closed).
- [`docs/competitive-benchmark.md`](../../competitive-benchmark.md) §3 "Approvals" — benchmark bar: ServiceNow approver inbox + Eptura mobile approve + Coupa cost-center routing.
- Memory: `project_industry_mix.md` (cost-center approvals are core for corporate HQ market).
- Memory: `project_routing_stack.md` (four-axis routing model is orthogonal to approvals — approvals are about *who must say yes* before fulfillment runs; routing is *who fulfills* once approved).
- Sibling specs:
  - [GDPR baseline](2026-04-27-gdpr-baseline-design.md) §3 — `audit_outbox` already wired; approval transitions emit there.
  - [Visual rule builder](2026-04-27-visual-rule-builder-design.md) — service rule effects can be `requires_approval` with parameterised approver selection; this spec ingests those rule outcomes as one input to the resolver.
  - [Vendor portal Phase B](2026-04-27-vendor-portal-phase-b-design.md) — vendor decline is a different shape than approval but the inbox UI patterns are reusable.
  - [MS Graph integration](2026-04-27-microsoft-graph-integration-design.md) Phase 3-4 — Teams adaptive-card approve-in-place delivery + action handling lives there; this spec specifies the contract.

---

## 1. Goals + non-goals

### Goals

1. **Single resolver** — when a request needs approval, exactly one resolver decides who must approve and in what order. Today's services / room booking / visitor management each describe their own approval flow; converge on one.
2. **Manager-chain resolution** — `requester.manager_person_id` walked N levels until threshold matches (cost / amount / role). Today the data is in `persons.manager_person_id` (496 rows already populated) but the resolver doesn't use it.
3. **Cost-center default approvers** — `cost_centers.default_approver_person_id` already exists (memory `project_industry_mix.md` flags this as the corporate HQ wedge). Surface it as a first-class resolver source.
4. **Durable delegation pre-baked at chain creation** — today's code re-resolves delegations at request time, so a delegation expiring mid-chain reroutes in-flight approvals. Target: resolver writes `delegated_to_person_id` at chain creation, and that field is the source of truth for the rest of the chain's life. New chains see the new delegate. Existing in-flight approvals don't reroute when the delegation expires (intentional — the work was already in flight; rerouting would be confusing).
5. **Approver dashboard** — every approver sees one inbox across services / rooms / visitors / orders, sorted by SLA-clock, with batch-approve for compatible items. Memory `feedback_quality_bar_comprehensive.md`: comprehensive scope, not lean — this is the daily-driver UX.
6. **Mobile-first approve** — phone-formatted inbox + one-tap approve / reject + reason capture. ~50% of approvals happen on mobile per benchmark §3.
7. **Teams approve-in-place** — adaptive card in Teams chat with Approve / Decline / Need-info actions; backend processes the action without a portal round-trip. Depends on MS Graph Phase 3 + Phase 4.
8. **Escalation on timeout** — chains expose a `timeout_at` per step; on timeout the approval auto-routes to the configured escalation target (manager-of-approver, team fallback, or auto-approve for low-risk). Today silently stalls.
9. **Single audit chain** — every approval transition emits to `audit_outbox` with a uniform shape so "show me everything that approved this booking" is one query.
10. **Reversibility** — admins with `approvals.override` can override a decision with reason; original chain preserved. Foundation for "this got auto-rejected because manager was OOO; reopen it."

### Non-goals

- **Multi-tenant approval delegation** (a manager from tenant A approving for tenant B). Out of scope; tenant boundary is hard.
- **Free-text approval policies authored in natural language.** The visual rule builder is the authoring surface; this spec consumes its outcomes.
- **External-approver workflow** (sending the approval to someone outside the tenant — e.g., a customer's procurement). Tier 3.
- **Approval analytics dashboard** for trends (avg approval time, top approvers, etc.). Tier 2 — separate from the per-approver inbox.
- **Approval-chain editor in the rule builder UI.** Sprint 4 of the rule builder will add it; this spec specifies the contract the editor consumes.
- **Email-only approvals** (reply-to-email-to-approve). Out of scope; magic-link in email lands you on the dashboard. Reasoning: reply-to-email is a regular source of phishing-equivalent abuse.

---

## 2. Architecture overview

### 2.1 Current state (codex post-review correction, 2026-04-28)

A previous draft of this spec implied the existing approvals subsystem already supported step-gated sequential chains + durable delegation. That was wrong. Concrete current state:

| Component | Reality | Intended end-state | Sprint to deliver |
|---|---|---|---|
| `approvals` table + RLS | ✅ shipped | unchanged | — |
| `delegations` table | ✅ shipped | unchanged | — |
| `persons.manager_person_id` (496 rows populated) | ✅ shipped | resolver consumes it | Sprint 1 |
| `ApprovalRoutingService.assemble` (orders/bundles, scope_breakdown dedup, cost-center default approver) | ✅ shipped at `apps/api/src/modules/orders/approval-routing.service.ts` | **rehomed** into the new domain-agnostic resolver; orders import the resolver instead | Sprint 1 |
| `ApprovalService.createSequentialChain` | ⚠️ inserts every step as `pending` simultaneously; no waiting state in the schema; surfaces `step_number` but never gates by it | resolver-driven chain creation + `respond()` enforces "current step must complete before later steps surface as actionable" | Sprint 1 |
| `ApprovalService.respond` | ⚠️ accepts a response on any pending row regardless of `step_number` | extends to check prior-step completion before accepting | Sprint 1 |
| `ApprovalService.advanceChain` | ⚠️ no-op (`_completedStep` arg unused) | drives next-step notifications + auto-skip self-as-approver + audit emit | Sprint 1 |
| Delegation routing | ⚠️ `respond()` checks `delegations` at request time; if a delegation expires mid-chain the in-flight approval reroutes mid-stream | resolver pre-bakes `delegated_to_person_id` at chain creation; expiry doesn't reroute in-flight approvals | Sprint 1 |
| Manager-chain resolver | ❌ not shipped — `persons.manager_person_id` is unused | climbing walker with cycle-detection + threshold-by-amount | Sprint 1 |
| Approver dashboard | ❌ not shipped | per-approver inbox + batch + Realtime | Sprint 2 |
| Escalation worker + reminders | ❌ not shipped | `approval_step_timeouts` + cron worker | Sprint 1 |
| Teams approve-in-place | ❌ not shipped — depends on MS Graph Phase 3 + 4 | adaptive cards | Sprint 4 (Wave 4 of cross-spec; gated by MS Graph Phase 4 landing) |
| Admin override surface | ❌ not shipped | reversal + reason + audit | Sprint 4 |

The headline correction: **Sprint 1 is bigger than originally suggested.** It must close the gating + advance + delegation gaps in `ApprovalService` AND ship the new resolver AND the escalation worker. That moves Sprint 1 from "1.5 weeks" to "~2 weeks." Total remains 5-6 weeks because Sprint 5 polish absorbs the slack.

### 2.2 Why one resolver, not a sidecar

`ApprovalRoutingService.assemble` already implements the dedup algorithm + cost-center-default approver lookup for orders + bundles. Booking-services-roadmap §4.4 explicitly says "do not add a sidecar" — new approval flows extend the existing path.

This spec's `ApprovalResolverService` is the **refactored, domain-agnostic** version of `ApprovalRoutingService`:

- All of `assemble`'s dedup + cost-center-default + scope_breakdown logic moves into the resolver as the "rule outcomes → chain template steps" reduction.
- Orders + bundles call the resolver via the same entry point they call today — the function signature stays compatible (Sprint 1 keeps a thin shim for backward compat; Sprint 5 deletes it).
- Room booking + visitor management add NEW entry points to the resolver — they don't re-implement scope_breakdown dedup.
- Net result: one approval-routing stack across all four entity types, not two.

### Module layout

The work extends two existing modules:
- `apps/api/src/modules/approval/` — `ApprovalService` (already exists; gets the resolver added).
- `apps/api/src/modules/delegation/` — `DelegationService` (already exists; resolver consumes it).

New module:
- `apps/api/src/modules/approval-resolver/` — `ApprovalResolverService`. Pure resolution logic; no state. Takes a request shape + tenant context, returns the chain definition the existing `ApprovalService.createSequentialChain` / `createParallelGroup` consumes.
- `apps/api/src/modules/approval-dashboard/` — `ApprovalDashboardService` for the per-approver inbox + admin overview.

New tables:
- `approval_chain_templates` — admin-authored named chains (e.g. "Catering >€500" → 1: cost-center default → 2: VP Finance).
- `approval_step_timeouts` — per-step escalation policy.
- `approval_overrides` — record of admin overrides (target approval id + override reason).

The visual rule builder writes `approval_chain_template_id` references into rule effect definitions; the resolver dereferences them.

### Background workers

- `ApprovalEscalationWorker` — every 5 minutes, scans `approvals` where `requested_at + step_timeout_minutes < now()` AND `status = 'pending'`. Applies the escalation policy.
- `ApprovalReminderWorker` — sends 1×24h-out + 1×at-deadline reminders to approvers. Uses the existing `notifications` module.

### How a request becomes an approval chain

```
Request creation (services order / room booking / visitor / etc.)
    │
    ▼
ApprovalResolverService.resolve(target, tenantContext)
    │
    │  Inputs:
    │   • Request type + amount + cost_center + requester
    │   • Service-rule effect (requires_approval: true | template_id | ...)
    │   • Tenant policy (default chain when nothing else matches)
    │
    │  Resolution order (first match wins):
    │   1. Explicit chain_template_id from the rule outcome
    │   2. Cost-center default chain (cost_centers.default_approver_person_id + escalation)
    │   3. Manager-chain by amount threshold
    │   4. Tenant default chain
    │   5. No approval needed (return null)
    │
    ▼
{steps: [{approver_person_id?, approver_team_id?, parallel_group?, timeout_minutes}, ...]}
    │
    ▼
ApprovalService.createSequentialChain(steps) | createParallelGroup(steps)
    │
    ▼
approvals rows created → notifications dispatched → SLA clock starts
```

### Where the existing scope_breakdown dedup fits

Roadmap §F10 (shipped via migration 00146) already dedupes approvals via `scope_breakdown`. Multi-line orders get one approval, not N. This spec preserves that — the resolver returns one chain per scope; the existing dedup logic handles the line-fan-in.

---

## 3. Data model

### Existing tables (reference; not modified by this spec except where called out)

- `approvals` — already shipped. Per-step row with `target_entity_type` / `target_entity_id` / `approval_chain_id` / `step_number` / `parallel_group` / `approver_person_id|team_id` / `delegated_to_person_id` / `status` / `scope_breakdown`. **Adds** `step_timeout_minutes` + `escalated_from_step_number` columns.
- `delegations` — already shipped. `delegator_user_id` / `delegate_user_id` / `starts_at` / `ends_at` / `active`.
- `persons.manager_person_id` — already shipped. 496 rows populated as of 2026-04-28.
- `cost_centers.default_approver_person_id` — already shipped (memory `project_industry_mix.md`).

### `approval_chain_templates`

Admin-authored named chains referenced by service rules + tenant defaults.

```sql
create table approval_chain_templates (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenants(id) on delete cascade,
  name                    text not null,
  description             text,
  applies_to_entity_type  text,                                    -- 'order' | 'reservation' | 'visitor' | null = any
  steps                   jsonb not null,                          -- canonical step shape (see below)
  active                  boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (tenant_id, name)
);

create index idx_approval_templates_tenant on approval_chain_templates (tenant_id, active) where active = true;
```

`steps` JSON shape (one entry per step; chain order = array order):

```json
[
  {
    "kind": "person" | "team" | "cost_center_default" | "manager_chain",
    "approver_person_id": "uuid?",
    "approver_team_id": "uuid?",
    "manager_chain_levels": 2,
    "manager_chain_threshold_role": "manager?",
    "parallel_group": "string?",
    "timeout_minutes": 1440,
    "escalation": {
      "policy": "auto_approve" | "manager_of_approver" | "team" | "auto_reject",
      "team_id": "uuid?",
      "person_id": "uuid?"
    },
    "required": true
  }
]
```

The `kind` discriminator lets one template express several resolution strategies in the same chain. e.g.:
- Step 1: `cost_center_default` (resolves at chain creation time to the requester's cost-center default approver).
- Step 2: `manager_chain` levels=2 (climbs 2 levels above the requester).
- Step 3: `team` (CFO team) parallel_group="finance".

### `approval_step_timeouts`

Per-step deadline enforcement. Could live as columns on `approvals` directly; pulled out so we can have multiple escalation rules per step (24h reminder + 48h escalate) without column explosion.

```sql
create table approval_step_timeouts (
  id                       uuid primary key default gen_random_uuid(),
  approval_id              uuid not null references approvals(id) on delete cascade,
  tenant_id                uuid not null references tenants(id) on delete cascade,
  fires_at                 timestamptz not null,
  action                   text not null check (action in ('remind','escalate','auto_decide')),
  decided_action           text,                                   -- 'auto_approve' | 'auto_reject' | null when remind
  fired_at                 timestamptz,
  created_at               timestamptz not null default now()
);

create index idx_approval_timeouts_pending
  on approval_step_timeouts (fires_at)
  where fired_at is null;
```

Created at chain creation time per the template's `timeout_minutes` + escalation policy. The escalation worker scans `fires_at <= now() AND fired_at IS NULL`.

### `approval_overrides`

Audit + reversibility for admin overrides.

```sql
create table approval_overrides (
  id                       uuid primary key default gen_random_uuid(),
  approval_id              uuid not null references approvals(id) on delete cascade,
  tenant_id                uuid not null references tenants(id) on delete cascade,
  override_kind            text not null check (override_kind in
    ('reverse_decision','force_advance','restart_chain')),
  reason                   text not null,                          -- ≥8 chars enforced at app layer
  initiated_by_user_id     uuid not null references users(id),
  initiated_at             timestamptz not null default now(),
  /* snapshot of the approval row pre-override for restore: */
  prior_status             text,
  prior_responded_at       timestamptz,
  prior_comments           text
);

create index idx_approval_overrides_approval on approval_overrides (approval_id, initiated_at);
```

### Audit event types (added to existing taxonomy)

- `approval.chain_created` — resolver matched a chain template; chain id + step count.
- `approval.requested` — per-step row created; approver(s) notified.
- `approval.responded` — approver clicked approve/reject; final outcome of step.
- `approval.delegated` — delegation rerouted a request to the delegate at chain creation OR mid-flight.
- `approval.escalated` — step timed out, applied escalation policy.
- `approval.auto_decided` — escalation policy resulted in auto-approve / auto-reject without human action.
- `approval.overridden` — admin used `approvals.override` to reverse / force-advance / restart.
- `approval.reminder_sent` — approver got the SLA reminder.

All emitted via `AuditOutboxService` (per cross-spec §3.2). Permission key `approvals.override` documented in `event-types.ts`.

---

## 4. Resolver

### Public surface

```typescript
class ApprovalResolverService {
  async resolve(input: ResolverInput): Promise<ResolverDecision>;
  async previewChain(template: ApprovalChainTemplate, requesterPersonId: string, tenantId: string): Promise<ResolvedStep[]>;
}

interface ResolverInput {
  tenantId: string;
  targetEntityType: 'order' | 'reservation' | 'visitor' | string;
  targetEntityId: string;
  requesterPersonId: string;
  costCenter: string | null;
  amount: number | null;
  /** Outcome from the visual rule builder (rule effect = requires_approval). */
  ruleEffect?: { kind: 'requires_approval'; chainTemplateId?: string };
  /** Tenant policy fallback. */
  tenantDefaultChainId?: string | null;
}

type ResolverDecision =
  | { kind: 'no_approval_needed' }
  | { kind: 'chain_resolved'; steps: ResolvedStep[]; sourceTemplateId: string | null };
```

### Resolution order (first match wins)

1. **Rule-effect-supplied chain template id.** The visual rule builder's `requires_approval` effect can name a chain. Direct lookup; deref to its `steps` JSON; pre-resolve dynamic kinds (`cost_center_default`, `manager_chain`).
2. **Cost-center-default chain.** When `cost_centers.default_approver_person_id` is set for the requester's cost-center, build a 1-step chain with the cost-center default approver + 24h timeout + escalation = manager_of_approver. Memory `project_industry_mix.md` makes this the corporate HQ wedge.
3. **Manager-chain by amount.** Climb `persons.manager_person_id` until either (a) the cumulative approval threshold matches the request amount, or (b) we hit `is_external = true` / no manager. Per-tenant config: thresholds (e.g. <€100 = direct manager only; €100-1000 = manager + manager's manager; >€1000 = climb 3 levels). Result: a sequential chain.
4. **Tenant default chain.** When `tenants.default_approval_chain_template_id` is set, deref it.
5. **No approval needed.** Order proceeds without an approval gate.

### Pre-resolution of dynamic step kinds

`steps` JSON can contain `kind: cost_center_default` and `kind: manager_chain` entries. At chain creation time:

- **`cost_center_default`** — look up `cost_centers.default_approver_person_id` for the requester's cost-center. If not set, skip the step (with audit log entry) OR fall through to the next step's policy. Tenant-configurable: prefer-skip vs prefer-block.
- **`manager_chain`** — walk `persons.manager_person_id` for `manager_chain_levels` levels. If the chain is shorter (no manager set), use the highest manager available. Each climb is one approval step. Optional `manager_chain_threshold_role` filter — skip levels whose person is below the role threshold.
- **`person` / `team`** — direct, no resolution.

### Delegation interleave

After the steps are pre-resolved, walk delegations. For each step's `approver_person_id`:

```
SELECT delegate_user_id
  FROM delegations
 WHERE delegator_user_id = (users.id where person_id = step.approver_person_id)
   AND tenant_id = tenant_id
   AND active = true
   AND starts_at <= now() AND ends_at > now()
LIMIT 1
```

If a delegation matches, set `step.delegated_to_person_id = delegate.person_id` (the original approver column stays for audit).

This pre-resolution means the chain is durable: if the delegation expires mid-chain the existing approvals stay routed to the delegate (intentional — the work was already in flight).

### Edge cases

- **Requester is also their own approver.** Skip the step + emit `approval.requested` audit with `auto_skipped: true`.
- **Approver is inactive or anonymized** (per GDPR baseline). Treat as "approver not available" → escalate immediately; admin gets notified.
- **Approver is the requester's subordinate** (anti-loop). Detect via the `manager_chain` walk and skip; if the subordinate is the only available approver, escalate to that subordinate's manager (which should be someone else).
- **No manager set at all.** `manager_chain` resolution returns 0 steps for that block; tenant fallback chain applies.

---

## 5. Approver dashboard

### `/desk/approvals` — per-approver inbox

`SettingsPageShell width="ultra"` (per CLAUDE.md width enum — analytics-grade dashboards qualify) with split layout:

- Left: filter rail (status: pending | overdue | recently-decided; entity type: orders | bookings | visitors; cost-center; amount range).
- Center: approval list, sorted by SLA-clock (overdue first, then by deadline ascending).
- Right: detail pane for the selected approval — full request context + history + comments + actions.

### Approval row

Each row shows:
- Entity type icon + name (e.g. "🍽 Sandwich platter for Q2 Board").
- Requester (avatar + first name + last_initial; full name on hover).
- Cost-center chip (if applicable).
- Amount (if applicable, right-aligned, tabular-nums).
- SLA badge: "due in 4h" / "overdue 30 min".
- Step count: "step 2/3".

### Actions

- **Single-row**: Approve / Decline / Need-info (each with optional comment).
- **Need-info**: routes back to the requester with a comment; the chain pauses. Requester answers; chain resumes.
- **Batch approve**: select N rows of compatible kind (same entity type + same approver + similar shape) → one Approve action covers all. Memory `feedback_quality_bar_comprehensive.md` — Tier 1 batch approve is benchmark-driven (ServiceNow gold).
- **Delegate-back**: re-delegate this single approval to someone else with a reason. Distinct from `delegations` table (which is permanent or time-bound); this is a one-off forward.

### Mobile

`/desk/approvals` is mobile-responsive. Below 640px:
- Collapse split to single column with detail pane behind a swipe gesture.
- Approve / Decline buttons sticky at bottom for one-thumb reach.
- Batch approve hidden (UX deferred to desktop).

### Real-time

Approvals update live via Supabase Realtime when:
- A new approval is created (your inbox shows the new card).
- Another approver in your team responds (your inbox removes it from the parallel group).
- Delegation flips a step to you mid-flight.

Same Realtime channel pattern as Phase B (per cross-spec §3.9).

---

## 6. Teams approve-in-place

Depends on MS Graph integration Phase 3 (Teams adapter wired) + Phase 4 (Teams adaptive card actions). This spec defines the contract.

### Adaptive card

When an approval is created and the approver has a Teams identity (`users.microsoft_user_id` populated by MS Graph Phase 1), the existing notification dispatch detects the channel preference and sends an adaptive card to the approver's Teams personal chat instead of email.

Card shape:

```json
{
  "type": "AdaptiveCard",
  "body": [
    {"type": "TextBlock", "text": "Approval requested", "weight": "Bolder"},
    {"type": "TextBlock", "text": "{entity_type_label}: {entity_summary}"},
    {"type": "FactSet", "facts": [
      {"title": "Requester", "value": "{requester_first_name}"},
      {"title": "Cost center", "value": "{cost_center}"},
      {"title": "Amount", "value": "{amount_formatted}"},
      {"title": "Deadline", "value": "{sla_deadline_relative}"}
    ]},
    {"type": "Input.Text", "id": "comment", "placeholder": "Comment (optional)"}
  ],
  "actions": [
    {"type": "Action.Execute", "title": "Approve", "verb": "approve", "data": {"approval_id": "..."}},
    {"type": "Action.Execute", "title": "Decline", "verb": "decline", "data": {"approval_id": "..."}},
    {"type": "Action.Submit", "title": "Open in Prequest", "data": {"deep_link": "..."}}
  ]
}
```

### Action handler

`POST /api/teams/adaptive-card-action` — MS Graph Phase 4 controller:

1. Verify card-action signature per Bot Framework spec.
2. Resolve the calling Teams user → `users.id` via `microsoft_user_id`.
3. Look up `approvals` by id; verify the actor is the named approver (or a valid delegate).
4. Apply the action via existing `ApprovalService.respond(approvalId, decision, comment)`.
5. Return an updated card showing "Approved by {actor} • {timestamp}" so the channel reflects the decision in place.

Failure modes:
- Approval already decided by someone else → return "Already approved/declined by {other_actor}" card; no double-decision.
- Approval not assigned to actor → return "You no longer have permission to approve this" card; log security audit.
- Network / DB error → return "We couldn't process that — try again" with a refresh action.

### Why not email approve-in-place (reply-to-approve)?

Considered; rejected. Reply-to-email is a long-tail phishing surface — third parties spoof the from-address, the human can't easily verify the chain of custody, and the "approval" rides over an unencrypted SMTP path. Magic-link in email lands you on the dashboard which has the same one-tap UX without the spoofing surface. Memory consistent with `feedback_best_in_class_not_legacy.md`.

---

## 7. Escalation + reminders

### Reminder schedule

Per step, on creation, schedule:
- T-24h before deadline: send approver a "reminder — pending your action" notification (existing notifications module).
- T-1h before deadline: same, more urgent copy.
- T+0 (deadline): apply escalation policy.

Each entry is a row in `approval_step_timeouts` with `action='remind'` (firing earlier) or `action='escalate'` (firing at deadline).

### Escalation policies

Per step, configurable in the chain template's `steps[i].escalation`:

- **`auto_approve`** — request proceeds without further human action. Audit captures the escalation. Used for low-risk, high-volume flows where blocking on a manager-OOO is worse than auto-approving.
- **`auto_reject`** — request gets rejected. Audit captures the escalation. Used for high-risk flows where silent inaction = unsafe default = no.
- **`manager_of_approver`** — bumps to `persons.manager_person_id` of the original approver. New approval row with `escalated_from_step_number`.
- **`team`** — routes to the named team_id. Anyone on the team can decide.
- **`person`** — routes to the named person_id (typically a senior backstop).

Default per chain template = `manager_of_approver` for safety + accountability.

### Worker

`ApprovalEscalationWorker.runEvery5Min`:

```
SELECT * FROM approval_step_timeouts
 WHERE fires_at <= now() AND fired_at IS NULL
 ORDER BY fires_at
 LIMIT 1000

For each row:
  Lock the row + the linked approval row (advisory + row lock).
  If approval.status != 'pending' → mark fired, skip (already decided).
  Apply action:
    - 'remind' → dispatch notification, set fired_at.
    - 'escalate' → emit gdpr-style audit, create new approvals row per escalation policy, mark old approval.status = 'escalated', set fired_at.
    - 'auto_decide' → apply approval.respond(decision = decided_action, actor='system'), set fired_at.
  Commit.
```

Idempotent: re-running on a row with `fired_at IS NOT NULL` is a no-op.

---

## 8. Admin UI — chain templates + override

### `/admin/approvals/chains` — chain template list

Per CLAUDE.md "Index + detail shape" pattern. `SettingsPageShell width="default"`. Index = table of templates with name, applies-to entity type, step count. New / detail / delete.

### `/admin/approvals/chains/:id` — chain template detail

Sections:
1. **Identity** — name, description, applies-to entity type, active toggle.
2. **Steps** — ordered list with drag-handle. Each step expands to show kind, approver picker (uses `EntityPickerAsync` from rule builder Sprint 1A), parallel group, timeout, escalation policy.
3. **Preview** — input form: requester person picker + amount + cost center → shows the resolved chain with all dynamic kinds expanded. Lets admin sanity-check before saving.
4. **Audit** — recent uses of this template (last 30 days; click through to the approval).
5. **Danger zone** — delete (only allowed if no in-flight chains reference it; otherwise mark inactive).

### `/admin/approvals/overrides` — override a decision

Permission `approvals.override` (new — added to roles taxonomy). Surface where admin can:
- Reopen a recently rejected approval (e.g. "auto-rejected because manager was OOO; reopen so I can decide manually").
- Reverse an approved decision (e.g. "approved in error; revert").
- Restart the chain from step 1 (e.g. "the request changed; re-run approvals").

Each writes to `approval_overrides` with the reason; emits `approval.overridden` audit.

---

## 9. Performance + scale

- Resolver: pure-function fast path; cost-center + manager-chain lookups are indexed. Sub-50ms typical.
- Approver inbox: paginated 50/page; cached 30s per actor. The "what's pending for me" query joins approvals + delegations + scope_breakdown — index on `(tenant_id, approver_person_id, status) WHERE status='pending'` already on `approvals`.
- Escalation worker: `approval_step_timeouts` partial index (fires_at WHERE fired_at IS NULL) keeps the scan O(N-firing-now); not O(N-all-approvals).
- Realtime: per-tenant per-approver channel; no broadcast.
- Dashboard real-time: 1 subscription per approver; updates filter client-side. <50 active approvers per tenant typical.

---

## 10. Security

- `approvals.respond` permission required to decide on approvals not assigned to you (delegate path).
- `approvals.override` permission for admin overrides (default off; explicit grant).
- `approvals.audit_read` permission for the admin override surface + cross-approver audit.
- Teams card actions verify Bot Framework signatures + cross-check that the calling Teams user maps to a valid `users.id` in the tenant.
- Magic-link-equivalent for email approvers (when email-only-fallback is used pre-Teams adoption): single-use signed token in the URL, 7-day TTL, lands on the dashboard with the action pre-selected.

---

## 11. Phased delivery

### Sprint 1 (~2 wks): Resolver + chain templates + step gating + escalation worker

(Larger than v1 of this spec implied — see §2.1. Closes the gating, advance, and durable-delegation gaps in `ApprovalService` while shipping the new resolver.)

- Migrations: `approval_chain_templates`, `approval_step_timeouts`, `approval_overrides`; `approvals` adds `step_timeout_minutes` + `escalated_from_step_number`.
- **Refactor of `ApprovalService` — fix the gating gaps:**
  - `respond()` checks prior-step completion (looks for `status='pending' AND step_number < this.step_number`); rejects if anything earlier is unresolved.
  - `advanceChain()` actually advances — emits the next-step notification, auto-skips when the next approver is the requester, emits audit.
  - Sequential `createSequentialChain` only creates the chain rows; only step 1 is "actionable" per the new gating in `respond()`. Optional column `is_actionable` not needed (gating is purely from `step_number`).
- **`ApprovalResolverService`** as the refactored, domain-agnostic version of `ApprovalRoutingService.assemble`. Backward-compat shim in orders + bundles so callers don't break; deleted in Sprint 5.
- 5 resolution sources + delegation pre-bake + edge-case handling per §4.
- `manager_chain` walker + cycle-detection.
- `ApprovalEscalationWorker` (5-min cron) + reminder timeouts.
- Backfill: existing in-flight approvals get default 24h timeout + `manager_of_approver` escalation.

**Acceptance:** sequential 3-step chain created; only step 1 actionable in `respond()`; step 1 approves → step 2 surfaces + notifies; manager-chain walker handles a 2-level climb; escalation auto-fires at T+0.

### Sprint 2 (1.5 wks): Approver dashboard + Realtime

- `/desk/approvals` page (single-column → split-view above 768px → ultra grid above 1280px).
- Filter rail (status / entity type / cost-center / amount).
- Approval row + detail pane.
- One-row Approve / Decline / Need-info.
- Real-time updates via Supabase Realtime subscription.

**Acceptance:** approver opens dashboard; sees their pending; clicks Approve; row updates instantly without reload.

### Sprint 3 (1 wk): Batch approve + mobile + admin chain editor

- Batch-approve: row checkboxes + "Approve N selected" action with compatibility check.
- Mobile responsive layout (sticky action bar; gesture-driven detail).
- `/admin/approvals/chains` + `/admin/approvals/chains/:id` UI consuming `EntityPickerAsync`.
- Live preview pane in the chain editor.

**Acceptance:** admin authors a 3-step chain (cost-center default → manager_chain levels=2 → CFO team) and previews resolution against a real requester.

### Sprint 4 (1 wk): Override surface (always); Teams approve-in-place (when MS Graph Phase 4 lands)

**Sequencing note (post-codex correction):** The override surface is independent and ships in Wave 3 alongside Sprints 1-3. Teams approve-in-place is a hard-dep on MS Graph Phase 3 (Teams adapter) + Phase 4 (adaptive-card actions); it ships in **Wave 4**, NOT Wave 3, even though it's nominally "Sprint 4" of approvals. The cross-spec dep map sequences this correctly.

Override surface (Wave 3):
- `/admin/approvals/overrides` admin surface with reason capture.
- `approval_overrides` table writes + audit emit.

Teams approve-in-place (Wave 4 — gated by MS Graph Phase 4):
- Adaptive-card builder per spec §6.
- `/api/teams/adaptive-card-action` controller integrated with `ApprovalService.respond`.
- Audit completeness sweep — every transition emits via `audit_outbox`.

**Acceptance (Wave 3 part):** admin can reverse a decision from `/admin/approvals/overrides` with reason captured; original chain reactivates at the timed-out step.

**Acceptance (Wave 4 part):** approver in Teams chat clicks Approve on a card → Prequest registers the decision + the card updates in place identically to the dashboard path.

### Sprint 5 (~3 days): Polish + i18n + a11y audit

- NL + FR + EN strings.
- Keyboard nav across the inbox (j/k = next/prev; e = approve; r = reject; n = need-info).
- A11y: combobox pickers, focus management, aria-live for status updates.
- Onboarding: empty state for first approver use; documentation link.

**Total: ~5-6 weeks.**

---

## 12. Acceptance criteria

1. Admin authors a chain template with 3 steps (cost-center default → manager_chain levels=2 → CFO team) → saves → preview shows the resolved chain for a sample requester with concrete person names → publishes.
2. A €750 catering order with cost_center='4501' triggers the resolver → returns 3-step chain → all 3 approvers get notified → each approves in turn → order proceeds.
3. Approver A is OOO with delegation to Approver B → resolver pre-resolves the step to B → B sees the approval in their inbox; A doesn't → audit captures the delegation.
4. Step 1 times out (24h, no response) → escalation policy `manager_of_approver` fires → step 1's manager gets a fresh approval row → audit captures `approval.escalated`.
5. Approver opens `/desk/approvals` on a phone → sees overdue first → taps a row → detail pane slides in → taps Approve → row removes from list with a 200ms animation.
6. Approver in Teams chat receives an adaptive card → taps Approve → card updates in-place to "Approved by {name}, 2 minutes ago" → backend records the decision identically to the dashboard path.
7. Admin uses `/admin/approvals/overrides` to reopen a recently auto-rejected approval → reason captured → original chain reactivates at the timed-out step → audit captures `approval.overridden`.
8. Batch approve: approver selects 8 compatible orders (same vendor, same cost-center, all <€500) → clicks Approve N → all 8 transition together → 8 audit events emit.
9. "Who approved this booking?" admin query: single audit query against `audit_events WHERE event_type LIKE 'approval.%' AND entity_id = X` returns the full chain in time order.
10. Mobile a11y: keyboard nav (j/k/e/r/n) works on desktop; screen reader announces approval count + status changes.

---

## 13. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Manager-chain cycle (manager_person_id loops) | Low | High | Cycle-detection in `manager_chain` walker; bail out + audit alert |
| Resolver misroutes due to stale cost-center default | Medium | Medium | Resolver pulls cost-center default at chain creation time, not request time; admin docs explicit |
| Escalation worker double-fires | Medium | Medium | Advisory lock + `fired_at IS NULL` predicate; idempotent on re-run |
| Teams card-action signature spoofed | Low | Critical | Verify Bot Framework signature on every action; reject mismatch + log audit; rotate cert via MS Graph dual-cert pattern |
| Approver impersonation via shared device | Low | High | Existing tenant SSO + session timeout; magic-link approve URLs are single-use + 7-day TTL |
| Override surface abused (over-approving without trail) | Medium | High | `approvals.override` permission default off; reason required; audit captured; quarterly review of override events |
| Delegation expires mid-chain causing stuck state | Low | Medium | Pre-resolution at chain creation (delegate baked in); chain durable through delegation expiry |
| Auto-approve escalation hides issues | Medium | Medium | Tenant policy default = `manager_of_approver` not `auto_approve`; explicit opt-in for auto-approve per chain |
| Inbox performance at 10k+ pending approvals per tenant | Low | Medium | Pagination + indexed-status query; warning banner if backlog exceeds threshold |
| Teams adaptive card UI varies by Teams version | Medium | Low | Test matrix (desktop / mobile / web Teams); fallback to plain text + deep-link |

---

## 14. Open questions

1. **Manager-chain cycle handling — bail out or reroute?** Proposed: bail out + escalate to tenant default chain + audit alert. Confirm with first wave-1 customer scenario.
2. **Cost-center default resolution timing — create-time or request-time?** Proposed: create-time (snapshotted into the approval row). Reasoning: admin changes to cost-center defaults shouldn't retroactively change in-flight approvals.
3. **Should approver-of-self automatically skip or require override?** Proposed: skip with audit. Confirm with finance / compliance for high-amount thresholds.
4. **Need-info bounce-back UX — chain pauses indefinitely or has its own timeout?** Proposed: 14-day pause then auto-cancel + audit. Tenant-configurable.
5. **Mobile keyboard shortcuts (j/k/e/r) — also on mobile, or desktop-only?** Proposed: desktop-only; mobile relies on tap.
6. **Email-only approver fallback (when no Teams + no SSO available) — single-use magic link or full session?** Proposed: single-use magic link, 7-day TTL, lands on `/desk/approvals` with the row pre-selected. Delivers parity with Teams card without the spoofing surface.
7. **Auto-approve default for very-low amounts (<€50) — opt-in or opt-out?** Proposed: opt-in tenant setting (default off); when enabled, threshold + approver chain still apply but the chain is "step 1 = auto_decide → auto_approve" for amounts below the line.
8. **Approval analytics dashboard** — Tier 2 separate dashboard? Or fold into reports? Proposed: under `/desk/reports/approvals/{overview,bottlenecks,sla}` to match existing reports pattern. Tier 2.

---

## 15. Out of scope

- External-approver workflows (approvers outside the tenant).
- Email-reply-to-approve.
- Automated approval recommendations (ML-suggested).
- Cross-tenant delegation.
- Approval-chain version history + diff view (Tier 2).
- Approver inbox Slack integration (Slack not in our integration roadmap per memory).

---

## 16. References

- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §G3-G6, §F17.
- [`docs/booking-services-roadmap.md`](../../booking-services-roadmap.md) §9.2.6.
- [`docs/cross-spec-dependency-map.md`](../../cross-spec-dependency-map.md) §13.3.
- [`docs/competitive-benchmark.md`](../../competitive-benchmark.md) §3 "Approvals".
- Sibling specs:
  - [GDPR baseline](2026-04-27-gdpr-baseline-design.md) §3.
  - [Visual rule builder](2026-04-27-visual-rule-builder-design.md).
  - [Vendor portal Phase B](2026-04-27-vendor-portal-phase-b-design.md).
  - [MS Graph integration](2026-04-27-microsoft-graph-integration-design.md) Phase 3-4.
- Memory:
  - `project_industry_mix.md` — cost-center approvals are corporate HQ wedge.
  - `project_routing_stack.md` — approvals orthogonal to routing.
  - `project_no_wave1_yet.md` — strategic context.
  - `feedback_quality_bar_comprehensive.md` — comprehensive scope.
- External:
  - ServiceNow Approval — benchmark for approver inbox + batch approve.
  - Eptura mobile approve — benchmark for mobile UX.
  - Bot Framework Adaptive Cards — Teams approve-in-place reference.

---

**Maintenance rule:** when implementation diverges from this spec, update the spec first then code. When the visual rule builder gains new approval-related effect kinds, register them here in §4 + update the resolver. When adding a new escalation policy, document it in §7 + add a check-constraint update.
