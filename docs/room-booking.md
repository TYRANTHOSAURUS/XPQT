# Room Booking — Operational Reference

This is the living operational reference for the room booking module. Same
mandate as `docs/assignments-routing-fulfillment.md` and `docs/visibility.md`:
**when code in the trigger list below changes, update this doc in the same
PR**. Silent drift is how room-booking bugs hide.

## Mental model — orthogonal axes

The room booking module separates four concerns. Keep them separate when
reasoning about a bug or feature:

1. **Availability** — does the conflict guard let this slot exist? Owned by
   the `reservations.time_range` GiST exclusion constraint and the buffers
   trigger (00122/00123).
2. **Access & policy** — should this requester even be allowed, or be sent
   to approval, or be warned? Owned by `room_booking_rules` (the D engine)
   and `RuleResolverService`.
3. **Execution** — once a booking is confirmed, what side effects fire?
   Notifications, calendar sync push, workflow events. Owned by
   `BookingFlowService` (post-write fan-out) and the cron jobs (auto-release,
   reconcile).
4. **Visibility** — who can see / edit / list reservations they didn't
   create? Owned by `ReservationVisibilityService` (three tiers:
   participant, operator, admin).

When something goes wrong, ask "which axis" first. A booking that won't
save is axis 1 or 2. A booking that saved but didn't notify is axis 3. A
booking that's invisible to the wrong user is axis 4.

## Reservation status — the seven-state model

```
draft               admin/api scratchpad; not on the picker
  ↓
pending_approval    rule effect = require_approval; counts toward the conflict guard
  ↓
confirmed           in the room; counts toward the conflict guard
  ↓
checked_in          requester has acknowledged at start_at; counts toward the conflict guard
  ↓
released            no-show auto-release; FREES the slot
cancelled           soft cancel; FREES the slot
completed           past end_at + grace; counts as historical only
```

The conflict-guard exclusion constraint covers `('confirmed','checked_in',
'pending_approval')`. Other statuses do not block new bookings.

## Booking creation pipeline

`BookingFlowService.create(input, actor)` is the **only** path that writes a
new reservation row. The portal, desk scheduler, calendar-sync intercept,
and recurrence materialiser all funnel through it.

```
1. Snapshot from space:    setup_buffer_minutes, teardown_buffer_minutes,
                           check_in_required, check_in_grace_minutes,
                           cost_per_hour
2. Compute effective time: start_at - setup_buffer  →  effective_start_at
                           end_at + teardown_buffer →  effective_end_at
                           (collapsed to zero when prior or following
                           booking on the same room shares requester_person_id)
3. RuleResolver.resolve(requester, space, time, criteria):
     - load rules where target matches the space's chain
       (room → space_subtree → room_type → tenant)
     - evaluate `applies_when` predicate against booking context
     - sort: specificity desc, then priority desc
     - aggregate effects: deny wins → require_approval → warn → allow
4. If any 'deny' (and not overridden) →
     throw 403 with denial_message + 3 picker alternatives
5. If any 'require_approval'           →
     status='pending_approval', create approvals row(s), fire workflow event
   else                                 →
     status='confirmed'
6. INSERT reservations
   On 23P01 (exclusion violation): never retry; build alternatives and
   return structured 409. The user always sees the alternatives panel.
7. Fan-out side effects:
     - reservation.created event
     - calendar sync push (Outlook outbound)
     - notification dispatch (confirmation email + portal toast)
     - realtime channel publish
```

## Predicate engine

Booking rules use the same predicate language as routing rules and request
type predicates. Helper SQL functions added in 00119:

| Function | Used for |
|---|---|
| `public.in_business_hours(at, calendar_id)` | "off-hours need approval" rules; respects calendar timezone + holidays |
| `public.org_node_descendants(root_id)` | "restrict to org subtree" — returns root + all descendants |
| `public.space_descendants(root_id)` | applying rules whose `target_scope='space_subtree'` |

When adding a new template that needs a new primitive, add a SQL helper
function in a new migration first, then expose it in the predicate engine
service.

## Rule templates (the admin's 95% surface)

12 starter templates ship in v1. Power users can drop into raw predicate
mode for the remaining 5%. The full list lives in
`apps/api/src/modules/room-booking-rules/rule-templates.ts`.

```
restrict_to_roles                       → deny by role allowlist
restrict_to_org_subtree                 → deny by org-node subtree
off_hours_need_approval                 → require_approval outside business hours
min_lead_time / max_lead_time           → deny if lead time outside range
max_duration                            → deny if booking too long
capacity_tolerance                      → over-capacity by factor (deny/warn/approve)
long_bookings_need_manager_approval     → duration over X → approval
high_capacity_needs_vp_approval         → attendees over X → approval
capacity_floor                          → deny if attendees < space.min_attendees
soft_over_capacity_warning              → warn if attendees > space.capacity
service_desk_override_allow             → allow_override for service desk role
```

## Calendar sync (Outlook only in v1)

Two patterns per room. Mode chosen in `spaces.calendar_sync_mode`:

- **Pattern A** (default): Outlook room mailbox exists, auto-accept off,
  Prequest is the calendar processor. Inbound invites flow through the
  intercept pipeline (`RoomMailboxService.handleNotification`) which calls
  the same `BookingFlowService.create` as the portal — rules and conflict
  guard run on every invite regardless of source.
- **Pattern B**: no Outlook room mailbox. Only the portal/desk creates
  bookings; Prequest writes the meeting to the user's personal calendar
  with the room as free-text `location`.

Reconciliation policy: **Prequest is authoritative**. Outlook attempts
that conflict with Prequest rules or with another booking are rejected
with the rule's `denial_message` written into the user's Outlook decline
email — the self-explaining differentiator extends across both surfaces.

The `room_calendar_conflicts` table is the conflicts inbox; admins resolve
unrecoverable cases via `/admin/calendar-sync/conflicts`. Healthy
deployments see this table empty.

## Recurrence

Each occurrence is a separate `reservations` row linked by
`recurrence_series_id`. The series row in `recurrence_series` carries the
recurrence rule, holiday calendar, and `materialized_through` rolling
window cap. `recurrenceRollover` cron extends the materialized horizon
nightly.

Edit semantics:

- **Edit this occurrence** — flip `recurrence_overridden=true` on the row,
  apply patch, leave others intact.
- **Edit this and following** — split the series at this occurrence: new
  series_id for the rest, new recurrence_rule.
- **Edit entire series** — patch the series row, then either re-materialise
  (if pattern changed) or apply per-row patches (if only metadata).
- **Skip occurrence** — flip `recurrence_skipped=true`, status='cancelled'.

Edits always show **impact preview** before commit: how many future
occurrences are affected, whether any of them now conflict, with options
to skip/find-alternative/cancel-series.

## Visibility tiers

Reservations are not tickets. Three tiers:

1. **Participant** — `requester_person_id`, anyone in `attendee_person_ids[]`,
   or `booked_by_user_id`. Implicit read of own data.
2. **Operator** — `rooms.read_all` permission OR a per-site grant. Reads
   across requesters but cannot edit.
3. **Admin** — `rooms.admin` permission. Full read + write + rule mgmt.

`ReservationVisibilityService.loadContext` caches per-request; the
controller injects `WHERE` clauses via `filterIds(ctx)` to avoid N+1.

## Background jobs

| Job | Cadence | Purpose |
|---|---|---|
| `autoReleaseScan` | every 5 min | flip uncheckedin → released; emits self-explaining release email |
| `checkInRemindersScan` | every 5 min | send reminder + magic-link 5 min before start |
| `recurrenceRollover` | nightly (3 am) | extend `materialized_through` for active series, capped 100 occurrences/tick |
| `outlookSyncPoll` | every 5 min | pull deltas from Microsoft Graph for active links |
| `outlookWebhookRenew` | hourly | renew Graph webhook subscriptions before expiry |
| `roomMailboxWebhookRenew` | hourly | renew Pattern-A room mailbox webhooks |
| `calendarHeartbeatReconcile` | hourly | per-room diff against Outlook calendar; raise drift |
| `cancellationGraceCleanup` | hourly | clear past-due `cancellation_grace_until` |
| `impactPreviewWarmer` | nightly | precompute aggregate stats for rule analytics |

Cron registrations live alongside their owning service (`CheckInService`,
`RecurrenceService`, `BookingNotificationsService`, `WebhookRenewalService`,
`ReconcilerService`).

## Notifications

The `BookingNotificationsService` is the single seam for booking-lifecycle
notifications. Each event maps to a `notification_type`:

| Trigger | notification_type | Audience |
|---|---|---|
| `BookingFlowService.create` (status='confirmed') | `reservation_created` | requester |
| `BookingFlowService.create` (status='pending_approval') | `reservation_approval_requested` | approvers |
| Approval decided (Phase J) | `reservation_approved` / `reservation_rejected` | requester |
| `ReservationService.cancelOne` | `reservation_cancelled` | requester |
| `CheckInService.autoReleaseScan` flips → released | `reservation_released` | requester (self-explaining) |
| `BookingNotificationsService.checkInRemindersScan` (T-5 min) | `reservation_check_in_reminder` | requester (with magic link) |

The release email is the differentiator (spec §12): tells the user *why* (no
check-in within grace), with deep-links to rebook this slot or see
alternatives.

## Magic-link check-in

Endpoint: `POST /reservations/:id/check-in/magic?token=<HMAC>` — `@Public()`.

Token shape (URL-safe base64): `${reservation_id}.${requester_person_id}.${expiry_ms}.${HMAC-SHA256}`

- Signed with `CHECK_IN_MAGIC_SECRET` env var.
- 30-minute expiry; mismatch / signature-fail / expired all reject with 400.
- Verifier asserts that the token's `requester_person_id` matches the
  reservation's `requester_person_id`, so a token can't be reused on another
  booking even if the IDs were swapped in the URL.

The reminder email includes this link so users can check in without logging
in. See `apps/api/src/modules/reservations/magic-check-in.token.ts`.

## Outlook intercept (Pattern A)

Wired in `ReservationsModule.onModuleInit` via
`RoomMailboxService.registerIntercept`. The handler:

1. Resolves `draft.organizer_email` → `persons.id` (case-insensitive `ilike`,
   tenant-scoped). Unknown organizer → `{ outcome: 'denied', denialMessage: 'Organizer email is not a registered Prequest user.' }`.
2. Resolves attendees the same way; missing emails are dropped silently
   from the internal-attendee list.
3. Calls `BookingFlowService.create` with `source='calendar_sync'` and a
   synthetic actor (no override).
4. Maps booking outcome → intercept outcome:
   - success → `{ outcome: 'accepted' }`
   - `ForbiddenException` (rule deny) → `{ outcome: 'denied', denialMessage }`
   - `ConflictException` (slot taken) → `{ outcome: 'conflict' }`
   - any other error → `{ outcome: 'deferred' }` (audit + retry on next tick)

The `RoomMailboxService` then writes accept/reject back to the room calendar.

## MANDATORY — keep this doc in sync

Trigger files. **If a change touches any of the below, update this doc in
the same commit / PR**:

Backend:
- `apps/api/src/modules/reservations/**`
- `apps/api/src/modules/room-booking-rules/**`
- `apps/api/src/modules/calendar-sync/**`
- `apps/api/src/modules/floor-plans/**`

Frontend:
- `apps/web/src/pages/portal/book/room/**`
- `apps/web/src/pages/portal/me/bookings/**`
- `apps/web/src/pages/desk/scheduler/**`
- `apps/web/src/pages/admin/room-booking-rules/**`
- `apps/web/src/pages/admin/calendar-sync/**`
- `apps/web/src/api/room-booking/**`
- `apps/web/src/api/room-booking-rules/**`
- `apps/web/src/api/calendar-sync/**`

Migrations — any add/alter of:

- `reservations`, `recurrence_series`, `room_booking_rules`,
  `room_booking_rule_versions`, `multi_room_groups`,
  `calendar_sync_links`, `calendar_sync_events`,
  `room_calendar_conflicts`, `floor_plans`,
  `room_booking_simulation_scenarios`.
- `spaces` columns related to booking config (`min_attendees`,
  buffers, check-in, calendar sync mode, floor_plan_polygon, etc.).
- `business_hours_calendars` if the working_hours / holidays jsonb shape
  changes — the `in_business_hours` helper depends on it.

When this doc and the code disagree, **fix this doc first, then align the
code to the corrected doc**.

## Related

- Design spec: [`docs/superpowers/specs/2026-04-25-room-booking-foundation-design.md`](./superpowers/specs/2026-04-25-room-booking-foundation-design.md)
- Module decomposition: [`docs/superpowers/specs/2026-04-25-room-booking-module-decomposition.md`](./superpowers/specs/2026-04-25-room-booking-module-decomposition.md)
- North-star blueprint: [`docs/workplace-booking-and-visitor-blueprint-2026-04-21.md`](./workplace-booking-and-visitor-blueprint-2026-04-21.md)
