# GDPR Baseline — Design Spec

**Date:** 2026-04-27
**Status:** Design — pending implementation
**Owner:** TBD
**Estimated effort:** 5-6 weeks (engineering); legal/policy work runs in parallel
**Roadmap location:** `docs/booking-services-roadmap.md` §9.1.13; `docs/booking-platform-roadmap.md` §G14, §A9, §E5.

**Why this spec exists:** every EU customer requires GDPR-aligned data handling — DPA, retention, right-of-access, right-of-erasure, audit log of personal-data reads, EU data residency. This is **mandatory**, not optional, regardless of customer size. Without it, we cannot sell a single EU contract through procurement. Beyond compliance, this is also the foundation other specs depend on: MS Graph integration cascades calendar PII through these mechanisms; daglijst PDFs route through retention rules; ghost persons from Outlook attendees route through erasure cascade.

**Context:**
- [`docs/booking-services-roadmap.md`](../../booking-services-roadmap.md) §9.1.13.
- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §G14, §A9, §E5.
- Memory: `project_gdpr_baseline.md` — visitor retention nuance (LIA + tenant-configurable, not hard 90d rule); departure cleanup pattern.
- Memory: `project_market_benelux.md` — NL/BE primary; AP (Autoriteit Persoonsgegevens) is the supervisory authority.
- Memory: `feedback_quality_bar_comprehensive.md` — comprehensive scope, not lean.
- Sibling specs: MS Graph integration (calendar content treatment); daglijst (PDF retention).

---

## 1. Goals + non-goals

### Goals

1. **DPA + privacy notice + sub-processor disclosure procurement-ready** so sales never blocks on "do you have a DPA?".
2. **Tenant-configurable retention per data category** with LIA (Legitimate Interest Assessment) tooling + sensible defaults + upper caps.
3. **Anonymization-first retention** — preserve operational analytics while removing PII at the right moment.
4. **Per-person right of access** — admin-initiated full export of all data for a person within 30 days SLA.
5. **Per-person right of erasure** — admin-initiated delete-or-anonymize with legal-retention exception handling.
6. **Right of rectification + portability** — covered by export endpoint + standard edit UX.
7. **Read-side audit log** — record every access to personal data (not just writes) with tenant-isolated query surface.
8. **Departure cleanup** — when a person leaves (`persons.left_at` set), cascade through all their PII per defined schedule.
9. **EU data residency** — verified Supabase region; sub-processors documented; transfer impact assessments where needed.
10. **Breach notification runbook** — internal process, customer comms templates, AP notification path.
11. **Records of Processing Activities (Art. 30)** — internal documentation living in code/repo, not as a Word doc.
12. **Foundation for SOC 2 / ISO 27001** — audit outbox pattern, segregated backups, key management. The certifications themselves are Tier 3, but the practices that enable them ship now.

### Non-goals

- **SOC 2 Type II audit certification** — Tier 3, only when enterprise pipeline demands it.
- **ISO 27001 / 27701 certification** — Tier 3.
- **Self-serve subject-access UI for end-users** — Tier 2 (admin-mediated covers v1; self-serve when customer demand emerges).
- **Granular consent management** for special categories beyond allergens — Tier 2.
- **Health-data special handling for hospital sub-segment** — Tier 3, niche.
- **Children's data protections** — out of scope (we don't target schools at this depth).
- **Cross-border transfer impact assessments for new sub-processors** — case-by-case, not specced here.
- **Data Protection Officer appointment** — legal/governance question, not engineering.

---

## 2. Architecture overview

### Module layout

**`PrivacyComplianceModule`** (`apps/api/src/modules/privacy-compliance/`):
- `RetentionService` — defines categories, applies retention windows, anonymizes records.
- `RetentionWorker` — nightly background job that drives anonymization + deletion.
- `DataSubjectService` — fulfills access / erasure / portability requests.
- `AuditReadService` — captures personal-data read events.
- `PrivacyNoticeService` — manages per-tenant privacy notice URLs.
- `SubProcessorService` — public sub-processor disclosure page + tenant subscription.
- `LegalHoldService` — pauses anonymization when active dispute / legal hold exists.

**Data category registry** (`apps/api/src/modules/privacy-compliance/categories/`):
Each PII-bearing entity registers a "data category" with its own retention rules + anonymization adapter. Categories at v1:
- `visitor_records`
- `visitor_photos_ids`
- `cctv_footage` (placeholder — we don't store CCTV today)
- `person_preferences`
- `person_ref_in_past_records`
- `past_bookings`
- `past_orders`
- `audit_events`
- `personal_data_access_logs`
- `calendar_event_content`
- `calendar_attendees_snapshot`
- `daglijst_pdfs`
- `email_notifications`
- `webhook_notifications`
- `ghost_persons` (per MS Graph spec — auto-created from Outlook attendees)
- `vendor_user_data` (vendor portal users — separate from main person data)

Each category has an adapter implementing:
```typescript
interface DataCategoryAdapter {
  category: string;
  description: string;
  default_retention_days: number;
  cap_retention_days: number | null;     // null = no cap; only for tenants with audit obligations
  legal_basis: 'legitimate_interest' | 'consent' | 'legal_obligation' | 'contract';
  scanForExpired(tenantId: string, retentionDays: number): Promise<EntityRef[]>;
  anonymize(entityRefs: EntityRef[]): Promise<void>;
  hardDelete(entityRefs: EntityRef[]): Promise<void>;
  exportForPerson(personId: string): Promise<ExportSection>;
  erasureRefs(personId: string): Promise<EntityRef[]>;  // entities to erase for this person
}
```

This makes adding new PII-bearing entities mechanical: implement the adapter, register the category. Retention worker, export, erasure all just work.

### Background workers

Nightly + on-demand:
- **RetentionWorker** — scan each registered category, find expired records, anonymize or delete per category rules. Idempotent + chunked.
- **DepartureCleanupWorker** — for each `persons.left_at` set today, schedule cascade tasks per category.
- **DriftDetectionWorker** — verify retention rules are being applied; alert if mismatched.

### Storage

- Most data already lives in Postgres. Anonymization = update-in-place to PII fields.
- PDFs / files (daglijst, photo proof) in Supabase Storage. Anonymization = file delete (no PII to scrub inside).
- Audit reads in Postgres via outbox pattern.

---

## 3. Data model

### Schema additions

#### `tenant_retention_settings`

Per-tenant per-category retention configuration with LIA documentation.

```sql
create table tenant_retention_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  data_category text not null,                 -- matches DataCategoryAdapter.category
  retention_days int not null,                 -- effective window
  cap_retention_days int,                      -- nullable; if non-null, retention_days <= cap_retention_days
  lia_text text,                               -- tenant's Legitimate Interest Assessment justification
  lia_text_updated_at timestamptz,
  lia_text_updated_by_user_id uuid references users(id),
  legal_basis text not null check (legal_basis in
    ('legitimate_interest','consent','legal_obligation','contract')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, data_category)
);
```

Defaults seeded per data category on tenant creation. Admin can shorten; can't extend past cap.

#### `personal_data_access_logs`

Read-side audit log. Volume is high — separate table from main `audit_events` for indexing + retention.

```sql
create table personal_data_access_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  accessed_at timestamptz not null default now(),
  actor_user_id uuid references users(id),     -- who accessed (nullable for system access)
  actor_role text,                              -- admin | desk_operator | api | system | vendor_user
  actor_ip_hash text,                           -- hashed; raw IP not stored
  actor_user_agent_hash text,                   -- hashed
  subject_person_id uuid,                       -- whose data was accessed
  data_category text not null,                  -- matches DataCategoryAdapter.category
  resource_type text not null,                  -- bookings | orders | visitors | etc.
  resource_id uuid,
  access_method text not null,                  -- list_query | detail_view | export | search
  query_hash text                               -- hash of query params (for grouping)
);

create index idx_pdal_subject on personal_data_access_logs (tenant_id, subject_person_id, accessed_at);
create index idx_pdal_actor on personal_data_access_logs (tenant_id, actor_user_id, accessed_at);
create index idx_pdal_retention on personal_data_access_logs (accessed_at);
```

This table itself has retention (default 365 days; cap 730).

#### `data_subject_requests`

Track right-of-access + right-of-erasure requests for SLA + audit.

```sql
create table data_subject_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  request_type text not null check (request_type in ('access','erasure','rectification','portability','objection')),
  subject_person_id uuid not null references persons(id),
  initiated_by_user_id uuid references users(id),  -- admin who triggered (or person themselves for self-serve)
  initiated_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending','in_progress','completed','denied','partial')),
  decision_reason text,                            -- if denied or partial, the explanation
  scope_breakdown jsonb,                           -- which data categories were processed, what was retained
  output_storage_path text,                        -- for access/portability: signed link to export bundle
  output_url_expires_at timestamptz
);

create index idx_dsr_pending on data_subject_requests (tenant_id, status) where status in ('pending','in_progress');
create index idx_dsr_subject on data_subject_requests (tenant_id, subject_person_id);
```

#### `legal_holds`

Active legal holds that pause anonymization on specific persons or data categories.

```sql
create table legal_holds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  hold_type text not null check (hold_type in ('person','category','tenant_wide')),
  subject_person_id uuid references persons(id),
  data_category text,
  reason text not null,
  initiated_by_user_id uuid not null references users(id),
  initiated_at timestamptz not null default now(),
  expires_at timestamptz,                          -- null = until manually released
  released_at timestamptz,
  released_by_user_id uuid references users(id)
);

create index idx_legal_holds_active on legal_holds (tenant_id, hold_type) where released_at is null;
```

Retention worker checks legal holds before anonymizing.

#### Schema additions to existing tables

```sql
-- Persons: ensure left_at exists (verify per existing schema; add if missing)
alter table persons
  add column if not exists left_at timestamptz,
  add column if not exists is_external boolean not null default false,
  add column if not exists kind text not null default 'employee'
    check (kind in ('employee','contractor','external','ghost')),
  add column if not exists last_seen_in_active_booking_at timestamptz;

-- Visitors: explicit retention timestamp
alter table visitors
  add column if not exists anonymized_at timestamptz,
  add column if not exists hard_deleted_at timestamptz;
```

Mirror columns on any other PII-bearing entity discovered during implementation sweep.

#### Default retention windows (seeded per tenant on creation)

| Data category | Default days | Cap days | Legal basis | Notes |
|---|---|---|---|---|
| visitor_records | 180 | 365 | legitimate_interest | Visitor name + host + visit timestamp. EU norm. |
| visitor_photos_ids | 90 | 180 | legitimate_interest | Higher sensitivity. |
| cctv_footage | 28 | 28 | legitimate_interest | Hard cap; no extension via UI. |
| person_preferences | 30 | 30 | contract | Days from `left_at`. |
| person_ref_in_past_records | 90 | 90 | contract | Days from `left_at`. After this, name anonymized but record retained. |
| past_bookings | 2555 | null | legal_obligation | 7 years for NL accounting; no cap. |
| past_orders | 2555 | null | legal_obligation | Same. |
| audit_events | 2555 | null | legal_obligation | Same. |
| personal_data_access_logs | 365 | 730 | legitimate_interest | Audit-of-audit. |
| calendar_event_content | 0 | 0 | n/a | Not warehoused — fetched on demand. |
| calendar_attendees_snapshot | 90 | 365 | legitimate_interest | Days from booking cancellation. |
| daglijst_pdfs | 90 | 365 | legitimate_interest | Operational record. |
| email_notifications | 30 | 365 | legitimate_interest | Sent email log retention. |
| webhook_notifications | 30 | 365 | legitimate_interest | Per MS Graph spec. |
| ghost_persons | 365 | 730 | legitimate_interest | Auto-created from Outlook attendees per MS Graph spec. |
| vendor_user_data | 730 | 1825 | contract | Active vendor account; days from last login or vendor relationship end. |

### Audit event types

- `gdpr.retention_anonymized` — record(s) anonymized by retention worker.
- `gdpr.retention_hard_deleted` — record(s) deleted (categories without anonymization path).
- `gdpr.access_request_initiated` / `_fulfilled` / `_denied`.
- `gdpr.erasure_request_initiated` / `_fulfilled` / `_denied` / `_partial`.
- `gdpr.legal_hold_placed` / `_released`.
- `gdpr.lia_updated` — admin updated LIA text for a category.
- `gdpr.retention_setting_changed` — admin changed retention_days (always paired with a reason field).
- `gdpr.read_personal_data` — alias for `personal_data_access_logs` writes.

All emitted via existing audit outbox pattern.

---

## 4. Retention service + worker

### `RetentionService`

```typescript
class RetentionService {
  registerCategory(adapter: DataCategoryAdapter): void;
  getCategorySettings(tenantId: string, category: string): TenantRetentionSettings;
  setCategorySettings(tenantId: string, category: string, settings: Partial<TenantRetentionSettings>, actorUserId: string): Promise<void>;
  scanExpired(tenantId: string, category: string): Promise<EntityRef[]>;
  applyRetention(tenantId: string, category: string, dryRun: boolean): Promise<RetentionApplyResult>;
}
```

Tenant settings change requires:
- Permission `gdpr:configure`.
- Reason field captured.
- LIA text required if extending vs default.
- Audit event.

### `RetentionWorker` — nightly job

```
For each tenant:
  For each registered data_category:
    settings = getCategorySettings(tenant, category)
    expired = adapter.scanForExpired(tenant, settings.retention_days)
    Filter out: anyEntities under active legal_holds
    Apply: adapter.anonymize(filtered) OR adapter.hardDelete(filtered) per category type
    Emit audit per batch
    Continue to next category
Run drift check: did we expect to anonymize N, did we anonymize N?
Alert tenant admin if N > threshold (e.g. 1000 records anonymized in one night)
```

Idempotency: anonymization/deletion sets a flag (`anonymized_at` etc.) so re-runs skip already-processed records.
Chunking: process in batches of 1000 to avoid long-running transactions.
Lock: per-tenant per-category advisory lock prevents double-processing.

### Anonymization patterns

Per category, the adapter defines what "anonymize" means:

- **visitor_records:** replace `name`, `email`, `host_email` with hash placeholder. Keep `visit_timestamp`, `building_id` for analytics.
- **person_ref_in_past_records:** replace `persons.name`, `persons.email`, `persons.phone` with `Former employee #<hash>`. `id` preserved for FK integrity.
- **calendar_attendees_snapshot:** clear the `calendar_attendees` JSONB; keep booking record.
- **audit_events:** replace `actor_email`, `subject_email` with hashes. Keep event_type + timestamps.

For categories without an anonymization path (e.g. `cctv_footage`, `daglijst_pdfs`), `hardDelete` is the only operation.

### Restore window (for accidental retention errors)

For 7 days after anonymization, the original PII is recoverable from a temporary `anonymization_audit` table (encrypted, admin-only). After 7 days, hard-purged. Lets us recover from bad config or buggy adapter without permanently losing data on day 1.

---

## 5. Departure cleanup

When `persons.left_at` is set:

1. Trigger immediately on save: deactivate auth (existing), revoke all sessions.
2. Schedule cascade tasks via `DepartureCleanupWorker`:
   - **+0 days:** delete `vendor_user_data` if applicable; revoke API keys.
   - **+30 days:** delete `person_preferences` (favorites, dietary, custom contacts).
   - **+90 days:** anonymize `person_ref_in_past_records` (`persons.name`, `email`, `phone` → placeholder). FK integrity preserved.
   - **+90 days:** anonymize `calendar_attendees_snapshot` for any active booking referencing this person.
   - **+90 days:** anonymize `personal_data_access_logs` referencing this person as subject (cascade).
3. `past_bookings`, `past_orders`, `audit_events` are retained per their own categories (typically 7 years for NL accounting); reference to person becomes the anonymized placeholder.

Per-tenant overrides allow extending or shortening the windows, with LIA documentation.

---

## 6. Right of access + erasure + portability

### Access (Art. 15) + Portability (Art. 20)

`POST /admin/gdpr/persons/:id/access`:
1. Verify caller has `gdpr:fulfill_request` permission.
2. Create `data_subject_requests` row with type=access.
3. Trigger background job: each adapter's `exportForPerson()` runs.
4. Aggregate results into single JSON export bundle:
   ```json
   {
     "request": { "id": "...", "subject_person_id": "...", "fulfilled_at": "..." },
     "person_record": { ... },
     "preferences": { ... },
     "bookings": [ ... ],
     "orders": [ ... ],
     "visitors_as_host": [ ... ],
     "audit_events": [ ... ],
     "calendar_attendees_snapshots": [ ... ],
     "daglijst_appearances": [ ... ]
   }
   ```
5. Optionally also produce CSV per category (portability format).
6. Upload to Supabase Storage with signed URL (TTL 30 days).
7. Update request row with output URL.
8. Email subject (or admin) with download link.

SLA: 30 days max (GDPR requirement). Goal: <24 hours typical.

### Erasure (Art. 17)

`POST /admin/gdpr/persons/:id/erase`:
1. Verify caller has `gdpr:fulfill_request` permission + reason captured.
2. Create `data_subject_requests` row with type=erasure.
3. Check for **erasure exceptions:**
   - Active legal hold on this person → deny request, document.
   - Legal retention obligation (e.g. ongoing dispute) → partial erasure (anonymize but retain records).
   - Active contractual obligation → admin must confirm override.
4. For each adapter: call `erasureRefs(personId)` → entities to erase.
5. Apply: anonymize where possible; hard delete where not.
6. Update request status (completed / partial / denied).
7. Audit captures full chain.

Default behavior is **anonymize, not hard-delete** — preserves operational records while removing PII. Hard-delete only on explicit subject demand + legal review.

### Rectification (Art. 16)

Mostly handled by normal admin "edit person" UI. Right-of-rectification request specifically:
- Subject identifies inaccurate data.
- Admin updates record.
- Audit captures the change.
- No special endpoint needed beyond regular CRUD.

### Self-serve subject access (Tier 2 — deferred)

Stub endpoint planned: `GET /portal/me/data/export`. End-user initiates own access request without admin mediation. Defer to Tier 2 — admin-mediated covers v1.

---

## 7. Read-side audit log

### What to log

Every read of personal data records the access in `personal_data_access_logs`:
- Listing of bookings → log per page accessed (with `data_category=past_bookings`).
- Detail view of a person → log the read.
- Search results returning persons → log the search.
- Export endpoints → log the export.
- API queries returning person/visitor data → log per request.

### How to instrument

Implementation choices:

- **Option A — middleware-based:** intercept HTTP requests to PII-returning endpoints; log per request.
- **Option B — service-layer:** every service method returning person/visitor data emits an access event.
- **Option C — DB-level triggers:** PostgreSQL triggers on SELECT (not standard; expensive).

Recommendation: **Option B — service-layer** — explicit, performant, testable. Wrap critical service methods with `@LogPersonalDataAccess('booking_detail')` decorator (NestJS).

### Volume + retention

At scale, this can be high-volume (every page load logs a read). Mitigations:
- Batch inserts (queue → flush every 5s).
- Aggregate similar reads in same session (one log per user-session-resource-5min window).
- Retention 365 days default (cap 730).
- Compressed cold storage for >180 day data (defer optimization).

### Admin query surface

`/admin/gdpr/access-log?subject=person_id` — admin can run "who accessed Marleen V.'s data in last 90 days?" report.
- Permission: `gdpr:audit_reads`.
- Output: paginated list with timestamp + actor + resource + access_method.
- Export to CSV.

---

## 8. Privacy notice + sub-processor disclosure

### Privacy notice

Per-tenant configurable privacy notice URL: `tenants.privacy_notice_url`.
- Default to global `https://prequest.app/privacy` if not set.
- Linked from app footer in every surface (admin, portal, vendor, kiosk).
- Tenant settings page allows override.

### Sub-processor disclosure

Public page at `/legal/sub-processors` — versioned list of sub-processors:

```
Current sub-processors (as of 2026-04-27):
- Supabase (database, auth, storage) — EU regions (Frankfurt)
- Postmark/Resend (email delivery) — EU regions
- Microsoft (Graph API + Bot Service) — EU regions when tenant-resident
- [...]
```

Each row has: name, purpose, data categories shared, region, DPA reference.

Tenants can subscribe to email notifications when sub-processor list changes.

### DPA template

Legal/policy work, not engineering. Output: standard DPA document procurement-ready. Sales has it ready to send.

Engineering integration: tenant onboarding flow can capture "DPA signed: yes/no/N/A" + signed timestamp + signer email.

---

## 9. Breach notification runbook

Mostly process, not engineering. Documented in:
- `docs/operations/breach-notification.md` (new).

Outline:
1. **Detection:** how breaches are identified (alerts, audit anomalies, customer reports).
2. **Triage:** is it a breach? (confidentiality / integrity / availability impact).
3. **Containment + investigation.**
4. **AP notification (NL):** within 72 hours via AP's reporting form.
5. **Customer notification:** templated email per affected customer with details, what happened, what we're doing, what they should do.
6. **Subject notification:** when high-risk to the data subjects, notify them directly without undue delay.
7. **Post-mortem:** internal review; update controls.

Engineering supports: automated alerts on suspicious access patterns (multi-record export by single user, off-hours access, etc.). Configurable thresholds; alerts to security@.

Annual tabletop exercise to test the runbook.

---

## 10. EU data residency + sub-processor controls

### Verification checklist (one-time)

- [ ] Supabase project provisioned in EU region (Frankfurt or Amsterdam).
- [ ] Supabase Storage bucket(s) in EU region.
- [ ] All sub-processors hosting PII are in EU OR have valid SCC + transfer impact assessment.
- [ ] Microsoft Graph traffic flows through EU regions when tenant's Azure AD tenant is EU-resident.
- [ ] Backup destinations are EU regions.
- [ ] Logging / monitoring tools (Sentry, etc.) — verify EU regions or accept SCC.

### Ongoing controls

- **Sub-processor change requires tenant notification** — email + sub-processors page version bump.
- **No cross-border transfers without DPA + SCC.**
- **Data residency setting per tenant** — most tenants default to EU; future API for tenants to specify residency preference (Tier 3, requires multi-region infra).

---

## 11. Records of Processing Activities (Art. 30)

Internal documentation living in `docs/compliance/records-of-processing-activities.md` (new):

For each data processing activity:
- Purpose.
- Lawful basis.
- Categories of data subjects.
- Categories of personal data.
- Recipients (sub-processors, internal teams).
- Retention period.
- Security measures.

Structured format (machine-parseable yaml or JSON) so we can generate exports for audits.

Tenant-level RoPA generated from product RoPA + tenant-specific configuration (retention overrides, integrations enabled). Available as PDF download in admin settings.

---

## 12. Frontend surfaces

### `/admin/settings/privacy` — Privacy & data settings page

Single page using `SettingsPageShell` width=`xwide`:

**Section: Privacy notice**
- `SettingsRow` privacy_notice_url — input (defaults to global Prequest URL).
- `SettingsRow` data residency — read-only display ("Your data is hosted in: Frankfurt (EU)").
- Link to sub-processor disclosure page.

**Section: Retention policies**
- Table of data categories: name, description, current retention days, default, cap, legal basis, LIA text (truncated), edit button.
- Edit row → opens dialog with retention slider, LIA text editor, "save reason" required.
- Dialog warns when extending retention close to cap.

**Section: Legal holds**
- Active holds table: type, subject, reason, initiated by, expires.
- "Place hold" button → form (person picker / category / tenant-wide, reason, expires).
- Release action per row (with reason + audit).

**Section: Data subject requests**
- List of pending + recent completed requests.
- Row: type, subject (anonymized after 30 days for privacy), status, link to detail.
- Detail page shows full chain.

**Section: Records of Processing Activities**
- Generate-and-download PDF button.
- Quarterly auto-emailed to compliance contact (configurable).

### `/admin/persons/:id/gdpr` — Per-person GDPR actions

Tab on existing person detail page:
- **Right of access** — "Export all data" button → triggers access request → email link to admin.
- **Right of erasure** — "Erase data" button → opens confirmation dialog with reason input + erasure type (full / anonymize-only) → submit → triggers erasure request.
- **Read-side audit** — "Who accessed this data?" → shows access log (last 90 days; expandable to last year).
- Permission gated: `gdpr:fulfill_request`.

### Tenant onboarding wizard addition

When a tenant first signs up, add a step:
- "Confirm data residency: Frankfurt (EU)" — informational.
- "Sign Data Processing Agreement" — link to DPA + signature capture.
- "Configure privacy notice" — set custom URL or use Prequest default.
- "Identify privacy contact" — email + role.

### Footer / header surfaces

- Privacy notice link in app footer (every surface).
- Sub-processor list link.
- Cookie banner if tracking is enabled (Tier 2 — depends on analytics).

---

## 13. Performance + scale

### Retention worker

- Nightly per-tenant per-category. ~16 categories × 50 tenants = 800 scan-and-apply runs per night.
- Most categories: <1000 expired records per night per tenant. Trivial.
- High-volume categories (audit_events, personal_data_access_logs): may be 100k+ expired rows per night per tenant — chunk + rate-limit.
- Total nightly runtime budget: <30 minutes wall clock.

### Read-side audit log

- High-write volume. Use Postgres native partitioning by month + auto-drop oldest partition past retention.
- Batched writes via outbox pattern.
- Indexes optimized for "by subject" and "by actor" queries.

### Export bundle generation

- Per-person export = O(N data categories × queries per category). Typically <100MB JSON, <10s generation.
- Streaming for large exports (rare).

### Erasure cascade

- Involves multiple table updates. Done in a transaction.
- O(person's data footprint). Typically <5s.

### Audit volume

- Expect 1-10 read events per page load. At 1000 active users × 100 page views/day = 100k-1M read events/day.
- Storage: ~200 bytes per row → ~40-200 GB/year per active tenant.
- Mitigation: aggregate similar reads in same session (5-min window); cold storage for >180d.

---

## 14. Security

### Encryption

- TLS in transit (existing).
- Postgres encryption at rest (Supabase default).
- Supabase Storage encryption (default).
- Pgsodium for additional sensitive fields (vendor secrets, PII tokens).

### Access control

- `gdpr:configure` — change retention settings.
- `gdpr:fulfill_request` — initiate access/erasure requests.
- `gdpr:audit_reads` — query personal-data access logs.
- `gdpr:place_legal_hold` — start legal holds.
- All gated; default off for non-admin roles.

### Multi-factor authentication

- MFA required for admins with any `gdpr:*` permission. Non-MFA logins blocked from these endpoints.
- Existing Supabase auth supports TOTP — enable + enforce.

### Anomaly detection

- Multi-record export by single actor → alert.
- Off-hours access from unusual IP → alert.
- Bulk read of restricted persons (e.g. CEO, board) → alert.
- Threshold-based; configurable per tenant.

---

## 15. Phased delivery

### Sprint 1 (2 wks): Foundation

- Schema migrations (`tenant_retention_settings`, `personal_data_access_logs`, `data_subject_requests`, `legal_holds`).
- Data category registry + adapter interface.
- `RetentionService` + `RetentionWorker` skeleton.
- Default retention seeding on tenant create.
- Audit event types.

### Sprint 2 (1 wk): Adapters

- Implement adapters for all v1 data categories.
- Anonymization functions per category.
- 7-day restore window infrastructure.

### Sprint 3 (1 wk): Read-side audit + access endpoint

- Service-layer instrumentation via `@LogPersonalDataAccess` decorator.
- Wrap critical PII-returning service methods.
- Per-person export endpoint + bundle generator.

### Sprint 4 (1 wk): Erasure + admin UI

- Per-person erasure endpoint.
- `/admin/settings/privacy` page (full spec).
- `/admin/persons/:id/gdpr` tab.
- Legal holds UI.

### Sprint 5 (~3 days): Breach runbook + RoPA

- Breach notification runbook + email templates.
- RoPA documentation in repo.
- Onboarding wizard additions.

**Total: ~5-6 weeks** (compressible to ~4 with two engineers parallel).

---

## 16. Acceptance criteria

1. Tenant admin can change visitor retention from default 180 days to 365 days, capped at 365, with required LIA text → saved → audit captured.
2. Admin attempts to change to 730 days → blocked by cap; UI shows "Cap is 365 days; contact support to discuss legal exception".
3. Nightly retention worker anonymizes visitor records past their retention window → audit captured per batch → admin sees count in privacy dashboard.
4. Admin places legal hold on Person X → retention worker excludes X's records from anonymization → hold released after dispute resolved → next nightly run resumes anonymization.
5. Admin initiates right-of-access for Person Y → request row created → background job runs → export bundle uploaded → admin gets email with signed link → 30-day-TTL link works.
6. Admin initiates right-of-erasure for Person Y → confirms with reason → erasure request executed → person's PII anonymized across all categories → audit captures full chain.
7. Person Y signs into the system 30 days post-erasure → no name shown; sees "Former employee" in their own past records (anonymization is destructive).
8. Person Z is set as `left_at` → 30 days later their preferences are deleted → 90 days later their name is anonymized in past records → past bookings retain integrity.
9. Admin runs "Who accessed Person W's data in last 90 days?" → audit log returns paginated list → CSV export available.
10. Sub-processor list page is publicly accessible at `/legal/sub-processors` → tenant can subscribe to changes via email.
11. Tenant onboarding wizard captures DPA signature + privacy contact + data residency confirmation.
12. Quarterly auto-email of RoPA to tenant compliance contact.
13. Breach notification runbook lives in `docs/operations/breach-notification.md` with customer comms templates.
14. EU data residency verified: Supabase project + Storage + sub-processors all in EU.

---

## 17. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Adapter coverage incomplete (PII-bearing entity not registered) | Medium | High | Mandatory checklist in PR template: any new table with PII must register adapter; CI lint fails on missing registration |
| Retention worker silently fails on one category | Medium | High | Drift detection nightly; alert if expected anonymizations don't happen; restore window for accidental over-anonymization |
| Anonymization breaks FK integrity | Medium | High | Anonymize PII fields only; never delete primary keys; thorough testing per adapter |
| Read-side audit log volume crashes DB | Low | High | Native partitioning by month; cold-storage path for >180d |
| Export bundle leaks data via misconfigured signed URL | Low | Critical | TTL ≤ 30 days; one-time-use option for high-sensitivity; admin re-generation required after expiry |
| Erasure request denied incorrectly (over-broad legal-hold interpretation) | Low | High | Independent review for denials; tenant escalation path; documented decision criteria |
| Performance impact of read-side audit log on hot endpoints | Medium | Medium | Async write via outbox; instrumentation behavior tested at scale |
| LIA text becomes a checkbox-tickbox without thought | Medium | Low | Force admin to update LIA when changing retention; require minimum length; surface in audit |
| Multi-tenant DB bloat from PII access logs | Medium | Medium | Per-tenant partitioning; cold storage; configurable retention |
| Compliance work incomplete at sales handoff (DPA missing for prospect) | Low | High | DPA template + sub-processor list + privacy notice ready before any sales motion |

---

## 18. Open questions

1. **Default retention for past_bookings: 7 years (NL accounting) or shorter for non-financial bookings?** Recommend 7y for orders (financial); 2y for non-financial bookings; allow tenant override. Discuss with legal counsel.
2. **Anonymization vs hard-delete on erasure request — default anonymize?** Recommend anonymize (preserves integrity); hard-delete only on explicit subject demand + legal review.
3. **Should we record IP addresses in audit logs raw or hashed?** Recommend hashed (with tenant-specific salt). Forensic value of raw IP is low in our context.
4. **MFA enforcement timeline — gate from day 1 or grace period?** Recommend gate from day 1 for `gdpr:*` permissions; grace period for general admin (configurable per tenant).
5. **Self-serve subject access via portal — Tier 2 priority?** Confirm with leadership when first enterprise customer asks.
6. **Anomaly detection sensitivity** — per-tenant configurable thresholds? Recommend yes; document defaults.
7. **DPO appointment** — do we need one ourselves? Threshold question for legal.
8. **Cookie consent / tracking consent** — out of scope here; align with whatever analytics decisions get made.
9. **Cross-border transfer of operational data (e.g. Sentry telemetry)** — accept SCC or move to EU-only telemetry vendor?

---

## 19. Out of scope

- SOC 2 Type II audit certification.
- ISO 27001 / 27701 certification.
- Self-serve subject access (Tier 2).
- Granular consent management beyond allergens (Tier 2).
- Health-data special handling (Tier 3).
- Children's data protections.
- DPO appointment.
- Automated transfer impact assessments.
- Ongoing legal counsel for jurisdiction-specific edge cases.

---

## 20. References

- [`docs/booking-services-roadmap.md`](../../booking-services-roadmap.md) §9.1.13.
- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §G14, §A9, §E5.
- [`docs/competitive-benchmark.md`](../../competitive-benchmark.md) — Planon + deskbird as GDPR benchmark.
- Sibling specs:
  - [MS Graph integration](2026-04-27-microsoft-graph-integration-design.md) — calendar PII handling.
  - [Daglijst](2026-04-27-vendor-portal-phase-a-daglijst-design.md) — PDF retention.
  - [Visual rule builder](2026-04-27-visual-rule-builder-design.md) — admin permissions.
- Memory:
  - `project_gdpr_baseline.md` — strategic context + visitor retention nuance.
  - `project_market_benelux.md` — NL/BE primary; AP supervisory authority.
  - `project_legacy_replacement.md` — migration timing.
  - `feedback_quality_bar_comprehensive.md` — comprehensive scope.
- External references:
  - GDPR Articles 5, 15-22, 25, 30, 32, 33-34.
  - EU Reg 1169/2011 (FIC) — allergen labeling.
  - Autoriteit Persoonsgegevens guidance on visitor retention.
  - Microsoft Customer DPA (sub-processor reference).

---

**Maintenance rule:** when implementation diverges from this spec, update the spec first, then code. When new PII-bearing entities are added to the platform, register a data category adapter + update §3 default retention table. Same convention as `docs/assignments-routing-fulfillment.md`.
