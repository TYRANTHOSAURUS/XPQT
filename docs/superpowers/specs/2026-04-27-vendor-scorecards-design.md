# Vendor Scorecards — Design Spec

**Date:** 2026-04-27
**Status:** Design — pending implementation (after Phase A + Phase B ship)
**Owner:** TBD
**Estimated effort:** 3-4 weeks
**Roadmap location:** `docs/booking-services-roadmap.md` §9.1.3; `docs/booking-platform-roadmap.md` §F7 + §G8.

**Why this spec exists:** vendor performance reporting is a procurement-blocker for any FM director evaluating Prequest against ServiceChannel (the gold-standard for vendor scorecards in FM software) or Planon Insights. Without scorecards, FM directors can't justify vendor decisions with data — they fall back to anecdote, and competing platforms win the evaluation. The scorecard data model lifts directly from ServiceChannel's well-understood KPI taxonomy, adapted for office workplace services (catering / AV / cleaning / maintenance) instead of multi-site retail FM.

**Why specced now even though implementation comes later:** Phase A (daglijst) provides status inference data for paper-only vendors; Phase B (vendor portal) provides self-reported status events. **Vendor scorecards depend on BOTH data sources.** Specifying the scorecard model now ensures Phase A + Phase B ship with the right event capture; otherwise we'd have to retrofit data collection.

**Context:**
- [`docs/booking-services-roadmap.md`](../../booking-services-roadmap.md) §9.1.3.
- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §F7 + §G8.
- [`docs/competitive-benchmark.md`](../../competitive-benchmark.md) — ServiceChannel scorecard model is best-in-class anywhere in FM software.
- Sibling specs:
  - [Daglijst (Phase A)](2026-04-27-vendor-portal-phase-a-daglijst-design.md) — status inference for paper-only vendors.
  - [Vendor portal (Phase B)](2026-04-27-vendor-portal-phase-b-design.md) — self-reported status events.
  - [GDPR baseline](2026-04-27-gdpr-baseline-design.md) — anonymization for satisfaction data tied to persons.

---

## 1. Goals + non-goals

### Goals

1. **Per-vendor scorecard with 9 core KPIs** lifted from ServiceChannel + adapted for office services: on-time delivery rate, ack latency, decline rate, completion time, post-order satisfaction, cost variance, schedule adherence, compliance currency, recall rate.
2. **Time-series trends** per KPI (last 90 days configurable; longer windows on demand) with daily granularity.
3. **Vendor comparison view** — side-by-side two vendors covering same (building, service_type), with KPI deltas highlighted.
4. **Tenant-internal benchmarks** — "your top 25% vendor", "your average". (Industry benchmarks deferred — would require cross-tenant data.)
5. **Cohort detection** — auto-flag vendors trending down vs their own historical baseline (e.g. "on-time rate dropped 15% over last 30 days").
6. **CSV / PDF export** for procurement review meetings.
7. **Source-of-truth distinction** — KPIs derived from inferred (paper-only) data labeled differently from self-reported (portal) data; confidence score surfaced.
8. **Hybrid vendor support** — paper + portal mixed; honor whichever source is available per event.
9. **Materialized aggregates** refreshed nightly to keep query latency acceptable at scale.
10. **GDPR-aligned** — satisfaction ratings tied to anonymized person IDs; aggregations don't expose individual feedback.
11. **Drives operational decisions** — "Switch primary vendor" CTA when comparison shows a clear better performer + coverage rules support a switch.

### Non-goals

- **Cross-tenant industry benchmarks** — would require federated data; deferred until customer demand + privacy framework.
- **Vendor-side scorecard view** (vendor sees their own performance) — Tier 2.
- **Predictive analytics** ("this vendor is likely to fail next week") — Tier 3, ML territory.
- **Procurement workflow integration** — exports to CSV; full procurement system integration (e.g. Coupa, Ariba) is Tier 3.
- **Real-time scorecards** — aggregates refreshed nightly. Real-time only on raw event surface.
- **Vendor compensation / penalty automation** — out of scope; scorecards inform decisions, don't automate financial actions.
- **Multi-tenant comparison** — tenant A can't see tenant B's vendor data even when same vendor serves both (per `project_vendors_per_tenant.md`).

---

## 2. Background — what data sources we have

### From Phase A (daglijst)

For `vendors.fulfillment_mode = 'paper_only'`:
- `vendor_order_status_events` rows with `actor_kind = 'inferred'`:
  - `received` at delivery_time -1h.
  - `delivered` at delivery_time + grace_minutes (default 30).
- Lower confidence (time-based, not actual reporting).
- Desk override available; manual updates flagged `actor_kind = 'tenant_user'`.

### From Phase B (vendor portal)

For `vendors.fulfillment_mode = 'portal'`:
- `vendor_order_status_events` rows with `actor_kind = 'vendor_user'`:
  - `received`, `preparing`, `en_route`, `delivered`, `declined` — actual self-reported timestamps.
- Higher confidence.

### Hybrid mode (`fulfillment_mode = 'hybrid'`)

- Mixed source per event. Each event individually identifies its actor_kind.
- KPIs aggregate across both sources; confidence score reflects mix.

### Other data sources

- `order_line_items` — order metadata (delivery_time, expected, headcount, line_total).
- `vendor_daily_lists` — daglijst events for paper vendors (download tracking).
- Future: `requester_ratings` (post-order satisfaction) — Tier 2 source from `docs/booking-services-roadmap.md` §9.2.5.
- Future: `vendor_invoices` — for cost variance — separate workstream.
- Future: `vendor_certifications` — for compliance currency — separate workstream.

### Data freshness

- Source events captured in real-time as they happen.
- Aggregation materialized view refreshed nightly (overnight job).
- Manual refresh button for desk lead (rare; expensive).

---

## 3. KPI taxonomy (lifted from ServiceChannel + adapted)

### Core KPIs (v1)

| KPI | Formula | Source | Confidence factor |
|---|---|---|---|
| **On-time delivery rate** | (orders delivered ≤ service_window_end + tolerance) / total delivered | status events | High for portal; medium for paper-inferred |
| **Acknowledgment latency** | time from order_created → first `received` event | status events | High for portal; N/A for paper |
| **Decline rate** | declined orders / total assigned orders | status events | High |
| **Completion time** | time from `received` → `delivered` | status events | High for portal; medium for paper |
| **Post-order satisfaction** | avg requester rating (1-5) over period | ratings (Tier 2) | High when present, low when ratings sparse |
| **Cost variance** | sum (actual_invoiced - planned_estimated) / planned_estimated | invoices (Tier 2) | High when present |
| **Schedule adherence** | (orders received within scheduled prep window) / total | status events | High for portal; medium for paper |
| **Compliance currency** | % of time vendor's certifications were current during period | certifications (future) | High when integrated |
| **Recall rate** | (orders requiring rework / re-delivery) / total delivered | status events + tickets | Medium |

### Composite scores

- **Operational quality score** = weighted blend (configurable per tenant): on-time (30%) + ack latency (15%) + decline rate (10%) + completion time (10%) + recall rate (15%) + schedule adherence (20%). Some inputs unavailable for non-portal vendors — composite score downscales gracefully and surfaces which inputs are missing.
- **Customer experience score** = post-order satisfaction (when available; voluntary requester ratings).
- **Cost discipline score** = cost variance (only when invoices flow through platform).
- **Overall grade** = A/B/C/D/F mapped from operational + experience + cost when sufficient data; otherwise displayed as "Limited data — visibility tier: [tier]" instead of a misleading grade.

Tenant admin can adjust weights per tenant via `tenant_scorecard_settings`.

### Vendor visibility tier (a new axis, not a KPI)

Vendors operate at different levels of platform integration. The scorecard surfaces this honestly rather than fabricating data we don't have:

| Visibility tier | What we measure | What we don't | When this happens |
|---|---|---|---|
| **Limited (paper / email only)** | Volume, declines (desk-recorded), complaints, recalls, satisfaction (requester ratings), cost variance (if invoices flow). | On-time, ack latency, completion time, schedule adherence — none of these are reliably measurable. | Vendor receives daglijst PDF or service-desk-forwarded email; no portal interaction. |
| **Partial (occasional portal use)** | Above + sporadic self-reported events when vendor logs in. | Most operational metrics still incomplete. | Vendor logs in to view orders but doesn't update statuses. |
| **Standard (portal-active)** | Above + ack latency + decline events + status transitions when reported. | Some completion time gaps if status updates lag. | Vendor uses portal regularly. |
| **Rich (KDS / mobile / fully integrated)** | All KPIs with high confidence. | — | Vendor uses optimized execution UX (KDS, mobile field-tech). |

The tier is **not** a punishment. It's honest information for the tenant.

**Use of visibility tier in the UI:**
- Per-vendor scorecard header shows tier prominently.
- Tier mix shown at tenant level: "5 vendors at Limited tier, 2 at Standard, 1 at Rich."
- "What you're missing" panel: lists the KPIs unavailable due to tier; explains why; offers migration suggestion.
- Tier transitions are tracked over time — when a vendor moves from Limited to Standard, scorecard updates with the new richer data.

**Why this matters strategically:**

The visibility tier is the lever for the migration story. Tenants see vendor X is at "Limited" → they have less control / less data / less ability to optimize. They negotiate portal adoption with vendor X at next contract renewal because they now have a concrete sales argument: "We need richer visibility to manage your delivery quality." The tenant — not us — pushes the vendor toward platform adoption.

This aligns with the vendor relationship reality: **vendors are managed outside the platform** (contracts, financials, compliance). We can't force adoption. We provide the value-delta that the tenant uses to negotiate adoption with their vendors.

### Tolerance defaults

- On-time tolerance: 15 minutes (configurable per tenant).
- Schedule adherence window: T-30 minutes to T+15 minutes for "on schedule arrival".
- Confidence: numeric 0.0-1.0; surface as label ("High confidence", "Medium", "Low (inferred)").

---

## 4. Data model

### `vendor_scorecards_daily` (materialized aggregation)

Per (tenant, vendor, building, service_type, date) bucket. Partitioned by month for retention + query speed.

```sql
create table vendor_scorecards_daily (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,
  building_id uuid references spaces(id),               -- null = tenant-wide
  service_type text not null,
  bucket_date date not null,

  -- Order volume
  orders_assigned int not null default 0,
  orders_acknowledged int not null default 0,
  orders_declined int not null default 0,
  orders_delivered int not null default 0,
  orders_cancelled int not null default 0,

  -- Latency (in minutes)
  ack_latency_minutes_p50 numeric,
  ack_latency_minutes_p95 numeric,
  completion_minutes_p50 numeric,
  completion_minutes_p95 numeric,

  -- Quality
  on_time_count int not null default 0,
  late_count int not null default 0,
  recall_count int not null default 0,                  -- orders requiring re-delivery / rework
  schedule_adherence_count int not null default 0,

  -- Satisfaction
  ratings_count int not null default 0,
  ratings_sum numeric not null default 0,               -- sum for averaging across days

  -- Financial
  total_revenue numeric not null default 0,             -- sum line totals (estimated)
  total_invoiced numeric,                                -- sum invoiced (when available)
  cost_variance_sum numeric,

  -- Source mix (drives confidence)
  events_self_reported_count int not null default 0,
  events_inferred_count int not null default 0,
  events_desk_override_count int not null default 0,

  -- Metadata
  computed_at timestamptz not null default now(),
  source_data_complete_through timestamptz,             -- last event timestamp considered
  unique (tenant_id, vendor_id, building_id, service_type, bucket_date)
) partition by range (bucket_date);

create index idx_vsd_vendor_date on vendor_scorecards_daily (vendor_id, bucket_date desc);
create index idx_vsd_building on vendor_scorecards_daily (building_id, bucket_date desc);
create index idx_vsd_service_type on vendor_scorecards_daily (tenant_id, service_type, bucket_date desc);
```

Partition by quarter (e.g. `vendor_scorecards_daily_2026q2`); auto-create + drop oldest past retention per `tenant_retention_settings.vendor_scorecards`.

Default retention: 730 days (2 years; capped 1825 days).

### `vendor_scorecard_summary` (rolling-window views)

Computed views for common time horizons:
- `vendor_scorecard_last_30d` — 30-day rolling.
- `vendor_scorecard_last_90d` — 90-day rolling.
- `vendor_scorecard_qtd` / `_ytd` — quarter / year-to-date.

These are query-time aggregations over `vendor_scorecards_daily`, not separate tables.

### `vendor_scorecard_alerts`

Cohort detection results: vendors trending down vs baseline.

```sql
create table vendor_scorecard_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vendor_id uuid not null references vendors(id),
  alert_type text not null check (alert_type in
    ('on_time_dropping','satisfaction_dropping','decline_rate_rising','cost_variance_increasing','recall_rate_rising')),
  detected_at timestamptz not null default now(),
  baseline_period_start date,
  baseline_period_end date,
  current_period_start date,
  current_period_end date,
  delta_value numeric,                                  -- e.g. -15.0 means dropped 15 points
  acknowledged_at timestamptz,
  acknowledged_by_user_id uuid references users(id),
  resolved_at timestamptz,
  resolved_reason text
);

create index idx_alerts_unack on vendor_scorecard_alerts (tenant_id, detected_at) where acknowledged_at is null;
```

### `tenant_scorecard_settings`

Per-tenant weights + thresholds.

```sql
create table tenant_scorecard_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references tenants(id) on delete cascade,
  on_time_tolerance_minutes int not null default 15,
  schedule_adherence_pre_window_minutes int not null default 30,
  schedule_adherence_post_window_minutes int not null default 15,
  weight_on_time numeric not null default 0.30,
  weight_ack_latency numeric not null default 0.15,
  weight_decline_rate numeric not null default 0.10,
  weight_completion_time numeric not null default 0.10,
  weight_recall_rate numeric not null default 0.15,
  weight_schedule_adherence numeric not null default 0.20,
  -- Sum of weights should equal 1.0; validation at app layer
  alert_on_time_threshold_drop numeric not null default 10.0,  -- alert if drops 10+ points
  alert_satisfaction_threshold_drop numeric not null default 0.5,
  alert_decline_rate_threshold_rise numeric not null default 5.0,
  enabled boolean not null default true
);
```

### Audit events

- `scorecard.computed` — nightly aggregation completed for vendor.
- `scorecard.alert_raised` — cohort detection found a trend.
- `scorecard.alert_acknowledged` / `.resolved`.
- `scorecard.csv_exported` — admin downloaded data.
- `scorecard.weights_changed` — tenant adjusted KPI weights.

---

## 5. Aggregation pipeline

### `ScorecardAggregator` worker

Nightly job. Per tenant:

1. **Identify dirty buckets** — (vendor, building, service_type, date) combinations where new events landed since last computation.
2. **Re-aggregate dirty buckets** — for each, scan source events + order_line_items + invoices + ratings → compute KPI counters → upsert `vendor_scorecards_daily` row.
3. **Re-compute rolling-window summaries** — invalidate cached summaries.
4. **Run cohort detection** — for each vendor, compare last 30d baseline vs prior 30d → flag drops > threshold → insert `vendor_scorecard_alerts` rows.
5. **Trigger admin notifications** — for new unacknowledged alerts, send email or in-app notification to tenant admin (configurable cadence).

### Idempotency

- Worker re-runs are safe: dirty bucket detection compares last computed `source_data_complete_through` to current event high-water mark.
- Backfilling is supported: admin triggers `POST /admin/scorecards/recompute?from=YYYY-MM-DD` — recomputes affected buckets.

### Performance

- Dirty bucket count per tenant per day: ~10-50 typical (vendors × service_types × buildings × 1 day).
- Per-bucket compute: <100ms.
- Total nightly window: trivial at our scale.

### Real-time path (out of v1)

For future: when a status event lands, enqueue micro-update to today's bucket. Defer to Tier 2 (most KPIs are forward-looking; nightly is fine).

### 5.5 Multi-source ground truth + confidence resolution

**The data-quality problem:** vendor self-reports are unreliable for two scenarios:
- Paper-only vendors don't self-report at all (status events are time-inferred).
- Some portal vendors deliver fine but lag on status updates ("vendor doing great operationally, terrible reportingly").

A single-source scorecard penalizes both groups unfairly. The aggregator must pick the strongest signal per event — not just trust vendor self-report.

#### Source hierarchy

| Source | Confidence | Notes |
|---|---|---|
| Requester rating + free-text | Highest | "Food arrived 12:25" overrides missing/late vendor event. |
| Desk operator post-delivery confirmation | High | Desk widget confirms on-time. |
| Recall ticket / complaint | High (negative) | Ticket exists = problem; absence = nothing reported. |
| Vendor self-report (portal) | Medium | Trust if matches above; suspect when it conflicts. |
| Time-of-day inference | Low | Default for paper-only; presume-fine until contradicted. |

#### Resolution algorithm per KPI

For each event being aggregated:
1. Collect all available signals.
2. Pick highest-confidence non-conflicting signal.
3. If conflicts exist (e.g. vendor said "delivered 09:00" but requester rated at 14:00 yesterday), prefer higher-confidence source + flag conflict in audit.
4. Compute KPI from chosen signal.
5. Store source + confidence in `vendor_scorecards_daily.signal_sources_used` jsonb + `confidence_score numeric`.

#### Composite score split — Operational vs Reporting

To handle vendors who deliver fine but lag on reporting:

- **Operational quality score** — what actually happened in the real world. Inputs: satisfaction, recall rate, desk-confirmed on-time, complaint absence, schedule adherence (when externally confirmable).
- **Reporting hygiene score** — how well vendor uses the system. Inputs: ack latency, status update frequency vs delivery time, completion time as self-reported.

Default: shown side-by-side; *not* combined into single composite. Tenant can override.

This means: vendor X with 4.5 satisfaction + 0% recalls + 4-hour ack latency gets:
- Operational: ~95/100 (excellent).
- Reporting: ~60/100 (poor).

Admin treats this as a coaching opportunity — push vendor toward portal/KDS — not as a vendor-replacement signal.

#### Paper-only vendor handling

For `vendors.fulfillment_mode = 'paper_only'`:
- Inference-based KPIs (on-time, ack latency, completion) labeled "Low confidence — paper-only" or hidden.
- KPIs that don't depend on self-report shown prominently:
  - Satisfaction (requester ratings).
  - Cost variance (invoice data).
  - Recall rate (ticket data).
  - Decline rate (desk-recorded phone declines).
  - Compliance currency (admin-tracked).
- Default mode = "negative-only signal" — vendor presumed fine; flipped to issue only when negative event lands (recall, low rating, complaint).
- Quarterly migration nudge to admin: "Consider inviting vendor X to portal for better visibility."

#### Desk post-delivery confirmation — exception-only, not routine

**Important:** desk-side confirmation is NOT a routine reporting step. Adding "confirm every delivery" to desk dashboards is friction we explicitly reject. Desk operators don't want to click on every delivery and we don't want to force them.

Instead:
- **Exception-handling only.** When something goes wrong (requester reports issue, recall ticket created, complaint comes in), THEN the desk operator confirms what happened. The negative signal triggers the data capture, not a routine "did this go well?" prompt.
- **Optional opt-in per tenant** for tenants who genuinely want post-delivery confirmation as part of their workflow. Default OFF.
- When used, populates `vendor_order_status_events` with `actor_kind = 'tenant_user'` + `event_source = 'desk_post_delivery_confirmation'`.

This means **paper-only vendors get scored mostly on negative signals + customer ratings** — which is honest about the data we have, rather than fabricating measurements through forced reporting.

#### Manual reconciliation

Admin can mark "delivery actually happened at X" overriding vendor's missing or late event when needed. Used in exception cases (vendor confirmed by phone after the fact; requester provided clear timing in feedback). Audit captures override. Permission-gated. Not a routine activity.

#### Schema additions

Add to `vendor_scorecards_daily`:
```sql
signal_sources_used jsonb,         -- { "on_time_count": "requester+desk", "ack_latency": "vendor_self_report" }
confidence_score numeric,           -- 0.0-1.0; weighted average across KPIs
operational_quality_score numeric,  -- separate composite
reporting_hygiene_score numeric,    -- separate composite
```

#### UI surfacing

- Every KPI tile shows source legend ("Source: requester rating · desk confirmation · vendor self-report").
- Confidence badge per KPI: "High", "Medium", "Low (inferred)".
- Operational + Reporting scores shown side-by-side, not blended by default.
- Tenant setting to combine into single composite (off by default).
- Filter: "Show paper-only vendors with low confidence" — admin can hide noisy data.

---

## 6. Frontend surfaces

### `/admin/vendors/:id` — Performance tab (new)

Add to existing vendor detail page:

```
┌─ Performance ──────────────────────────────────────────────┐
│                                                              │
│ Last 30 days · [Date range ▾]  [Service: All ▾]  [Building: All ▾]
│                                                              │
│ ┌─ Overall grade: B+ ────────────────────────────┐         │
│ │ Operational quality: 87/100 (▲ +3 vs prior 30d)│         │
│ │ Customer experience: 4.3/5 (n=42)               │         │
│ │ Cost discipline: 102% (planned)                 │         │
│ └─────────────────────────────────────────────────┘         │
│                                                              │
│ ┌─ KPI tiles ───────────────────────────────────┐           │
│ │ On-time     93%        ▲ +2pts                │           │
│ │ Ack latency p50: 4 min, p95: 18 min  ▼ -2 min │           │
│ │ Decline rate 2%        — flat                  │           │
│ │ Completion  35 min med ▲ +5 min worse          │           │
│ │ Satisfaction 4.3/5 (n=42)  ▲ +0.2              │           │
│ │ Recalls     1 (out of 184)                     │           │
│ └────────────────────────────────────────────────┘           │
│                                                              │
│ ┌─ Trendlines (last 90d, daily) ────────────────┐           │
│ │ [chart of on-time%, ack latency, decline rate]│           │
│ └────────────────────────────────────────────────┘           │
│                                                              │
│ Source mix: 87% self-reported · 11% inferred · 2% desk-override
│ Data confidence: High                                        │
│                                                              │
│ [Export CSV] [Export PDF] [Compare to another vendor]        │
└──────────────────────────────────────────────────────────────┘
```

### `/admin/vendors/compare?vendor_a=X&vendor_b=Y` (new)

Side-by-side comparison view:

- Two vendors covering same (building, service_type) — admin picks via combobox.
- KPI table: Vendor A | Vendor B | Δ
- Trendline overlay (last 90d).
- "Switch primary vendor" CTA if `vendor_b` outperforms on operational quality + tenant has multi-vendor coverage rules supporting a switch.

### `/admin/scorecards` — tenant-wide overview

- Top of fold: scorecard alerts (unacknowledged trending-down vendors).
- Vendor list with current grade + 30d trend per vendor.
- Filter by service_type, building, grade.
- Export tenant-wide CSV.
- Settings link to `/admin/scorecards/settings` (weights, thresholds, alert config).

### `/admin/scorecards/settings` — tenant config

- Weight sliders for KPI composition.
- Tolerance settings.
- Alert thresholds.
- Scorecard retention setting (links to GDPR baseline).

---

## 7. Reusing components

- **Charts:** existing chart library (`@tanstack/react-charts` or similar — check current stack).
- **Trendline pattern:** matches `/desk/reports/bookings/*` reports.
- **EntityPicker:** vendor + building combobox from rule-builder spec.
- **CSV export:** existing pattern from bookings reports.
- **PDF export:** `@react-pdf/renderer` from daglijst spec.

This is mostly a **data + visualization** spec, not new component infrastructure.

---

## 8. Cohort detection

### Algorithm (per vendor, nightly)

1. **Baseline period:** 30 days ending 30 days ago.
2. **Current period:** last 30 days.
3. **Per KPI delta:** `(current - baseline) / baseline * 100`.
4. **Flag if:**
   - On-time rate dropped > threshold (default 10pts).
   - Satisfaction dropped > threshold (default 0.5pts).
   - Decline rate rose > threshold (default 5pts).
   - Recall rate rose > threshold (default 3pts).
   - Cost variance increased > threshold (default 5%).
5. **Insert alert row** with delta + period boundaries.
6. **Notify tenant admins** with `scorecards:read` permission.

### UI

`/admin/scorecards` shows alerts in priority order:
- Severity (delta magnitude).
- Recency.
- Service criticality (catering > supplies > random).

Per-alert: vendor name, KPI affected, delta, sample evidence ("12 of last 50 deliveries were late vs 4 of prior 50"), CTAs (acknowledge, dismiss, set follow-up).

---

## 9. GDPR alignment

### Data category

`vendor_scorecards` — aggregated operational data; not personal data.

But sub-component **post-order satisfaction ratings** can be tied to specific persons (the rater). Per ratings spec (Tier 2), ratings are anonymized after 90 days from rating date — only aggregate score retained, individual rater ID dropped.

Scorecard view never shows individual ratings — only aggregates (avg + count). Source: anonymized aggregate.

### Cross-cutting

- Read-side audit log captures scorecard views (per `personal_data_access_logs`).
- Permission `scorecards:read` required.
- Per-vendor erasure (vendor relationship ends): aggregates retained for tenant audit window; vendor name preserved (not personal data).

---

## 10. Phased delivery

### Sprint 1 (1 wk): Schema + aggregation foundation

- Migrations: `vendor_scorecards_daily` (partitioned), `vendor_scorecard_alerts`, `tenant_scorecard_settings`.
- `ScorecardAggregator` worker skeleton.
- Default tenant settings seeded.

### Sprint 2 (1 wk): Aggregation logic + nightly worker

- Implement KPI calculations (on-time, ack latency, completion, decline, recall, schedule adherence).
- Wire up source events → bucket dirty detection → re-aggregate.
- Idempotent backfill endpoint.
- Audit events.

### Sprint 3 (1 wk): Per-vendor performance tab UI

- `/admin/vendors/:id/performance` tab.
- KPI tiles + trendline charts.
- Date range / service / building filters.
- CSV + PDF export.
- Source mix indicator + confidence score.

### Sprint 4 (1 wk): Comparison view + cohort alerts + tenant overview

- `/admin/vendors/compare` view.
- Cohort detection algorithm + alerts table population.
- `/admin/scorecards` tenant-wide overview.
- `/admin/scorecards/settings` weights + thresholds.
- Notifications wired (in-app + email for unack'd alerts).

**Total: ~3-4 weeks** elapsed (compressible with parallel work).

---

## 11. Acceptance criteria

1. **Nightly worker computes scorecards** for last 24h of events; populates `vendor_scorecards_daily`.
2. **Tenant admin opens vendor detail → Performance tab** → sees 30-day rolling KPI tiles with trendlines.
3. **KPI source mix is transparent** — admin sees "87% self-reported, 11% inferred, 2% desk-override" + confidence label.
4. **Date range / service / building filters** update tiles + charts within 500ms.
5. **CSV export** delivers full per-day data for selected range.
6. **Comparison view** shows two vendors side-by-side with KPI deltas; "Switch primary vendor" CTA appears when one clearly outperforms + coverage supports switch.
7. **Cohort detection** flags a vendor whose on-time rate dropped 15pts in last 30 days; admin sees alert; can acknowledge with note.
8. **Weights configuration** — admin slides weight sliders for KPIs; composite score recomputes in preview; saves.
9. **Backfill endpoint** can recompute past 90 days of scorecards on demand.
10. **Hybrid mode** vendors aggregate cleanly across paper-inferred and self-reported events; both contribute to same KPI.
11. **Performance:** page load <2s for 90-day vendor scorecard view; CSV export <30s for 365-day data.
12. **GDPR:** scorecard aggregate views never expose individual ratings; satisfaction shows only avg + count.

---

## 12. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| KPI calculations drift between paper-inferred and self-reported (incompatible measurements) | Medium | High | Source distinction always surfaced; confidence score computed; document calculation differences in admin help |
| Aggregation worker fails silently | Medium | High | Drift detection (compare event counts to bucket counts); alert on >5% miss; admin manual recompute available |
| Backfill of 365 days swamps DB | Low | Medium | Chunked + rate-limited; per-tenant advisory lock; runs off-hours |
| Cohort alerts too noisy | High | Medium | Conservative defaults; tenant-tunable thresholds; mute option per vendor |
| Cost variance KPI shipped without invoice integration | High | Low | Mark KPI "Not enough data" until invoice flow ships; ratings KPI same |
| Composite weights misconfigured by admin (sum ≠ 1.0) | Low | Low | UI auto-normalizes; warning if sum substantially off |
| Vendor relationship ends but scorecard data persists indefinitely | Medium | Low | Per GDPR retention; aggregates retained per audit window; vendor name preserved (operational, not personal) |
| Comparison view "Switch primary" CTA fires before manual review | Low | High | CTA opens dialog with confirmation + impact preview; never auto-switches |
| Multi-tenant isolation breaks (vendor data crosses tenants) | Low | Critical | RLS enforced; integration tests verify; per `project_vendors_per_tenant.md` |

---

## 13. Open questions

1. **Composite score defaults — A/B/C/D/F vs 0-100?** Recommend both: numeric score with letter grade label.
2. **Should declined orders count toward "decline rate" only when fallback succeeded vs vendor truly couldn't fulfill?** Recommend both views (raw decline + adjusted-for-fallback).
3. **Weight presets — should we offer "Balanced", "Speed-focused", "Quality-focused" as quick-pick instead of slider authoring?** Recommend yes Tier 2; v1 ships sliders.
4. **Retention: aggregate scorecards 2 years (default) or 5 years (audit cap)?** Recommend 2 years default; tenant override available.
5. **Should tenant admins be able to manually adjust a vendor's KPI** (e.g. mark a late delivery as "external cause, don't count")? Recommend Tier 2 — useful but adds complexity; ship raw v1.
6. **Multi-vendor comparison >2** (compare 3-4 vendors)? Recommend Tier 2.
7. **Anonymized cross-tenant industry benchmarks** ("your on-time rate vs median across NL corporate HQ tenants")? Recommend defer until customer demand + privacy framework.
8. **Should vendor see its own scorecard in vendor portal Phase B?** Recommend Tier 2 — not in this spec.

---

## 14. Out of scope

- Vendor-side scorecard view (Tier 2).
- Predictive analytics (Tier 3).
- Procurement system integration (Tier 3).
- Real-time scorecard updates.
- Cross-tenant benchmarks.
- Vendor compensation / penalty automation.
- Manual KPI adjustments / overrides (Tier 2).

---

## 15. References

- [`docs/booking-services-roadmap.md`](../../booking-services-roadmap.md) §9.1.3.
- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §F7 + §G8.
- [`docs/competitive-benchmark.md`](../../competitive-benchmark.md) — ServiceChannel + Planon Insights benchmarks.
- Sibling specs:
  - [Daglijst (Phase A)](2026-04-27-vendor-portal-phase-a-daglijst-design.md) — status inference source.
  - [Vendor portal (Phase B)](2026-04-27-vendor-portal-phase-b-design.md) — self-reported source.
  - [GDPR baseline](2026-04-27-gdpr-baseline-design.md) — ratings anonymization, retention.
  - [Visual rule builder](2026-04-27-visual-rule-builder-design.md) — coverage rules backing "Switch primary" CTA.
- Memory:
  - `project_vendor_fulfillment_reality.md` — 3 modes drive source mix.
  - `project_industry_mix.md` — corporate HQ patterns.
  - `feedback_quality_bar_comprehensive.md` — comprehensive scope.

---

**Maintenance rule:** when implementation diverges from this spec, update spec first, then code. When adding a new KPI, update §3 taxonomy + §4 schema + §10 phased delivery.
