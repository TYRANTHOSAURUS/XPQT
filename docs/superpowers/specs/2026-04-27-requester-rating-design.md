# Requester Rating System — Design Spec

**Date:** 2026-04-27
**Status:** Design — pending implementation
**Owner:** TBD
**Estimated effort:** 3-4 weeks
**Roadmap location:** `docs/booking-services-roadmap.md` §9.2.5; `docs/booking-platform-roadmap.md` (cross-cuts §F + §G).

**Why this spec exists:** in our scorecard model, requester ratings are the **highest-trust voluntary signal** — the one source of ground truth that doesn't require vendors or desk teams to do extra work. Per `feedback_no_friction_for_data.md`, we cannot fabricate scorecard data via forced reporting; we *can* ask requesters to voluntarily rate their experience after the fact, with thoughtful UX that respects their time. Done well, this single feature provides the most-defensible scorecard signal across paper-only vendors, portal vendors, and internal teams alike.

**Why design caution is unusually high:** rating prompts are easy to over-do (every product asks for ratings, most do it badly). One-too-many emails breaks user trust forever. We ship a *single* well-timed prompt with clear opt-out, never repeated, never escalated. If we get this wrong, we lose the signal AND damage requester trust in the platform.

**Context:**
- [`docs/booking-services-roadmap.md`](../../booking-services-roadmap.md) §9.2.5.
- Memory: `feedback_no_friction_for_data.md` — voluntary signals only; respect requesters' time.
- Memory: `feedback_hide_vendor_from_requester.md` — rate components, never name the vendor.
- Memory: `project_industry_mix.md` — corporate HQ pattern (event-driven; not daily-cycle).
- Sibling specs:
  - [Vendor scorecards](2026-04-27-vendor-scorecards-design.md) — primary consumer of rating data.
  - [GDPR baseline](2026-04-27-gdpr-baseline-design.md) — rating anonymization after 90 days.
  - [MS Graph integration](2026-04-27-microsoft-graph-integration-design.md) — Teams DM channel for rating prompts.

---

## 1. Goals + non-goals

### Goals

1. **Single, well-timed rating prompt per booking** — sent at T+24h after booking ends. Email primary; Teams DM where MS Graph integration is connected.
2. **Component-by-component rating** matching the booking's actual composition: catering, AV/equipment, cleaning/setup, room. Show only components the booking had.
3. **Voluntary always; opt-out always available.** Per-service-type and global opt-out in `/portal/me/preferences`. No "follow-up" reminder emails — single ask.
4. **Hidden vendor maintained** — requester rates "the catering", never "Compass Catering". Rating routes to the actual fulfiller (vendor or internal team) internally without exposing identity.
5. **No login required to rate.** Signed-token link from email; mobile-first landing page; tap stars; submit; done.
6. **Negative signal first** — if a component "didn't happen" or had a serious issue, capture as a recall ticket signal rather than coercing a star rating.
7. **Anonymization after 90 days** per GDPR baseline — individual rater dropped, aggregate rating preserved.
8. **Rate-limited** — at most one rating prompt per person per day even if they had multiple bookings. Multiple bookings batch into one prompt.
9. **Recurring booking aware** — don't prompt after every occurrence of a weekly meeting; configurable cadence (default monthly).
10. **Aggregates feed vendor scorecards** + space quality metrics (room rating routes separately from service ratings).
11. **Trustworthy data** — rate-once-per-booking enforced via single-use tokens; can't be gamed.

### Non-goals

- **Mid-meeting rating prompts** — never. Rating is post-event only.
- **Multi-attendee rating** in v1 (only the named requester rates). Tier 2: opt-in attendee rating.
- **Mandatory ratings as approval gating** — never. Rating is voluntary.
- **Survey-style rating with 10+ questions** — never. Component ratings + optional free text.
- **Public ratings** — ratings are tenant-internal; never shown to other requesters or to vendors directly.
- **Ratings tied to financial penalties** — out of scope; signal informs vendor relationship, doesn't automate consequences.
- **NPS-style "would you recommend Prequest" prompts** — different feature; not specced here.
- **Cross-tenant aggregation** — ratings stay per-tenant.

---

## 2. Architecture overview

### Module layout

**`RatingsModule`** (`apps/api/src/modules/ratings/`):
- `RatingPromptScheduler` — background worker that schedules + sends rating prompts.
- `RatingTokenService` — generates + validates single-use rating tokens.
- `RatingSubmissionService` — accepts submissions; validates; persists.
- `RatingAggregationService` — daily aggregation into `vendor_scorecards_daily` + space quality metrics.
- `RatingPreferencesService` — manages per-person opt-out + cadence.
- `RatingDeliveryAdapter` — abstracts email + Teams DM delivery.

**Frontend**:
- `/rate/:token` (public, no-auth) — landing page for redeemed token.
- `/portal/me/preferences/ratings` — opt-out preferences for logged-in user.

### Data flow

```
Booking ends → background worker fires at T+24h
   ↓
Per booking: should we ask?
   - Booking not cancelled
   - At least one component had a deliverable (catering / AV / cleaning / room)
   - Person hasn't opted out
   - Person hasn't been rate-limited (max 1 prompt/day)
   - This isn't an N-th occurrence of a recurring series within suppression window
   ↓
Yes → batch with other bookings same day for same person
   ↓
Generate rating_request_token (signed, single-use, 7-day TTL)
   ↓
Send via primary channel (Teams DM if MS Graph connected; else email)
   ↓
Person clicks → /rate/:token landing page (mobile-first)
   ↓
Rate components (1-5 stars + optional comment)
   ↓
Submit → token consumed → rating persisted → aggregates queued
   ↓
Confirmation: "Thanks — your feedback helps the FM team improve services."
```

---

## 3. Data model

### `rating_request_tokens`

Single-use tokens for unauthenticated rating submission.

```sql
create table rating_request_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  subject_person_id uuid not null references persons(id),
  -- The booking(s) being rated. JSONB array because multiple bookings can batch into one prompt.
  booking_bundle_ids uuid[] not null,
  token_hash text not null,                    -- pgcrypto hash; raw token sent to user
  generated_at timestamptz not null default now(),
  expires_at timestamptz not null,             -- typically generated_at + 7 days
  sent_at timestamptz,
  channel text check (channel in ('email','teams','in_app')),
  redeemed_at timestamptz,
  redeemed_from_ip_hash text,
  unique (token_hash)
);

create index idx_rrt_pending on rating_request_tokens (subject_person_id, generated_at) where redeemed_at is null and expires_at > now();
create index idx_rrt_retention on rating_request_tokens (generated_at);
```

Retention: 90 days from generation; covered by GDPR baseline category.

### `requester_ratings`

The actual rating submissions.

```sql
create table requester_ratings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  rating_request_token_id uuid references rating_request_tokens(id),
  rated_by_person_id uuid references persons(id),  -- nullable after anonymization
  -- Per booking covered by this submission (one row per booking even when prompts batched)
  booking_bundle_id uuid references booking_bundles(id),
  reservation_id uuid references reservations(id),  -- for room-only bookings without bundle
  -- Component ratings (each 1-5; null if component didn't apply or wasn't rated)
  catering_rating int check (catering_rating between 1 and 5),
  av_rating int check (av_rating between 1 and 5),
  cleaning_rating int check (cleaning_rating between 1 and 5),
  room_rating int check (room_rating between 1 and 5),
  overall_rating int check (overall_rating between 1 and 5),
  -- Per-component free-text comments (optional, capped 500 char each)
  catering_comment text,
  av_comment text,
  cleaning_comment text,
  room_comment text,
  overall_comment text,
  -- "Did this component happen?" — captures negative event when component was supposed to deliver but didn't
  catering_did_not_happen boolean default false,
  av_did_not_happen boolean default false,
  cleaning_did_not_happen boolean default false,
  -- Anonymization metadata
  anonymized_at timestamptz,
  -- Routing
  catering_routed_to_vendor_id uuid,           -- for scorecard aggregation
  catering_routed_to_team_id uuid,
  av_routed_to_vendor_id uuid,
  av_routed_to_team_id uuid,
  cleaning_routed_to_vendor_id uuid,
  cleaning_routed_to_team_id uuid,
  -- Source
  rated_at timestamptz not null default now(),
  source text check (source in ('email','teams','in_app','api'))
);

create index idx_ratings_bundle on requester_ratings (booking_bundle_id);
create index idx_ratings_reservation on requester_ratings (reservation_id);
create index idx_ratings_rated_by on requester_ratings (rated_by_person_id) where rated_by_person_id is not null;
create index idx_ratings_anonymize on requester_ratings (rated_at) where anonymized_at is null;
create index idx_ratings_aggregation_catering on requester_ratings (catering_routed_to_vendor_id, rated_at);
create index idx_ratings_aggregation_av on requester_ratings (av_routed_to_vendor_id, rated_at);
```

Retention: rating data retained per tenant audit window (default 365d for individual records); after 90 days, individual rater dropped (anonymized) but aggregate preserved.

### `rating_preferences`

Per-person opt-out preferences.

```sql
create table rating_preferences (
  person_id uuid primary key references persons(id) on delete cascade,
  tenant_id uuid not null,
  opted_out_global boolean not null default false,
  opted_out_catering boolean not null default false,
  opted_out_av boolean not null default false,
  opted_out_cleaning boolean not null default false,
  opted_out_room boolean not null default false,
  recurring_meeting_cadence_days int default 30,  -- ask after every Nth occurrence; default monthly
  preferred_channel text check (preferred_channel in ('email','teams','in_app','none')) default 'email',
  preferred_time_of_day time,                       -- e.g. 09:00 to avoid late-night prompts
  do_not_disturb_start time,
  do_not_disturb_end time,
  updated_at timestamptz not null default now()
);
```

### `recurring_rating_suppression`

Tracks when we last asked someone about a recurring meeting series, to suppress until cadence elapses.

```sql
create table recurring_rating_suppression (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  person_id uuid not null references persons(id),
  recurrence_series_id uuid not null,
  last_prompted_at timestamptz not null default now(),
  unique (person_id, recurrence_series_id)
);

create index idx_rrs_lookup on recurring_rating_suppression (person_id, recurrence_series_id);
```

### Audit events

- `rating_prompt.scheduled` — scheduler decided to send a prompt.
- `rating_prompt.sent` — actually delivered via channel.
- `rating_prompt.skipped` — would have prompted but suppressed (rate limit, opt-out, recurring suppression, etc.) — captured for analytics on prompt cadence.
- `rating.submitted` — person rated.
- `rating.expired` — token expired without redemption.
- `rating.anonymized` — 90-day anonymization applied.

---

## 4. RatingPromptScheduler — when + who to ask

Runs hourly (configurable per tenant; default hourly).

### Algorithm

For each booking that ended in the previous hour (T+0 to T+1h ago):

1. **Eligibility checks:**
   - `bookings.status != 'cancelled'`.
   - At least one of: `booking has catering OR av OR cleaning order_line_item` OR (`booking has reservation AND no order line items` — pure room booking; rate room only).
   - Booking is at T+24h ± 1h window (the actual scheduling).
2. **Person checks** (named requester):
   - Person not in `rating_preferences.opted_out_global`.
   - Person hasn't been rate-limited (no token sent in last 24h).
   - Booking isn't suppressed by recurring cadence (`recurring_rating_suppression.last_prompted_at + cadence_days > now()`).
3. **Batch check:** if multiple bookings ended within ±2h for the same person, batch them into one prompt covering all.
4. **Generate token** with 7-day TTL.
5. **Schedule send** at T+24h or person's `preferred_time_of_day`, respecting `do_not_disturb_*` windows.
6. **Update suppression table** if recurring (so future occurrences are skipped until cadence elapses).
7. **Audit:** `rating_prompt.scheduled` per qualifying booking; `rating_prompt.skipped` per suppressed.

### Channel selection

- If person has Teams DM available (tenant has MS Graph + Teams installation + person mapped to Azure AD user): **Teams DM**.
- Else: **email**.
- Per-person `preferred_channel` overrides default.
- `preferred_channel = 'none'` is equivalent to opt-out.

### Rate limiting

- Hard limit: 1 prompt per person per 24h regardless of how many bookings.
- Soft limit: tenant-configurable max prompts per person per week (default 3) to prevent fatigue from frequent meeting hosts.

---

## 5. Rating UX

### Email template (primary channel)

**Subject:** `How was your meeting in [room name] on [date]?`

**Body** (HTML branded; minimal text fallback):
- Tenant logo + greeting using requester first name.
- One sentence: "We're checking in on the meeting you organized at [Boardroom 4A] on [Apr 30 at 14:00]."
- Components rated: list with stars (renders as filled-in by clicking; opens landing page on first click).
- "Rate now" CTA button.
- Sub-text: "This takes 30 seconds. We use this to improve services. You can opt out anytime."

The email itself never asks for input via reply — always routes through the link to the landing page.

### Teams DM (alternative channel)

Adaptive card:
- Header: "How was your meeting?"
- Booking summary: "Boardroom 4A · Apr 30 at 14:00"
- Components: tap stars inline (adaptive card supports this)
- Submit button or "Open in browser" for free-text comments.

### Landing page `/rate/:token`

Mobile-first; no login required.

```
┌─ Rate your meeting ──────────────────────────┐
│ Boardroom 4A · Apr 30 at 14:00               │
│ 12 attendees · catering · AV setup           │
│                                                │
│ ─── Catering ───────────────────────────────  │
│ How was the food?                            │
│   ⭐ ⭐ ⭐ ⭐ ⭐  (tap to rate)                │
│   [Optional: tell us more]                   │
│   [✗ This didn't arrive — tell the desk]    │
│                                                │
│ ─── AV / equipment ─────────────────────────  │
│ How was the AV setup?                         │
│   ⭐ ⭐ ⭐ ⭐ ⭐                                  │
│   [Optional]                                  │
│                                                │
│ ─── Room ────────────────────────────────────  │
│ How was the room itself? (cleanliness,        │
│ temperature, comfort)                         │
│   ⭐ ⭐ ⭐ ⭐ ⭐                                  │
│                                                │
│ ─── Overall experience ─────────────────────  │
│   ⭐ ⭐ ⭐ ⭐ ⭐                                  │
│                                                │
│ [Submit]   [Skip this rating]                 │
│                                                │
│ Don't want these emails? Manage preferences   │
└────────────────────────────────────────────────┘
```

### "Didn't happen" path

Tapping "This didn't arrive — tell the desk" on a component:
- Opens a textarea: "What happened? (optional)"
- Submit creates a recall ticket assigned to the desk team for follow-up.
- Marks `requester_ratings.{component}_did_not_happen = true`.
- Doesn't capture a star rating for that component (1-star ≠ "didn't happen").
- Strong signal in vendor scorecard's "recall_count" metric.

This avoids the false signal of "1 star = bad food" when the food never arrived. Different problem, different signal.

### Submission states

- **Token valid + first redemption:** show rating form.
- **Token valid + already submitted:** "Thanks for your earlier rating." Submission is locked.
- **Token expired:** "This rating link has expired. You can rate via the Prequest portal." (link to `/portal/me-bookings`).
- **Token invalid/forged:** generic 404; don't leak token validity.

### Confirmation

After submit:
- "Thanks — your feedback helps the FM team improve services."
- Brief summary of what the requester rated (no vendor names).
- Link to manage rating preferences.
- Single click to "view all my bookings" in portal.

### Mobile-first

- Phone primary surface (320-428px).
- Single column.
- Large tap targets (≥44px).
- One-handed reachability.
- Skeleton loaders, not spinners.

---

## 6. Component routing — rating → vendor / internal team

Per-component, route the rating to the actual fulfiller:

```typescript
function routeComponent(rating, bundleId, component) {
  // For catering, av, cleaning — find the order_line_item that fulfilled this component
  const lineItem = await findLineItem(bundleId, component);
  if (!lineItem) return; // component didn't apply

  // Component routes to whichever fulfilled it: vendor or internal team
  rating[`${component}_routed_to_vendor_id`] = lineItem.vendor_id;
  rating[`${component}_routed_to_team_id`] = lineItem.fulfillment_team_id;

  // Aggregator (vendor scorecards) uses these fields to assign rating to vendor/team
}

// Room rating routes separately — to space quality metrics, not to a vendor
function routeRoomRating(rating, reservationId) {
  // Aggregates feed `space_quality_daily` (separate from vendor scorecards)
  // Drives FM team's "which rooms are people happy in?" analytics
}
```

Per `feedback_hide_vendor_from_requester.md` — requester sees component name; system sees fulfiller routing. Separation maintained.

### Aggregation (per scorecard spec §3 + §4)

- Daily aggregation worker scans newly submitted ratings.
- For each component, route to the vendor's or team's `vendor_scorecards_daily` row + increment ratings_count + add to ratings_sum.
- Room ratings to `space_quality_daily` (new aggregate table — out of scope here, but called out as future).

### Multiple ratings, same vendor, same booking

Edge case: vendor delivered both catering and AV. Same booking. Requester rates each separately. Each component routes to the vendor's scorecard independently. Vendor's avg rating aggregates both component ratings. Acceptable.

### Vendor anonymized post-rating

If vendor relationship ends after ratings have been collected:
- Aggregate rating data preserved (per scorecard retention).
- Individual rating record stays in `requester_ratings` per its own retention.
- No special handling needed; vendor record itself anonymizes per `vendor_user_data` GDPR category.

---

## 7. Recurring meeting handling

A weekly meeting that runs for a year would generate 52 rating prompts if we didn't suppress. That's relentless — exactly the friction we reject.

### Cadence rules

- After first occurrence: rating prompt sent.
- After Nth occurrence: skip; suppress entry persists.
- Cadence reset: every `recurring_meeting_cadence_days` (default 30 — monthly).
- Per-person override: `rating_preferences.recurring_meeting_cadence_days` (10 to 365 range; person can extend).
- "Don't ask about this series again": one-click in the prompt landing page; sets `suppressed_until = far_future`.

### Implementation

`recurring_rating_suppression` table tracks (`person_id`, `recurrence_series_id`, `last_prompted_at`).

Scheduler checks: `if exists in table AND last_prompted_at + cadence_days > now() then skip`.

Default cadence: 30 days. Common pattern: ask once a month for the same standing meeting.

### Edge cases

- **Series modified mid-stream** (e.g. catering changes weekly to alternate weeks): treat as same series for suppression unless cadence rule changed materially.
- **Recurring booking with one-off catering** (catering only on first meeting, room weekly thereafter): rate the catering separately on its own occurrence; resume room-only suppression for subsequent.
- **Series cancelled and recreated**: new `recurrence_series_id` → fresh suppression. Acceptable.

---

## 8. Opt-out + preferences

### `/portal/me/preferences/ratings`

Single page in user portal:

```
Rating prompts
─────────────────
☐ Don't ask me to rate any meetings (global)

For meetings I organize, ask me about:
  ☑ Catering
  ☑ AV / equipment
  ☑ Room cleanliness
  ☑ Overall experience

For recurring meetings, ask me at most once every:
  [ 30 ] days

Send rating prompts:
  ◉ Email
  ◯ Microsoft Teams
  ◯ Don't send (in-app only)

Don't disturb hours:
  From [ 18:00 ]  to [ 08:00 ]
```

### Email-side opt-out

Every rating prompt email contains a "Manage preferences" link in the footer. Single click opens preferences page (after auth — not unauthenticated to prevent spam-driven changes).

### Effective immediately

Opt-out applies to next prompt scheduled. In-flight prompts already sent stay valid until expiry.

---

## 9. Negative-event handling

### "Didn't happen" workflow

When requester taps "This didn't arrive" on a component:

1. Show optional textarea: "What happened?".
2. Submit:
   - Set `requester_ratings.{component}_did_not_happen = true`.
   - Create a `recall_event` (existing schema or new) tied to the order_line_item.
   - Notify desk team via Teams DM (or email): "Requester reported that catering for [meeting] on [date] didn't arrive. Follow up: [link to bundle]."
   - Increment vendor scorecard's `recall_count` for that vendor in that day's bucket.
3. **Rating doesn't capture star** — different signal.

This is the right escalation path: requesters report a real problem; desk handles it; vendor scorecard reflects the recall accurately.

### Don't conflate "1 star" with "didn't happen"

A 1-star rating for catering means "the food was bad." A didn't-happen flag means "no food arrived." Vendor scorecard treats them separately:
- Low ratings → satisfaction signal.
- Didn't-happen → recall + complaint signal.

Conflating them creates noise. Specs separate them structurally.

---

## 10. GDPR alignment

### Anonymization (per GDPR baseline §3 + §5)

- 90 days after `requester_ratings.rated_at`:
  - Set `rated_by_person_id = NULL`.
  - Drop free-text comments (or replace with `[redacted]` if comment was mentioned by aggregate analytics).
  - Set `anonymized_at = now()`.
- Star ratings + "didn't happen" flags retained — they're aggregate analytics, not personal.
- Audit: `rating.anonymized` event.

Per `requester_ratings` GDPR category — added to `tenant_retention_settings` registry.

### Erasure cascade

When a person is anonymized via departure cleanup:
- Their `requester_ratings` entries are anonymized immediately (`rated_by_person_id = NULL`; comments redacted) regardless of 90-day window.
- Aggregate ratings preserved.
- `rating_preferences` row deleted.

### Read-side audit

Reading rating data captures audit per `personal_data_access_logs`:
- Admin viewing ratings → logged.
- Aggregator running daily → not logged (system actor).

### Tenant isolation

- All rating data tenant-scoped.
- No cross-tenant aggregation in v1.

---

## 11. Phased delivery

### Sprint 1 (1 wk): Schema + scheduler

- Migrations: `rating_request_tokens`, `requester_ratings`, `rating_preferences`, `recurring_rating_suppression`.
- `RatingPromptScheduler` worker skeleton.
- Eligibility logic + rate limiting.
- Audit events.

### Sprint 2 (1 wk): Email channel + landing page + submission

- Email template + branding.
- `/rate/:token` landing page (mobile-first, no auth).
- `RatingTokenService` + `RatingSubmissionService`.
- Single-use token enforcement.
- "Didn't happen" workflow + recall event creation.

### Sprint 3 (1 wk): Teams channel + opt-out + recurring cadence

- Teams adaptive card delivery (depends on MS Graph integration Phase 3).
- `/portal/me/preferences/ratings` page.
- Recurring suppression logic.
- Per-channel preferences.

### Sprint 4 (~3 days): Aggregation + GDPR + polish

- Daily aggregation into vendor scorecards (when scorecards spec ships).
- 90-day anonymization worker.
- Read-side audit.
- i18n: NL + FR + EN (template strings).
- Accessibility audit.

**Total: ~3-4 weeks** elapsed; compressible with parallel work.

---

## 12. Acceptance criteria

1. **Booking ends; T+24h later, requester gets exactly one rating prompt** via email (or Teams if connected).
2. **Prompt contains only components that applied** to the booking — empty room booking gets only "Room" + "Overall"; full bundle gets all four.
3. **Requester clicks link, lands on `/rate/:token`** without login required.
4. **Requester rates components, submits**, sees confirmation.
5. **No second prompt** if requester ignores the first or misses the 7-day window.
6. **Rate limiting works**: requester with 3 bookings same day gets one batched prompt covering all three.
7. **"This didn't happen" workflow** creates a recall event + notifies desk team; vendor scorecard's recall_count increments; no star rating captured for that component.
8. **Recurring meeting suppression**: requester gets first occurrence prompt; no subsequent prompts within 30 days for same series.
9. **Opt-out works**: requester opts out globally; no future prompts. Per-component opt-out skips just that component.
10. **Component routing**: catering rating routes to vendor in `requester_ratings.catering_routed_to_vendor_id`; aggregates into vendor's `vendor_scorecards_daily.ratings_*`.
11. **Anonymization at 90 days**: `rated_by_person_id` set to NULL; comments redacted; aggregates preserved.
12. **Vendor identity never visible** anywhere in rating UX — components named, fulfillers internal-only.
13. **Mobile-first landing page** works at 320px width with single-handed reachability.
14. **Teams channel** delivers adaptive card with inline star-tap when MS Graph + Teams installation present.

---

## 13. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Prompt fatigue — frequent meeting host gets too many prompts | High | High | Hard rate-limit (1/24h); soft limit (3/week, configurable); recurring suppression; opt-out always one-click |
| Token leak (forwarded email) → wrong person rates | Low | Medium | Single-use; token tied to subject_person_id; mismatched-IP detection (logged but not blocked) |
| "Didn't happen" misuse (requester clicks for everything) | Low | Low | Free-text required; desk reviews; pattern-detection alerts admin to abusers |
| Submit endpoint open to spam without auth | Medium | Medium | Token validation; rate-limit per IP per token; CAPTCHA if abuse detected |
| Aggregation lags scorecards by days | Low | Low | Hourly aggregation possible; default daily acceptable |
| Recurring meeting with one-off rating becomes repeating annoyance | Medium | Medium | "Don't ask about this series again" CTA on prompt landing |
| Email bounce → person never rates → silent gap | Medium | Low | Bounce tracking; admin sees "X% of prompts bounced" in dashboard; no individual outreach |
| Component routing fails for orphan line items | Low | Medium | Default route to "unattributed" bucket if vendor_id and team_id both null; admin alert |
| Multiple bookings batched but components vary across bookings | Medium | Medium | Show per-booking section in landing page; rate each independently |
| Token forgery / replay | Low | High | Tokens hashed at rest; signing key rotation; replay prevented by single-use enforcement |
| Anonymization breaks aggregate calc retroactively | Low | Medium | Aggregate captured before anonymization; never recompute aggregates that touch anonymized rows |

---

## 14. Open questions

1. **Default cadence for recurring meetings** — 30 days reasonable? Validate with FM-director interviews.
2. **Show requester their past ratings in `/portal/me`?** Recommend yes, lightweight history view; helps engagement.
3. **Aggregate weighting — should 5-star count more than 4-star?** Recommend simple linear avg in v1; consider weighted later.
4. **Rate-limit threshold** — soft limit 3/week appropriate? Validate.
5. **Should we ever ask about a SPECIFIC vendor's catering directly** (e.g. "Vendor X is up for renewal — rate their last 5 deliveries")? Recommend NO — breaks hidden-vendor rule.
6. **Should desk operator see individual ratings or only aggregates?** Recommend aggregates only; individual ratings are admin (`scorecards:read` permission).
7. **Should we surface aggregate ratings to requester in any context** ("This catering had 4.6/5 satisfaction")? Recommend NO — opens vendor identity question.
8. **Should we ask attendees too, not just requester?** Recommend Tier 2; adds complexity but more signal.
9. **Should "didn't happen" auto-cancel the order_line_item** since it didn't fulfill? Recommend yes — cascades to refund/no-charge logic when present.

---

## 15. Out of scope

- Multi-attendee rating (Tier 2).
- Public-facing reviews of vendors/products (never).
- Mid-meeting prompts (never).
- NPS-style "would you recommend Prequest" (different feature).
- Cross-tenant aggregate ratings (not in scope).
- Mandatory ratings as approval gating (anti-pattern).
- Rating-driven financial penalties (out of scope).
- Survey-style rating with 10+ questions (rejected).
- Anonymous public review platforms (different product).

---

## 16. References

- [`docs/booking-services-roadmap.md`](../../booking-services-roadmap.md) §9.2.5.
- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) cross-cuts §F + §G.
- Sibling specs:
  - [Vendor scorecards](2026-04-27-vendor-scorecards-design.md) — primary consumer.
  - [GDPR baseline](2026-04-27-gdpr-baseline-design.md) — anonymization + retention.
  - [MS Graph integration](2026-04-27-microsoft-graph-integration-design.md) — Teams DM channel.
- Memory:
  - `feedback_no_friction_for_data.md` — voluntary signals only.
  - `feedback_hide_vendor_from_requester.md` — rate components, not vendors.
  - `project_industry_mix.md` — corporate HQ event-driven cadence.
  - `feedback_quality_bar_comprehensive.md` — comprehensive scope.

---

**Maintenance rule:** when implementation diverges from this spec, update spec first. When adding new component types (e.g. parking, lockers in future), extend `requester_ratings` schema + landing page accordingly.
