# SLA Escalation Thresholds — Design

**Date:** 2026-04-20
**Status:** Draft — awaiting user review
**Scope:** Turn `sla_policies.escalation_thresholds` from a dead-weight jsonb stub into a live feature that notifies users/teams and reassigns tickets when an SLA timer crosses a configured percent.

---

## 1. Context

The SLA subsystem already tracks response and resolution timers with business-hours-aware pause/resume, a minute-cron that flips `sla_at_risk` and `sla_*_breached_at` on tickets, and stores `escalation_thresholds` on each policy as a jsonb array. The admin UI lets operators add rows shaped `{ at_percent, action: 'notify' | 'escalate', notify: string }`.

None of that data is read by the backend. `grep -i escalat apps/api` returns zero matches. The "Escalate" action is inert and the target is a free-text email field with no resolver. This design wires the feature up end-to-end.

## 2. Goals and non-goals

**Goals**

- When an SLA timer reaches a configured percent, fire the configured action exactly once per timer.
- `notify` sends a notification (email + in-app, subject to user preferences) to a structured target: user, team, or the requester's manager.
- `escalate` reassigns the ticket to the target and preserves the previous assignee as a watcher, then notifies.
- Full audit trail of every threshold crossing, queryable per-ticket for operators and per-policy for future SLA analytics.
- Admin UX that reads as a sentence and eliminates the current "No escalation thresholds" footgun (blank draft row that never gets committed on Save).

**Non-goals (deferred)**

- Per-request-type policy overrides.
- Workflow-engine-driven escalations (the workflow engine is orthogonal).
- Notification templates (handoff point exists at `NotificationService.send`; template_id can be threaded through later without changing this feature's data shape).
- Policy versioning (tracked in the competitive gap doc as a separate initiative).
- Per-tenant fairness in the cron (scale optimization).
- Role-based / manager-of-assignee / external-email targets.

## 3. User-facing behavior

### 3.1 Admin — SLA policy dialog

Each threshold row reads as a sentence:

> `At [80] of [Resolution] → [Notify] [User] [Sarah Chen]`
> `At [100] of [Resolution] → [Escalate] [Team] [Facilities Tier 2]`
> `At [120] of [Resolution] → [Notify] [Requester's manager]`

`Escalate` is labelled `Escalate (reassign)` to make the semantic obvious. Target selector is a two-step control: target-type Select, then a picker appropriate to the type (`PersonCombobox` for user, team `Select` for team, nothing for `manager_of_requester`).

Adding rows: a single `Add threshold` button appends a row with defaults (`100 / resolution / notify / user / null`). No ghost draft row; the row inline *is* the row being edited. Removing rows: trash icon at the end.

Validation is per-row via `<FieldError>`. Save is blocked if any row has an invalid percent (outside 1-200) or missing target. Save writes the array via the existing `PATCH /sla-policies/:id`.

All form primitives use shadcn `Field`/`FieldSet`/`FieldLegend`/`FieldGroup` per project form rules.

### 3.2 Desk — ticket detail

The SLA panel grows a compact "Escalations" section that only renders when the ticket has at least one crossing. Each line:

> `2026-04-20 10:14 — Response 80% → Notified Sarah Chen`
> `2026-04-20 14:02 — Resolution 100% → Escalated to Facilities Tier 2`
> `2026-04-20 16:30 — Resolution 120% — skipped (no manager on record)`

`escalate` actions additionally write a `ticket_activities` entry so the main timeline surfaces them. `notify` actions do not write a ticket_activities entry (too noisy for the timeline).

## 4. Data model

### 4.1 Threshold shape (inside `sla_policies.escalation_thresholds`)

```json
{
  "at_percent": 80,
  "timer_type": "response" | "resolution" | "both",
  "action": "notify" | "escalate",
  "target_type": "user" | "team" | "manager_of_requester",
  "target_id": "uuid | null"
}
```

- `at_percent` is 1-200 (inclusive). Below 100 = warning; 100 = at-breach; above 100 = post-breach escalation.
- `target_id` is required unless `target_type === 'manager_of_requester'`.
- `(at_percent, timer_type)` is unique per policy.

### 4.2 New table: `sla_threshold_crossings`

```sql
create table public.sla_threshold_crossings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  sla_timer_id uuid not null references public.sla_timers(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  at_percent integer not null check (at_percent between 1 and 200),
  timer_type text not null check (timer_type in ('response', 'resolution')),
  action text not null check (action in ('notify', 'escalate', 'skipped_no_manager')),
  target_type text not null,
  target_id uuid,
  notification_id uuid references public.notifications(id),
  fired_at timestamptz not null default now(),
  unique (sla_timer_id, at_percent, timer_type)
);

alter table public.sla_threshold_crossings enable row level security;
create policy "tenant_isolation" on public.sla_threshold_crossings
  using (tenant_id = public.current_tenant_id());

create index idx_sla_crossings_timer on public.sla_threshold_crossings (sla_timer_id);
create index idx_sla_crossings_ticket on public.sla_threshold_crossings (ticket_id, fired_at desc);
```

### 4.3 New partial index on `sla_timers`

```sql
create index idx_sla_timers_active on public.sla_timers (tenant_id)
  where breached = false and paused = false and completed_at is null;
```

### 4.4 One-time migration of legacy threshold rows

Existing rows in `sla_policies.escalation_thresholds` use the old `{ at_percent, action, notify: string }` shape. Migration drops rows without a structured target — admins reconfigure via the new UI. A seeded test row on the "Standard" policy (added during design for verification) is cleaned up by the migration.

## 5. API

### 5.1 `POST /sla-policies` and `PATCH /sla-policies/:id`

Accept the new `escalation_thresholds` shape. Validation is added to `SlaPolicyController` (direct checks, `BadRequestException` — consistent with the rest of this codebase):

- `at_percent` integer in [1, 200]
- `timer_type` ∈ {`response`, `resolution`, `both`}
- `action` ∈ {`notify`, `escalate`}
- `target_type` ∈ {`user`, `team`, `manager_of_requester`}
- If `target_type !== 'manager_of_requester'` → `target_id` must be a valid uuid and resolve to a tenant-scoped `persons` (for user) or `teams` (for team) row; else 400.
- If `target_type === 'manager_of_requester'` → `target_id` must be null; else 400.
- Duplicate `(at_percent, timer_type)` within the array is 400.

### 5.2 `GET /sla/tickets/:ticketId/crossings`

New endpoint. Returns `sla_threshold_crossings` for the ticket, ordered by `fired_at desc`. Each row is enriched with the target's resolved name (joined via `persons.full_name` / `teams.name` depending on `target_type`). Tenant-scoped. Visibility check via `TicketVisibilityService.assertVisible`.

Response shape (`target_id`, `target_name`, and `notification_id` are null for `action = 'skipped_no_manager'`):

```json
[{
  "id": "uuid",
  "fired_at": "2026-04-20T10:14:03Z",
  "timer_type": "response",
  "at_percent": 80,
  "action": "notify",
  "target_type": "user",
  "target_id": "uuid | null",
  "target_name": "string | null",
  "notification_id": "uuid | null"
}]
```

## 6. Engine

Extends `SlaService.checkBreaches` in `apps/api/src/modules/sla/sla.service.ts`. Order of passes in the minute-cron: breach → at-risk → threshold-crossing. The threshold pass sees breach updates from the same tick, so "at 100%, escalate" fires in the same minute the timer breaches.

### 6.1 Threshold pass

1. Fetch up to 500 active timers (`breached = false and paused = false and completed_at is null`), ordered by `due_at asc`. Cap prevents one busy tenant from starving the batch; remaining work picks up on the next tick.
2. Load `escalation_thresholds` for all referenced policies in one query; cache as `Map<policyId, Threshold[]>` for the tick.
3. Fetch existing crossings for the batch's timers in one query; build `Set<"${timerId}|${pct}|${timerType}">`.
4. For each timer, compute `percentElapsed` using the same formula the existing at-risk pass uses (`(now - started_at) / (due_at - started_at) * 100`). This is pause-aware by construction — `due_at` is shifted on each resume to absorb paused business minutes — and business-hours-aware via the shifts applied by `BusinessHoursService`. Keeping one formula avoids drift between at-risk and threshold firing.
5. Filter policy thresholds to those where: timer type matches (or is `both`), `percentElapsed >= at_percent`, and the crossing key is not in the fired set.
6. For each matched threshold, fire sequentially per timer (ordering matters if multiple cross in one tick):
    - **Resolve target.**
      - `user` → `persons.id = target_id`.
      - `team` → `teams.id = target_id`.
      - `manager_of_requester` → `persons.manager_person_id` for the ticket's `requester_person_id`. If null, write a crossing with `action = 'skipped_no_manager'` and skip the rest of this step. This fills the unique slot so we never retry.
    - **Action = notify:** call `NotificationService.send({ notification_type: 'sla_threshold_crossed', recipient_person_id | recipient_team_id, related_entity_type: 'ticket', related_entity_id: ticket_id, subject, body })`. Inline copy per §3. Capture the returned notification id (first row).
    - **Action = escalate:** reassign the ticket.
      - Target is `user` / `manager_of_requester` → `assigned_user_id = target_person.id`. `assigned_team_id` unchanged.
      - Target is `team` → `assigned_team_id = target_team.id`, `assigned_user_id = null`.
      - Previous `assigned_user_id` (if any, and if different from the new assignee) is appended to `tickets.watchers`.
      - Write a `ticket_activities` entry: `"SLA escalated — {policy.name} at {at_percent}% of {timer_type}"`.
      - Also call `NotificationService.send` to the new assignee.
      - If the target already equals the current assignment, skip the reassignment and the activity entry but still send the notification and write the crossing (respect admin intent).
    - **Write the crossing row** with resolved `target_id` and captured `notification_id`. DB `unique (sla_timer_id, at_percent, timer_type)` is the last line of defence against races; on `23505`, swallow.
    - **Emit `domain_events`** row: `{ event_type: 'sla_threshold_crossed', entity_type: 'ticket', entity_id: ticket_id, payload: { timer_type, at_percent, action, target_type, target_id } }`.
7. Wrap each timer in a try/catch. On error: emit `sla_threshold_fire_failed` with the error and skip without writing a crossing (so the next tick can retry if the underlying condition self-healed).

### 6.2 Pause/resume interaction

`percentElapsed` is computed from business-minutes-elapsed, which the existing pause/resume logic already handles by shifting `due_at` and tracking `total_paused_minutes`. No special handling needed in the threshold pass.

### 6.3 Policy edited after timer started

Thresholds fire against the *current* policy definition. Removing a threshold stops future fires; adding one fires on the next tick if the timer is already past the configured percent. Policy versioning is tracked separately in the gap doc.

## 7. Notifications

Reuses `NotificationService.send` / `sendToTeam` (`apps/api/src/modules/notification/notification.service.ts`). Respects `notification_preferences`.

- `notification_type`: `sla_threshold_crossed`
- Subject: `[Ticket #{ticket.number}] SLA {timer_type} at {at_percent}%`
- Body: `Ticket "{ticket.title}" has reached {at_percent}% of its {timer_type} SLA ({policy.name}). {action_verb} {target_name}. Target: {due_at}.`
- `related_entity_type: 'ticket'`, `related_entity_id: ticket.id`

Team targets fan out via `NotificationService.sendToTeam`.

## 8. Observability

Every fire produces four audit surfaces, any of which is sufficient to reconstruct what happened:

- `sla_threshold_crossings` row (positive idempotency record).
- `domain_events` row (`sla_threshold_crossed` or `sla_threshold_fire_failed`).
- `notifications` rows (delivery record per channel).
- `ticket_activities` row for `escalate` fires (visible in the desk timeline).

## 9. Error handling and edge cases

| Case | Behavior |
| --- | --- |
| Per-timer exception during fire | Logged, `sla_threshold_fire_failed` event emitted, no crossing row written (next tick retries). |
| Two cron ticks try to fire the same crossing | DB `unique` rejects the second; app catches `23505` and swallows. Double-notification possible in rare race — acceptable. |
| Target already equals current assignment | `notify` still fires; `escalate` skips the reassign but writes the crossing + event. |
| Policy edited after timer started | Fires against current definition; thresholds removed never fire; thresholds added fire on next applicable tick. |
| `manager_of_requester` with no manager | Crossing row written with `action = 'skipped_no_manager'`, `target_id = null`. Rendered as muted line in the ticket's SLA history. Never retries (unique constraint). |
| Team with no members | `sendToTeam` yields zero notifications — harmless. |
| Active timers exceed 500 per tick | Cap applies; remaining drain on subsequent ticks. Fairness across tenants is adequate because ordering is `due_at asc` and the cap is large relative to expected scale. |

## 10. Testing

- **Unit — engine:** `sla.service.spec.ts` covering: single threshold fires once; `timer_type: both` fires on both timer types; `manager_of_requester` with no manager writes `skipped_no_manager`; DB-level double-insert returns cleanly; pause/resume respected via mocked `BusinessHoursService`.
- **Unit — validation:** `sla-policy.controller.spec.ts` for reject paths (invalid percent, missing target, duplicates).
- **Integration smoke:** seed a policy with one threshold; create a ticket; advance `sla_timers.started_at` so `percentElapsed >= threshold.at_percent`; run one `checkBreaches` tick; assert crossing + notification rows exist.
- **Frontend:** no component tests (Vitest/RTL not wired in this repo yet). Typecheck + manual smoke script in the PR body.

### Manual smoke checklist (for PR)

1. Policy with `80% / response / notify / user @me`; create a ticket linked to it; advance timer; confirm the notification lands within a minute.
2. `100% / resolution / escalate / team Facilities L2`; confirm `assigned_team_id` changes, `assigned_user_id` is nulled, the old assignee is in `watchers`, and a `ticket_activities` entry shows "SLA escalated".
3. `120% / resolution / notify / manager_of_requester` on a requester whose `persons.manager_person_id` is null; confirm the skipped crossing shows up in the ticket's SLA history with the "no manager" copy.

## 11. Files touched (inventory)

**New**

- `supabase/migrations/00043_sla_threshold_crossings.sql` — table + indexes + partial index on `sla_timers` + one-time legacy-threshold cleanup.
- `apps/web/src/components/admin/sla-threshold-row.tsx` — inline horizontal row editor, reusable.

**Modified**

- `apps/api/src/modules/sla/sla.service.ts` — threshold pass inside `checkBreaches`; new private helpers for target resolution, per-action execution, crossing write.
- `apps/api/src/modules/sla/sla-policy.controller.ts` — threshold validation on `POST` / `PATCH`.
- `apps/api/src/modules/sla/sla.controller.ts` — new `GET /tickets/:id/sla-crossings`, delegated to `SlaService`.
- `apps/api/src/modules/sla/sla.module.ts` — wire in `NotificationService`, `TicketVisibilityService` if not already imported.
- `apps/web/src/pages/admin/sla-policies.tsx` — replace draft-row pattern with list-of-rows editor; call `<SlaThresholdRow>` per entry.
- `apps/web/src/pages/desk/ticket-detail.tsx` (or current ticket-detail entry point) — SLA panel gets the "Escalations" section.

Tests:

- `apps/api/src/modules/sla/sla.service.spec.ts`
- `apps/api/src/modules/sla/sla-policy.controller.spec.ts`

## 12. Rollout

1. Merge and deploy; new `escalation_thresholds` rows are inert until the first cron tick reads them (≤1 min after deploy).
2. Apply the migration (cleans up legacy rows, adds the crossings table + partial index).
3. Admins reconfigure escalations via the new UI.
4. No feature flag — behavior only activates for policies that have thresholds, which are opt-in per policy.
