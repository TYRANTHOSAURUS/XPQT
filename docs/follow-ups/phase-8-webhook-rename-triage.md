# Phase 8.A.2.5 — webhook wire-shape rename triage

> **Status:** read-only triage. NO code renames in this commit.
> **Date:** 2026-05-09. **Branch:** `main`.
> **Scope:** every legacy/asymmetric ref in `webhook-mapping*.spec.ts`
> + `webhook-mapping-validator.ts` (34 refs total).

## 0. Why this exists

The Phase 8 audit (see [`phase-8-naming-audit.md`](./phase-8-naming-audit.md)
§2.C) flagged the webhook subsystem as the highest wire-shape-risk
surface in the rename sweep:

> **The webhook ingest contract may emit `request_type_id` (config
> side) but accept `ticket_type_id` (runtime side). Renaming
> variables in this surface without auditing the wire-shape is a
> potential public-API breakage.** (§4.1)

This document is that audit. Each ref is classified into one of two
buckets:

- `WIRE_SHAPE_PINNED` — the field name is on the public webhook
  configuration contract or the ingress JSON DTO. **Renaming
  changes a public API.** Must NOT rename without versioning the
  webhook config schema.
- `INTERNAL_RENAME_SAFE` — the ref is a local variable, type alias,
  test description, or comment. Renaming affects no caller.

Per the user's standing instruction: "When in doubt, rename
INTERNAL variables, KEEP wire-shape field names." This commit does
**zero** renames; the `INTERNAL_RENAME_SAFE` bucket is queued for a
follow-up under Phase 8.B.x — applying it here would conflate a
public-API audit with a no-op cleanup.

## 1. Production wire-shape contract (source of truth)

The following names ARE on the public contract:

| Field | Where | Why pinned |
|---|---|---|
| `default_request_type_id` | `webhook_endpoints.default_request_type_id` column + `Webhook` type field (`webhook-types.ts:28`) + admin DTO (`webhook-admin.service.ts:24`) | Stored on disk + read by every admin client + present on the response shape returned by every webhook GET. |
| `request_type_rules` (array of `RequestTypeRule`) | Same table column + same DTO (`webhook-admin.service.ts:25`, `webhook-types.ts:29`) | Same — stored config readable by every UI. |
| `RequestTypeRule.request_type_id` | Inner field on each rule | Shape inside `request_type_rules`; an admin client constructs these. |
| `default_request_type_id` validator field key | `webhook-mapping-validator.ts:21` `field` discriminator | The validator's `problems[].field` keys are returned from the validate API to admin UIs that highlight the offending field in a form. Changing the key breaks the UI's field-binding logic. |
| `ticket_type_id` validator field key | Same `field` discriminator (`webhook-mapping-validator.ts:42`) + `field_mapping.ticket_type_id` JSONPath alias | Admin UI binds errors to the form field literally named `ticket_type_id` (the universal requirement). |
| `field_mapping.ticket_type_id` | `field_mapping` is a free-form JSONB column whose KEYS are runtime row column names — `ticket_type_id`, `requester_person_id`, etc. (`webhook-mapping-validator.spec.ts:42`) | Tenants author these mappings; we cannot rename keys without a data migration over every existing webhook config row. |
| `dto.ticket_type_id` | The mapping output DTO consumed by `TicketService.create()` (`webhook-mapping.service.ts:48`) | Internal cross-module field, BUT it has the same name as the runtime row column (`tickets.ticket_type_id`) per B.2 §0.1 — this is the asymmetry-by-design, not a stale variable. |
| `webhook_endpoints.workflow_id` | `webhook_endpoints.workflow_id` column + Webhook type (`webhook-types.ts:22`) + admin DTO | Webhook can pin a specific workflow; uses runtime-row short form per B.2 §0.1. Stored + on the public read shape. |

## 2. Triage table

Format: `path:line` — `field` — classification.

### `webhook-mapping-validator.ts` (4 refs)

| Path:line | Field | Classification | Notes |
|---|---|---|---|
| `webhook-mapping-validator.ts:21` | `'default_request_type_id'` | WIRE_SHAPE_PINNED | Discriminator literal in the `WebhookValidationProblem` union. Returned to admin UI. |
| `webhook-mapping-validator.ts:35` | `webhook.default_request_type_id` | WIRE_SHAPE_PINNED | Reading the storage column / public type. |
| `webhook-mapping-validator.ts:37` | `provided.has('ticket_type_id')` | WIRE_SHAPE_PINNED | Looks up by the literal field-mapping key admins author. |
| `webhook-mapping-validator.ts:42` | `field: 'ticket_type_id'` | WIRE_SHAPE_PINNED | Discriminator literal returned in `problems[].field`. |

### `webhook-mapping-validator.spec.ts` (14 refs)

| Path:line | Field | Classification | Notes |
|---|---|---|---|
| `webhook-mapping-validator.spec.ts:5` | `'default_request_type_id' \| 'request_type_rules'` (in test type union) | WIRE_SHAPE_PINNED | Mirrors the discriminator; renaming = bypassing the contract. |
| `webhook-mapping-validator.spec.ts:11` | `default_request_type_id: null` | WIRE_SHAPE_PINNED | Constructs a Webhook fixture matching production. |
| `webhook-mapping-validator.spec.ts:20` | `it('errors when no ticket_type_id source...')` | INTERNAL_RENAME_SAFE | Test description — descriptive English. Deferred. |
| `webhook-mapping-validator.spec.ts:23` | `field === 'ticket_type_id'` | WIRE_SHAPE_PINNED | Asserts the public discriminator. |
| `webhook-mapping-validator.spec.ts:27, 32, 34, 49, 71, 92, 102` | `default_request_type_id: 'rt1'` (and similar) | WIRE_SHAPE_PINNED | Fixture data on the public Webhook shape. |
| `webhook-mapping-validator.spec.ts:42` | `field_mapping: { ticket_type_id: '$.rt' }` | WIRE_SHAPE_PINNED | The KEY of the field_mapping object is admin-authored. |
| `webhook-mapping-validator.spec.ts:60, 81` | `default_request_type_id: 'rt1'` | WIRE_SHAPE_PINNED | Same. |

### `webhook-mapping.service.spec.ts` (16 refs)

| Path:line | Field | Classification | Notes |
|---|---|---|---|
| `webhook-mapping.service.spec.ts:39` | `workflow_id: null` | WIRE_SHAPE_PINNED | `webhook_endpoints.workflow_id` column. |
| `webhook-mapping.service.spec.ts:45` | `default_request_type_id: null` | WIRE_SHAPE_PINNED | Same column / type. |
| `webhook-mapping.service.spec.ts:72, 80, 91, 94, 101, 107, 121, 136, 154` | `default_request_type_id: …` | WIRE_SHAPE_PINNED | Same. |
| `webhook-mapping.service.spec.ts:77` | `it('picks ticket_type_id from a matching request_type_rule')` | INTERNAL_RENAME_SAFE | Test description prose. Deferred. |
| `webhook-mapping.service.spec.ts:83-84` | `request_type_id: 'rt-p1'` (inside `request_type_rules[]`) | WIRE_SHAPE_PINNED | Inner field of `RequestTypeRule`. Admin-authored. |
| `webhook-mapping.service.spec.ts:88, 101` | `dto.ticket_type_id` | WIRE_SHAPE_PINNED | The mapping DTO is consumed by `TicketService.create()`; field name pinned by B.2 §0.1 runtime-row asymmetry. |
| `webhook-mapping.service.spec.ts:97` | `request_type_id: 'rt-other'` | WIRE_SHAPE_PINNED | Inside `request_type_rules[]`. |

## 3. Summary

- **WIRE_SHAPE_PINNED**: 32 of 34 refs.
- **INTERNAL_RENAME_SAFE**: 2 refs (both test descriptions / English
  prose; renaming would make the test names worse, not better).

**Net renames recommended:** 0. The webhook subsystem is at full
canonical alignment with the public contract; the 34 refs are not
naming drift, they are the contract.

## 4. Apply in Phase 8.B.x follow-up

Nothing to apply. Both `INTERNAL_RENAME_SAFE` items are test names
written in English; renaming "ticket_type_id" → "request_type_id"
in a test description doesn't improve clarity (the test asserts on
the literal field name on the wire — using the DB-column form
matches what the reader sees in fixtures).

If the webhook config table is ever versioned to v2, reopen this
triage. Until then: the audit doc's risk-register §4.1 entry can be
marked resolved.

## 5. Allowlist coverage

All 34 refs are currently outside `apps/api/src/.naming-allowlist.txt`
because the patterns this file matches (`request_type_id`, etc.) are
not in the legacy-table grep set (`booking_bundle | reservation`).
The Phase 8.A.2.6 CI guard greps only for those legacy-table refs;
the asymmetry refs in this triage are NOT in scope and don't need
allowlist entries.

The B.2 §0.1 asymmetry has its own guard at
`scripts/check-b2-config-reads.sh` + `apps/api/src/modules/.b2-config-reads-allowlist.txt`,
which already covers `webhook-admin.service.ts` reads.

---

**Status:** triage complete. Reference resolved Phase 8 audit risk
§4.1. No code action required.
