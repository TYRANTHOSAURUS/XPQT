# Records of Processing Activities (Art. 30)

**Status:** v1 — operating from 2026-04-28.
**Owner:** DPO (when appointed); CTO until then.
**Spec reference:** [`docs/superpowers/specs/2026-04-27-gdpr-baseline-design.md`](../superpowers/specs/2026-04-27-gdpr-baseline-design.md) §11.
**Format:** structured YAML inside this file. Machine-parseable so we can generate per-tenant exports + procurement-ready PDFs.

GDPR Art. 30 obliges the controller (and us, as processor for our customers) to maintain records of processing activities. This document is the canonical product-level RoPA. Per-tenant overlays (retention overrides, integrations enabled) generate the tenant-specific RoPA from this base.

The categories in `activities[].categories_of_data` correspond 1:1 to the seed list in `seed_default_retention_for_tenant()` (migration 00162) and the adapter registry in `apps/api/src/modules/privacy-compliance/adapters/`.

---

```yaml
controller_or_processor:
  role: processor                                    # We process on behalf of our customers (controllers).
  name: Prequest B.V.
  registered_office: Amsterdam, NL                   # Update when company is incorporated.
  representative_in_eu: same_as_above
  dpo:
    appointed: false
    interim_contact:
      name: CTO
      email: dpo@prequest.app
  controllers:
    - "Tenant organizations contracting with Prequest"

last_reviewed: 2026-04-28

activities:

  # =================================================================
  # 1. Workplace request management (core platform)
  # =================================================================
  - id: ticketing
    purpose: |
      Receive, route, fulfil, and audit workplace service requests
      (facilities, maintenance, catering, AV, room bookings, visitors).
    legal_basis: contract                            # Tenant contract with their employees / requesters.
    categories_of_subjects:
      - employees
      - contractors
      - external_attendees
      - visitors
      - vendor_contacts
    categories_of_data:
      - person_ref_in_past_records                   # First name, last name, email, phone.
      - past_bookings                                # Reservation history.
      - past_orders                                  # Service order history.
      - person_preferences                           # Notification + dietary preferences.
    recipients:
      - "Authorized tenant administrators (RBAC-gated)"
      - "Vendors assigned to the work order (limited to the order metadata)"
    transfers_outside_eea: none
    retention:
      see: "tenant_retention_settings — defaults in migration 00162"
    technical_organisational_measures:
      - "TLS 1.2+ in transit; AES-256 at rest (Supabase managed)."
      - "Tenant isolation via RLS (`current_tenant_id()`) on every PII-bearing table."
      - "RBAC permission checks at API layer (`user_has_permission`)."
      - "MFA enforced for any admin role with `gdpr.*` permission."
      - "Audit log retained for 7 years (legal-obligation basis)."
      - "Read-side audit log captures every access via `personal_data_access_logs`."

  # =================================================================
  # 2. Visitor management
  # =================================================================
  - id: visitor_management
    purpose: |
      Pre-register visitors, check them in via kiosk, notify hosts,
      maintain the lobby panel + watchlist for site security.
    legal_basis: legitimate_interest                 # Site security + safety.
    categories_of_subjects:
      - visitors
      - hosts
    categories_of_data:
      - visitor_records
      - visitor_photos_ids                           # Pending visitor management spec — adapter stub today.
    recipients:
      - "Authorized tenant reception + site security staff"
    transfers_outside_eea: none
    retention:
      visitor_records:
        default_days: 180
        cap_days: 365
        rationale: "EU norm; longer caps require LIA documentation."
      visitor_photos_ids:
        default_days: 90
        cap_days: 180
        rationale: "Higher sensitivity; tighter window."
    technical_organisational_measures:
      - "Photos stored in private Supabase Storage bucket with tenant-prefixed paths."
      - "Hard-deleted (file-level) past retention, not anonymized."
      - "Anonymization preserves visit_date + site_id for analytics; removes badge_id + person link."

  # =================================================================
  # 3. Calendar + email integration (MS Graph / Outlook)
  # =================================================================
  - id: calendar_integration
    purpose: |
      Bi-directional sync between Outlook calendars and Prequest room
      bookings; deep-link UX so attendees can attach services to a
      booking without leaving Outlook.
    legal_basis: contract                            # Part of tenant contract; integration toggleable.
    categories_of_subjects:
      - employees
      - external_meeting_attendees
    categories_of_data:
      - calendar_event_content                       # Not warehoused — fetched on-demand from MS Graph.
      - calendar_attendees_snapshot                  # Snapshot at booking creation.
      - ghost_persons                                # Auto-created from attendee emails.
    recipients:
      - "Microsoft (sub-processor, EU regions when tenant Azure AD is EU-resident)"
      - "Authorized tenant administrators"
    transfers_outside_eea: |
      None when tenant Azure AD is EU-resident. Microsoft EU Data Boundary applies.
      Cross-border only on tenant explicit opt-in (Tier 3 — not yet supported).
    retention:
      calendar_event_content: "0 days (not warehoused)"
      calendar_attendees_snapshot: "90 days default; 365 day cap."
      ghost_persons: "365 days default; 730 day cap; auto-anonymized on inactivity."
    technical_organisational_measures:
      - "Multi-tenant Azure AD app with cert-based auth + dual-cert rotation."
      - "Token cache (Redis) tenant-scoped; never cross-tenant readable."
      - "App-only permissions — least privilege per integration scope."

  # =================================================================
  # 4. Vendor portal (Phase B)
  # =================================================================
  - id: vendor_portal
    purpose: |
      Provide vendor staff with a magic-link-authenticated portal to
      receive, accept, and update workplace service orders.
    legal_basis: contract                            # Tenant <-> vendor relationship.
    categories_of_subjects:
      - vendor_employees
      - requesters_of_services
    categories_of_data:
      - vendor_user_data                             # Pending Phase B spec.
      - past_orders                                  # Vendor sees orders relevant to them.
    recipients:
      - "Vendor employees authorized by their tenant administrator"
    transfers_outside_eea: none
    retention:
      vendor_user_data:
        default_days: 730
        cap_days: 1825
        rationale: |
          Active vendor account retention from contract end.
    technical_organisational_measures:
      - "Magic-link sessions short-lived; tokens never reusable across devices."
      - "PII minimisation: vendor sees only assigned-to-them order metadata; no requester PII unless required."
      - "Per spec §B-spec, requester identity hidden from vendor (`feedback_hide_vendor_from_requester.md` mirror)."

  # =================================================================
  # 5. Audit trails + observability
  # =================================================================
  - id: audit
    purpose: |
      Maintain a tamper-evident record of all administrative actions
      and personal-data reads for compliance + incident response.
    legal_basis: legal_obligation                    # GDPR Art. 30 + general accounting (NL 7-year rule).
    categories_of_subjects:
      - employees
      - contractors
      - admin_users
    categories_of_data:
      - audit_events
      - personal_data_access_logs
    recipients:
      - "Tenant administrators with `gdpr.audit_reads` permission"
      - "Prequest engineering on-call during incident response"
    transfers_outside_eea: none
    retention:
      audit_events:
        default_days: 2555                           # 7 years
        cap_days: null
        rationale: "NL accounting + AP supervision; PII redacted past 7y via adapter."
      personal_data_access_logs:
        default_days: 365
        cap_days: 730
        rationale: "Audit-of-audit; high write volume; partition-dropped past retention."
    technical_organisational_measures:
      - "audit_outbox pattern decouples emit from durability."
      - "Read-side audit log via @LogPersonalDataAccess + interceptor."
      - "Partitioned by month; oldest partitions auto-dropped."
      - "Tenant-scoped via RLS."

  # =================================================================
  # 6. GDPR fulfilment (DSR + retention)
  # =================================================================
  - id: gdpr_fulfilment
    purpose: |
      Process Art. 15 (access), Art. 17 (erasure), Art. 16/20 (rectification,
      portability) requests; apply per-category retention; place legal holds
      during litigation or regulatory inquiry.
    legal_basis: legal_obligation
    categories_of_subjects:
      - employees
      - contractors
      - visitors
      - vendor_employees
    categories_of_data:
      - data_subject_requests
      - legal_holds
      - anonymization_audit                          # 7-day restore window for retention errors.
    recipients:
      - "Tenant administrators with `gdpr.fulfill_request` permission"
      - "Tenant administrators with `gdpr.place_legal_hold` permission"
    transfers_outside_eea: none
    retention:
      data_subject_requests: "Indefinite — proves we honoured each request."
      legal_holds:           "Indefinite — proves chain of custody."
      anonymization_audit:   "7 days post-anonymization, then hard-purged."
    technical_organisational_measures:
      - "DSR initiated only by `gdpr.fulfill_request`-permissioned admin."
      - "Erasure denied immediately when active legal hold covers the subject."
      - "Per-person export bundles uploaded to private bucket with 30-day signed URLs."
      - "All transitions audited via `audit_outbox` with `gdpr.*` event types."

# =====================================================================
# Sub-processors (Annex B of the customer DPA)
# =====================================================================

sub_processors:
  - name: Supabase Inc.
    purpose: "Database, authentication, storage, realtime."
    region: EU (Frankfurt + Amsterdam)
    transfers_outside_eea: "None — pinned to EU regions in our project config."
    dpa: "Supabase DPA — published at supabase.com/legal/dpa"

  - name: Microsoft Corporation
    purpose: "MS Graph + Bot Service for Outlook + Teams integrations."
    region: "EU when tenant Azure AD is EU-resident; per-tenant configurable."
    transfers_outside_eea: |
      Microsoft EU Data Boundary applies. SCCs in place via Microsoft Customer
      Agreement + Data Processing Addendum.
    dpa: "Microsoft Online Services DPA"

  - name: Cloudflare, Inc.
    purpose: "Edge / WAF / DDoS for our public surfaces."
    region: Global anycast (EU PoPs serve EU traffic).
    transfers_outside_eea: |
      Possible for traffic edge-cached outside EU; SCCs + UK IDTA in place.
    dpa: "Cloudflare DPA"

  - name: "Email delivery sub-processor (TBD)"
    purpose: "Transactional email delivery."
    region: TBD
    transfers_outside_eea: TBD
    dpa: TBD
    note: |
      Sprint 5+ — choose between Postmark (EU region) and Resend (EU region).
      Defer until first real customer requires production email volume.

# =====================================================================
# Maintenance
# =====================================================================
maintenance:
  - "Update last_reviewed annually or whenever a new processing activity is added."
  - "Add new sub-processors here AND on /legal/sub-processors page; tenants
    subscribed to sub-processor changes will be notified."
  - "When a new data category is added to the adapter registry, add the activity
    + reference here in the same PR."
  - "Per-tenant RoPA generated by joining this YAML with that tenant's
    `tenant_retention_settings` overrides + `tenant_settings.integrations_enabled`."
```
