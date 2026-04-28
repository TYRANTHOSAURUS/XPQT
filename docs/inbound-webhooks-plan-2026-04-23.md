# Inbound Webhooks — Create Tickets + Start Workflows from External Systems

**Status:** shipped (as of 2026-04-28)
**Plan date:** 2026-04-23
**Owner:** routing / ticketing
**Related docs:** [`docs/assignments-routing-fulfillment.md`](./assignments-routing-fulfillment.md), [`docs/visibility.md`](./visibility.md)

> **Shipped state.** This plan was executed end-to-end. The implementation lives at `apps/api/src/modules/webhook/*` (admin + auth + ingest + mapping + events services) with admin pages at `apps/web/src/pages/admin/webhook{,-create,-detail,-events}.tsx`. Schema landed in `supabase/migrations/00095_inbound_webhooks.sql` (API-key auth, ticket idempotency via `external_system` + `external_id`, `webhook_events` audit log). The §2 "current state" prose below describes the *pre-implementation* world (the old `00029_workflow_webhooks.sql` table) — it is preserved as a benchmark, not as a description of today's behaviour.

---

## 1. Goal

Let a second system (Jira, ServiceNow, Zendesk, a monitoring alert, an IoT device) POST a payload to Prequest and have it:

1. Create a ticket with the right scope (request type, location, asset, requester, priority).
2. Route through the normal resolver — assignee, SLA, approval gate all behave identically to a portal-created ticket.
3. Start a workflow — either the one attached to the resolved request type (preferred) **or** an explicit override picked per webhook.
4. Stay idempotent across retries and report actionable errors back to the caller.

Non-goals in v1: outbound webhooks, bidirectional sync, attachment ingestion, per-field ACLs on inbound data.

---

## 2. Current state (why this plan exists)

Migration `00029_workflow_webhooks.sql` already ships a `workflow_webhooks` table and `/webhooks/:token` public endpoint. It works but has real gaps:

| What today does | Consequence |
|---|---|
| `WorkflowWebhookService.receive` inserts directly into `tickets` (`supabase.admin.from('tickets').insert(...)`). | **Bypasses `TicketService.create`.** No resolver runs → no assignee, no `routing_decisions` row. No SLA timers start. Approval gate ignored. No `ticket_created` / `system_event` activity or domain event. |
| Manually calls `engine.startForTicket(ticket.id, row.workflow_id)` after the insert. | Works, but duplicates what `runPostCreateAutomation` would do if `request_types.workflow_definition_id` were wired via a mapped `ticket_type_id`. Also forces every webhook to hardcode a workflow ID even when the payload *does* have a request type. |
| Auth = 24-byte hex token in the URL path (`POST /webhooks/:token`). | Tokens end up in access logs, proxies, and browser history. Acceptable for a demo, not for production integrations. |
| No `external_system` / `external_id` columns on `tickets`. No dedupe. | A retry storm from the source system creates N duplicate tickets. |
| Payload mapping (`ticket_defaults` + `field_mapping`) cannot resolve a `ticket_type_id`. | Routing has nothing to route on — the resolver's first input is the request type. Every webhook-created ticket would miss routing rules and land on the request-type default — but there is no request type, so it would land unassigned. |
| No HMAC, no IP allowlist, no rate limit. | DoS by accident or design, and no way to prove a request actually came from Jira. |
| Failures are logged only in `workflow_webhooks.last_error` (overwritten each time). | No per-event audit. Ops can't answer "what happened to the payload Jira sent at 14:02?" |

The plan keeps the existing table (additive migrations) and swaps the receive handler to a corrected pipeline.

---

## 3. How routing runs for an inbound webhook — before the ticket exists

**Short answer: routing doesn't run "before the ticket is made." It runs *as part of* ticket creation, inside `runPostCreateAutomation`** (see [`docs/assignments-routing-fulfillment.md` §3.0](./assignments-routing-fulfillment.md#30-when-the-resolver-runs)). The webhook's job is to give the resolver enough input — *then* the resolver does its normal thing.

The call chain for an inbound webhook:

```
POST /webhooks/v2/ingest        (public, HMAC or API-key auth)
  ↓  resolve API key → tenant
  ↓  idempotency check: (tenant_id, external_system, external_id)
  ↓  map payload → CreateTicketDto
  ↓  TicketService.create(dto)                                  ← normal tenant path
        ↓  insert into tickets
        ↓  (approval gate? park in pending_approval, return)
        ↓  runPostCreateAutomation(ticket, tenant, request_type_cfg)
              ↓  RoutingService.evaluate({ request_type, location, asset, priority, domain })
                    ↓  RoutingEvaluatorService → (dualrun or legacy or v2)
                    ↓  writes routing_decisions row
              ↓  write assigned_team_id / _user_id / _vendor_id back to tickets
              ↓  SlaService.startTimers(ticket.id, sla_policy_id)
              ↓  WorkflowEngineService.startForTicket(ticket.id, workflow_definition_id)
  ↓  return { ticket_id, workflow_instance_id, external_id } with 200 (or 202 if async)
```

The key insight: **the webhook doesn't make routing decisions. It constructs a well-formed `CreateTicketDto`, and the existing `runPostCreateAutomation` path routes + SLAs + starts the workflow exactly like any other create.** Any divergence between "how a ticket from the portal routes" and "how a ticket from Jira routes" is a bug.

### What the resolver needs from the payload

Because **routing fires before workflow starts** (both happen inside `runPostCreateAutomation`, but routing is first), a workflow that expects an assigned team / SLA clock / approver in scope can only work if the *resolver* had enough input to produce a meaningful assignment. So the webhook contract isn't "any JSON at all" — it's "enough JSON to make routing deterministic for the specific request type you mapped."

Universal requirements — **the ingest endpoint returns 422 before insert if either is missing:**

| Field | Why required |
|---|---|
| `ticket_type_id` | Without a request type the resolver has **no domain, no strategy, no defaults** — every branch misses and the ticket lands `unassigned`, which also means no workflow because `workflow_definition_id` lives on the request type. Source: direct payload field, first matching `request_type_rules`, or webhook-level `default_request_type_id`. |
| `requester_person_id` | `CreateTicketDto.requester_person_id` is NOT NULL. The ticket refuses to insert without one. Source: payload field, `requester_lookup` (email → person), or webhook-level `default_requester_person_id` (typically a designated "Integrations" system user). |

Conditional requirements — **depend on the mapped request type's `fulfillment_strategy`** (see [routing doc §4](./assignments-routing-fulfillment.md#4-fulfillment-strategies--which-branches-run)). The webhook config must supply these, or routing silently degrades to the request-type default:

| Strategy on the mapped request type | Also needs in payload (or webhook config) | What happens if missing |
|---|---|---|
| `fixed` | Nothing extra. | Lands on `request_types.default_team_id` / `default_vendor_id`. Intended behavior. |
| `asset` | `asset_id` | Asset branch is skipped. Falls to request-type default. Probably wrong for an asset-centric request type — flag this at config time, not at receive time. |
| `location` | `location_id` (or an `asset_id` whose `assets.assigned_space_id` resolves). | Location chain never walks. Falls to request-type default. Same: flag at config time. |
| `auto` | At least one of `asset_id` or `location_id` to exercise either branch. | Both branches skipped. Falls to request-type default. Acceptable if the request type has a sensible default, suspicious otherwise. |

Priority is optional (default `medium`) but matters for routing rules that match on `priority` — webhooks for urgent alerts should set it explicitly.

### Config-time validation (the key guardrail)

Because missing-required-for-routing fields degrade silently at runtime (the ticket still gets created, just on the wrong team), the **admin save path** for a webhook runs a validator that inspects the mapped request type's strategy and surfaces problems before the first event ever arrives:

```ts
validateWebhookMapping(webhook, requestType): ValidationResult {
  const problems: string[] = [];
  const provided = { ...keys(webhook.field_mapping), ...keys(webhook.ticket_defaults) };

  if (!webhook.default_request_type_id && webhook.request_type_rules.length === 0
      && !provided.has('ticket_type_id')) {
    problems.push({ severity: 'error', field: 'ticket_type_id',
      message: 'Webhook does not supply a request type — every inbound event will 422.' });
  }

  if (!webhook.default_requester_person_id && !webhook.requester_lookup
      && !provided.has('requester_person_id')) {
    problems.push({ severity: 'error', field: 'requester_person_id',
      message: 'Webhook does not supply a requester — every inbound event will 422.' });
  }

  switch (requestType.fulfillment_strategy) {
    case 'asset':
      if (!provided.has('asset_id')) problems.push({ severity: 'warning',
        field: 'asset_id',
        message: 'Request type is asset-strategy; without asset_id, routing falls to request-type default.' });
      break;
    case 'location':
      if (!provided.has('location_id') && !provided.has('asset_id')) problems.push({ severity: 'warning',
        field: 'location_id',
        message: 'Request type is location-strategy; without location_id (or an asset), routing falls to request-type default.' });
      break;
    case 'auto':
      if (!provided.has('asset_id') && !provided.has('location_id')) problems.push({ severity: 'info',
        message: 'Request type is auto-strategy; neither asset nor location mapped — only request-type default will assign.' });
      break;
  }

  return { ok: problems.every(p => p.severity !== 'error'), problems };
}
```

Returned in two places:

1. On `POST /workflow-webhooks` and `PATCH /workflow-webhooks/:id` — `error` blocks save, `warning`/`info` persist but surface in the UI.
2. From `POST /workflow-webhooks/:id/test` — runs against a sample payload so the admin can see exactly what `CreateTicketDto` will be built, plus the `routing/studio/simulate` result on that DTO. This answers "will my webhook route correctly?" without sending a real event.

Practical rule the admin UI surfaces prominently: **choose the request type first, and the form grows the fields that request type's strategy needs.**

### Approval gate interaction

If the resolved request type has `requires_approval = true`, `TicketService.create` parks the ticket in `pending_approval` and **does not route yet**. Routing/SLA/workflow all fire on approval grant via `onApprovalDecision('approved')`. This is desirable behavior for webhooks — a change-management integration in Jira shouldn't bypass internal approvals just because it came through an API.

### Workflow start — two modes

1. **Request-type-driven (default):** the workflow is whatever `request_types.workflow_definition_id` says. This is how the portal already works. Preferred.
2. **Webhook override:** `workflow_webhooks.workflow_id` (already exists in schema) acts as an explicit override — set this when the webhook is for a payload that has no natural request type (e.g. generic "alert from monitoring"). When override is set, we still run routing via a mapped `ticket_type_id` (otherwise the ticket lands unassigned), but swap the workflow definition for the override at the end of `runPostCreateAutomation`.

v1 implementation: if `webhook.workflow_id` is set, after `TicketService.create` returns, call `WorkflowEngineService.startForTicket(ticket.id, webhook.workflow_id)` — **and** add a guard to `runPostCreateAutomation` that skips the request-type workflow when called from the webhook path (new optional flag: `skipWorkflow`).

---

## 4. Scope for v1

In:

- Single public endpoint `POST /webhooks/ingest`. Replaces the existing `POST /webhooks/:token` outright — no shim, no dual-run, no deprecation period.
- **Synchronous processing.** The request doesn't return until `TicketService.create` has finished. Internally the workflow engine is structured so `startForTicket` returns as soon as the `workflow_instances` row is inserted; long-running nodes (external HTTP, delays) execute on the engine's own tick, not on the caller's stack. This keeps p50 ingest latency in the 50–150ms range while preserving the "routing → workflow" invariant.
- API-key auth via `Authorization: Bearer <key>` header. Key identifies tenant + webhook config. **HMAC is out of scope for v1** — added later when we onboard a source system that speaks it natively (GitHub, Stripe, etc.).
- Idempotency via unique index on `tickets (tenant_id, external_system, external_id)`.
- Payload mapping: keep the existing `ticket_defaults` + `field_mapping` shape, **add** request-type rules + requester lookup.
- Per-event audit log (`webhook_events` table) — **30-day hard-delete retention**, single daily cron.
- Admin CRUD UI under settings to create/revoke keys, edit mapping, view recent events.

Prepared-for-later (contract only, no runtime yet):

- **Attachments.** The `webhook_events.payload` captures the full raw source body — whatever URLs/metadata the source sent is preserved verbatim. When we implement attachment ingestion, the work is bounded to a new `WebhookAttachmentFetcher` service + a new `attachments_mapping` field on `workflow_webhooks`. No ingest-side schema change needed at that point. v1 ships with `attachments_mapping` absent from the config and payloads are ignored for attachments.
- **HMAC.** Auth service interface (`WebhookAuthService.verify(req) → VerifiedWebhook`) is defined with one implementation today (API key). Adding HMAC is a new branch inside `verify` + a nullable `hmac_secret` column on `workflow_webhooks`. No refactor required.

Out (punt to v2):

- Queue-based async ingest (v1 is synchronous — resolver, SLA, workflow all run in the request).
- Outbound webhooks (separate plan).
- Attachment ingestion via signed-URL pull.
- Per-source adapter modules (generic JSON mapping first; adapter abstraction only if we hit 3+ sources).

---

## 5. Design

### 5.1 Endpoint

```
POST /webhooks/ingest
Authorization: Bearer <api_key>
X-Prequest-External-System: jira            (optional but recommended)
X-Prequest-External-Id: PROJ-1234            (optional but unlocks idempotency)
X-Prequest-Signature: sha256=<hex>           (required only when HMAC enabled)
Content-Type: application/json

{ ...vendor payload... }
```

Response:

```
200 OK
{
  "ticket_id": "...",
  "workflow_instance_id": "...",
  "external_id": "PROJ-1234",
  "deduplicated": false
}
```

Errors:

| Status | Meaning |
|---|---|
| 401 | Missing / invalid API key. |
| 403 | API key valid but webhook inactive, or HMAC signature mismatch. |
| 409 | Idempotency hit — same `(tenant, external_system, external_id)` already processed. Returns the prior `ticket_id`. |
| 422 | Payload mapping produced an invalid `CreateTicketDto` (missing `ticket_type_id`, missing requester, etc.). Body includes which fields were missing. |
| 500 | Internal error (ticket insert failed, workflow engine threw). Written to `webhook_events.last_error`. |

Public, excluded from `TenantMiddleware` (tenant is resolved from the API key, not the subdomain).

### 5.2 Auth

**API key — the only auth mechanism in v1.** Header: `Authorization: Bearer <key>`.

- Format: `pqt_live_<32 random bytes hex>`. Prefix enables future visual scanning and environment separation (`pqt_test_…` for sandbox).
- Stored in `workflow_webhooks.api_key_hash` (SHA-256 of the key, never the plaintext). Presented exactly once at create/rotate time.
- Lookup path: compute hash of header value → `workflow_webhooks where api_key_hash = … and active = true`. Unique index on `api_key_hash`.
- `workflow_webhooks.last_used_at` updated on every accepted request (fire-and-forget, not on the request critical path).

**HMAC — deferred.** The `WebhookAuthService.verify(req)` interface is shaped so HMAC slots in as a second verification branch when we add it. No DB columns reserved in v1; a later migration adds `workflow_webhooks.hmac_secret` when needed.

**IP allowlist (optional).** `workflow_webhooks.allowed_cidrs text[]`. If set, source IP must match one of them. Default empty = open.

**Rate limit.** Per-webhook, simple token bucket — 60/min default, configurable. Implementation: in-memory on the Node process with a warning in the docs that this is per-instance, not global, and real protection should be at the edge (Vercel WAF). Good enough for v1.

### 5.3 Payload mapping

Extend existing `workflow_webhooks` shape:

```ts
{
  // existing
  ticket_defaults: Record<string, unknown>;  // static fields to set on every ticket
  field_mapping: Record<string, string>;     // ticketField -> JSONPath in payload

  // new
  default_request_type_id: string | null;    // fallback when no rule matches
  request_type_rules: Array<{                // first match wins
    when: Array<{ path: string; operator: 'equals' | 'in' | 'exists'; value?: unknown }>;
    request_type_id: string;
  }>;
  default_requester_person_id: string | null; // "integrations" user for payloads with no requester
  requester_lookup: {                        // optional email → person resolution
    path: string;                            // e.g. "$.reporter.email"
    strategy: 'exact_email' | 'none';
  } | null;
}
```

Resolution order in `WebhookMappingService.mapToCreateTicketDto(webhook, payload)`:

1. `ticket_type_id` — first matching `request_type_rules` entry → else `default_request_type_id` → else **422**.
2. `requester_person_id` — `field_mapping.requester_person_id` → `requester_lookup` → `default_requester_person_id` → else **422**.
3. `title`, `description`, `priority`, `location_id`, `asset_id`, `form_data` — pull from `field_mapping`, fall back to `ticket_defaults`, fall back to sensible constants (`title: "(Webhook) " + external_id`).
4. `source_channel` — hardcoded `'webhook:' + webhook.name` so list views can tell them apart.
5. `metadata.webhook_id`, `metadata.external_system`, `metadata.external_id`, `metadata.original_payload` — always set.

JSONPath evaluator: keep the existing `evalJsonPath` helper in `workflow-webhook.service.ts`. It's simple, tested implicitly by the existing demo webhooks, and doesn't justify a library. Extract it to `apps/api/src/modules/webhook/json-path.ts` so it can be unit-tested directly.

### 5.4 Idempotency

New columns on `tickets` (nullable, no backfill):

- `external_system text` — free-form label (`'jira'`, `'servicenow'`, `'datadog'`).
- `external_id text` — the source system's ID.

Unique index: `create unique index idx_tickets_external_ref on tickets (tenant_id, external_system, external_id) where external_system is not null and external_id is not null;`

Receive flow:

1. If payload has both `external_system` (from header or `field_mapping`) and `external_id`, `select id from tickets where tenant_id=? and external_system=? and external_id=?`.
2. Hit → return 200 with `deduplicated: true` and the existing `ticket_id`. No insert. No workflow start.
3. Miss → proceed to `TicketService.create`. The insert's unique-index violation on a race is caught and reinterpreted as a dedupe hit (safety net).

Expiry: none. Rationale — duplicate detection should last as long as the ticket exists. A 7-day window would silently re-create tickets for slow source systems.

### 5.5 Per-event audit log

Replace the "last_received_at / last_error" single-row state with an append-only log:

```sql
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  webhook_id uuid not null references public.workflow_webhooks(id) on delete cascade,
  received_at timestamptz not null default now(),
  external_system text,
  external_id text,
  status text not null,                  -- 'accepted' | 'deduplicated' | 'rejected' | 'error'
  ticket_id uuid references public.tickets(id) on delete set null,
  workflow_instance_id uuid,
  http_status int not null,
  error_message text,
  payload jsonb not null,                -- raw request body (redact later if needed)
  headers jsonb                          -- subset: user-agent, content-type, external-system, external-id
);

create index idx_webhook_events_webhook on public.webhook_events (webhook_id, received_at desc);
create index idx_webhook_events_external on public.webhook_events (tenant_id, external_system, external_id) where external_system is not null;
```

Ops can answer "what happened to the event Jira sent at 14:02" without tailing logs. Admin UI lists last 100 events per webhook with filters (status, external_id).

**Retention — 30 days hard delete.** Single daily cron (`0 3 * * *`) runs `delete from webhook_events where received_at < now() - interval '30 days'`. Reasoning: the event log exists for recent-issue triage, not long-term audit. Long-term audit already lives on the ticket itself — `tickets.metadata` always gets `{webhook_id, external_system, external_id, original_payload}` for successful ingests, so the provenance of a created ticket survives event-log expiry. Keeping one small, hot table with a single range-delete is better for query performance than a large table with tiered retention + partial nulling.

### 5.6 Legacy cleanup — dropped in the same PR

The existing `POST /webhooks/:token` endpoint, the `workflow_webhooks.token` column, and the token-based controller are dropped outright. No shim, no dual-run, no deprecation banner. What gets removed:

- `POST /webhooks/:token` route — deleted from the public controller.
- `workflow_webhooks.token` column — dropped in migration 00094 (same migration that adds the new columns).
- `idx_wwh_token` index — dropped.
- `apps/api/src/modules/workflow/workflow-webhook.controller.ts` — deleted. Admin endpoints move to the new `webhook` module under the same URL path (`/workflow-webhooks` → stays `/workflow-webhooks`, no URL breakage for admin clients).
- `apps/api/src/modules/workflow/workflow-webhook.service.ts` — deleted. Its logic either lives in the new `WebhookIngestService` (receive path, rewritten — the direct insert into `tickets` is replaced with `TicketService.create`) or `WebhookAdminService` (CRUD).
- `supabase/migrations/00042_seed_workflow_webhooks_demo.sql` — the migration file stays (don't rewrite history), but the *seed content* it inserted is superseded. Migration 00094 runs an `UPDATE … SET api_key_hash = …, default_request_type_id = …` over the existing demo rows to bring them onto the new schema, and drops any now-meaningless columns (`token`). Existing tenants get their demo webhooks upgraded in place; no one has to re-create them by hand.
- The `app.module.ts` entry that excludes `/webhooks/:token` from `TenantMiddleware` is replaced with an exclusion for `/webhooks/ingest`.

Result: one receive endpoint, one auth model, one code path, one storage shape. No "legacy mode" anywhere.

---

## 6. Migrations

Next free prefix is 00094 (latest shipped per `CLAUDE.md` memory = 00093 catalog collapse).

### 00095_inbound_webhooks.sql (00094 is already taken by request-type replace functions)

Single migration does the additions **and** the cleanup:

Additions on `workflow_webhooks`:

1. `api_key_hash text unique` — added nullable; backfilled in step 8; `set not null` in step 9.
2. `allowed_cidrs text[] not null default '{}'`.
3. `rate_limit_per_minute int not null default 60`.
4. `default_request_type_id uuid references public.request_types(id)`.
5. `request_type_rules jsonb not null default '[]'`.
6. `default_requester_person_id uuid references public.persons(id)`.
7. `requester_lookup jsonb`.
8. Backfill: `update workflow_webhooks set api_key_hash = encode(sha256(gen_random_uuid()::text::bytea), 'hex') where api_key_hash is null` (demo seed rows). A migration log message notes that these hashes are unreachable and must be rotated by an admin — acceptable because we're a system in development.
9. `alter column api_key_hash set not null`.
10. `alter column workflow_id drop not null` — workflow is now optional (request type can supply it).

**Not added in v1** (deferred): `hmac_secret`. Added in a later migration when HMAC lands.

Removals on `workflow_webhooks`:

11. `drop index if exists idx_wwh_token;`
12. `alter table workflow_webhooks drop column token;`

Additions on `tickets`:

13. `add column external_system text` (nullable).
14. `add column external_id text` (nullable).
15. `create unique index idx_tickets_external_ref on tickets (tenant_id, external_system, external_id) where external_system is not null and external_id is not null;`

New table:

16. Create `webhook_events` (see §5.5) + indexes + RLS `tenant_isolation` policy identical to `workflow_webhooks`.

Retention cron (added alongside the existing SLA cron in code, not in SQL):

17. Daily `0 3 * * *` job calling `delete from webhook_events where received_at < now() - interval '30 days'`.

Trailer:

18. `notify pgrst, 'reload schema';`

No separate follow-up migration. The token column and the legacy endpoint are gone after 00094 runs.

---

## 7. API surface

### Admin (tenant-scoped, under `/workflow-webhooks` — already exists)

Additive endpoints:

- `POST /workflow-webhooks/:id/api-key/rotate` — returns `{ api_key: "pqt_live_…" }` **exactly once**. Future reads return only the hash-prefix for identification.
- `POST /workflow-webhooks/:id/hmac-secret/rotate` — returns `{ hmac_secret: "…" }` exactly once. Passing `{ hmac_secret: null }` disables HMAC.
- `GET /workflow-webhooks/:id/events?status=&external_id=&limit=` — list recent events.
- `POST /workflow-webhooks/:id/test` — accepts a sample payload, runs it through mapping **without** creating a ticket, returns the would-be `CreateTicketDto`. Critical for testing mapping rules.

Existing `POST /workflow-webhooks`, `PATCH /workflow-webhooks/:id`, `DELETE /workflow-webhooks/:id` gain the new columns via the DTO.

### Public (no auth middleware)

- `POST /webhooks/ingest` — the only entry point (§5.1). `POST /webhooks/:token` is gone.

---

## 8. Module layout

Extract webhook code out of `workflow/` into its own module — it's about ticket intake, not about workflow internals. The old files under `workflow/` are **deleted**, not proxied.

```
apps/api/src/modules/webhook/
  webhook.module.ts
  webhook-admin.controller.ts          (tenant-scoped: /workflow-webhooks CRUD + rotate + events + test)
  webhook-ingest.controller.ts         (public: POST /webhooks/ingest)
  webhook-ingest.service.ts            (orchestrates auth → mapping → TicketService.create → workflow)
  webhook-mapping.service.ts           (JSONPath + request_type_rules + requester_lookup)
  webhook-auth.service.ts              (API key lookup, HMAC verify, IP allowlist, rate limit)
  webhook-event.service.ts             (append-only events + retention)
  webhook-mapping-validator.ts         (validateWebhookMapping — §3 "Config-time validation")
  json-path.ts                         (extracted helper)
  *.spec.ts
```

Deleted:

- `apps/api/src/modules/workflow/workflow-webhook.controller.ts`
- `apps/api/src/modules/workflow/workflow-webhook.service.ts`

Their imports disappear from `apps/api/src/modules/workflow/workflow.module.ts`. `WorkflowEngineService` is untouched — it doesn't care where ticket creation came from.

URL path retained: admin CRUD stays at `/workflow-webhooks` to avoid breaking admin clients and the URL in the admin UI. Only the *module boundary* moved.

---

## 9. Tests

Unit:

- `WebhookMappingService` — each resolution path for `ticket_type_id` and `requester_person_id`, including failure cases (422).
- `WebhookAuthService.verifyHmac` — constant-time comparison, header formats (`sha256=...`), mismatch.
- `JsonPath` — `$.a.b`, `$.items[0].name`, missing keys, leading-`$`-optional.

Integration (with testcontainers Postgres or against local Supabase):

- Happy path: POST with API key → 200, ticket created, routing_decisions row present, SLA timer started, workflow instance created.
- Idempotency: same external_id twice → second returns 409 with existing ticket_id.
- Approval gate: request type with `requires_approval=true` → ticket in `pending_approval`, no routing_decisions yet, workflow_instance_id is null, later approval → routing fires.
- Workflow override: webhook has `workflow_id` and request type has a different `workflow_definition_id` → webhook override wins, exactly one workflow instance created.
- Missing `ticket_type_id` in both payload and config → 422.
- Legacy `/webhooks/:token` path still works.

Resolver-specific scenarios (reuse the routing scenario harness in `apps/api/src/modules/routing/scenarios.spec.ts`):

- Webhook-mapped ticket with `location_id` only → location branch runs.
- Webhook-mapped ticket with `asset_id` only → asset branch, falls back to asset-owned space.
- Webhook-mapped ticket with no scope → lands on `request_type_default_team`.

---

## 10. Admin UI (`apps/web`)

New settings page `/admin/integrations/webhooks` using `SettingsPageShell` template (per `CLAUDE.md`):

1. **List view** — one row per webhook: name, request type, active, last event status, last_used_at. Actions: edit / rotate key / view events / delete.
2. **Edit sheet** — `FieldGroup` with sections:
   - *Identity:* name, active.
   - *Mapping:* default request type select, `request_type_rules` editor, `default_requester_person_id`, `field_mapping` key-value editor, `ticket_defaults`.
   - *Auth:* HMAC toggle (show secret once on enable), IP allowlist, rate limit.
   - *Workflow override:* dropdown of workflow definitions; "inherit from request type" is the default.
3. **Test panel** — paste a JSON payload, click "Test mapping" → shows resulting `CreateTicketDto` + would-be `routing_decision` preview (via `routing/studio/simulate`).
4. **Event log** — table of recent events, filterable by status, searchable by `external_id`. Click a row → side drawer with raw payload, headers, error, resulting ticket link.

All forms use shadcn Field primitives per `CLAUDE.md`. React Query per [`docs/react-query-guidelines.md`](./react-query-guidelines.md) — one key factory under `apps/web/src/api/webhooks/`.

---

## 11. Rollout

Single PR, single migration, no feature flag. System is in development — no tenants to migrate, no integrations to preserve.

1. **Migration 00094** — adds new columns, drops `token`, creates `webhook_events`, backfills demo rows with throwaway `api_key_hash` values (admin must rotate to get a usable key — see §6).
2. **Code swap** — delete `workflow-webhook.*.ts`, register new `WebhookModule`, rewrite `app.module.ts` middleware exclusion (`/webhooks/ingest` in, `/webhooks/:token` out).
3. **Admin UI** — ship directly, no flag.
4. **Update `docs/assignments-routing-fulfillment.md`** — add webhook ingestion to §3.0's resolver-trigger table, add the new webhook module + migration to §15's mandatory-update trigger list, add `tickets.external_system` / `tickets.external_id` to the schema trigger list.
5. **Run `pnpm db:push`** against remote Supabase (per `CLAUDE.md` workstream permission).
6. **Smoke test** — curl a payload at `/webhooks/ingest`, verify `tickets` row has an assignee, `routing_decisions` has a row, SLA timers are open, workflow instance started, `webhook_events` logged the accept.

---

## 12. Files touched

New:

- `supabase/migrations/00095_inbound_webhooks.sql`
- `apps/api/src/modules/webhook/webhook.module.ts`
- `apps/api/src/modules/webhook/webhook-admin.controller.ts`
- `apps/api/src/modules/webhook/webhook-ingest.controller.ts`
- `apps/api/src/modules/webhook/webhook-ingest.service.ts`
- `apps/api/src/modules/webhook/webhook-mapping.service.ts`
- `apps/api/src/modules/webhook/webhook-auth.service.ts`
- `apps/api/src/modules/webhook/webhook-event.service.ts`
- `apps/api/src/modules/webhook/webhook-mapping-validator.ts`
- `apps/api/src/modules/webhook/json-path.ts`
- `apps/api/src/modules/webhook/*.spec.ts`
- `apps/web/src/api/webhooks/queries.ts`, `mutations.ts`
- `apps/web/src/pages/admin/integrations/webhooks/{index.tsx,edit-sheet.tsx,events-drawer.tsx,test-panel.tsx}`

Deleted:

- `apps/api/src/modules/workflow/workflow-webhook.controller.ts`
- `apps/api/src/modules/workflow/workflow-webhook.service.ts`

Modified:

- `apps/api/src/modules/workflow/workflow.module.ts` — drop the two deleted providers/controllers.
- `apps/api/src/modules/ticket/ticket.service.ts` — accept `external_system`, `external_id` on `CreateTicketDto`; add optional `skipWorkflow` flag to `runPostCreateAutomation` so a webhook-level workflow override doesn't double-fire alongside the request type's workflow.
- `apps/api/src/app.module.ts` — register `WebhookModule`, swap the `TenantMiddleware` exclusion from `/webhooks/:token` to `/webhooks/ingest`.
- `docs/assignments-routing-fulfillment.md` — add row to §3.0 resolver-trigger table ("Webhook ingestion" → calls through `TicketService.create` → `runPostCreateAutomation`). Extend §15's trigger list with the new webhook module, migration 00094, and the `tickets.external_system` / `tickets.external_id` columns.

---

## 13. Decisions (resolved 2026-04-23)

1. **Sync ingest.** Best for performance in this system's scale: no queue hop, no worker cold-start, no extra infra. Invariant: `WorkflowEngineService.startForTicket` must return as soon as `workflow_instances` is inserted — long-running nodes run on the engine's own tick, not the webhook caller's stack.
2. **Attachments — deferred, contract reserved.** Raw payloads are preserved in `webhook_events.payload`, so no data is lost. When we implement ingestion: add `WebhookAttachmentFetcher` + `workflow_webhooks.attachments_mapping`. No v1 schema cost.
3. **API key only in v1. HMAC later.** `WebhookAuthService.verify` is designed with a single branch today and a second branch slot for HMAC.
4. **30-day hard-delete retention** on `webhook_events`. Single daily cron. Long-term provenance lives on the ticket itself via `tickets.metadata.original_payload`.

---

## 14. Out of scope (tracked, not done here)

- **Attachment ingestion.** Payloads are preserved; fetcher + `attachments_mapping` ship later.
- **HMAC auth.** Single-column additive migration + new branch in `WebhookAuthService.verify`.
- **Async / queued ingest.** If sync latency becomes a problem in practice (p99 > 5s), revisit with Vercel Queues or Upstash.
- Outbound webhooks (ticket state changes POST back to the source).
- Per-source adapter modules (`JiraAdapter`, `ServiceNowAdapter`) — only if the generic mapping model hits its limits.
- Bidirectional comment sync.
- Webhook signing certificates (mTLS) — enterprise-only, separate plan.
- Rate limiting beyond per-instance in-memory — push to edge layer (Vercel WAF) when it matters.
