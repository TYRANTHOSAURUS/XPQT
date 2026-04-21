# Competitive Gap Analysis: Prequest vs ServiceNow, TOPdesk, Zendesk, Jira Service Management, IBM Maximo, Axxerion, WISH, Ultimo, and Facilitor

Date: 2026-04-20

## Scope

This review compares the current repo state of Prequest against current public capabilities from:

- ServiceNow
- TOPdesk
- Zendesk
- Jira Service Management
- IBM Maximo Real Estate and Facilities
- Axxerion
- WISH by Facility Kwadraat
- IFS Ultimo
- Facilitor

The goal is not to ask whether Prequest already has every feature those products have. The goal is to identify where the current platform and configuration model mismatch the market baseline, and whether that mismatch is a strategic advantage or a gap that needs to be closed.

## Bottom Line

Prequest already has three real strengths:

- A cleaner operational model for FM plus IT work than Zendesk and, in some areas, TOPdesk: explainable routing, explicit case vs work order split, and vendor-aware dispatch.
- A pragmatic architecture for a small team: modular monolith, shared data model, tenant isolation with RLS, and clear separation between routing, ownership, execution, and visibility.
- A strong foundation in approvals, SLA timing, and routing traceability that is more coherent than many mid-market service desks.

Prequest is also clearly behind the market in several important areas:

- Configuration governance is inconsistent. The spec promises a unified draft/publish/version/rollback engine, but the implementation only applies that pattern to some config types.
- Workplace and FMIS breadth is not there yet. Reservations, visitors, preventive maintenance, knowledge, email channel, floor plans, offline mobile, and change management are still roadmap items.
- Desk workspace, reporting, integrations, and AI are materially behind ServiceNow, Jira Service Management, Zendesk, TOPdesk, and the mature Dutch FMIS suites.

If the target is "faster, more coherent than legacy enterprise suites for mid-market workplace operations," Prequest is directionally strong.

If the target is "replace ServiceNow, TOPdesk, Axxerion, WISH, Facilitor, or Ultimo across all feature areas today," the platform still needs major improvement.

## Cross-Platform Feature Matrix

Legend:

- `S` = Strong
- `P` = Partial
- `W` = Weak
- `M` = Missing

Scores are conservative. If a capability appears to rely on a marketplace add-on or is only lightly evidenced in public material, it is scored `P` rather than `S`.

Platform abbreviations:

- `PQT` = Prequest
- `SN` = ServiceNow
- `TOP` = TOPdesk
- `ZEN` = Zendesk
- `JIRA` = Jira Service Management
- `MX` = IBM Maximo
- `AX` = Axxerion
- `WS` = WISH by Facility Kwadraat
- `UL` = IFS Ultimo
- `FC` = Facilitor

### Self-Service and Intake

```text
+------+--------+---------+-------+--------+-------+
| Plat | Portal | Catalog | Forms | Knowl. | Email |
+------+--------+---------+-------+--------+-------+
| PQT  | P      | P       | P     | M      | M     |
| SN   | S      | S       | S     | S      | S     |
| TOP  | S      | S       | P     | S      | S     |
| ZEN  | P      | S       | S     | S      | S     |
| JIRA | S      | S       | S     | S      | S     |
| MX   | P      | P       | P     | P      | P     |
| AX   | S      | P       | P     | W      | W     |
| WS   | S      | P       | P     | P      | W     |
| UL   | P      | P       | P     | P      | W     |
| FC   | S      | P       | P     | S      | S     |
+------+--------+---------+-------+--------+-------+
```

### Desk, Routing, and Automation

```text
+------+-------+---------+--------+---------+----------+
| Plat | Desk  | Routing | WOrder | Approv. | Workflow |
+------+-------+---------+--------+---------+----------+
| PQT  | P     | S       | S      | S       | P        |
| SN   | S     | S       | S      | S       | S        |
| TOP  | S     | S       | P      | P       | P        |
| ZEN  | S     | P       | W      | W       | S        |
| JIRA | S     | S       | P      | S       | S        |
| MX   | P     | P       | S      | S       | P        |
| AX   | P     | S       | S      | P       | S        |
| WS   | P     | P       | P      | W       | P        |
| UL   | W     | W       | S      | W       | P        |
| FC   | S     | P       | P      | P       | P        |
+------+-------+---------+--------+---------+----------+
```

### FMIS and Operations

```text
+------+--------+------+---------+----------+---------+
| Plat | Assets | CMDB | Reserve | Visitors | PMaint. |
+------+--------+------+---------+----------+---------+
| PQT  | P      | M    | M       | M        | M       |
| SN   | S      | S    | S       | S        | P       |
| TOP  | S      | W    | S       | S        | P       |
| ZEN  | P      | W    | M       | M        | M       |
| JIRA | S      | P    | P       | W        | W       |
| MX   | S      | S    | P       | P        | S       |
| AX   | S      | P    | S       | S        | S       |
| WS   | S      | W    | S       | W        | S       |
| UL   | S      | W    | P       | P        | S       |
| FC   | S      | S    | S       | S        | S       |
+------+--------+------+---------+----------+---------+
```

### Platform, AI, and Reach

```text
+------+--------+----+--------+--------+--------+
| Plat | Config | AI | Integ. | Report | Mobile |
+------+--------+----+--------+--------+--------+
| PQT  | P      | M  | P      | P      | M      |
| SN   | S      | S  | S      | S      | S      |
| TOP  | P      | P  | P      | S      | P      |
| ZEN  | P      | S  | S      | S      | P      |
| JIRA | P      | S  | S      | S      | P      |
| MX   | P      | P  | S      | S      | S      |
| AX   | P      | M  | P      | S      | P      |
| WS   | P      | M  | P      | S      | P      |
| UL   | P      | S  | S      | S      | S      |
| FC   | P      | P  | S      | S      | S      |
+------+--------+----+--------+--------+--------+
```

## Other Important Differences

These are the differences that matter in platform selection even when raw feature counts look similar.

### Product Shape and Best Fit

```text
+-----+----------------------------------+--------------------------------------+
| Plat | Product shape                   | Best fit                             |
+-----+----------------------------------+--------------------------------------+
| PQT | Workplace ops platform in prog.  | Mid-market FM + IT fulfillment       |
| SN  | Enterprise workflow platform     | Large enterprise breadth + governance|
| TOP | Mid-market service mgmt suite    | Mature FM + IT service teams         |
| ZEN | Customer svc platform extended   | Ticket-heavy orgs, channels, AI      |
| JIRA| ITSM with Atlassian adjacency    | Atlassian-standardized service teams |
| MX  | EAM / FM / maintenance platform  | Asset-heavy maintenance environments |
| AX  | Dutch FMIS / IWMS suite          | Dutch FM + property + workplace ops  |
| WS  | Dutch FMIS for FM + real estate  | Property-heavy Dutch FM teams        |
| UL  | Best-of-breed EAM / CMMS         | Asset-heavy ops and maintenance orgs |
| FC  | Modular Dutch CAFM / FMIS        | FM + IT + reservations heavy orgs    |
+-----+----------------------------------+--------------------------------------+
```

### Prequest Advantage and Competitive Risk

```text
+-----+----------------------------------+--------------------------------------+
| Plat | Prequest advantage              | Main risk when competing             |
+-----+----------------------------------+--------------------------------------+
| PQT | N/A                              | Missing breadth and governance       |
| SN  | Simpler, lower overhead          | ServiceNow breadth is far ahead      |
| TOP | Cleaner routing + execution model| TOPdesk ahead on FM + portal breadth |
| ZEN | Better workplace ops model       | Zendesk ahead on UX, channels, AI    |
| JIRA| Better FM-native execution       | JSM ahead on forms, assets, portal   |
| MX  | Simpler desk-centric model       | Maximo ahead on maintenance depth    |
| AX  | Cleaner case/work split          | Axxerion ahead on FM breadth         |
| WS  | Better FM + IT unification       | WISH ahead on RE/FM process breadth  |
| UL  | Better requester-facing workflow | Ultimo ahead on maintenance depth    |
| FC  | Less module sprawl               | Facilitor ahead on breadth + reports |
+-----+----------------------------------+--------------------------------------+
```

### Delivery and Maturity

```text
+-----+--------------+---------------+------------+------------+--------------+
| Plat | Admin safety | Workflow mat. | FMIS depth | ITSM depth | Impl. cost   |
+-----+--------------+---------------+------------+------------+--------------+
| PQT | Med-low      | Med-low       | Low        | Medium     | Low-medium   |
| SN  | High         | High          | Med-high   | Very high  | Very high    |
| TOP | Medium       | Medium        | High       | High       | Medium       |
| ZEN | Medium       | Medium        | Low        | Med-high   | Medium       |
| JIRA| Medium       | High          | Low-medium | High       | Medium       |
| MX  | Medium       | Medium        | Very high  | Medium     | High         |
| AX  | Medium       | Medium        | High       | Medium     | Medium       |
| WS  | Medium       | Low-medium    | High       | Low-medium | Medium       |
| UL  | Medium       | Medium        | High       | Low-medium | Med-high     |
| FC  | Medium       | Medium        | High       | Medium     | Medium       |
+-----+--------------+---------------+------------+------------+--------------+
```

### Strategic Direction

```text
+-----+---------------------------------------------------------------+
| Plat | Main competitive reality for Prequest                        |
+-----+---------------------------------------------------------------+
| PQT | Double down on routing, execution model, and unified ops.     |
| SN  | Compete on simplicity and coherence, not total breadth.       |
| TOP | Catch up on workplace breadth and reporting before parity.    |
| ZEN | Compete where FM, vendors, and work orders matter more.       |
| JIRA| Compete where FM + IT convergence matters more than ecosystem.|
| MX  | Avoid parity claims until maintenance modules are shipped.    |
| AX  | Do not claim Dutch FMIS parity before FM baseline ships.      |
| WS  | Need stronger RE/FM dashboards before parity claims.          |
| UL  | Position only outside asset-heavy maintenance head-on deals.  |
| FC  | Need broader modular breadth and CMDB/reporting maturity.     |
+-----+---------------------------------------------------------------+
```

### Commercial Reality

These ratings are inference-based and meant for positioning, not procurement.

```text
+------+---------+---------------+------------------+---------------------------+
| Plat | TCO     | Time-to-value | Migration diff.  | Note                      |
+------+---------+---------------+------------------+---------------------------+
| PQT  | Low-med | Fast          | N/A              | Greenfield or wedge sale  |
| SN   | Very hi | Slow          | Very high        | Breadth at highest cost   |
| TOP  | Medium  | Medium        | High             | Balanced FM/IT baseline   |
| ZEN  | Medium  | Med-fast      | Medium           | Channel-led support focus |
| JIRA | Medium  | Medium        | Medium           | Ecosystem lowers friction |
| MX   | High    | Slow          | Very high        | Heavy asset/EAM programs  |
| AX   | Medium  | Medium        | High             | Dutch FMIS breadth        |
| WS   | Medium  | Medium        | High             | Real-estate-centric scope |
| UL   | Med-high| Medium        | High             | EAM / CMMS depth          |
| FC   | Medium  | Medium        | High             | Modular FMIS breadth      |
+------+---------+---------------+------------------+---------------------------+
```

## The Biggest Internal Mismatch

The largest mismatch is not a missing module. It is the gap between the spec and the shipped governance model.

The spec says configuration should be a shared platform capability with draft/publish, validation, version history, rollback, and consistent admin UX.

The repo currently does this only partially:

- `config_entities` and `config_versions` implement a real versioned config engine in `apps/api/src/modules/config-engine/config-engine.service.ts`.
- Form schemas use that engine in `apps/web/src/pages/admin/form-schemas.tsx`.
- Request types still use direct CRUD on `request_types` in `apps/api/src/modules/config-engine/request-type.service.ts`.
- SLA policies still use direct CRUD on `sla_policies` in `apps/api/src/modules/sla/sla-policy.controller.ts`.
- Routing rules still use direct CRUD on `routing_rules`, and the admin UI only exposes one simple condition plus team assignment in `apps/web/src/pages/admin/routing-rules.tsx`.
- Workflows use a separate `workflow_definitions` table and a shallow draft/publish flow in `apps/api/src/modules/workflow/workflow.service.ts`, but publish updates the same row instead of creating a versioned snapshot.

This is the first thing to fix. Competitors are not necessarily better because their models are cleaner. They are better because admins can safely change production behavior without guessing what will happen.

## Category-by-Category Assessment

The comparison below uses stacked entries instead of a wide table so it stays readable in raw markdown and narrow editors.

### Platform Core

**Architecture and tenancy**  
Current Prequest state: Strong core design. Modular monolith, shared objects, tenant resolution middleware, and RLS-based isolation are coherent and pragmatic.  
Competitor baseline: ServiceNow has domain separation and deep platform tooling. Enterprise suites also have mature release, sandbox, and deployment controls.  
Assessment: **Mixed.** Better on simplicity and team-fit. Worse on enterprise delivery controls.

**Configuration governance**  
Current Prequest state: The versioned config engine exists, but only some config types use it. Request types, SLAs, routing, and notifications are not governed through one lifecycle.  
Competitor baseline: ServiceNow, Jira, Zendesk, and TOPdesk all give admins more consistent production configuration surfaces.  
Assessment: **Improve urgently.** This is the biggest maturity gap.

**Release management and environments**  
Current Prequest state: Phase docs still list CI/CD, containerization, and environment separation as not done. Dedicated database tier and release rings are still roadmap items.  
Competitor baseline: Mature enterprise platforms already assume sandboxes, staged rollout, and safer admin promotion models.  
Assessment: **Improve.** This matters if enterprise buyers are in scope.

### Intake and Workspace

**Portal and self-service front door**  
Current Prequest state: Portal supports catalog browsing, request submission, and my requests. `/portal/book`, `/portal/visitors`, and `/portal/order` currently redirect back to `/portal` in `apps/web/src/App.tsx`.  
Competitor baseline: ServiceNow Employee Center, TOPdesk SSP, Zendesk Help Center, and JSM portals all expose more complete self-service flows now.  
Assessment: **Improve.** Vision is good; shipped scope is still narrow.

**Branding and multi-brand**  
Current Prequest state: Tenant records store `branding`, but the public tenant API only returns `id`, `slug`, and `tier` in `apps/api/src/modules/tenant/tenant.controller.ts`. There is no live branding admin UI in the current app routes.  
Competitor baseline: Zendesk supports multiple branded help centers and brand identities. TOPdesk and ServiceNow expose portal branding and portal composition.  
Assessment: **Improve.** This is table-ready data without a finished product surface.

**Forms and request intake**  
Current Prequest state: Form builder supports field types and preview, but not conditional logic. Runtime file upload is still placeholder-only in `apps/web/src/components/form-renderer/dynamic-form-fields.tsx`.  
Competitor baseline: JSM forms support conditional logic and rich formatting. Zendesk supports ticket forms and conditional required fields. ServiceNow catalog intake is richer.  
Assessment: **Improve.** Current builder is useful, but below market baseline.

**Agent workspace**  
Current Prequest state: Desk has a basic queue, side-panel detail, inline editing, tags, watchers, and attachments. It still lacks mature saved views, advanced filters, keyboard-heavy workflow, real-time updates, and deeper bulk actions.  
Competitor baseline: Zendesk, ServiceNow, and JSM are materially stronger here. TOPdesk is also more mature for operators.  
Assessment: **Improve.** This is still one of the highest-value parity areas.

### Routing, Workflow, and Execution

**Routing and fulfillment**  
Current Prequest state: This is one of Prequest's strongest areas. The resolver chain is explicit and traceable. The case vs work order split is strong for FM plus IT execution. Vendor assignment exists at the dispatch and asset/location/default levels.  
Competitor baseline: ServiceNow can match or exceed this breadth, but with more complexity. Zendesk is weaker here. TOPdesk is solid, but Prequest's routing trace is unusually clean.  
Assessment: **Better conceptually, improve operationally.** Keep this as a differentiator.

**Routing rule admin surface**  
Current Prequest state: Backend supports ordered rules and several operators, but the admin UI only captures one condition and only assigns teams. Routing rules cannot assign vendors today.  
Competitor baseline: ServiceNow and JSM expose richer decision logic; Zendesk triggers and TOPdesk automation surfaces are also broader than the current Prequest UI.  
Assessment: **Improve.** The engine is ahead of the UI.

**Workflow automation**  
Current Prequest state: Visual editor, validator, simulator, webhook entry, HTTP request node, approval node, and child task dispatch already exist.  
Competitor baseline: ServiceNow Flow Designer, JSM automation, and Zendesk triggers are more production-mature, with better versioning and scheduling behavior.  
Assessment: **Mixed.** Good direction, but not enterprise-safe yet.

**Workflow versioning and runtime durability**  
Current Prequest state: `workflow_instances` store `workflow_version`, but `workflow_definitions.version` never increments on publish in `apps/api/src/modules/workflow/workflow.service.ts`. Publish updates the same record in place. Timer nodes write `timer_resume_at` into context, but I did not find an automatic scheduler that resumes waiting instances; only manual `POST /workflows/instances/:instanceId/resume` exists.  
Competitor baseline: Competitors with mature automation engines handle published versions and time-based resume more reliably.  
Assessment: **Improve urgently.** This is a real runtime correctness gap, not just admin polish.

**Approvals and delegation**  
Current Prequest state: Strong backend foundation: single-step, sequential, parallel, and delegation are implemented.  
Competitor baseline: ServiceNow and JSM offer richer channel reach and end-user approval UX. Zendesk is weaker here as a native platform concept.  
Assessment: **Mixed leaning strong.** Better than Zendesk, credible against JSM, behind ServiceNow polish.

**SLA and business hours**  
Current Prequest state: Strong core foundation: response and resolution timers, pause/resume, business-hours math, breach cron, at-risk flags, and per-ticket timer state.  
Competitor baseline: ServiceNow SLM, Zendesk SLAs, and TOPdesk reporting expose stronger dashboards, analytics, and policy administration.  
Assessment: **Strong foundation, improve analytics and policy flexibility.**

### FMIS and Data Model

**Asset and CMDB model**  
Current Prequest state: Asset registry is present, but there is no discovery, reconciliation, CI graph, service map, or import framework.  
Competitor baseline: ServiceNow CMDB and Service Mapping, Jira Assets, and Maximo are far ahead. Zendesk only reaches this via custom objects, where Prequest is actually cleaner.  
Assessment: **Better than Zendesk, behind ServiceNow/JSM/Maximo.**

**Workplace reservations**  
Current Prequest state: Not shipped in the current product surface. Phase docs still list booking, recurring reservations, and linked order flows as future UI.  
Competitor baseline: TOPdesk has live reservation management for rooms, assets, services, and approvals. FMIS tools treat this as a baseline module.  
Assessment: **Improve materially.** This is a hard mismatch with FMIS positioning.

**Visitor management**  
Current Prequest state: Not shipped in the current product surface. Phase docs still list preregistration, reception, check-in, host notification, and checkout as future work.  
Competitor baseline: TOPdesk already supports visitor registration in the self-service portal. FM suites often include this or integrate tightly with it.  
Assessment: **Improve materially.**

**Preventive maintenance and FM execution**  
Current Prequest state: Not shipped in the current product surface. IBM Maximo treats preventive maintenance and recurring work order generation as a core application area.  
Competitor baseline: Maximo and other FM/EAM systems are far ahead here.  
Assessment: **Improve materially.** Without this, FMIS parity claims are weak.

### Knowledge, AI, and Analytics

**Knowledge base and search**  
Current Prequest state: No knowledge base module and no unified search service are shipped yet.  
Competitor baseline: ServiceNow, TOPdesk, Zendesk, and JSM all have mature knowledge-base-backed self-service today.  
Assessment: **Improve.** This is now baseline, not a premium add-on.

**AI**  
Current Prequest state: The product spec is thoughtful, but I did not find shipped AI endpoints or portal/desk AI flows in the current app code.  
Competitor baseline: ServiceNow Virtual Agent, Jira virtual service agent, Zendesk Agent Copilot, and TOPdesk AI features are all live now.  
Assessment: **Improve.** Governance posture is good; execution is behind.

**Reporting and analytics**  
Current Prequest state: Reporting is basic counts and simple SLA aggregates in `apps/api/src/modules/reporting/reporting.service.ts`. The visibility reference explicitly notes reporting is tenant-wide and not yet filtered.  
Competitor baseline: ServiceNow, TOPdesk, Zendesk Explore, and JSM reporting are much more mature.  
Assessment: **Improve urgently.** Reporting is below market expectation.

**Security, visibility, and auditability**  
Current Prequest state: The visibility model is well thought through: participant, operator, override, plus explainable traces. Routing decisions are explicitly audited.  
Competitor baseline: ServiceNow has deeper enterprise controls, but many mid-market tools are less explicit than this.  
Assessment: **Better than average.** This is another differentiator worth keeping.

**Integrations and channels**  
Current Prequest state: Workflow webhooks and HTTP request nodes exist, but there is no general email-to-ticket, calendar sync, HR sync, CMDB import, Slack/Teams integration, or domain event connector layer yet.  
Competitor baseline: ServiceNow IntegrationHub, JSM integrations, Zendesk channels, and TOPdesk OData/reporting exports are ahead.  
Assessment: **Improve.**

## Where Prequest Is Already Better

### 1. Routing is clearer than most mid-market systems

The separation between routing, ownership, execution, and visibility is unusually clean. The resolver trace in `routing_decisions` and the documented rule chain in `docs/assignments-routing-fulfillment.md` make the system easier to debug than most ticket platforms.

This is a real product advantage.

### 2. The case vs work order split is excellent for workplace operations

Most service desk tools flatten work into one requester-facing record or force awkward subtask semantics. Prequest's explicit split between requester-facing case and executor-facing work order is very strong for FM, vendor work, and cross-team dispatch.

This is better than Zendesk's native model and cleaner than many improvised JSM setups.

### 3. The visibility model is more explicit than many competitors

`docs/visibility.md` makes the access model intelligible. The debug trace endpoint is good. The architecture separates visibility from routing and ownership instead of letting those concerns leak into one another.

This is product-quality thinking, not just implementation detail.

### 4. The architecture fits the team reality

For a two-person team, the shared codebase plus shared DB plus RLS approach is a better operating model than prematurely chasing ServiceNow-style platform complexity.

The weakness is not the architecture. The weakness is the missing product layers on top of it.

## Where Prequest Needs Improvement Most

### Tier 1: fix now

1. Make the config engine canonical for every configurable type.
2. Add real workflow versioning, publish snapshots, impact preview, and scheduled timer resume.
3. Ship dynamic form logic, required rules, and working file uploads.
4. Upgrade the desk workspace with saved views, filters, sorting, keyboard flow, and audited bulk reassignment.
5. Fix reporting scope, add exports, and build meaningful operational dashboards.

### Tier 2: required for credible FMIS or enterprise positioning

1. Ship reservations, visitors, and preventive maintenance.
2. Ship knowledge base, unified search, and email-to-ticket.
3. Add integration framework basics: calendar, HR/person sync, inbound and outbound event connectors.
4. Add tenant branding, config diff/rollback UI, import/export, and safer release promotion.
5. Add vendor identity formalization and vendor portal groundwork.

### Tier 3: strategic expansion

1. CI and asset graph modeling beyond flat asset registry.
2. Floor plans and workplace visualization.
3. AI assistant and copilot surfaces once knowledge and search exist.
4. Change management if ServiceNow-class ITSM is a real target.

## Strategic Recommendation

Prequest should not try to beat every competitor everywhere at once.

The strongest route is:

- Keep routing, visibility, case/work-order execution, and FM plus IT unification as the core differentiators.
- Raise configuration governance and workflow runtime correctness to enterprise-safe quality.
- Ship the missing FM/workplace baseline modules before claiming broad FMIS parity.
- Treat knowledge, email channel, reporting, and integrations as baseline table stakes, not later nice-to-haves.

In plain terms:

- Against Zendesk, Prequest can be better if the target is workplace operations and multi-team fulfillment.
- Against TOPdesk, Prequest can be better on model clarity and explainable routing, but it is still behind on shipped FM and self-service breadth.
- Against Jira Service Management, Prequest can be better on FM-native execution modeling, but it is behind on forms, assets, portal maturity, and AI support workflows.
- Against Axxerion, WISH, and Facilitor, Prequest can compete on execution clarity and simplicity, but not yet on full FMIS breadth.
- Against Ultimo, Prequest is not a realistic replacement for asset-heavy maintenance programs today.
- Against ServiceNow and Maximo, Prequest is not close on breadth or enterprise maturity yet, but it can still win on simplicity, speed, and coherence for a narrower mid-market segment.

## Prequest Capability Status

### Live today

- Service catalog browsing and request submission are live in `apps/web/src/pages/portal/home.tsx` and `apps/web/src/pages/portal/submit-request.tsx`.
- Basic desk queueing, ticket detail, inline editing, and search are live in `apps/web/src/pages/desk/tickets.tsx`.
- Routing, ownership, work order modeling, approvals, and SLA timing are live in the current backend modules and documented in `docs/assignments-routing-fulfillment.md`.
- The config engine exists and is live for form schemas in `apps/api/src/modules/config-engine/config-engine.service.ts` and `apps/web/src/pages/admin/form-schemas.tsx`.
- Workflow editing, simulation, webhook entry, HTTP calls, approval nodes, and child task dispatch are shipped in the workflow modules.

### Partial or thin today

- Configuration governance is only partial because request types, SLAs, routing, and notifications are not all on the shared versioned config lifecycle.
- Workflow publishing is partial because publish mutates the same workflow record rather than producing an immutable production snapshot.
- Reporting is partial because the service exists, but scope and depth are below market baseline and `docs/visibility.md` explicitly notes reporting is not yet fully filtered.
- Search is partial because service catalog search exists in `apps/api/src/modules/config-engine/service-catalog.service.ts`, but there is no shipped unified global search across entities.
- Branding is partial because tenant branding data exists, but there is no complete public/admin product surface around it yet.

### Roadmap only or not shipped

- Reservations, visitor management, linked booking flows, and reception flows remain roadmap work in `docs/phase-2.md`; `/portal/book`, `/portal/visitors`, and `/portal/order` still route back to `/portal` in `apps/web/src/App.tsx`.
- Preventive maintenance and deeper field/mobile FM execution remain roadmap work in `docs/phase-3.md`.
- Knowledge base, email-to-ticket, vendor portal, broader integrations, and more advanced reporting remain roadmap work in `docs/phase-4.md`.
- Offline mobile and floor-plan-heavy workplace visualization remain future scope in `docs/spec.md` and `docs/phase-4.md`.

## Buyer Rejection Triggers

```text
+-------------------------+-----------------------------+----------+---------------------------+
| Trigger                 | Affected buyers             | Severity | Why it blocks deals       |
+-------------------------+-----------------------------+----------+---------------------------+
| Unsafe config lifecycle | Enterprise / regulated ops  | Fatal    | No safe prod change model |
| Missing FM baseline     | FMIS buyers                 | Fatal    | Reservation/visitor/PM gap|
| Weak reporting          | Multi-team ops buyers       | Fatal    | Can't prove performance   |
| Thin channels/integs    | ITSM / shared services      | High     | Email/HR/calendar missing |
| Basic desk workspace    | High-volume service desks   | High     | Agent productivity gap    |
| Workflow runtime risk   | Automation-heavy buyers     | High     | Publish/timer correctness |
+-------------------------+-----------------------------+----------+---------------------------+
```

## Priority Gap Matrix

```text
+-------------------------+-------+----------+----------+-------------------------+
| Gap                     | State | Impact   | Priority | Buyer risk              |
+-------------------------+-------+----------+----------+-------------------------+
| Unified config engine   | Part  | Very hi  | Now      | Admin trust / change mg |
| Workflow durability     | Weak  | Very hi  | Now      | Runtime correctness     |
| Reporting + exports     | Weak  | Very hi  | Now      | Operational proof       |
| Desk workspace          | Part  | High     | Now      | Agent efficiency        |
| Forms + uploads         | Part  | High     | Now      | Intake quality          |
| Reservations + visitors | Miss  | Very hi  | 180d     | FMIS credibility        |
| Knowledge + email       | Miss  | High     | 180d     | Self-service baseline   |
| Integrations layer      | Weak  | High     | 180d     | Adoption friction       |
| Preventive maintenance  | Miss  | Very hi  | 365d     | FM / EAM expansion      |
| Floorplans + mobile     | Miss  | Medium   | 365d     | Workplace usability     |
+-------------------------+-------+----------+----------+-------------------------+
```

## Competitive Positioning by Segment

`RE` = real estate.

```text
+-----------------------------+------------------+--------------------------------+------------------------------+
| Segment                     | Strongest alt    | Prequest win condition         | Main blocker today           |
+-----------------------------+------------------+--------------------------------+------------------------------+
| Mid-market FM + IT ops      | TOP / AX / FC    | Clear routing + faster setup   | Missing FM baseline breadth  |
| Dutch public / edu / RE FM  | AX / WS / FC     | Simpler cross-domain workflow  | Local FM/reporting depth     |
| Ticket-heavy helpdesk orgs  | ZEN / JIRA       | Physical-work execution model  | Channels, AI, desk UX        |
| Asset-heavy maintenance     | UL / MX          | Narrow adjunct use only        | PM depth, mobile, EAM depth  |
| Enterprise workflow buyers  | SN               | Department-level wedge only    | Governance + maturity        |
+-----------------------------+------------------+--------------------------------+------------------------------+
```

## Segment-Weighted Scorecards

These are directional current-state scores out of 100. They are not procurement-grade benchmarks. They weight what matters most for each segment, not total platform breadth.

### Mid-market FM + IT operations

Weights: `routing/execution 30`, `portal + desk 25`, `FM/workplace breadth 20`, `governance + reporting 15`, `cost + time-to-value 10`.

Ranking: `1. TOPdesk (85)`, `2. ServiceNow (83)`, `3. Facilitor (78)`, `4. Prequest (76)`, `5. Axxerion (75)`, `6. Jira Service Management (72)`, `7. WISH (68)`, `8. Zendesk (64)`, `9. Maximo (57)`, `10. Ultimo (49)`.

Why Prequest lands here: the execution model is unusually strong for FM + IT work, but the missing FM baseline and thinner desk/reporting surface still keep it below the top shipped suites.

### Dutch public / education / real-estate FM

Weights: `FM breadth 30`, `reservations + visitors 20`, `reporting + dashboards 15`, `service desk 15`, `implementation effort 10`, `governance 10`.

Ranking: `1. TOPdesk (86)`, `2. Axxerion (84)`, `3. Facilitor (83)`, `4. WISH (80)`, `5. ServiceNow (77)`, `6. Prequest (63)`, `7. Jira Service Management (61)`, `8. Maximo (58)`, `9. Zendesk (46)`, `10. Ultimo (44)`.

Why Prequest lands here: it could become attractive as a simpler cross-domain ops platform, but it is not yet a credible Dutch FMIS replacement where reservations, visitors, dashboards, and local FM breadth are required at go-live.

### Ticket-heavy internal helpdesk

Weights: `desk workspace 30`, `channels + self-service 20`, `automation + AI 15`, `portal + forms 15`, `vendor / physical-work execution 10`, `cost + time-to-value 10`.

Ranking: `1. ServiceNow (90)`, `2. Jira Service Management (84)`, `3. Zendesk (82)`, `4. TOPdesk (80)`, `5. Prequest (69)`, `6. Facilitor (64)`, `7. Axxerion (57)`, `8. WISH (50)`, `9. Maximo (43)`, `10. Ultimo (36)`.

Why Prequest lands here: it beats many tools on physical-work execution logic, but current channel depth, knowledge, AI, and desk UX keep it below the leaders for classic service-desk-heavy environments.

### Asset-heavy maintenance operations

Weights: `preventive maintenance 35`, `asset depth 20`, `mobile field execution 15`, `integrations 10`, `service desk 10`, `portal 10`.

Ranking: `1. Maximo (90)`, `2. Ultimo (88)`, `3. Axxerion (76)`, `4. Facilitor (74)`, `5. WISH (72)`, `6. ServiceNow (70)`, `7. TOPdesk (63)`, `8. Prequest (40)`, `9. Jira Service Management (38)`, `10. Zendesk (25)`.

Why Prequest lands here: it is not yet a realistic primary platform for maintenance-led organizations.

## Head-to-Head Rankings by Use Case

Current-state ranking only. `>` means stronger current fit for the named use case.

```text
+-------------------------------------------+--------------------------------------------------------+-----------+
| Use case                                  | Ranking                                                | PQT place |
+-------------------------------------------+--------------------------------------------------------+-----------+
| Employee portal + desk + vendors          | SN > TOP > JIRA > PQT > FC > ZEN > AX > WS > UL > MX  | 4         |
| Mid-market FM + IT convergence            | TOP > FC > PQT > SN > AX > JIRA > WS > ZEN > MX > UL  | 3         |
| Dutch FMIS baseline                       | TOP > AX > FC > WS > SN > PQT > MX > JIRA > UL > ZEN  | 6         |
| High-volume internal support desk         | SN > JIRA > ZEN > TOP > PQT > FC > AX > WS > MX > UL  | 5         |
| Asset-heavy maintenance                   | MX > UL > AX > FC > WS > SN > TOP > PQT > JIRA > ZEN  | 8         |
+-------------------------------------------+--------------------------------------------------------+-----------+
```

## Where Prequest Can Win Now

- Mid-market organizations that need FM + IT fulfillment in one operating model and do not want ServiceNow complexity.
- Teams with vendor-heavy or multi-team execution where the case/work-order split and routing trace are genuinely useful.
- Organizations frustrated with ticket-centric tools like Zendesk or improvised JSM setups for physical work.
- Greenfield workplace ops deployments where speed, clarity, and coherence matter more than a giant module catalog.

## Where Prequest Should Not Position Yet

- As a full Dutch FMIS replacement for Axxerion, WISH, or Facilitor when reservations, visitors, preventive maintenance, dashboards, and integration depth are required on day one.
- As an EAM / CMMS replacement for Ultimo or Maximo in asset-heavy maintenance environments.
- As a broad enterprise workflow platform replacement for ServiceNow.
- As a high-volume support desk replacement for Zendesk or JSM when channels, AI assist, and mature workspace UX are the main buying criteria.

## Deal Disqualifiers and Claim Boundaries

### Practical disqualifiers

```text
+------------------------------------------+----------------------+-------------------------------+
| Situation                                | Disqualify today?    | Reason                        |
+------------------------------------------+----------------------+-------------------------------+
| Reservations + visitors needed at go-live| Yes                  | Not shipped                   |
| PM / maintenance-led deployment          | Yes                  | PM module not shipped         |
| Enterprise-safe config promotion needed  | Yes                  | Governance model incomplete   |
| Email-first support channel required     | Usually yes          | Email-to-ticket missing       |
| Deep KB deflection required              | Usually yes          | KB not shipped                |
| Local Dutch FM dashboards required       | Usually yes          | Reporting still too thin      |
| Vendor-heavy FM + IT execution needed    | No                   | Relative strength             |
| Simple wedge vs larger suite acceptable  | Maybe                | Good wedge, not full replace  |
+------------------------------------------+----------------------+-------------------------------+
```

### Claim-safe positioning boundaries

Use this as a guardrail for marketing, demos, and sales qualification.

```text
+---------------------------------------------+--------------------------------+-------------------------------+
| Safe to claim now                           | Claim with caution             | Do not claim yet              |
+---------------------------------------------+--------------------------------+-------------------------------+
| Strong routing transparency                 | Better than JSM for FM flows   | Full FMIS replacement         |
| Strong case/work-order execution model      | Dutch FMIS alternative         | ServiceNow-class governance   |
| Good fit for FM + IT fulfillment            | Enterprise-ready workflow      | Complete reservations suite   |
| Better than ticket-first tools for vendors  | Replace TOPdesk broadly        | Preventive maintenance suite  |
| Faster, simpler ops model for mid-market    | AI-assisted service platform   | High-volume omnichannel desk  |
+---------------------------------------------+--------------------------------+-------------------------------+
```

## 90 / 180 / 365 Day Roadmap

### Next 90 days

1. Make the config engine canonical for request types, SLAs, routing, notifications, and workflow definitions.
2. Add immutable workflow version snapshots, publish impact preview, and automatic timer resume.
3. Raise the desk workspace to baseline with saved views, better filters, bulk actions, and faster operator flow.
4. Fix reporting scope, add exports, and ship meaningful ops dashboards.
5. Finish dynamic forms with conditional logic, required rules, and working file uploads.

### Next 180 days

1. Ship reservations and visitors so the workplace / FMIS story becomes credible.
2. Ship knowledge base, unified search, and email-to-ticket so self-service reaches baseline.
3. Add calendar sync, HR/person sync, and a simple integration/event layer.
4. Add tenant branding, config diff/rollback UI, and safer promotion between environments.
5. Formalize vendor identity and external assignment flows so vendor execution becomes product-grade.

### Next 365 days

1. Ship preventive maintenance and recurring task generation.
2. Add floor plans, occupancy visualization, and stronger workplace visualization.
3. Add vendor portal, deeper mobile capability, and offline field flows if usage proves it necessary.
4. Add AI assistant and copilot surfaces once knowledge, search, and safe configuration exist.
5. Add change management only if broader enterprise ITSM is still a strategic target.

## Proof Strength and Research Notes

- `Repo-evidenced:` Prequest config-governance mismatch, portal redirects, workflow versioning/timer gaps, reporting limitations, and current shipped UX are based on local repo inspection.
- `Official-doc-evidenced:` competitor capability claims are based on official product pages or official documentation linked in the Sources section below.
- `Inference:` TCO, time-to-value, migration difficulty, some best-fit positioning, and some conservative `P/W/M` scores are judgment calls derived from the official materials rather than vendor-confirmed procurement data.
- `Conservative scoring rule:` if a capability appeared to be partner-led, marketplace-led, or not clearly described as a core shipped workflow, it was not scored as `S`.

## Sources

### Internal repo

- `apps/api/src/modules/config-engine/config-engine.service.ts`
- `apps/api/src/modules/config-engine/request-type.service.ts`
- `apps/api/src/modules/config-engine/service-catalog.service.ts`
- `apps/api/src/modules/sla/sla-policy.controller.ts`
- `apps/api/src/modules/workflow/workflow.service.ts`
- `apps/api/src/modules/workflow/workflow-engine.service.ts`
- `apps/api/src/modules/reporting/reporting.service.ts`
- `apps/api/src/modules/tenant/tenant.controller.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/pages/portal/home.tsx`
- `apps/web/src/pages/portal/submit-request.tsx`
- `apps/web/src/pages/desk/tickets.tsx`
- `apps/web/src/pages/admin/form-schemas.tsx`
- `apps/web/src/pages/admin/routing-rules.tsx`
- `apps/web/src/components/form-renderer/dynamic-form-fields.tsx`
- `docs/assignments-routing-fulfillment.md`
- `docs/visibility.md`
- `docs/spec.md`
- `docs/phase-1.md`
- `docs/phase-2.md`
- `docs/phase-3.md`
- `docs/phase-4.md`

### ServiceNow

- Flow Designer: https://www.servicenow.com/docs/r/application-development/flow-designer.html
- Employee Center overview: https://www.servicenow.com/docs/r/employee-service-management/employee-experience-foundation/explore-emp-center.html
- Service Catalog in Employee Center: https://www.servicenow.com/docs/r/zurich/servicenow-platform/service-catalog/service-catalog-in-ec.html
- Service Level Management: https://www.servicenow.com/docs/r/it-service-management/service-level-management/service-level-mgmt-landing-page.html
- CMDB domain separation: https://www.servicenow.com/docs/r/zurich/servicenow-platform/configuration-management-database-cmdb/domain-separation-cmdb.html
- Service Mapping: https://www.servicenow.com/docs/r/it-operations-management/service-mapping/c_ServiceMappingOverview.html
- Virtual Agent: https://www.servicenow.com/docs/r/conversational-interfaces/virtual-agent/virtual-agent-landing-page.html

### TOPdesk

- Self-Service Portal: https://www.topdesk.com/en/features/self-service-portal/
- Reservations management: https://www.topdesk.com/en/features/reservations-management/
- Assets and reservations management: https://docs.topdesk.com/en/assets-and-reservations-management.html
- Visitor management in SSP: https://docs.topdesk.com/en/managing-your-visitors-via-the-self-service-portal.html
- Change Management: https://docs.topdesk.com/VA2023R2/en/change-management.html
- Reporting: https://www.docs.topdesk.com/en/reporting.html
- AI features: https://www.docs.topdesk.com/en/ai-features.html

### Zendesk

- Ticket forms: https://support.zendesk.com/hc/en-us/articles/4408836460698-Managing-your-ticket-forms
- Conditional field requirements: https://support.zendesk.com/hc/en-us/articles/4408846008218-Making-conditional-ticket-fields-required
- Business hours and holidays: https://support.zendesk.com/hc/en-us/articles/4408842938522-Setting-your-schedule-with-business-hours-and-holidays
- Agent Copilot: https://support.zendesk.com/hc/en-us/articles/7908817636378-About-agent-copilot
- Custom objects overview: https://support.zendesk.com/hc/en-us/articles/5914453843994-Understanding-custom-objects
- Activate custom objects: https://support.zendesk.com/hc/en-us/articles/6073693948058-Activating-custom-objects
- Multiple branded help centers: https://support.zendesk.com/hc/en-us/articles/4408882448922-Using-Zendesk-Support-and-Zendesk-Knowledge-together

### Jira Service Management

- Forms: https://support.atlassian.com/jira-service-management-cloud/docs/what-are-forms/
- Approvals: https://support.atlassian.com/jira-service-management-cloud/docs/what-are-approvals/
- Virtual service agent: https://support.atlassian.com/jira-service-management-cloud/docs/about-the-virtual-agent/
- Assets: https://support.atlassian.com/assets/docs/what-is-assets-in-jira-service-management-cloud/
- Knowledge base: https://support.atlassian.com/jira-service-management-cloud/docs/what-is-a-knowledge-base/
- Automation guide: https://www.atlassian.com/software/jira/service-management/product-guide/tips-and-tricks/automation

### IBM Maximo

- Preventive Maintenance: https://www.ibm.com/docs/en/masv-and-l/maximo-manage/cd?topic=module-preventive-maintenance
- Work orders: https://www.ibm.com/docs/en/masv-and-l/maximo-manage/continuous-delivery?topic=overview-work-orders
- Real Estate and Facilities Management: https://www.ibm.com/products/maximo/real-estate-facility-management

### Axxerion

- Overview: https://www.xxelerate.net/
- Facility management software: https://www.xxelerate.net/facility-management-software/
- English FM overview: https://www.xxelerate.net/en/facility-management-en/
- Axxerion Go: https://www.xxelerate.net/en/axxerion-go-2/
- English workplace / meetings and visitors page: https://www.xxelerate.net/en/axxerion-facility-management-en/

### WISH by Facility Kwadraat

- FMIS WISH overview: https://www.facility2.nl/en/fmis-wish-facility-and-real-estate-management-software/
- Modules overview: https://www.facility2.nl/en/fmis-wish-facility-and-real-estate-management-software/modules/
- Facility management and Product Service Catalogue: https://www.facility2.nl/en/facility-management/
- Space management: https://www.facility2.nl/en/fmis/modules/space-management-software/
- Long-term maintenance plan: https://www.facility2.nl/en/fmis/modules/long-term-maintenance-plan-software/

### IFS Ultimo

- EAM software overview: https://www.ultimo.com/eam-software
- Capabilities overview: https://www.ultimo.com/capabilities
- Self-Service: https://www.ultimo.com/editions/features/self-service
- About Ultimo: https://www.ultimo.com/about-us
- AI: https://www.ultimo.com/ai
- CMMS software: https://www.ultimo.com/capabilities/cmms-software
- Officebooking marketplace solution: https://marketplace.ultimo.com/solution/officebooking/

### Facilitor

- Overview: https://facilitor.nl/
- Modules overview: https://facilitor.nl/en/modular-system/
- Service Management: https://facilitor.nl/en/modular-system/service-management/
- Reservations: https://facilitor.nl/en/modular-system/reservations/
- Knowledgebase: https://facilitor.nl/en/modular-system/knowledgebase/
- Mobile: https://facilitor.nl/en/modular-system/mobile/
- CMDB: https://facilitor.nl/en/modular-system/cmdb/
- REST API: https://facilitor.nl/en/modular-system/rest-api/
- Recurring tasks: https://facilitor.nl/en/modular-system/recurring-tasks/
- Graphics / floor plans: https://facilitor.nl/en/modular-system/graphics/
- Mail2Melding: https://facilitor.nl/modulair-fmis-systeem/mail2melding/
