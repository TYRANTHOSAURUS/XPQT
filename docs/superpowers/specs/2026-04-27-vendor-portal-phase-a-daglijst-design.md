# Vendor Portal Phase A — Daglijst (Daily List) — Design Spec

**Date:** 2026-04-27
**Status:** Design — pending implementation
**Owner:** TBD
**Estimated effort:** 2-3 weeks
**Roadmap location:** `docs/booking-services-roadmap.md` §9.1.1 Phase A; `docs/booking-platform-roadmap.md` §F2.

**Why this spec exists:** A meaningful portion of NL/BE customers' catering vendors don't use software — they work off printed daily lists ("daglijst voor catering"). Without first-class daglijst output, we exclude entire EU client segments running on this workflow. This is parity with operational reality (not with a software competitor), and is a Tier 1 deal-blocker before broad migration.

**Context:**
- [`docs/booking-services-roadmap.md`](../../booking-services-roadmap.md) §9.1.1 Phase A.
- [`docs/competitive-benchmark.md`](../../competitive-benchmark.md) — none of Tier A competitors have first-class daglijst output. This is genuine gap-fill.
- Memory: `project_vendor_fulfillment_reality.md` — paper today, KDS tomorrow; daglijst is one of three fulfillment modes.
- Memory: `project_market_benelux.md` — NL primary; daglijst is the dominant vendor workflow.
- Memory: `project_industry_mix.md` — corporate HQ-led; event-driven catering; supports paper + portal + hybrid.
- Memory: `feedback_quality_bar_comprehensive.md` — comprehensive scope with excellent execution; not MVP.

---

## 1. Goals + non-goals

### Goals

1. **Each vendor receives a structured daily list at a tenant-configurable cutoff time**, by email (PDF attachment + plain text body) and downloadable from admin/desk surfaces.
2. **One daglijst per (vendor, building, service_type, date)** — a vendor doing catering and AV at one building gets two lists; a vendor delivering to two buildings gets two lists per service type.
3. **Three fulfillment modes per vendor:** `portal | paper_only | hybrid`. Paper-only and hybrid get daglijst by default; portal-only opts in.
4. **Lock-state on cutoff:** once daglijst is sent for a (vendor, date), subsequent edits to its orders flag `requires_phone_followup` for desk operators to handle out-of-band.
5. **Versioning + diff highlights:** v2+ daglijsts highlight changes since previous version (added/removed/quantity-changed items) so a kitchen reading v2 sees the delta at a glance, not a fresh full re-read.
6. **Status inference for paper-only vendors:** auto-advance fulfillment status by time-of-day so vendor scorecards work for paper-only vendors (using desk confirmation as ground truth).
7. **Internationalization (NL first, FR + EN baseline):** daglijst rendered in vendor's preferred language; default to tenant's primary language.
8. **GDPR-aligned:** PDFs stored with tenant isolation + signed URLs + retention; PII minimized in email body; allergen data treated as Article 9 special category.

### Non-goals (this spec)

- **Vendor login portal** (Phase B — separate spec).
- **Mobile field-tech UX, KDS, cleaning checklist** (Tier 2 — see booking-services-roadmap §9.2.0).
- **Vendor capacity management** (separate item, §9.1.5).
- **Vendor scorecards** (data model in §9.1.3 consumes paper-only-vendor inferred status from this spec; scorecard UI is separate).
- **Custom daglijst layouts per vendor** (single template per service-type for v1; per-vendor overrides deferred).
- **Deep editor for daglijst templates** (admin gets preview + regenerate, no template authoring).

---

## 2. Architecture overview

### High-level flow

```
Order created with vendor X assigned
   ↓
Order_line_items locked? → no
   ↓
Hourly background worker
   ↓
For each (vendor, building, service_type, date) with pending orders:
   compute next_send_at = earliest_order.delivery_time - vendor.daglijst_cutoff_offset_minutes
   ↓
   At next_send_at, assemble daglijst v1:
     - Aggregate orders for that bucket
     - Render PDF
     - Email vendor's daglijst_email
     - Set order_line_items.daglijst_locked_at = now()
     - Audit: daglijst.generated, daglijst.sent
   ↓
Subsequent change to a locked order_line_item:
   - Flag requires_phone_followup = true
   - Desk dashboard widget surfaces it
   - Desk operator phones vendor, marks confirmed_phoned
   - Admin can trigger regenerate → v2 with diff highlights
```

### Module boundaries

**`VendorFulfillmentModule`** (new, `apps/api/src/modules/vendor-fulfillment/`)
- `DaglijstService` — assemble + render + email
- `DaglijstSchedulerService` — background worker that triggers sends at cutoff
- `DaglijstLockService` — manages daglijst_locked_at + post-cutoff change flow
- `DaglijstStatusInferenceService` — auto-advance status for paper-only vendors
- `DaglijstController` — admin/desk endpoints (preview, regenerate, history, confirm-phoned)

**`PdfRenderingModule`** (new or co-located)
- `PdfRenderer` — wraps `@react-pdf/renderer` to produce PDFs from JSX templates
- `PdfTemplate` (per service_type — catering, av_setup, cleaning, etc.) — JSX components

**Storage:**
- Supabase Storage bucket `daglijsten` (tenant-isolated by RLS).
- Path: `{tenant_id}/{vendor_id}/{date}/{building_slug}/{service_type}-v{version}.pdf`.

**Notifications:**
- Use existing email infrastructure (Postmark / SendGrid / similar via `apps/api/src/modules/notifications/`).

---

## 3. Data model

### Schema additions to `vendors`

```sql
alter table vendors
  add column fulfillment_mode text not null default 'paper_only'
    check (fulfillment_mode in ('portal','paper_only','hybrid')),
  add column daglijst_email text,
  add column daglijst_cutoff_offset_minutes int not null default 180,
  add column daglijst_send_clock_time time,        -- alternative: fixed time-of-day (e.g. 07:00) instead of relative
  add column daglijst_language text not null default 'nl'
    check (daglijst_language in ('nl','fr','en','de')),
  add column daglijst_inferred_status_grace_minutes int not null default 30;
```

`daglijst_cutoff_offset_minutes` and `daglijst_send_clock_time` are mutually exclusive — admin picks one or the other:
- **Offset mode** (default): send at `earliest_delivery_time - cutoff_offset_minutes`.
- **Clock mode**: send at fixed time-of-day (e.g. always 07:00 NL local).

### `vendor_daily_lists`

```sql
create table vendor_daily_lists (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,
  building_id uuid references spaces(id),         -- nullable when vendor delivers tenant-wide
  service_type text not null,                      -- catering | av_equipment | supplies | etc.
  list_date date not null,                         -- the delivery date this list covers
  version int not null,                            -- 1, 2, 3...
  payload jsonb not null,                          -- structured snapshot of orders + items at generation time
  pdf_storage_path text,                           -- supabase storage path; null until rendered
  pdf_url_expires_at timestamptz,                  -- last signed URL expiry
  generated_at timestamptz not null default now(),
  generated_by_user_id uuid references users(id), -- null for auto-generated; set for manual regenerate
  sent_at timestamptz,
  recipient_email text,
  email_message_id text,                           -- from email provider for bounce tracking
  email_status text                                -- queued | sent | delivered | bounced | failed
    check (email_status in ('queued','sent','delivered','bounced','failed','never_sent')),
  email_error text,
  created_at timestamptz not null default now()
);

create unique index uq_daglijst_version
  on vendor_daily_lists (tenant_id, vendor_id, building_id, service_type, list_date, version);
create index idx_daglijst_pending_send
  on vendor_daily_lists (tenant_id, sent_at) where sent_at is null;
create index idx_daglijst_history
  on vendor_daily_lists (tenant_id, vendor_id, list_date desc);
```

### Schema additions to `order_line_items`

```sql
alter table order_line_items
  add column daglijst_locked_at timestamptz,
  add column daglijst_id uuid references vendor_daily_lists(id),
  add column requires_phone_followup boolean not null default false,
  add column desk_confirmed_phoned_at timestamptz,
  add column desk_confirmed_phoned_by_user_id uuid references users(id);

create index idx_oli_phone_followup
  on order_line_items (tenant_id, requires_phone_followup, delivery_date)
  where requires_phone_followup = true and desk_confirmed_phoned_at is null;
```

### Audit events (added to existing taxonomy)

- `daglijst.generated` — new version created.
- `daglijst.sent` — email dispatched.
- `daglijst.regenerated` — manual / auto regeneration creating v2+.
- `daglijst.send_failed` — email bounce or transient failure.
- `order.post_cutoff_change` — order_line_item edited after `daglijst_locked_at`.
- `order.phone_followup_confirmed` — desk operator marked phoned.
- `order_line_item.status_inferred` — status auto-advanced for paper-only vendor.

---

## 4. Backend services + endpoints

### `DaglijstSchedulerService`

Background worker, runs every 15 minutes (or 5 minutes during business hours configurable per tenant).

**Algorithm:**
1. Query: for each (vendor in paper_only|hybrid mode, building, service_type, date) bucket with at least one order_line_item where `daglijst_locked_at IS NULL AND delivery_date IN (today, tomorrow)`:
   - Compute `next_send_at`:
     - If `daglijst_send_clock_time` set: `list_date - 1 day @ clock_time` (NL local).
     - Else: `min(delivery_time across bucket) - daglijst_cutoff_offset_minutes`.
2. If `now() >= next_send_at` AND no v1 yet emitted: trigger generation.
3. Concurrency: per-bucket advisory lock to prevent double-send.

**Edge handling:**
- If bucket spans multiple days due to recurrence: split per date.
- If first order created after cutoff window: skip daglijst (post-cutoff workflow handles); flag for desk.
- If bucket has zero orders at send time (all cancelled): emit a "list cancelled" notification to vendor instead of empty daglijst.

### `DaglijstService`

```typescript
class DaglijstService {
  async generate(args: GenerateArgs): Promise<VendorDailyList>;  // assembles + renders + uploads PDF + records row
  async send(daglijstId: string): Promise<void>;                   // emails the vendor; updates email_status
  async regenerate(args: RegenerateArgs): Promise<VendorDailyList>; // creates v+1 with diff vs prior version
  async preview(args: PreviewArgs): Promise<{html: string; pdfUrl: string}>; // for admin without sending
  async getHistory(args: HistoryArgs): Promise<VendorDailyList[]>;
  async getDownloadUrl(daglijstId: string): Promise<string>;       // signed URL with TTL
}

interface GenerateArgs {
  tenantId: string;
  vendorId: string;
  buildingId: string | null;
  serviceType: ServiceType;
  listDate: string;       // YYYY-MM-DD
  triggeredBy: 'auto' | 'admin_manual';
  generatedByUserId?: string;
}
```

**Assembly steps:**
1. Resolve vendor + building + tenant settings.
2. Query orders + order_line_items for the bucket: `WHERE vendor_id = X AND service_type = Y AND building_id = Z AND DATE(delivery_time) = D AND status NOT IN ('cancelled')`.
3. For each line: resolve catalog_item (name, image_url, allergens), space (room name, floor, building), requester (first name only — privacy), dietary needs (per-attendee where attached).
4. Aggregate into structured payload (sorted by delivery time, grouped by order).
5. Compute version (v1 if first; v_prev + 1 otherwise).
6. Render PDF via `PdfRenderer`.
7. Upload to Supabase Storage path `{tenant_id}/{vendor_id}/{date}/{building_slug}/{service_type}-v{version}.pdf`.
8. Insert `vendor_daily_lists` row with payload jsonb + pdf_storage_path.
9. Trigger `send()`.

### `DaglijstLockService`

- Triggered on order_line_items change events (subscribe to existing event bus).
- If line's order.delivery_date matches a `vendor_daily_lists` row that has `sent_at IS NOT NULL` and the line's vendor matches:
  - Set `order_line_items.requires_phone_followup = true`.
  - Emit `order.post_cutoff_change` audit.
  - Optionally trigger auto-regenerate if tenant has `auto_regenerate_on_post_cutoff = true` (default off in v1; admin opts in).

### `DaglijstStatusInferenceService`

Background worker, runs every 5 minutes.

**Algorithm:**
For each `order_line_item` where:
- vendor.fulfillment_mode = 'paper_only'
- order_line_item.fulfillment_status IN ('ordered', 'preparing')
- delivery_time has passed certain thresholds

Apply transitions:
- T-1h before delivery_time → `preparing` (if currently `ordered`)
- delivery_time + grace_minutes (default 30) → `delivered`

Emit audit `order_line_item.status_inferred` per transition.

Desk can override via existing UI; manual updates suppress further inference.

### Endpoints

```
POST   /admin/vendors/:id/daglijst/preview            -- generate preview without sending; returns HTML + PDF URL
POST   /admin/vendors/:id/daglijst/regenerate         -- manual v+1 generation; returns new daglijst row
GET    /admin/vendors/:id/daglijst/history            -- last 30 days of daglijst rows for this vendor
GET    /admin/daglijsten/:id/download                 -- signed URL to PDF (TTL ≤ 1 hour)
PATCH  /admin/vendors/:id/fulfillment                 -- update fulfillment_mode + daglijst_email + cutoff config
GET    /desk/post-cutoff-changes                      -- list order_line_items with requires_phone_followup=true
POST   /desk/order-lines/:id/confirm-phoned           -- mark desk_confirmed_phoned_at
```

All admin endpoints gated by `vendors:manage` permission. Desk endpoints by `tickets:write_all` or per-location operator scope.

---

## 5. PDF generation

### Library choice: `@react-pdf/renderer`

**Why:** Node-native (no Chromium overhead). JSX-based templates (familiar to frontend team). Good control over typography, spacing, page breaks. Multi-language support via `<Text>` components. ~1-3s render time per PDF (acceptable at our scale).

**Alternatives considered:**
- **Puppeteer/Playwright** — high fidelity, heavy runtime; overkill for daglijst layout.
- **PDFKit programmatic** — fast but ugly to author.
- **WeasyPrint** — Python runtime added to stack; not justified.

### Template structure

One JSX template per service_type:
- `CateringDaglijstTemplate.tsx` — primary v1 deliverable.
- `AvDaglijstTemplate.tsx` — Phase A+ (after catering proven).
- `CleaningDaglijstTemplate.tsx` — Phase A+.
- `MaintenanceDaglijstTemplate.tsx` — Phase A+.

Each template:
- Header: tenant logo (per-tenant branding) + vendor name + building + service_type + list date + version + generated timestamp + "v2 — changes from v1 highlighted" subtitle on regenerate.
- Order section: card per order (delivery time + room + headcount + requester first name + dietary count + items table).
- Item table: quantity column, name column, modifiers/allergens column, special-instructions column.
- Allergen flags rendered as colored pills (red for "contains nut", yellow for "contains gluten", etc. — matching Square KDS pattern, not Toast's red-caps).
- Footer: total items, total estimated cost, desk contact info ("Questions? Call +31 X X X X"), tenant address (for invoice purposes).
- Diff highlights (v2+): added items shown with green "+" marker; removed items with strikethrough red "−"; quantity changes shown as "8 → 12" with yellow background.

### Rendering pipeline

```typescript
async function renderPdf(payload, locale) {
  const doc = (
    <Document>
      <DaglijstTemplate payload={payload} locale={locale} />
    </Document>
  );
  return await pdf(doc).toBuffer();
}
```

PDF buffer uploaded to Supabase Storage; path stored on `vendor_daily_lists.pdf_storage_path`.

### Branding

Per-tenant brand applied via `tenant_branding` (existing surface). Logo + primary color in PDF header. Fallback to Prequest brand if tenant brand not configured.

### Multi-language

Template uses i18n key lookup (`useTranslation`-style) keyed on vendor's `daglijst_language`. Translations live in `apps/api/src/modules/vendor-fulfillment/i18n/{lang}.json`.

Phase A ships:
- `nl` — Dutch primary (NL+BE-NL).
- `fr` — Belgian French (BE-FR).
- `en` — English (fallback / multi-national).

Future: `de` for German-speaking customers if we expand DACH.

---

## 6. Email delivery

### Email content

**Subject:** `Daglijst {service_type} — {date} — {building}` (in vendor's language)

**Plain-text body:**
```
Beste {vendor name},

In de bijlage de daglijst van {date} voor {building}.

{N orders}, {total items}, eerste levering om {earliest_delivery_time}.

Vragen? Neem contact op met {desk_phone}.

— {tenant_name}
```

**HTML body:** branded equivalent + CTA button "Open daglijst (PDF)" linking to a signed download URL (TTL 7 days, regenerable on access).

**Attachment:** the PDF.

**No PII in email body beyond vendor name + tenant brand** — actual order details stay in the attachment, which sits behind tenant-isolated storage. Email-borne PII is minimized.

### Delivery + tracking

- Use existing `NotificationsModule` adapter (Postmark / SendGrid / Resend).
- Track `email_message_id` for bounce + delivery webhooks.
- On bounce: `email_status = 'bounced'`; alert tenant admin via in-app notification + escalate via Teams (Phase 3+) or email.
- On delivery confirmation: `email_status = 'delivered'`.
- Failure escalation: 3 retries with exponential backoff; after 3 failures, mark `failed` + alert desk lead.

### Audit

Every `daglijst.sent` event records: recipient_email, message_id, send_status, latency.

---

## 7. Lock state + post-cutoff change workflow

### Lock state

When `daglijst_v1.sent_at IS NOT NULL` for a (vendor, building, service_type, date):
- All `order_line_items` matching that bucket get `daglijst_locked_at = sent_at` and `daglijst_id = v1.id`.
- Subsequent edits flag `requires_phone_followup = true` automatically (DB trigger or service-layer hook).

### Desk dashboard widget — "Today's late changes"

Surface on `/desk` home (existing) and `/desk/bookings` filter:

```
🟡 Today's late changes — call these vendors
─────────────────────────────────────────────
Compass Catering · 0123-456789
  • Order #1234 — qty 12 → 15 — board lunch 12:30 — Marleen V.
  • Order #1245 — line removed — exec lunch 13:00 — Jan B.
  [Confirm phoned]

ISS Cleaning · 0987-654321
  • Order #1236 — new line added — meeting room 4D 14:00
  [Confirm phoned]
```

Actions:
- "Confirm phoned" button per vendor row → POST `/desk/order-lines/:id/confirm-phoned` (or batched per vendor).
- After confirmation: row disappears from widget.
- Audit `order.phone_followup_confirmed` per line.

### Auto-regenerate (optional)

Per-tenant setting `auto_regenerate_daglijst_on_post_cutoff`:
- **Off (default v1):** desk confirms phone follow-up; no v2 sent automatically.
- **On (opt-in):** when ≥N post-cutoff changes accumulate (default 3 lines or 1 line cancelled), auto-trigger regenerate creating v2 with diff highlights.

Auto-regenerate suppresses re-triggering for 30 minutes after last v2 send (prevent thrashing).

### Versioning + diff highlights

- v1: full daglijst at cutoff.
- v2, v3, ...: regeneration creates new version. PDF rendered with diff highlights vs immediately preceding version.
- Diff calculation: compare payload jsonb of new vs prior. Resolve at line level: `(catalog_item_id, special_instructions, service_window)` as identity key.
- Output: items added, removed, quantity-changed, time-shifted.
- Email body for v2+ includes summary: "5 changes since v1: 2 added, 1 removed, 2 quantity changed."

---

## 8. Status inference for paper-only vendors

### Why

Vendor scorecards (booking-services-roadmap §9.1.3) need on-time and delivery KPIs. Paper-only vendors don't update their own statuses. Without inference, scorecards are blank for ~50% of vendors in NL/BE.

### Inference rules

For `order_line_items` where `vendors.fulfillment_mode = 'paper_only'`:

| Current status | Inferred transition | Trigger |
|---|---|---|
| `ordered` | → `preparing` | `now() >= delivery_time - 1h` |
| `preparing` | → `delivered` | `now() >= delivery_time + grace_minutes` |

Defaults configurable per vendor via `daglijst_inferred_status_grace_minutes` (default 30).

### Override behavior

- Desk operator can change status manually at any time (existing UI).
- Manual change → set `manual_status_set_at` flag → suppress further inference for that line.
- Audit captures every inferred transition with `event_source = 'inferred'` so scorecards can distinguish self-reported vs inferred.

### Scorecard implication

Paper vendor's "on-time %" derived from `inferred delivered_at` vs `delivery_time + tolerance`. Less precise than self-reported, but better than nothing. Scorecard UI surfaces source distinction so FM directors don't conflate.

---

## 9. Admin UI

### `/admin/vendors/:id` — Fulfillment tab (new)

Add to existing vendor detail page:

**Section: Fulfillment mode**
- `SettingsRow` with mode selector: `Portal` / `Paper only` / `Hybrid`.
- Description: explains each mode + recommendation ("If your vendor doesn't use software, choose Paper only.").

**Section: Daglijst (visible if paper_only or hybrid)**
- `SettingsRow` daglijst email — input field for vendor's email.
- `SettingsRow` cutoff strategy — dropdown:
  - "Send N hours before earliest delivery" (offset mode) + number input (default 3).
  - "Send daily at fixed time" (clock mode) + time picker (default 07:00 NL).
- `SettingsRow` language — dropdown (NL / FR / EN / DE).
- `SettingsRow` status inference grace (number input, default 30 min).
- Buttons: "Preview today's list" + "Regenerate v2 now".

**Section: Daglijst history**
- `SettingsRow` listing last 30 days of generated lists per (building, service_type, date, version, status).
- Per-row: download PDF button + view email status.

### `/admin/vendors/:id/daglijst/preview` (modal or sub-page)

- Renders today's daglijst as HTML + PDF preview.
- "Send to vendor" button (only enabled if no v1 sent yet today; otherwise "Regenerate v2 and send").
- Side panel: lock state, post-cutoff change count, last sent timestamp.

### Tenant settings — `auto_regenerate_daglijst_on_post_cutoff` toggle

Per-tenant global setting under `/admin/settings/fulfillment`. Default off.

---

## 10. Desk operator UI

### `/desk` home — "Today's late changes" widget

Already specified in §7. Implementation:
- Card-style widget pinned to top of dashboard when `requires_phone_followup` count > 0.
- Grouped by vendor.
- Per-row: order summary + line change description + vendor phone + action buttons.
- Real-time refresh via Supabase realtime channel `desk_post_cutoff_changes:tenant_<id>`.

### `/desk/bookings` filter chip

Add chip: "Late changes" — filters reservation list to bookings with at least one `requires_phone_followup = true` line.

### `/desk/bookings/:id` drawer — late-change indicator

If a booking has lines with `requires_phone_followup = true`, surface:
- Banner: "This booking has late changes that need vendor follow-up".
- Per-line: amber "📞 Call vendor" badge.
- "Mark vendor phoned" action per line (or batch per vendor).

---

## 11. Internationalization

### Languages

Phase A ships:
- **`nl`** — Dutch (Netherlands + Belgian Dutch).
- **`fr`** — Belgian French.
- **`en`** — English (fallback + multi-national).

Future:
- `de` — German (DACH expansion).

### Translation surfaces

- PDF templates: i18n key lookup per element.
- Email subject + body: i18n keys per language.
- Admin UI labels: existing i18n infra (web app).

### Per-vendor language preference

`vendors.daglijst_language` overrides tenant default. Common case: tenant in NL with one Wallonian vendor → set that vendor's daglijst to FR.

### Date / time formatting

- Dates: NL locale (`DD-MM-YYYY`) for nl; FR locale (`DD/MM/YYYY`) for fr; ISO for en.
- Times: 24-hour for nl + fr; 24-hour for en (consistent with EU norms; configurable).
- Timezones: tenant local — Europe/Amsterdam by default.

---

## 12. Performance + scale

### Load estimate

For 50 tenants, each with 5 vendors averaging 1 daglijst per workday per service_type:
- ~250 daglijsts/day total.
- ~75 minute window per day for sending (early morning bulk).
- PDF render ~2s per daglijst → 8 minutes serial; trivial parallel.

For an enterprise tenant with 50 vendors × 3 buildings × 2 service_types = 300 daglijsts on a busy day. Parallelize 10x = 60s total render time. Acceptable.

### Bottlenecks

- **PDF rendering** is single-threaded per process; parallelize via worker pool.
- **Supabase Storage upload** is networked; batch where possible.
- **Email provider rate limits** — track per-tenant quota; backoff if exceeded.
- **Hourly scheduler scan** is O(active vendors × pending buckets); index well.

### Caching

- Catalog item metadata (name, image, allergens) cached at render time (5-min TTL).
- Tenant branding (logo, color) cached at render time.

### Observability

- Per-daglijst metrics: render latency, upload latency, email send latency, bounce rate.
- Per-tenant aggregate dashboard surfaces in admin health view.
- Alert threshold: bounce rate >5% per tenant in last 24h.

---

## 13. Security + GDPR

### Data classification

- **Vendor email + name + phone:** ordinary PII. Standard tenant isolation.
- **Order content (items + quantities):** operational; tenant-isolated.
- **Requester first name (in daglijst):** ordinary PII; first name only minimizes exposure.
- **Dietary / allergen flags:** Article 9 special-category data (health). Highest sensitivity.

### Storage

- PDFs in Supabase Storage bucket `daglijsten` with RLS:
  - Read: tenant members with `vendors:manage` permission OR scoped operators.
  - Write: server-side only.
- Retention: PDFs retained for tenant's audit window (default 90 days), then auto-deleted by nightly worker.
- Signed URLs only (TTL ≤ 1 hour for download links; 7 days for vendor-side email links — vendor's email link refreshed per regeneration).

### Email

- Email body contains minimal PII (just vendor name + tenant name + delivery date + count).
- PDF attachment is encrypted at rest in storage; transit via TLS.
- For tenants with extra-strict policies, email can be replaced with secure-link-only flow (PDF NOT attached; email contains only signed link with vendor-token-based auth).

### Audit

- Every send + access of a daglijst PDF logged.
- Person ID redacted in audit (use hashed IDs); event still queryable.
- Full trail available for SAR / breach response.

### Right of erasure

- When a person is anonymized (`persons.left_at`), past daglijsts containing their first name are NOT mutated retroactively (audit trail integrity), but the source `order_line_items.requester_person_id` link points to anonymized record.
- New daglijsts after person is anonymized show "Former employee" instead of name.
- Stored PDFs retained for tenant audit period; can be force-deleted on tenant-explicit erasure request.

---

## 14. Acceptance criteria

### Phase A — daglijst MVP

1. **Tenant admin configures vendor's fulfillment_mode + daglijst_email + cutoff** in vendor detail page → settings persist.
2. **Background worker auto-generates v1** at cutoff time for any (vendor, building, service_type, date) bucket with pending orders → daglijst row created → PDF uploaded to storage → email sent → audit captured.
3. **PDF includes:** tenant logo, vendor name, building, service_type, date, version, generation timestamp, per-order cards with delivery time + room + headcount + requester first name + items table with quantities + dietary flags, footer with desk contact + total cost.
4. **PDF renders correctly in NL, FR, and EN.**
5. **Lock state engages on send:** subsequent edits to any line in the bucket flag `requires_phone_followup = true`.
6. **Desk widget surfaces late changes** grouped by vendor with phone CTA → desk operator confirms phoned → audit captures chain.
7. **Admin manual regenerate** triggers v2 with diff highlights vs v1; email body summarizes changes; new PDF emitted.
8. **Status inference advances paper-only vendor lines** at T-1h → preparing, at T+grace → delivered; manual override suppresses inference; audit captures inference vs self-reported source.
9. **PDF history view** shows last 30 days for any vendor; admin can re-download any prior version.
10. **Email bounce/failure** updates daglijst row email_status; admin alerted via in-app notification.
11. **Multi-vendor multi-building scenario:** vendor X serves buildings A + B → two separate daglijsts emitted per service_type per date.
12. **GDPR tenant-isolation enforced:** PDFs not accessible across tenants even via direct URL guess.

### Phase A+ (next service types)

Same acceptance for AV, cleaning, maintenance daglijst templates.

---

## 15. Phased delivery

**Sprint 1 (1 wk):** Schema + basic backend
- Migrations: vendor schema additions, vendor_daily_lists, order_line_items locks.
- DaglijstService skeleton (assemble + record, no PDF render yet).
- Audit events wired.

**Sprint 2 (1 wk):** PDF rendering + email
- `@react-pdf/renderer` setup + CateringDaglijstTemplate v1 (NL only).
- Storage upload + signed URL.
- Email integration with bounce tracking.
- Background worker + scheduling logic.

**Sprint 3 (1 wk):** Admin UI + lock workflow
- Vendor detail page Fulfillment tab.
- Preview + regenerate buttons.
- History list.
- Desk dashboard widget for post-cutoff changes.
- Auto-regenerate toggle.

**Sprint 4 (~3 days):** i18n + status inference + polish
- FR + EN templates.
- Status inference background worker.
- Acceptance test sweep.

**Total: ~3 weeks** elapsed if linear; ~2 weeks with two engineers parallel.

---

## 16. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| PDF render performance at scale | Low | Medium | Worker pool + parallel; @react-pdf/renderer benchmarked at <3s/PDF |
| Email bounces high for vendors with bad addresses | Medium | Medium | Bounce tracking + admin alert; offer fallback secure link |
| Vendor doesn't read email until delivery time | Medium | High | Out of our hands; recommend tenant set cutoff earlier (5h+); educate via onboarding docs |
| Diff highlights confusing for vendors expecting fresh full list | Low | Medium | Clear "v2 — changes from v1 highlighted" subtitle; option to send full re-render without diff |
| Status inference incorrect for delayed deliveries | Medium | Low | Desk override always available; surface inference source in scorecards |
| Multi-language template maintenance burden | Low | Low | Externalize all strings; CI lint for missing keys |
| Tenant edits vendor email after v1 sent — second send to wrong address? | Low | Medium | Audit captures recipient_email; admin can manually re-send to corrected email |
| Vendor changes (admin replaces vendor mid-day) — pending daglijst orphaned | Medium | Medium | On vendor swap: cancel pending v1, regenerate for new vendor, audit chain |
| Order created post-cutoff with no v1 yet | Medium | Medium | Send fresh v1 immediately if no prior; or include in next v2 when threshold hit; flag for desk regardless |
| Storage cost growth over time | Low | Low | 90-day retention; nightly delete worker; cost negligible |

---

## 17. Open questions

1. **Default cutoff time for offset mode.** 3 hours (current default) — confirm with NL FM ops research or pilot.
2. **Email provider choice.** Existing tenant is on Postmark / SendGrid / Resend? Verify ahead of implementation.
3. **Should v1 wait for confirmation if vendor has multiple bounce history?** Suggest yes — auto-pause and require admin re-confirm email.
4. **Admin-overridable PDF template per vendor?** v1 says no (single template per service_type). When does first customer ask for custom branding? Phase A+ if demand.
5. **Should desk operator be able to send a daglijst on demand independent of cutoff schedule?** Yes — already covered by manual regenerate. Confirm UX is discoverable.
6. **Status inference — should the grace_minutes default be 30 or should it scale with order size (large catering takes longer)?** Default 30; per-vendor override available; revisit after wave-1 data.
7. **Multi-vendor co-served buildings with shared kitchen** (rare in NL but possible) — daglijst per vendor still right? Yes; cross-vendor coordination is admin's job.

---

## 18. Out of scope (Phase A)

- Vendor login portal (Phase B).
- Vendor mobile app / KDS / field-tech UX (Tier 2).
- Per-vendor custom PDF templates (Phase A+).
- Real-time daglijst editing (vendors phone in changes; not in scope).
- Catering invoice attachment / reconciliation (separate workstream).
- Vendor self-onboarding (admin-only invite remains the model).

---

## 19. References

- [`docs/booking-services-roadmap.md`](../../booking-services-roadmap.md) §9.1.1 Phase A.
- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §F2.
- [`docs/competitive-benchmark.md`](../../competitive-benchmark.md) — Tier A competitor parity gap.
- [`docs/superpowers/specs/2026-04-26-linked-services-design.md`](2026-04-26-linked-services-design.md) — order_line_items + vendor model.
- Memory:
  - `project_vendor_fulfillment_reality.md` — the daglijst is the dominant NL workflow.
  - `project_market_benelux.md` — NL primary, FR secondary.
  - `project_industry_mix.md` — corporate HQ catering pattern.
  - `project_no_wave1_yet.md` — build before customer; mind over-engineering.
  - `feedback_quality_bar_comprehensive.md` — comprehensive scope; not lean.

---

**Maintenance rule:** when implementation diverges from this spec, update spec first, then code. Same convention as `docs/assignments-routing-fulfillment.md` and `docs/visibility.md`.
