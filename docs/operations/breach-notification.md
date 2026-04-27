# Personal-data breach notification runbook

**Status:** v1 — operating from 2026-04-28.
**Owner:** Security on-call · CTO as deputy.
**Spec reference:** [`docs/superpowers/specs/2026-04-27-gdpr-baseline-design.md`](../superpowers/specs/2026-04-27-gdpr-baseline-design.md) §9.
**Regulator:** Autoriteit Persoonsgegevens (AP, Netherlands) — primary supervisory authority for our EU-resident tenants. Belgian APD secondary.

This is the operational runbook. It exists so that under stress we don't think about *what* to do, only *who's doing it right now*. Practice it once per quarter (tabletop) and after every real incident.

---

## §1. The 72-hour clock

GDPR Art. 33 obliges the controller to notify the supervisory authority **within 72 hours of becoming aware of a personal data breach**, unless the breach is unlikely to result in a risk to the rights and freedoms of natural persons.

> "Becoming aware" starts when we have reasonable degree of certainty that a security incident has occurred AND that personal data was affected. Suspicion alone is not awareness — but suspicion that resolves into confirmation does not stop the clock; it counts from the original confirmation.

**Default posture:** assume notification is required and run the timer. Decide *not* to notify only with explicit written sign-off from the DPO (or, until appointed, the CTO + legal counsel).

---

## §2. Stages

```
Detection ──▶ Triage ──▶ Containment ──▶ Investigation ──▶ Notification ──▶ Post-mortem
```

Every stage has a named owner + a deliverable. Hand-off is explicit and timestamped in the incident log (a private channel in `#sec-incidents-2026-NN`).

### 2.1 Detection

**Sources we treat as detection signals:**
- Audit anomaly alerts from the GDPR retention worker (`gdpr.retention_run_failed`, dead-letter spikes on `audit_outbox`).
- Multi-record export by single actor (>1000 records in <60s).
- Off-hours access from unusual IP for any actor with `gdpr.*` permissions.
- Bulk read of restricted persons (CEO, board, executive assistants — flagged in `tenant_settings.restricted_person_ids`).
- Customer report (support ticket tagged `#security`).
- Internal employee report (Slack `#security` or email security@prequest.app).
- Sub-processor breach notification (Supabase, Postmark, Microsoft, etc.).
- External research disclosure (responsible-disclosure inbox).

**Owner:** Security on-call.
**Deliverable:** an open incident ticket with timestamp, source, and the raw evidence.

### 2.2 Triage

**Question:** is this a personal-data breach (confidentiality / integrity / availability impact on PII)?

**Triage rubric:**

| Question | Answer | Implication |
|---|---|---|
| Did personal data leave our control or become inaccessible? | Yes | Likely a breach. |
| Is the leak within our infrastructure (e.g. cross-tenant query bug)? | Yes | Still a breach if PII boundaries crossed. |
| Was the data already public / pseudonymous beyond reidentification? | Yes | Likely not a notifiable breach. |
| Is the impact limited to non-PII operational metadata? | Yes | Not a personal-data breach. |
| Is there a credible chain of custody for the affected data? | Yes | Notifiable. |

**Owner:** Security on-call + CTO/DPO.
**Deliverable:** triage decision recorded in the incident log within 4 hours of detection. If decision = "not a breach", document the reasoning explicitly — defensibility matters.

### 2.3 Containment

**Default actions in priority order:**

1. **Stop the bleeding.** Disable the compromised credential / revoke the API key / pause the leaking job. Speed > elegance.
2. **Capture forensics.** Snapshot Postgres logs, Supabase audit logs, application logs, queue state. Don't restart processes that hold the only copy of evidence.
3. **Limit access to the affected scope.** Apply tenant-wide legal hold via `/api/admin/gdpr/legal-holds` so retention worker doesn't anonymize evidence — see [§3.5 of this runbook](#35-emergency-legal-hold).
4. **Notify internally.** Open `#sec-incidents-2026-NN`; pull in CTO, DPO (when appointed), engineering lead, customer success lead.

**Owner:** Engineering lead.
**Deliverable:** containment timeline in the incident log. Each action timestamped.

### 2.4 Investigation

**Goals:**
- **Scope** — which tenants, which subjects, which data categories.
- **Timeline** — when did the exposure begin, when was it contained.
- **Cause** — code change, misconfiguration, sub-processor incident, malicious actor.
- **Severity** — likelihood + impact on data subjects' rights.

**Tools:**
- `audit_events` table (GDPR retention 7y) — all administrative actions.
- `personal_data_access_logs` — read-side audit; query `actor_user_id`, `subject_person_id`, `accessed_at`.
- `audit_outbox` — events in flight at incident time.
- Supabase audit logs (control plane) — for credential rotation, schema changes.
- Application logs from the relevant time window.

**Owner:** CTO (or named delegate).
**Deliverable:** investigation report (markdown, in private repo) with scope + cause + timeline + remediation.

### 2.5 Notification

There are up to three audiences. Order them by severity + obligation, not by ease.

**(a) Supervisory authority (Art. 33).**
- Filed within 72 hours of awareness via the AP reporting form (https://autoriteitpersoonsgegevens.nl/en/reporting-a-data-breach).
- Use the "Notification of a personal data breach" form. Fields map to the report.
- BE residents: file with the APD/GBA in addition to AP.

**(b) Affected customers / controllers (Art. 33(2)).**
- We are processor for our customers; they are controllers. They have their own 72h obligation, so we have to inform them faster than that — practically, within 24 hours of triage confirming breach.
- Use the customer comms template ([§4.1](#41-customer-notification-template)).
- Send via designated breach-comms email per `tenants.privacy_contact_email`.
- Follow with a phone call for high-tier customers (enterprise).

**(c) Data subjects (Art. 34).**
- Required when the breach is **likely to result in high risk** to subjects (sensitive categories, financial, large scale, identity-theft potential).
- Use the subject comms template ([§4.2](#42-subject-notification-template)).
- Send via the channel(s) tenants typically use to reach subjects (email; for high-risk include in-app banner).
- **The controller (our customer) is the legal sender; we draft, customer signs off.**

**Owner:** CTO + customer success lead (parallel notification).
**Deliverable:** notification log with timestamps, recipients, content, and any responses received.

### 2.6 Post-mortem

**Within 14 days of containment**, produce a blameless post-mortem in `docs/postmortems/<date>-<short-name>.md`:

- Summary (≤3 sentences).
- Detection → resolution timeline.
- Root cause analysis (5 whys minimum).
- What went well.
- What went poorly.
- Action items with owners + dates (each one tracked in Linear).

Review with the engineering team. Update the relevant runbook(s) so the next person (or the same person, six months later) knows.

---

## §3. Roles + escalation

| Role | Responsibility |
|---|---|
| **Security on-call** | First responder; runs detection + initial triage; pages others. |
| **CTO** | Owns the incident overall; final call on notification; spokesperson if external-facing. |
| **Engineering lead** | Containment + technical investigation. |
| **DPO** (when appointed; CTO + legal counsel until then) | GDPR compliance; supervisory-authority interface; sign-off on no-notify decisions. |
| **Customer success lead** | Customer comms; manages customer-side post-incident questions. |
| **Legal counsel** (external) | Reviews notification language; advises on regulator interactions. |

**Escalation tree:**

```
Security on-call
    │
    ├─▶ CTO (immediate, any potential breach)
    │       │
    │       ├─▶ DPO / Legal counsel (within 4h)
    │       └─▶ Engineering lead (immediate, for containment)
    │
    └─▶ Customer success lead (when customer comms drafted)
```

Keep the chain short. If a layer is unreachable for >30 minutes during an active incident, the next layer takes over.

---

## §4. Communication templates

### 4.1 Customer notification template

> **Subject:** Security incident affecting your Prequest workspace — required disclosure
>
> Dear {customer privacy contact},
>
> Prequest is writing to inform you that we detected a security incident that affected personal data held in your workspace. As your processor under our DPA, we are notifying you so that you can fulfil your own GDPR Art. 33 obligations as the data controller.
>
> **What happened:** {one-paragraph factual description}.
> **When:** Detected at {ISO timestamp}; the exposure window is {start}–{end} CET. Contained at {ISO timestamp}.
> **Who is affected:** {tenant scope; subject scope; data categories — quote the categories from `tenant_retention_settings`}.
> **What we have done:** {containment + remediation actions}.
> **What we are still investigating:** {open questions}.
> **What you should consider:** depending on the nature of the data, you may need to notify your supervisory authority and the affected data subjects. We recommend coordinating with your DPO. We are available to support that process.
> **Our regulator notification:** filed / will be filed / under DPO review by {timestamp}.
>
> Your dedicated contact for this incident is {name} at {email + phone}. We will follow up with a written investigation report within 14 days.
>
> Sincerely,
> {CTO name}
> Prequest

### 4.2 Subject notification template

> **Subject:** Important notice about your personal information held by {customer name}
>
> Dear {subject},
>
> {Customer name} is writing to inform you of a security incident that affected personal information they hold about you. {Customer name} uses Prequest as its workplace operations platform, and we partnered with Prequest to investigate and respond.
>
> **What happened:** {one-paragraph factual description in plain language}.
> **What information was affected:** {list of categories — be specific. e.g. "your name, work email address, and visit dates between {start} and {end}". Avoid hedging like "may have been affected" — say what we know}.
> **What we have done:** {containment + remediation actions, in plain language}.
> **What you can do:** {concrete steps where applicable — e.g. "please change any passwords if you reused this email's password elsewhere". Where no action is required, say so}.
> **More information:** if you have questions, contact {customer DPO name} at {email}. You also have the right to lodge a complaint with your supervisory authority ({list authority for the subject's jurisdiction}).
>
> Sincerely,
> {Customer privacy contact}
> {Customer name}

### 4.3 Internal status update template

> **#sec-incidents-2026-NN status — {timestamp}**
>
> - **State:** {detection | triage | containment | investigation | notification | post-mortem}.
> - **Scope:** {tenants × subjects × categories}.
> - **Notification status:** {AP not yet filed | filed at {timestamp} | not required (reason)}.
> - **Customer comms:** {pending | sent {timestamp}}.
> - **Subject comms:** {N/A | pending controller sign-off | sent {timestamp}}.
> - **Outstanding actions:**
>   - {action} — owner: {name}, due {timestamp}.

---

## §5. Annexes

### 5.1 AP reporting form fields (mapped to investigation outputs)

| AP form field | Source from our investigation |
|---|---|
| Date and time of breach | Investigation timeline §2.4. |
| Date and time of detection | Detection log §2.1. |
| Type of breach (confidentiality / integrity / availability) | Triage §2.2 rubric. |
| Categories of data subjects | `personal_data_access_logs.subject_person_id` → `persons.type`. |
| Categories of data | Quote from `tenant_retention_settings.data_category`. |
| Approximate number of subjects | Distinct `subject_person_id` count in affected scope. |
| Approximate number of records | Row count in affected scope. |
| Likely consequences | Investigation §2.4 severity. |
| Measures to address the breach | Containment §2.3 + remediation. |
| DPO contact | (When appointed.) Until then, CTO. |

### 5.2 Quarterly tabletop exercise

Once per quarter, the CTO picks an incident scenario and runs a 60-minute tabletop:

- Q1: malicious insider exporting bulk PII via the per-person Art. 15 endpoint.
- Q2: cross-tenant RLS bypass discovered in production.
- Q3: sub-processor breach notification (e.g. Supabase or Postmark notifying us).
- Q4: ransomware encrypting Postgres backups.

Document the exercise; treat it like a real incident through §2.5 (skip §2.6 — no actual harm to post-mortem).

### 5.3 Emergency legal hold (§2.3 reference)

When containment requires preserving evidence, place a tenant-wide legal hold immediately:

```
POST /api/admin/gdpr/legal-holds
{
  "hold_type": "tenant_wide",
  "reason": "INCIDENT-2026-NN: preserving evidence pending investigation",
  "expires_at": null
}
```

Releases require a `reason` of {'≥'}8 chars and emit `gdpr.legal_hold_released`. Default to manual release after the post-mortem signs off.

---

**Maintenance rule:** when this runbook is exercised (real or tabletop) and reality diverges from the playbook, fix the playbook first, then close out the incident. Drift is how runbooks become useless.
