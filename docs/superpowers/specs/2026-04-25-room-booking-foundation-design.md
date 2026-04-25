# Room Booking Foundation — Design (Sub-project 1)

Date: 2026-04-25

Related docs:
- [Room Booking Module — Decomposition](./2026-04-25-room-booking-module-decomposition.md) — the umbrella that places this slice in the broader module track
- [Workplace Booking & Visitor Blueprint](../../workplace-booking-and-visitor-blueprint-2026-04-21.md) — north-star product shape
- [Spec](../../spec.md) — main product specification

## Goal

Ship the **rooms foundation** — a complete employee + service-desk experience for booking meeting rooms, desks, and parking — that is **best in class**, not lean. The foundation everything in the workplace-booking module track builds on (linked services, visitors, reception, notifications, calendar mirroring) without painting future slices into corners.

## Scope at a glance

In:
- Reservations schema upgraded with conflict guard, buffers, check-in, expanded status, policy snapshot, source.
- Predicate-driven booking rules engine (`room_booking_rules`) with template-first authoring, simulation, impact preview, self-explaining denials, audit/versioning.
- Portal hybrid-C booking flow (criteria bar + ranked candidates with mini-timelines).
- Desk calendar-first scheduler (rooms-as-rows grid with drag interactions, book-on-behalf, override-with-reason).
- Admin rule editor + room booking config + floor-plan editor.
- Required check-in with auto-release.
- Recurrence (practical patterns, materialised rows, edit-this/this-and-following/series with impact preview).
- Multi-attendee scheduling for internal personnel.
- Multi-room atomic bookings (rooms-only, no bundle yet).
- Microsoft Graph (Outlook) calendar sync — Pattern A (resource delegation) and Pattern B (Prequest-only rooms). Google not in v1.
- Realtime availability updates via Supabase Realtime.
- Smart room ranking and floor-plan picker view.
- Minimum notification set: confirmation, cancellation, check-in reminder, auto-release notice, approval requested/decided.
- Audit + observability + perf budgets verified.

Out (locked seams in §13 Non-scope below): `booking_bundles`, visitors, linked services/orders, reception board, host workspace, workflow versioning, badge/access integrations, building-map view, booking templates, chargeback admin/reports, external-org/rentee identity model, Google Calendar.

## Locked decisions (quick reference)

| Decision | Choice |
|---|---|
| Primary booking flow | Portal **hybrid C** (criteria bar + ranked candidates with mini-timelines); desk **calendar-first B+** (grid scheduler) |
| Access & rule model | **D — predicate-based**, plugged into the existing predicate engine, with template-first authoring |
| Rule effects | `deny`, `require_approval`, `allow_override`, `warn` |
| Rule scope targets | `room`, `room_type`, `space_subtree`, `tenant` |
| Best-in-class differentiators on rules | (1) templates UI, (2) simulation/dry-run, (3) impact preview against last-30-days, (4) self-explaining denials in portal + Outlook |
| Time slot granularity | Free at data layer; snapped to 15-min in default UI; per-tenant configurable |
| Conflict guard | DB-level `EXCLUDE USING gist (tenant_id, space_id, time_range)` with btree-gist; never retry server-side; loser of race sees inline alternatives |
| Buffers | Per-room `setup_buffer_minutes` + `teardown_buffer_minutes`; included in conflict-guard window; same-requester back-to-back collapses buffer to zero |
| Recurrence | Practical patterns (daily/weekly/monthly + interval + by-day); materialised occurrence rows linked by `recurrence_series_id`; edit-this / edit-this-and-following / edit-series with impact preview; max 12 months / 365 occurrences caps; holiday-skip via tenant calendar |
| Check-in | Required-with-auto-release **per-room** (`check_in_required` + `check_in_grace_minutes`); flips status to `released`; self-explaining release notification |
| Reservation status | `draft`, `pending_approval`, `confirmed`, `checked_in`, `released`, `cancelled`, `completed` |
| Cancellation | Soft (`status='cancelled'`) with `cancellation_grace_until` for restore affordance; recurrence prompt: this / this-and-following / series with impact preview |
| External attendees | Count only in v1 (`attendee_count`). Names/emails are sub-project 3's domain |
| Internal attendees | `attendee_person_ids[]` for multi-attendee scheduling and find-time |
| Multi-room | `multi_room_groups` table; atomic create of N rooms in one transaction; same time, same requester |
| Calendar sync mode | **Pattern A** (default — Outlook room mailbox with auto-accept off, Prequest as processor, webhook-intercept); **Pattern B** (Prequest-only — no calendar resource). Pattern C ("best-effort drift") not shipped. Microsoft Graph only |
| Reconciliation policy | **Prequest authoritative** for room slots; Outlook attempts that conflict with Prequest rules are rejected with the rule's `denial_message` written to the user's Outlook |
| "Book on behalf" | Service desk + assistants via `rooms.book_on_behalf` permission; audit tracks actor (`booked_by_user_id`) vs requester |
| "Override rules" | Service desk via `rooms.override_rules` permission; mandatory reason, high-visibility audit |
| Realtime | Supabase Realtime channels per (tenant, space) and per (tenant, user); 200 ms client debounce |
| Smart suggestions / ranking | Score = criteria match + distance to requester's `default_location` + team affinity + capacity fit + utilisation balance; reasons surfaced inline ("Used by your team 6× this month") |
| Floor-plan picker | Toggle on portal picker; per-floor SVG with rooms as polygons coloured by availability |
| Chargeback | **Schema seam only** — `spaces.cost_per_hour`, `reservations.cost_amount_snapshot`. No admin UI / no reports. Sub-project 6 owns chargeback |
| Sub-tenant / external-org / rentee | Out of v1 entirely. Future sub-project owns the identity model |

## 1 · Architecture & boundaries

### 1.1 What this slice is

A complete employee + service-desk room-booking experience layered over Prequest's existing platform primitives (spaces, persons, predicate engine, approvals, audit, notification engine, Supabase Realtime).

### 1.2 Codebase placement

```
apps/api/src/modules/
  reservations/                    ← module of record for bookings (upgraded)
    reservation.service.ts           CRUD, status transitions, cancel/restore, edit semantics
    reservation.controller.ts        REST endpoints
    booking-flow.service.ts          orchestrates create-booking pipeline (snapshot → resolve → conflict → write → events)
    list-bookable-rooms.service.ts   the picker query (rules + availability + criteria + ranking)
    ranking.service.ts               smart suggestions
    conflict-guard.service.ts        race handling + alternatives lookup on 23P01
    multi-attendee.service.ts        find-time across internal attendees
    multi-room.service.ts            atomic group create
    check-in.service.ts              + auto-release scheduler
    reservation-visibility.service.ts three-tier visibility (participant, operator, admin)
    recurrence.service.ts            expander, materialiser, rollover cron, edit semantics
  room-booking-rules/                ← new module: rules + simulation + impact preview
    room-booking-rules.service.ts
    room-booking-rules.controller.ts
    rule-resolver.service.ts         given (user, room, time, criteria) → matched rules + effect
    rule-templates.ts                12 starter templates + predicate compilers
    simulation.service.ts            saved scenarios + dry-run runner
    impact-preview.service.ts        "this rule would have changed N bookings in last 30d"
  calendars/                          ← new (small): tenant calendars (business hours, holidays)
  calendar-sync/                      ← Microsoft Graph adapter + reconciliation
    outlook-sync.adapter.ts
    room-mailbox.service.ts          intercepts inbound invites; runs booking pipeline; replies on the room calendar
    reconciler.service.ts            heartbeat reconciliation + conflicts inbox
    sync-health.controller.ts        admin sync-health page data
  floor-plans/
  predicate-engine/                   ← already exists; reused

apps/web/src/
  pages/portal/book/room/             hybrid C picker (list + floor plan view)
  pages/portal/me/bookings/           list + drawer + check-in + restore
  pages/desk/scheduler/               calendar-grid scheduler (drag interactions, book-on-behalf, override)
  pages/admin/rooms/                  reservability + buffers + check-in + cost stub + smart-suggestion keywords + floor-plan polygon editor
  pages/admin/floor-plans/            upload + manage floor plan images
  pages/admin/room-booking-rules/     index + detail per index+detail mandate
  pages/admin/calendars/              tenant calendars (business hours, holidays)
  pages/admin/calendar-sync/          sync health page + conflicts inbox
  api/room-booking/                   React Query keys (per react-query-guidelines.md)
  api/room-booking-rules/
  api/calendar-sync/
```

### 1.3 Relationships to existing modules

| Existing | Relationship |
|---|---|
| `spaces` | Source of truth for rooms; v1 adds operational columns (`min_attendees`, buffers, check-in, cost stub, calendar sync mode + ids, smart-suggestion keywords, default calendar). Hierarchy untouched. |
| `persons` / `users` / `roles` | Predicate engine consumes existing identity context. New permissions added: `rooms.read`, `rooms.read_all`, `rooms.admin`, `rooms.book_on_behalf`, `rooms.override_rules`. |
| `org_nodes` | Predicate engine uses existing subtree expansion. Untouched. |
| `approvals` | When a rule's effect is `require_approval`, we create rows in the existing `approvals` table; no new approval engine. |
| `predicate-engine` | Consumed via existing service; we add room-booking-specific helper functions (`in_business_hours`, `descendants_of`, etc.). |
| `audit_events` | Booking lifecycle + rule changes + overrides write to the existing audit table. Rule history mirrored to `room_booking_rule_versions` for diff viewing. |
| `tickets` / `routing` | **Untouched.** Bookings are a separate domain. |
| `workflow-engine` | We fire domain events (`reservation.*`); no workflow templates ship in v1. |
| `notification-engine` | Existing transport; we wire booking-related notification types. |
| Supabase Realtime | Used for live picker / scheduler / my-bookings updates. |

### 1.4 Multi-surface contract

```
                  reservations  +  recurrence_series  (DB)
                  conflict guard · buffers · status
                            ▲
        ┌───────────────────┼───────────────────────┐
        │                   │                       │
  Portal hybrid-C    Desk calendar grid       Admin rules + sims
  booking flow       (book-on-behalf)         + conflicts inbox
        │                   │                       │
        └────── shared ─────┴──────── shared ───────┘
            list_bookable_rooms  +  rule-resolver
                          │
                    predicate-engine (existing)
```

The three surfaces share two backend services (`list_bookable_rooms` and the rule resolver). No surface gets a unique pipeline that bypasses rules or the conflict guard.

### 1.5 Data flow — booking creation (the canonical pipeline)

```
1. Client (portal, desk, or Outlook intercept) → POST /reservations  /reservations/dry-run
2. BookingFlowService.create(input, actor)
     a. Snapshot from space:        buffers, check-in policy, cost
     b. Effective time range:       [start - setup, end + teardown]
                                    (collapsed for same-requester back-to-back)
     c. RuleResolver.resolve(...)
        → rules matched by scope (room → room_type → space_subtree → tenant)
        → predicate engine evaluates each
        → outcome: deny | require_approval | warn | allow_override | (none)
     d. If any 'deny' (and not overridden) → throw 403 with denial_message + 3 alternatives
     e. If any 'require_approval'           → status='pending_approval'; create approvals row; fire event
                Else                         → status='confirmed'
     f. INSERT reservations          ← exclusion constraint catches races
        On 23P01: ConflictGuard.parseRaceError → friendly_alternatives → 409
        (No server-side retry. The user always sees the alternatives.)
     g. Fire workflow events:        reservation.created (+approval_requested if applicable)
     h. Enqueue side effects:        notify, calendar sync push, realtime channel publish
3. Response to client:
     { reservation, applied_rule_ids, policy_snapshot,
       calendar_sync_status: 'pending' }
```

## 2 · Database schema

### 2.1 Calendars (new — shared primitive shipping first)

```sql
-- Migration 00119_calendars.sql
CREATE TABLE public.calendars (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id),
  name            text NOT NULL,
  timezone        text NOT NULL,
  business_hours  jsonb NOT NULL,    -- { mon: [{start: "08:00", end: "18:00"}], tue: [...], ... }
  holiday_dates   date[] NOT NULL DEFAULT '{}',
  is_default      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.calendars ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.calendars
  USING (tenant_id = public.current_tenant_id());
CREATE INDEX idx_calendars_tenant_default ON public.calendars (tenant_id, is_default);
CREATE TRIGGER set_calendars_updated_at BEFORE UPDATE ON public.calendars
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Predicate-engine helper:
CREATE OR REPLACE FUNCTION public.in_business_hours(at timestamptz, calendar_id uuid)
  RETURNS boolean LANGUAGE sql STABLE AS $$
  -- evaluates `at` against the calendar's business_hours and holiday_dates;
  -- timezone-aware via the calendar's timezone column
  SELECT … ;
$$;
```

### 2.2 Spaces — operational config additions

```sql
-- Migration 00120_spaces_room_booking_columns.sql
ALTER TABLE public.spaces
  ADD COLUMN IF NOT EXISTS min_attendees                            int,
  ADD COLUMN IF NOT EXISTS setup_buffer_minutes                     int      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS teardown_buffer_minutes                  int      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS check_in_required                        boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS check_in_grace_minutes                   int      NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS cost_per_hour                            numeric(10,2),    -- chargeback stub
  ADD COLUMN IF NOT EXISTS default_calendar_id                      uuid REFERENCES public.calendars(id),
  ADD COLUMN IF NOT EXISTS default_search_keywords                  text[]   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS calendar_sync_mode                       text     NOT NULL DEFAULT 'pattern_a'
                                                                     CHECK (calendar_sync_mode IN ('pattern_a','pattern_b')),
  ADD COLUMN IF NOT EXISTS external_calendar_id                     text,
  ADD COLUMN IF NOT EXISTS external_calendar_provider               text     CHECK (external_calendar_provider IN ('outlook')),
  ADD COLUMN IF NOT EXISTS external_calendar_subscription_id        text,
  ADD COLUMN IF NOT EXISTS external_calendar_subscription_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS external_calendar_last_full_sync_at      timestamptz,
  ADD COLUMN IF NOT EXISTS floor_plan_polygon                       jsonb;          -- shape on parent floor's plan
```

### 2.3 Room booking rules + versions

```sql
-- Migration 00121_room_booking_rules.sql
CREATE TABLE public.room_booking_rules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES public.tenants(id),
  name                text NOT NULL,
  description         text,
  target_scope        text NOT NULL CHECK (target_scope IN ('room','room_type','space_subtree','tenant')),
  target_id           uuid,                                  -- null when target_scope='tenant'
  applies_when        jsonb NOT NULL,                        -- predicate
  effect              text NOT NULL CHECK (effect IN ('deny','require_approval','allow_override','warn')),
  approval_policy_id  uuid REFERENCES public.approval_policies(id),
  denial_message      text,                                  -- self-explaining text shown to users
  priority            int  NOT NULL DEFAULT 100,
  template_id         text,                                  -- which starter template (null if raw)
  template_params     jsonb,                                 -- params if compiled from template
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES public.users(id),
  updated_by          uuid REFERENCES public.users(id)
);
ALTER TABLE public.room_booking_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.room_booking_rules
  USING (tenant_id = public.current_tenant_id());
CREATE INDEX idx_room_booking_rules_active_scope
  ON public.room_booking_rules (tenant_id, active, target_scope, target_id, priority);
CREATE TRIGGER set_room_booking_rules_updated_at BEFORE UPDATE ON public.room_booking_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.room_booking_rule_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         uuid NOT NULL REFERENCES public.room_booking_rules(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL,
  version_number  int  NOT NULL,
  change_type     text NOT NULL CHECK (change_type IN ('create','update','enable','disable','delete')),
  snapshot        jsonb NOT NULL,                            -- full row at this version
  diff            jsonb,                                     -- changes vs prior
  actor_user_id   uuid REFERENCES public.users(id),
  actor_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, version_number)
);
ALTER TABLE public.room_booking_rule_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.room_booking_rule_versions
  USING (tenant_id = public.current_tenant_id());
-- Insert/update locked to service role; admins read via app code.
CREATE POLICY service_role_only ON public.room_booking_rule_versions
  FOR INSERT WITH CHECK (false);   -- service_role bypass via app
```

### 2.4 Reservations — the big upgrade

```sql
-- Migration 00122_reservations_room_booking_columns.sql

-- Status enum upgrade (full blueprint set).
-- Migrate existing seed data first: rows with status='pending' (the old enum) become 'pending_approval'.
UPDATE public.reservations SET status = 'pending_approval' WHERE status = 'pending';

ALTER TABLE public.reservations
  DROP CONSTRAINT IF EXISTS reservations_status_check;
ALTER TABLE public.reservations
  ADD CONSTRAINT reservations_status_check
  CHECK (status IN ('draft','pending_approval','confirmed','checked_in','released','cancelled','completed'));

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS setup_buffer_minutes      int      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS teardown_buffer_minutes   int      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS effective_start_at        timestamptz GENERATED ALWAYS AS
                             (start_at - make_interval(mins => setup_buffer_minutes)) STORED,
  ADD COLUMN IF NOT EXISTS effective_end_at          timestamptz GENERATED ALWAYS AS
                             (end_at   + make_interval(mins => teardown_buffer_minutes)) STORED,
  ADD COLUMN IF NOT EXISTS time_range                tstzrange  GENERATED ALWAYS AS
                             (tstzrange(effective_start_at, effective_end_at, '[)')) STORED,

  ADD COLUMN IF NOT EXISTS check_in_required         boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS check_in_grace_minutes    int      NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS checked_in_at             timestamptz,
  ADD COLUMN IF NOT EXISTS released_at               timestamptz,

  ADD COLUMN IF NOT EXISTS cancellation_grace_until  timestamptz,

  ADD COLUMN IF NOT EXISTS policy_snapshot           jsonb    NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS applied_rule_ids          uuid[]   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS source                    text     NOT NULL DEFAULT 'portal'
                             CHECK (source IN ('portal','desk','api','calendar_sync','auto','reception')),
  ADD COLUMN IF NOT EXISTS booked_by_user_id         uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS cost_amount_snapshot      numeric(10,2),

  ADD COLUMN IF NOT EXISTS attendee_person_ids       uuid[]   NOT NULL DEFAULT '{}',

  ADD COLUMN IF NOT EXISTS multi_room_group_id       uuid,    -- FK added below

  ADD COLUMN IF NOT EXISTS recurrence_master_id      uuid REFERENCES public.reservations(id),
  ADD COLUMN IF NOT EXISTS recurrence_index          int,
  ADD COLUMN IF NOT EXISTS recurrence_overridden     boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recurrence_skipped        boolean  NOT NULL DEFAULT false,

  ADD COLUMN IF NOT EXISTS calendar_event_id         text,
  ADD COLUMN IF NOT EXISTS calendar_provider         text     CHECK (calendar_provider IN ('outlook')),
  ADD COLUMN IF NOT EXISTS calendar_etag             text,
  ADD COLUMN IF NOT EXISTS calendar_last_synced_at   timestamptz,

  ADD COLUMN IF NOT EXISTS booking_bundle_id         uuid;    -- FK added in sub-project 2
```

### 2.5 The conflict guard (most important constraint in the slice)

```sql
-- Migration 00123_reservations_conflict_guard.sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE public.reservations
  ADD CONSTRAINT reservations_no_overlap
  EXCLUDE USING gist (
    tenant_id  WITH =,
    space_id   WITH =,
    time_range WITH &&
  ) WHERE (status IN ('confirmed','checked_in','pending_approval'));
```

Excluded statuses (`released`, `cancelled`, `completed`, `draft`) free the slot.

Same-requester back-to-back buffer collapse is enforced in `BookingFlowService` *before* INSERT (the constraint can't reference subqueries). When the immediately-prior or following booking on the same room has the same `requester_person_id`, buffers between them are zeroed in the new row's snapshotted columns. The constraint then sees what reality looks like.

### 2.6 Recurrence series

```sql
-- Migration 00124_recurrence_series.sql
CREATE TABLE public.recurrence_series (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id),
  recurrence_rule          jsonb NOT NULL,                  -- {frequency, interval, by_day[], by_month_day, count, until}
  series_start_at          timestamptz NOT NULL,
  series_end_at            timestamptz,                     -- null = open-ended (capped by max_occurrences)
  max_occurrences          int  NOT NULL DEFAULT 365,
  holiday_calendar_id      uuid REFERENCES public.calendars(id),
  materialized_through     timestamptz NOT NULL,            -- rolling window cap
  parent_reservation_id    uuid REFERENCES public.reservations(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.recurrence_series ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.recurrence_series
  USING (tenant_id = public.current_tenant_id());
CREATE INDEX idx_recurrence_series_materialized
  ON public.recurrence_series (tenant_id, materialized_through);
CREATE TRIGGER set_recurrence_series_updated_at BEFORE UPDATE ON public.recurrence_series
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- reservations.recurrence_series_id already exists from 00014; add FK here
ALTER TABLE public.reservations
  ADD CONSTRAINT reservations_recurrence_series_fk
  FOREIGN KEY (recurrence_series_id) REFERENCES public.recurrence_series(id);
```

### 2.7 Multi-room groups

```sql
-- Migration 00125_multi_room_groups.sql
CREATE TABLE public.multi_room_groups (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id),
  requester_person_id      uuid NOT NULL REFERENCES public.persons(id),
  primary_reservation_id   uuid REFERENCES public.reservations(id),  -- "main" room of the group
  created_at               timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.multi_room_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.multi_room_groups
  USING (tenant_id = public.current_tenant_id());

ALTER TABLE public.reservations
  ADD CONSTRAINT reservations_multi_room_group_fk
  FOREIGN KEY (multi_room_group_id) REFERENCES public.multi_room_groups(id);
```

### 2.8 Calendar sync (Microsoft Graph only in v1)

```sql
-- Migration 00126_calendar_sync.sql
CREATE TABLE public.calendar_sync_links (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id),
  user_id                  uuid NOT NULL REFERENCES public.users(id),
  provider                 text NOT NULL CHECK (provider IN ('outlook')),
  access_token_encrypted   text NOT NULL,                     -- pgcrypto / vault wrap
  refresh_token_encrypted  text NOT NULL,
  expires_at               timestamptz,
  external_calendar_id     text NOT NULL,
  sync_status              text NOT NULL DEFAULT 'active'
                             CHECK (sync_status IN ('active','error','disabled')),
  last_synced_at           timestamptz,
  last_error               text,
  webhook_subscription_id  text,
  webhook_expires_at       timestamptz,
  UNIQUE (user_id, provider)
);
ALTER TABLE public.calendar_sync_links ENABLE ROW LEVEL SECURITY;
-- Tenant isolation + owner-or-admin read
CREATE POLICY tenant_isolation ON public.calendar_sync_links
  USING (tenant_id = public.current_tenant_id());
CREATE POLICY owner_or_admin ON public.calendar_sync_links
  FOR SELECT USING (
    user_id = public.current_user_id()
    OR public.user_has_permission(public.current_user_id(), 'rooms.admin')
  );
CREATE INDEX idx_calendar_sync_links_active
  ON public.calendar_sync_links (provider, sync_status, last_synced_at)
  WHERE sync_status = 'active';

CREATE TABLE public.calendar_sync_events (
  reservation_id    uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  provider          text NOT NULL CHECK (provider IN ('outlook')),
  external_event_id text NOT NULL,
  external_etag     text,
  sync_direction    text NOT NULL CHECK (sync_direction IN ('in','out','both')),
  last_synced_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reservation_id, provider)
);
ALTER TABLE public.calendar_sync_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.calendar_sync_events
  USING (EXISTS (SELECT 1 FROM public.reservations r
                 WHERE r.id = reservation_id
                   AND r.tenant_id = public.current_tenant_id()));

CREATE TABLE public.room_calendar_conflicts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES public.tenants(id),
  space_id               uuid NOT NULL REFERENCES public.spaces(id),
  detected_at            timestamptz NOT NULL DEFAULT now(),
  conflict_type          text NOT NULL CHECK (conflict_type IN
                          ('etag_mismatch','recurrence_drift','orphan_external','orphan_internal','webhook_miss_recovered')),
  reservation_id         uuid REFERENCES public.reservations(id),
  external_event_id      text,
  external_event_payload jsonb,
  resolution_status      text NOT NULL DEFAULT 'open'
                          CHECK (resolution_status IN ('open','auto_resolved','admin_resolved','wont_fix')),
  resolution_action      text,
  resolved_at            timestamptz,
  resolved_by            uuid REFERENCES public.users(id)
);
ALTER TABLE public.room_calendar_conflicts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.room_calendar_conflicts
  USING (tenant_id = public.current_tenant_id());
CREATE INDEX idx_room_calendar_conflicts_open
  ON public.room_calendar_conflicts (tenant_id, resolution_status, detected_at)
  WHERE resolution_status = 'open';
```

### 2.9 Floor plans

```sql
-- Migration 00127_floor_plans.sql
CREATE TABLE public.floor_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id),
  space_id        uuid NOT NULL REFERENCES public.spaces(id),    -- the floor space
  image_url       text NOT NULL,
  width_px        int NOT NULL,
  height_px       int NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id)                                    -- one plan per floor; replace on re-upload
);
ALTER TABLE public.floor_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.floor_plans
  USING (tenant_id = public.current_tenant_id());
CREATE TRIGGER set_floor_plans_updated_at BEFORE UPDATE ON public.floor_plans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
```

### 2.10 Simulation scenarios

```sql
-- Migration 00128_room_booking_simulation_scenarios.sql
CREATE TABLE public.room_booking_simulation_scenarios (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id),
  name            text NOT NULL,
  description     text,
  scenario        jsonb NOT NULL,    -- requester_id + space_id + time + criteria
  last_run_at     timestamptz,
  last_run_result jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES public.users(id)
);
ALTER TABLE public.room_booking_simulation_scenarios ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.room_booking_simulation_scenarios
  USING (tenant_id = public.current_tenant_id());
```

### 2.11 Indexes

```sql
-- Migration 00129_room_booking_indexes.sql

-- Auto-release scheduler (partial — keeps the working set tiny)
CREATE INDEX IF NOT EXISTS idx_reservations_pending_check_in
  ON public.reservations (tenant_id, start_at)
  WHERE check_in_required = true
    AND status = 'confirmed'
    AND checked_in_at IS NULL;

-- "My bookings" list
CREATE INDEX IF NOT EXISTS idx_reservations_requester_time
  ON public.reservations (tenant_id, requester_person_id, start_at DESC)
  WHERE status NOT IN ('cancelled','released');

-- Picker availability per-room
CREATE INDEX IF NOT EXISTS idx_reservations_space_time_active
  ON public.reservations (tenant_id, space_id, start_at, end_at)
  WHERE status IN ('confirmed','checked_in','pending_approval');

-- Multi-attendee find-time
CREATE INDEX IF NOT EXISTS idx_reservations_attendee_persons
  ON public.reservations USING gin (attendee_person_ids)
  WHERE status IN ('confirmed','checked_in','pending_approval');

-- Cancellation grace cleanup
CREATE INDEX IF NOT EXISTS idx_reservations_cancellation_grace
  ON public.reservations (tenant_id, cancellation_grace_until)
  WHERE cancellation_grace_until IS NOT NULL;
```

### 2.12 Permissions

```sql
-- Migration 00130_room_booking_permissions.sql
-- Adds permission keys recognised by user_has_permission():
--   rooms.read         (own only — implicit for portal users)
--   rooms.read_all     (operators / service desk)
--   rooms.admin        (admin module access)
--   rooms.book_on_behalf
--   rooms.override_rules
-- Inserts into the permission registry table the project uses.
```

### 2.13 Migration checklist

Per `CLAUDE.md` Supabase remote vs local:

1. Each migration is idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).
2. Local: `pnpm db:reset` validates SQL.
3. Remote: per the user's standing grant for this workstream, `pnpm db:push` is authorised; psql fallback when needed (DB password supplied via env per session). After push: `NOTIFY pgrst, 'reload schema';`.

## 3 · Backend services & APIs

### 3.1 REST surface

```
# Reservations
GET    /reservations                                list (mine / by-room / by-time / status filter)
GET    /reservations/:id
POST   /reservations                                create — full booking pipeline
PATCH  /reservations/:id                            edit one occurrence (or whole booking if non-recurring)
PATCH  /reservations/:id/recurrence                 edit-this-and-following / edit-entire-series
POST   /reservations/:id/cancel                     soft cancel; with recurrence_scope
POST   /reservations/:id/check-in
POST   /reservations/:id/restore                    within cancellation_grace_until
POST   /reservations/dry-run                        full pipeline simulation, no write
POST   /reservations/multi-room                     atomic create of N rooms in one group

# Picker
POST   /reservations/picker                         {time_range, attendee_count, criteria, requester_id?, site_id?, sort?}
                                                    → ranked rooms with availability + rule outcomes per room

# Multi-attendee scheduling
POST   /reservations/find-time                      {duration_minutes, person_ids[], window_start, window_end, criteria}
                                                    → ranked time slots when all attendees are free

# Rules
GET    /room-booking-rules
GET    /room-booking-rules/:id
GET    /room-booking-rules/:id/versions
POST   /room-booking-rules
PATCH  /room-booking-rules/:id
DELETE /room-booking-rules/:id                      soft (active=false)
POST   /room-booking-rules/from-template            {template_id, params, target} → compiled predicate
POST   /room-booking-rules/simulate                 dry-run a {requester, space, time, criteria}
POST   /room-booking-rules/:id/impact-preview       "this rule would have changed N bookings in last 30d"
GET    /room-booking-rules/templates                list of starter templates with param schemas

# Saved simulation scenarios
GET    /room-booking-simulation-scenarios
POST   /room-booking-simulation-scenarios
POST   /room-booking-simulation-scenarios/:id/run

# Calendars
GET    /calendars
POST   /calendars
PATCH  /calendars/:id
DELETE /calendars/:id

# Calendar sync (per user)
GET    /calendar-sync/me                            my linked outlook + status
POST   /calendar-sync/connect                       start OAuth; returns Microsoft auth URL
POST   /calendar-sync/callback                      OAuth callback handler
DELETE /calendar-sync/outlook                       disconnect
POST   /calendar-sync/outlook/resync                force one-time resync

# Calendar sync (admin)
GET    /admin/calendar-sync/health                  per-room sync status + counters
GET    /admin/calendar-sync/conflicts               conflicts inbox
POST   /admin/calendar-sync/conflicts/:id/resolve   admin resolution

# Floor plans
GET    /floor-plans?space_id=
POST   /floor-plans                                 multipart upload
PATCH  /spaces/:id/polygon                          set room polygon on its floor's plan
DELETE /floor-plans/:id

# Inbound webhook (Microsoft Graph notifications)
POST   /webhooks/outlook                            Graph push notifications endpoint
```

### 3.2 Core services — interface contracts

(Implementation detail in code; this is the contract.)

```ts
// ReservationService — the orchestrator
class BookingFlowService {
  create(input: CreateReservationInput, actor: ActorContext): Promise<Reservation>
  edit(id: string, patch: EditPatch, actor: ActorContext): Promise<Reservation>
  cancel(id: string, scope: 'this'|'this_and_following'|'series', actor: ActorContext): Promise<CancelImpact>
  checkIn(id: string, actor: ActorContext): Promise<Reservation>
  restore(id: string, actor: ActorContext): Promise<Reservation>
}

class ListBookableRoomsService {
  list(input: PickerInput): Promise<RankedRoom[]>
  // One Postgres query with LATERAL availability + LATERAL rule resolver per candidate
}

class RankingService {
  score(room: Space, requester: Person, criteria: PickerCriteria): { score: number; reasons: string[] }
}

class RuleResolverService {
  resolve(requester: Person, space: Space, time: TimeRange, criteria: PickerCriteria):
    Promise<{ effects: Effect[]; matchedRules: Rule[]; denialMessages: string[] }>
  resolveBulk(requester: Person, spaceIds: string[], time: TimeRange, criteria: PickerCriteria):
    Promise<Map<string, RuleOutcome>>
}

class RuleTemplateService {
  list(): TemplateDefinition[]
  compile(templateId: string, params: Record<string, unknown>): { applies_when: jsonb; effect: Effect; denial_message?: string }
}

class SimulationService {
  run(scenario: Scenario, draftRules?: Rule[]):
    Promise<{ rule_evaluations: Evaluation[]; final_outcome: 'allow'|'deny'|'require_approval'; explain_text: string }>
}

class ImpactPreviewService {
  preview(rule: Rule | DraftRule):
    Promise<{ affected_count: number; denied_count: number; approval_required_count: number;
              sample_affected_bookings: Reservation[]; breakdown_by_room: BreakdownRow[]; breakdown_by_requester: BreakdownRow[] }>
}

class RecurrenceService {
  expand(rule: RecurrenceRule, start: Date, end: Date, holidays: Date[]): Date[]   // pure
  materialize(seriesId: string, through?: Date): Promise<string[]>                  // returns new reservation ids
  rollOver(): Promise<void>                                                         // cron: monthly extend
  splitSeries(reservationId: string): Promise<string>                               // returns new series id
  applyOccurrenceOverride(reservationId: string, patch: EditPatch): Promise<Reservation>
  skipOccurrence(reservationId: string): Promise<Reservation>
  previewImpact(reservationId: string, scope: RecurrenceScope, patch: EditPatch): Promise<RecurrenceImpact>
}

class ConflictGuardService {
  preCheck(spaceId: string, timeRange: TimeRange, excludeIds?: string[]): Promise<Reservation[]>
  parseRaceError(pgError: Error, input: CreateReservationInput): Promise<{ conflictingReservation: Reservation; alternatives: RankedRoom[] }>
}

class MultiAttendeeFinder {
  findFreeSlots(personIds: string[], duration: number, window: TimeRange, criteria: PickerCriteria): Promise<RankedSlot[]>
}

class MultiRoomBookingService {
  createGroup(input: MultiRoomInput, actor: ActorContext): Promise<MultiRoomGroup>
}

class CheckInService {
  checkIn(reservationId: string, actor: ActorContext): Promise<Reservation>
  autoReleaseScan(): Promise<void>   // cron: every 5 min, FOR UPDATE SKIP LOCKED on partial index
}

class ReservationVisibilityService {
  loadContext(userId: string, tenantId: string): Promise<VisibilityContext>
  assertVisible(reservation: Reservation, ctx: VisibilityContext): void
  filterIds(ctx: VisibilityContext): Sql                                  // injects WHERE clause
}
```

### 3.3 Permissions

| Permission | Granted to |
|---|---|
| `rooms.read` | implicit for any authenticated portal user (read own + as participant + as attendee) |
| `rooms.read_all` | service desk, ops |
| `rooms.admin` | admins (read + manage rules, rooms, calendars, sync health) |
| `rooms.book_on_behalf` | service desk, designated assistants |
| `rooms.override_rules` | service desk only — bypass `deny` with reason; high-visibility audit |

### 3.4 Background jobs (NestJS `@Cron`)

| Job | Cadence | Purpose |
|---|---|---|
| `autoReleaseScan` | every 5 min during business hours | flip uncheckedin → released |
| `recurrenceRollover` | nightly | extend `materialized_through` for active series |
| `outlookSyncPoll` | every 5 min | pull deltas from Microsoft Graph for active links |
| `outlookWebhookRenew` | hourly | renew expiring webhook subscriptions an hour before expiry |
| `roomMailboxWebhookRenew` | hourly | same as above, for room mailbox subscriptions |
| `calendarHeartbeatReconcile` | hourly | per-room diff against Outlook calendar; detect drift |
| `cancellationGraceCleanup` | hourly | clear past-due `cancellation_grace_until` |
| `impactPreviewWarmer` | nightly | precompute aggregate stats for rule analytics |

All cron registrations live in `room-booking-cron.module.ts`.

## 4 · UX surfaces

### 4.1 Portal — booking flow (hybrid C)

`/portal/book/room` — single page:

- **Criteria bar** (top): When (date/time/duration), Attendees, Site, Must-have chips, view toggle (List / Floor plan).
- **Live ranking strip**: count, sort selector (default `Best match`), realtime indicator.
- **Result rows** (ranked):
  - Room name, capacity, floor, distance from requester ("90 m walk"), amenities, smart-rank reasons inline ("Used by your team 6× this month").
  - Mini-timeline of the day with the requested slot outlined.
  - Status badges: `BEST MATCH`, `Capacity tight`, `Needs approval`, `Restricted` (visible only to service desk; hidden from employees).
  - Inline `Book` / `Request` button per row.
- **Realtime**: each shown room's mini-timeline updates live as bookings change. If a candidate becomes unavailable for the requested slot, soft-toast suggests two alternatives.
- **Progressive disclosure footer**: `+ Add internal attendees`, `+ Add another room`, `+ Make this recurring` — keeps the default flow simple.
- **Floor-plan toggle**: flips list to per-floor SVG with rooms overlaid as polygons coloured by availability.
- **On submit race**: 409 surfaces inline alternatives panel; one-click rebook on each.

### 4.2 Portal — "My bookings"

`/portal/me/bookings`:

- Default Upcoming; tabs: Upcoming / Past / Cancelled.
- Row: room, time, status pill (hover popover for "auto-released because…"), inline decision affordance (`Check in` near start, `Rebook` if released, `Restore` if cancelled within grace).
- Click row → right-side drawer with detail, attendees, recurrence info, edit/cancel/edit-this-and-following controls.
- Recurring series collapses to one grouped row with expand-to-occurrences.

### 4.3 Portal — booking edit drawer

Built with shadcn Field primitives (per CLAUDE.md form composition rules):

- Identity: name, description, attendees list (internal person picker).
- Time + room (changing either re-runs availability + rules).
- Recurrence: humanised summary + edit-modal with this/this-and-following/series + impact preview.
- Approvals: inline pending state.
- Calendar sync status pill ("Mirrored to Outlook").
- Cancel with recurrence-scope prompt + impact preview.

### 4.4 Desk scheduler

`/desk/scheduler`:

- Calendar grid: rooms-as-rows, time-as-columns. Default = today + 6 days, single building. Filters: building, floor, room type, has-amenity, requester (book-on-behalf).
- **Drag-create / drag-extend / drag-move** with live conflict feedback (red-glow on violation).
- **Rule tags per cell** when "Booking for: <person>" is set: amber tint for "needs approval for this requester," dimmed for denies.
- **Override-rules**: clicking a denied cell offers "Override this rule? Reason: ___" with mandatory reason and high-visibility audit.
- Buffer windows shaded lighter than the meeting itself.
- **Multi-room create**: shift-click multiple cells → "Book all selected as multi-room" → atomic.

### 4.5 Admin — rooms & spaces

Existing `/admin/locations` extended:

- New tab on the room detail page: **Booking config**:
  - Reservable toggle (existing).
  - Min attendees, capacity (existing).
  - Setup buffer / teardown buffer (minutes).
  - Check-in required + grace minutes.
  - Cost per hour (chargeback stub field; greyed with "Chargeback ships in a follow-up slice").
  - Default calendar.
  - Smart-suggestion keywords (free-text tags).
  - Calendar sync mode: Pattern A (default) / Pattern B.
  - For Pattern A: linked Outlook room mailbox id + provision/health controls.
- **Floor-plan editor** sub-page: upload SVG/image; click rooms to drop / drag / resize polygons.

### 4.6 Admin — room booking rules (index + detail per CLAUDE.md mandate)

`/admin/room-booking-rules` — index:

- Header with "+ New rule" action.
- Table columns: name, scope (with resolved-set tooltip), effect badge, last-modified, active toggle.
- Empty state: 12 starter templates as quick-add cards.

`/admin/room-booking-rules/:id` — detail:

- `SettingsGroup` blocks with `SettingsRow`s:
  - **Identity**: name, description, active toggle (auto-save).
  - **Scope**: target_scope row → dialog with live-preview resolved rooms.
  - **When this applies**: predicate row → dialog with template-or-raw editor (per-section save).
  - **Effect**: deny / require_approval (with approval policy picker) / warn / allow_override.
  - **Denial message**: free-text shown to users; live preview.
  - **Test**: saved-scenario picker + Run → simulation panel inline.
  - **Impact preview**: auto-runs once on detail open.
  - **History**: rule-version diff viewer.
  - **Danger zone**: soft delete; second-confirm hard delete.

### 4.7 Admin — rule editor (template-first / raw-fallback dialog)

Two tabs: `Template` / `Raw predicate`:

- Left: searchable list of 12 starter templates.
- Right: parameter form for the chosen template + live "Compiles to" predicate preview + impact preview (last 30 days).
- Footer: "Test against scenario" link + Cancel + Save.
- Raw tab: JSON predicate editor with validation; admins reach this only when no template covers the case.

The 12 starter templates ship in v1:

1. Restrict to roles
2. Restrict to org subtree
3. Off-hours need approval
4. Min lead time
5. Max lead time
6. Max duration
7. Capacity tolerance (over-capacity → deny / warn / approve)
8. Long bookings need manager approval
9. High-capacity needs VP approval
10. Capacity floor (under-attendees → deny — pairs with `spaces.min_attendees`)
11. Soft over-capacity warning
12. Service-desk override allow

### 4.8 Admin — calendar sync health

`/admin/calendar-sync`:

- Per-room sync status (mode, last sync, webhook expiry, errors).
- Counters: "Last 30 days: 18 invites intercepted, 14 accepted, 4 denied (rule X), 0 unresolved double-bookings."
- Conflicts inbox: typically empty in healthy state; non-empty rows show what happened with one-click resolutions ("Cancel external / keep Prequest" or "Adopt external / cancel Prequest") + audit log.

### 4.9 Notifications UX

- **Email**: confirmation, cancellation, check-in reminder, auto-release notice (self-explaining, with rebook deep-link), approval requested/decided.
- **In-portal toast / inbox**: same events real-time via existing notification engine.
- **Outlook decline body** (Pattern A only): when a rule denies an Outlook invite, the rejection's body is the rule's `denial_message`. Self-explaining differentiator extends into Outlook.

### 4.10 Floor-plan picker (alternate portal view)

Toggle on the picker; per-floor SVG with rooms as polygons:

- Green = available + matches criteria
- Amber = warning (capacity tight, etc.)
- Purple = needs approval
- Hatched / dimmed = unavailable
- Hidden = denied (employee never sees these)
- Hover → tooltip with mini-timeline + capacity + amenities + Book button.
- Click → opens booking drawer (same as list view).

## 5 · Calendar sync architecture (Microsoft Graph only)

### 5.1 Two patterns per room

| Pattern | Purpose |
|---|---|
| **A** (default) | Outlook room mailbox exists. Auto-accept off. Prequest is the calendar processor + has webhook subscription. Inbound invites are intercepted and run through the booking pipeline before Outlook accepts/rejects. |
| **B** | No Outlook room mailbox at all. Prequest is the only system that books the room. After booking, the meeting is created on the **user's** personal calendar with the room as free-text `location`. |

Pattern A is the recommended default — preserves Outlook room-finder workflow while eliminating dual-acceptance.

### 5.2 Microsoft Graph adapter (`OutlookSyncAdapter`)

```ts
class OutlookSyncAdapter implements CalendarSyncPort {
  // User-side
  connect(user: User): Promise<{ authUrl: string }>
  finishConnect(user: User, code: string): Promise<{ link: CalendarSyncLink }>
  pushEvent(reservation: Reservation, link: CalendarSyncLink): Promise<{ externalEventId: string; etag: string }>
  pullDelta(link: CalendarSyncLink, since?: string): Promise<{ events: GraphEvent[]; deltaToken: string }>
  subscribeWebhook(link: CalendarSyncLink): Promise<{ subscriptionId: string; expiresAt: Date }>

  // Room-mailbox side (Pattern A)
  configureRoomMailbox(space: Space): Promise<{ subscriptionId: string }>
  acceptOnRoomCalendar(reservation: Reservation): Promise<{ etag: string }>
  rejectOnRoomCalendar(externalEventId: string, denialMessage: string): Promise<void>
  unconfigureRoomMailbox(space: Space): Promise<void>
}
```

### 5.3 Room mailbox intercept pipeline (Pattern A)

```
1. User adds Lotus as a resource in Outlook.
2. Mailbox queues the request (auto-accept = off).
3. Microsoft Graph sends a webhook notification to /webhooks/outlook.
4. RoomMailboxService.handleNotification(payload):
     a. fetch full event from Graph
     b. translate Graph event to CreateReservationInput (start_at, end_at, requester from user lookup,
        attendees, criteria from room properties)
     c. BookingFlowService.create(input, actor=system_calendar_intercept)
        → runs the same rules + conflict guard as the portal
     d. on success:
        - reservations row created with source='calendar_sync'
        - acceptOnRoomCalendar(reservation) writes accept on the room calendar
        - calendar_sync_events row created
     e. on rule deny:
        - rejectOnRoomCalendar(external_event_id, rule.denial_message)
        - Outlook sends the user a decline email with the denial message body
     f. on conflict-guard race (someone booked the slot in Prequest portal first):
        - rejectOnRoomCalendar(external_event_id, "Already booked in Prequest")
```

### 5.4 Heartbeat reconciliation

Hourly cron:

- For each Pattern A room: fetch Outlook events for [now, now + 14 days], diff against `reservations` rows, raise `room_calendar_conflicts` rows for anomalies (etag mismatch, recurrence drift, orphan external/internal).
- Auto-resolve straightforward cases (e.g. webhook miss → re-process the event).
- Surface unresolved cases to the admin conflicts inbox.

### 5.5 Reconciliation policy

**Prequest authoritative** (default and only mode in v1). Outlook attempts that conflict with Prequest rules or with another booking are rejected with the rule's `denial_message` written into the Outlook decline.

### 5.6 Recurrence translation

Prequest stores materialised occurrence rows; Outlook uses master + EXDATE + override events. Outbound translation:

- Master event with recurrence pattern matching Outlook's `patternedRecurrence` shape.
- EXDATE list assembled from `recurrence_skipped` rows.
- Per-occurrence override events for `recurrence_overridden` rows.

Inbound translation reverses the process: when Outlook reports a master event change, we re-materialise the affected occurrences and rerun the rule resolver per occurrence.

Documented limits (out-of-scope for v1):

- Outlook's "every other Monday and Wednesday" hyper-patterns translated to closest Prequest rule; user warned if exact translation impossible.
- Series moved across days where DST transitions cross (handled by tz-aware comparison; documented edge cases in the admin handbook).

### 5.7 OAuth token storage

`access_token_encrypted` / `refresh_token_encrypted` via `pgcrypto` symmetric encryption. Encryption key sourced from env (`SUPABASE_VAULT_KEY` or equivalent). If `pgcrypto` isn't already wired in the repo, the migration adds the extension + a helper function for encrypt/decrypt.

### 5.8 Failure modes

| Failure | Mitigation |
|---|---|
| Webhook subscription lapses (we miss invites) | `outlookWebhookRenew` cron renews 1 h before expiry; heartbeat reconciler catches drift on next run |
| Graph API outage | Mailbox stays in "no-auto-accept"; invites pending; backlog drains when Graph returns |
| 429 / `quotaExceeded` | Exponential backoff (30 s, 1 m, 2 m, 4 m), max 4 retries; then `sync_status='error'` + admin alert |
| Admin re-enables auto-accept on a room mailbox | Heartbeat reconciler detects mode drift; admin alerted |
| User edits meeting in Outlook (move time, add room) | Webhook fires intercept path; rules + conflict re-run; deny → decline written back |
| External (cross-tenant) inviter adds the room | Same intercept; rules can include "if requester is external, deny" predicate (or treat as visitor flow in sub-project 3) |
| Token refresh fails | `sync_status='error'`, user notified to reconnect; outbound pushes queue |

## 6 · Operational concerns

### 6.1 Performance budgets

| Surface | Target p95 | How we hit it |
|---|---|---|
| Portal picker (`/reservations/picker`) | < 250 ms server, < 600 ms perceived | one Postgres query with LATERAL availability + LATERAL rule resolver per ≤ 30 candidate rooms |
| Desk scheduler grid open (50 rooms × 7 days) | < 700 ms server, < 1.2 s perceived | one range query + one rules-by-room query; static rule outcomes cached per (room, requester); FE virtualises rows |
| Conflict-guard write | < 80 ms | single GiST index lookup |
| Auto-release scan tick | < 200 ms | partial index `idx_reservations_pending_check_in` keeps working set < 100 rows |
| Realtime fan-out | < 1 s to clients | Supabase Realtime native; rate-limited per client |
| Calendar sync push (per booking) | async, < 5 s end-to-end | enqueued, non-blocking |

A `perf-budgets.md` checklist accompanies the implementation plan; PRs touching the picker / scheduler queries include `EXPLAIN ANALYZE` snippets.

### 6.2 Conflict-guard race handling

- Postgres rejects with `SQLSTATE 23P01`.
- Service catches, looks up conflicting row(s), calls `ListBookableRoomsService` with `space_excluded_ids` to find 3 alternatives.
- Returns structured 409 with alternatives.
- **Never retry server-side.** The user always sees the alternatives panel — no silent rebook.

### 6.3 Realtime channels

```
reservations:tenant_<id>:space_<id>     - created/updated/cancelled/released
reservations:tenant_<id>:user_<id>      - my_reservations_changed
room_booking_rules:tenant_<id>          - rules_changed (admin UI)
```

Filtered via Supabase RLS publications. Client-side: 200 ms debounce before re-querying.

### 6.4 Observability

Metrics (added to existing pipeline):
- `room_booking_picker_latency_seconds` (histogram, by tenant)
- `room_booking_creates_total` (counter, by source)
- `room_booking_denied_total` (counter, by rule_id)
- `room_booking_releases_auto_total` (counter)
- `room_booking_rule_eval_seconds` (histogram, by rule_id)
- `outlook_sync_failures_total` (counter, by error_class)
- `outlook_webhook_intercepts_total` (counter, by outcome: accepted | denied | conflict)

Audit events for: reservation create / edit / cancel / restore / check-in / auto-release / rule lifecycle / override-with-reason / Pattern-A intercept outcomes.

Tracing: span chain per booking pipeline call.

### 6.5 Failure modes designed for explicitly

- **Predicate engine slow / stuck** — 200 ms timeout per rule eval; treated as "did not match" + admin alerts emitted ("Rule X is slow").
- **Calendar provider outage** — pushes queue; reservations still work in Prequest; UI shows degraded pill.
- **Booking storms** (start-of-week 9 am) — picker is read-only, cacheable per-tenant for ~1 s if load testing demands.
- **Recurrence backlog** — rollover catches up incrementally (max N occurrences per run).

### 6.6 Testing posture

- Schema integration tests: concurrent inserts vs exclusion constraint; same-requester buffer collapse; GENERATED ALWAYS columns; recurrence DST/leap cases.
- Service unit tests: rule resolver specificity sort, deny-wins, time-variant; recurrence expander; conflict-guard race handling.
- API e2e: booking pipeline (happy / denied / approval / race / override); Outlook intercept with mocked Graph; picker ranking determinism.
- UI tests: picker, scheduler, rule editor.
- Playwright happy-path: employee books a room end-to-end.
- Migration tests: all 12 migrations against fresh local DB; rollback safety.

## 7 · Phasing

```
A · Foundation                      1.5 wk
    Migrations 00119–00130. Calendars. RLS. Predicate-engine helper functions.

B · Predicate rules engine          1 wk
    room_booking_rules tables, RuleResolverService, RuleTemplateService + 12 templates.
    Resolver unit tests.

C · Booking pipeline + conflict     1.5 wk
    BookingFlowService end-to-end. Auto-release scheduler. Soft cancel/restore/edit.
    Buffer collapse for same-requester back-to-back. Concurrent-insert tests.

D · Portal hybrid-C flow            1.5 wk
    /portal/book/room (list view), my-bookings, check-in, edit drawer.
    React Query keys.

E · Desk calendar scheduler         2 wk
    Grid with virtualisation, drag-create/extend/move, rule tags, book-on-behalf,
    override. Performance budget verification.

F · Admin rule editor + sims        1.5 wk
    Index + detail page. Template editor dialog. Saved scenarios.
    Impact preview against last 30 days. Versions diff viewer.

G · Recurrence                      1 wk
    Expander, materialiser, rollover cron, edit semantics with impact preview.
    Holiday-skip via calendar.

H · Multi-attendee + multi-room +
    smart suggestions + floor-plan  1 wk
    find-time endpoint. Multi-room atomic create. Ranking algorithm.
    Floor-plan picker + admin polygon editor.

I · Calendar sync (Outlook only)    2 wk
    OutlookSyncAdapter. Webhook intercept (Pattern A). Heartbeat reconciler.
    Conflicts inbox + sync-health page. OAuth + token encryption.
    (Reduced from 2.5 wk: no Google adapter, no Pattern C migration tool.)

J · Realtime + notifications        1 wk
    Supabase Realtime channels. Notification wiring. Self-explaining release email.

K · Hardening                       1.5 wk
    Perf tests against budgets. Audit coverage. Observability metrics + tracing.
    Playwright happy-path. Admin onboarding docs (Pattern A configuration).
```

Total: ~14.5 weeks of engineering effort. Phases B–E run two parallel tracks after A: (B → C → D) and (B → E). F, G, H pick up after dependencies. I runs largely in parallel with G + H.

## 8 · Acceptance criteria for v1 shippable

Hard gates, not negotiable:

1. The conflict-guard exclusion constraint prevents overlapping bookings under concurrency tests (1 000 concurrent submits, 0 dual-accepts).
2. Auto-release scheduled job runs continuously in pilot for 7 days with no missed releases.
3. Pattern A integration: 100 invites flow through the intercept path with the rule resolver — 0 double-bookings.
4. The 12 rule templates each compile to a working predicate; admin can configure all 6 originally-listed rule examples (org scope, role allowlist, capacity floor, etc.) using templates only.
5. Self-explaining denial text appears in (a) portal booking error, (b) Outlook decline body, (c) "My bookings" status pill.
6. Picker p95 < 250 ms server, < 600 ms perceived. Desk scheduler open p95 < 1.2 s perceived.
7. Calendar-sync health page shows 0 unresolved conflicts for the pilot tenant for 30 days.
8. Audit log covers every booking-lifecycle event + every rule change + every override-with-reason.
9. Admin documentation: Pattern-A onboarding guide; rule library handbook; user "what's new" portal note.

## 9 · Rollout strategy

- **Internal pilot first** (your tenant). 2 weeks, polish from real bookings.
- **Design-partner rollout** to 1–2 friendly tenants. Pattern A configured hands-on; conflicts inbox monitored closely.
- **Broad availability** once design partners report no unresolved double-bookings for 30 days, perf gates met, admins demonstrably configuring rules from templates without raw editing.

(No legacy customers; no per-tenant feature flag for migration safety.)

## 10 · Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Picker LATERAL-join query slows at >500 rooms / tenant | Medium | High | Perf tests in Phase K; Redis cache layer in follow-up if needed; query is read-only and tenant-scoped |
| Recurrence ↔ Outlook translation edge cases | High | Medium | Extensive named test scenarios (DST, leap year, hyper-patterns); documented "what we don't support" upfront in admin handbook |
| Microsoft Graph rate limits during onboarding | Medium | Medium | Per-tenant outbound queue; backoff; spread initial sync over hours not minutes |
| Rule resolver slows with 100+ rules per tenant | Low | Medium | 200 ms per-rule timeout; index on (tenant, scope, target, active); admin warning when rule consistently slow |
| Override-rules permission abused by service desk | Low | Medium | Mandatory reason; high-visibility audit; admin "overrides last 30 days" report; permission gated behind explicit role grant |
| Realtime chatter under booking storms | Low | Low | 200 ms client debounce; publication filtered by RLS; degrades to manual refresh on disconnect |

## 11 · Open implementation-time questions

(Honest "we'll learn during build," not unanswered design questions.)

- Whether `pgcrypto` is already wired for token-at-rest encryption in this repo or if Phase I includes its setup.
- Whether the existing predicate engine's primitives cover all 12 templates' compiled outputs, or whether we add 1–2 helper functions in Phase A.
- Exact Microsoft Graph rate-limit thresholds at our typical tenant size — measured load testing in Phase K.
- Whether Supabase Realtime's filtering supports the multi-channel subscription pattern without a custom proxy — fallback is a thin Node WebSocket gateway if not.

## 12 · Best-in-class differentiators (the moat summary)

1. **Predicate-driven rule engine with template-first authoring** — ServiceNow's power without ServiceNow's admin pain.
2. **Simulation + impact preview before publish** — "this rule would have changed 47 of last 30 days' bookings." Datadog/PagerDuty-style; almost nobody in this market does this.
3. **Self-explaining denials** — visible in the portal *and* in Outlook decline emails. Most competitors send generic "request denied." We tell users why and what to try instead.
4. **Pattern A double-booking elimination** — Outlook room mailbox configured so Prequest is the only entity that can accept; rules + conflict guard run on every invite, regardless of source. Genuinely zero double-bookings — the most common operational pain in this category.
5. **Smart room ranking with reasons** — "Used by your team 6× this month · 90 m walk · matches whiteboard + video." Default sort that beats a list every time.
6. **Realtime availability** — picker + scheduler update live; race losers see alternatives, not errors.
7. **Floor-plan picker as a first-class view** — visual moat vs list-only competitors.
8. **Multi-attendee scheduling for internal personnel** — Outlook-quality find-a-time without leaving Prequest.
9. **Multi-room atomic bookings** — a rare correctness feature; competitors silently fail half the rooms.
10. **Recurrence with impact preview on edit** — blueprint's "change impact clarity" moat made concrete.
11. **Admin sync-health page + conflicts inbox** — operational transparency on Outlook ↔ Prequest reconciliation.
12. **Override-with-reason** — service desk has the escape hatch; admins can audit every use.

## 13 · Non-scope (locks the seams)

| Out of v1 | Lives in |
|---|---|
| `booking_bundles` orchestration record | Sub-project 2 |
| Visitors (preregistration, host invite, visitor records) | Sub-project 3 |
| Linked services / orders (catering, AV, setup) on a booking | Sub-project 2 |
| Reception board + host workspace | Sub-project 4 |
| Workflow templates + workflow versioning + publish-rollback | Cross-cutting prerequisite track |
| Access control / badge / Wi-Fi / signage integrations | Blueprint "Later" tier |
| Building-map view (across-floor map vs per-floor plan) | Follow-up polish slice |
| Booking templates / favourites | Follow-up slice within room-booking track |
| Multi-room bookings spanning non-coincident times | Follow-up |
| Rule-effectiveness analytics dashboard | Follow-up (~30 days post-launch) |
| AI-assisted planning, calendar-driven meeting intent detection | Blueprint "Later" |
| Cross-provider room mailboxes (room in both Outlook and Google) | Defer indefinitely |
| Hot-desking-specific UX (floor-plan desk picker, neighborhood booking) | Separate desk-hoteling sub-project |
| Chargeback admin UI / reports / billing rules | Sub-project 6 — schema seam shipped in v1 |
| External-org / rentee identity model | Separate sub-project |
| Google Calendar sync | Future addition (2-line CHECK update + new adapter) |

## 14 · Mandatory doc updates triggered by this slice

Per CLAUDE.md trigger lists, this slice will require updates to:

- A new `docs/room-booking.md` operational reference doc, modeled on `docs/assignments-routing-fulfillment.md` and `docs/visibility.md` — created in Phase A and kept in sync as code changes (touch-to-update mandate).
- `docs/assignments-routing-fulfillment.md` — only if any room-booking rule effect ends up calling routing primitives. Probably no change needed, but verify in Phase F.
- `docs/visibility.md` — add a section on reservation visibility tiers (participant / operator / admin) and how `ReservationVisibilityService` differs from the ticket model.
- `CLAUDE.md` — add a "Room booking" section in the Frontend Rules / Architecture areas pointing at the new operational reference doc.

Touch-to-update applies: changes to `apps/api/src/modules/reservations/**`, `apps/api/src/modules/room-booking-rules/**`, `apps/api/src/modules/calendar-sync/**`, or any of the room-booking-related migrations require a same-PR update of `docs/room-booking.md`.
