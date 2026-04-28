# Visual Rule Builder — Design Spec

**Date:** 2026-04-27
**Status:** Design — pending implementation
**Owner:** TBD
**Estimated effort:** 6-8 weeks (3 sprints; can run partially parallel with MS Graph + daglijst work)
**Roadmap location:** `docs/booking-services-roadmap.md` §9.1.2; `docs/booking-platform-roadmap.md` §F4 + §G1.

**Why this spec exists:** the current admin UX for authoring service rules is a free-form JSON editor with raw UUID inputs. This is unusable by non-technical FM admins and is the largest projected support-ticket source in the platform. The `applies_when` predicate AST + template system is solid; the editor on top is not. Beyond service rules, the same rule engine governs room booking rules (and will govern visitor + parking + asset rules in the future). One unified visual rule builder is both a competitive parity gate (matching ServiceNow's Flow Designer) and the visible expression of our biggest architectural wedge — one predicate engine across the entire workplace platform.

**Context:**
- [`docs/booking-services-roadmap.md`](../../booking-services-roadmap.md) §9.1.2 — Tier 1 critical (current admin UX is the largest support-load risk).
- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §F4 (visual builder) + §G1 (one predicate engine wedge).
- [`docs/competitive-benchmark.md`](../../competitive-benchmark.md) — ServiceNow Flow Designer is the bar; Eptura/Planon/Robin all worse.
- Existing schema: `service_rules`, `service_rule_versions`, `service_rule_templates`, `service_rule_simulation_scenarios`, parallel structure for `room_booking_rules`.
- Memory: `feedback_quality_bar_comprehensive.md` — comprehensive, not lean. This spec covers the full visual builder, not an MVP.

---

## 1. Goals + non-goals

### Goals

1. **A non-technical FM admin can author a complete rule** ("catering over €500 needs VP approval", "no AV requests within 2 hours of meeting start", "lunch in conference rooms requires desk approval", etc.) **without ever seeing JSON or UUIDs.**
2. **Single visual builder works across every rule domain** — service rules, room booking rules, visitor rules (future), parking rules (future), asset rules (future). One UI, one mental model, one component library.
3. **Template-first authoring path** for the common cases (~80% of rules). Pick template → fill named params → preview → activate.
4. **Advanced authoring path** for the long tail. Visual condition builder with AND/OR groups, drag-drop, field/operator/value pickers. No JSON unless user explicitly toggles "Edit raw" for the very edge cases.
5. **Live preview at every step.** As the admin edits a rule, "this would match X events from your last 30 days" updates inline.
6. **Rule simulator** with real-form scenario authoring (replace today's JSON simulator).
7. **Rule debugger** — given any specific event/booking/order, show "which rules matched and why" with per-condition evaluation trace.
8. **Coverage matrix view** — for any target (catalog item, room, etc.), see which rules apply, in what order, with what effect.
9. **Conflict detection** — flag rules that contradict (one denies, another allows the same predicate).
10. **Rule impact preview before publish** — dry-run new/edited rule against last 30 days; show "this would have affected N events."
11. **Combobox primitive library** — one canonical `EntityPicker<T>` component used across rule builder, admin forms, approval routing, etc.
12. **Versioning + revert** — already in schema; visible in UI as a clear changelog with diff and one-click revert.

### Non-goals

- **Building a Zapier-style cross-system automation engine.** Rules govern decisions within Prequest, not external integrations.
- **Visual workflow editor.** Already separate (workflow-editor / React Flow surface). Rule builder is for predicates + effects only.
- **End-user-facing rule visibility.** Rules are admin-only configuration. End users see effects (denials, approvals); they don't see rules.
- **AI-generated rules.** Future enhancement (frontier territory). Not in scope here.
- **Per-tenant predicate language extensions.** The vocabulary is product-defined; tenants don't add custom field types.
- **Migration tooling for existing rules.** Existing rules have already been authored as JSON — they migrate forward as-is. No bulk re-authoring.

---

## 2. Background — current state

### What exists today

**Schema:**
- `service_rules` (target, applies_when jsonb, effect, approval_config, priority, active, template_id).
- `service_rule_versions` (snapshot per version, audit + revert).
- `service_rule_templates` (read-only seeded — 7 v1 templates: item_blackout, item_requires_lead_time, item_requires_approval, item_cost_approval_threshold, item_capacity_approval_threshold, category_hidden, menu_unavailable).
- `service_rule_simulation_scenarios` (test cases for rule editor).
- `room_booking_rules` (parallel structure).

**Backend:**
- `ServiceRuleResolverService` — predicate AST evaluator; deterministic; specificity-bucketed (catalog_item → menu → category → tenant); cached results in `policy_snapshot`.
- `ServiceEvaluationContext` — builder for predicate inputs (requester, space, item, quantity, asset, cost, lead time, etc.).
- `ServiceRuleService` — CRUD + simulate.
- Same patterns mirrored for room_booking.

**Frontend (today's gap):**
- `/admin/booking-services/rules/:id` — free-form JSON editor for `applies_when`.
- Target picker is a UUID input.
- Approval config is a nested JSON blob.
- Simulator takes JSON context as free-form text.
- Templates listed in a popover; clicking prefills JSON. No structured param UI.

### Why this is a critical fix

- Non-technical FM admin cannot author rules. Will phone support every time a rule is needed.
- The `applies_when` AST is well-designed and the template system has all the affordances we need — they just aren't exposed in the UI.
- Existing rules are usable as-is; we don't need to migrate them.

---

## 3. Domain unification

### One builder, all rule domains

The visual builder is **not** "the service rule builder." It's **the rule builder.** It works across:

- **Room booking rules** (`room_booking_rules` table) — who can book what room, when, with what restrictions.
- **Service rules** (`service_rules` table) — catering / AV / cleaning availability + approval + restrictions.
- **Visitor rules** (future) — pre-registration requirements, NDA, watchlist.
- **Parking rules** (future) — capacity, time-of-day pricing, role restrictions.
- **Asset rules** (future) — equipment availability, cost-center restrictions, capacity caps.

Each domain has its own `applies_when` schema (different fields available — e.g. service rules have `catalog_item`, room rules have `space_group`). The builder reads the per-domain schema and renders appropriate field pickers; the user experience is identical.

### Why unification matters

- **For admins:** one UI to learn. Same template flow. Same advanced builder. Same simulator. Same debugger. Same versioning. Same combobox vocabulary.
- **For us:** one component to build, one to maintain, one to optimize. Massive code reuse.
- **For the wedge:** the entire competitive position rests on "one predicate engine across all surfaces." This UI makes that visible — admins literally see the same rule builder for room rules and service rules. ServiceNow's Flow Designer is per-flow; Eptura's rules are per-module; Planon requires consultants per change. Ours is one.

### Schema-driven UI

Each rule domain registers a "rule schema" with the builder:

```typescript
interface RuleDomainSchema {
  domain: 'service_rules' | 'room_booking_rules' | 'visitor_rules' | 'parking_rules' | 'asset_rules';
  fields: FieldDefinition[];     // available predicate fields
  effects: EffectDefinition[];   // available effects (deny, require_approval, etc.)
  targets: TargetDefinition[];   // what kinds of entities this rule attaches to
  templates: RuleTemplate[];     // domain-specific seeded templates
  contextBuilder: () => Schema;  // for simulator + debugger
}
```

Builder reads the registered schema for the current domain and renders accordingly. Adding a new domain = registering a new schema, no UI rewrite.

---

## 4. Architecture

### Module layout

**Frontend (`apps/web/src/components/admin/rule-builder/`):**

- `RuleBuilder.tsx` — top-level container; routes between template-mode and advanced-mode editing.
- `RuleTemplateGallery.tsx` — template picker (step 1 of template flow).
- `RuleTemplateForm.tsx` — generates form fields from `param_specs`.
- `RuleAdvancedBuilder.tsx` — visual AST editor for advanced mode.
- `ConditionGroup.tsx` — recursive component for AND/OR groupings.
- `ConditionRow.tsx` — single field/operator/value triple.
- `FieldPicker.tsx` — combobox for available fields per domain.
- `OperatorPicker.tsx` — operator dropdown (filtered by field type).
- `ValueEditor.tsx` — value editor (typed per field — number input, date picker, EntityPicker, etc.).
- `RulePreview.tsx` — dry-run "would have matched X events" panel.
- `RuleSimulator.tsx` — simulate against ad-hoc scenario.
- `RuleDebugger.tsx` — "why did this match?" trace.
- `CoverageMatrix.tsx` — for-target view of all matching rules.

**Frontend primitives (`apps/web/src/components/ui/entity-picker/`):**

- `EntityPicker<T>.tsx` — generic single-select async combobox.
- `EntityMultiPicker<T>.tsx` — multi-select.
- Variants registered per entity type (catalog_item, menu, category, role, cost_center, person, vendor, asset_type, space, etc.).

**Backend (`apps/api/src/modules/rules/`):**

- `RuleSchemaService` — registers schemas per domain; serves field/operator/value definitions to frontend.
- `RuleDryRunService` — given a rule (draft or saved) + tenant, run against last 30 days of historical data and return matching events.
- `RuleSimulatorService` — given rule + scenario context, return effect + trace.
- `RuleDebuggerService` — given an entity (order, booking, etc.), return all matched rules with per-condition evaluation trace.
- `RuleConflictDetectionService` — periodic background scan for conflicting rules.

### Data flow

```
Admin opens /admin/.../rules/:id
    ↓
Frontend loads:
  - Rule (existing or new draft)
  - Domain schema (fields/operators/effects/targets/templates) from RuleSchemaService
  - For preview: rule's last 30 days of dry-run results from RuleDryRunService
    ↓
User edits via TemplateForm or AdvancedBuilder
    ↓
On every change:
  - Local state updates
  - 500ms debounce → re-query RuleDryRunService for fresh preview
  - Validate AST; show inline errors
    ↓
On Publish:
  - Server validates AST + permissions
  - Saves rule + creates new service_rule_versions row
  - Audit event
  - Cache invalidation in ServiceRuleResolverService
```

---

## 5. Predicate AST + canonical operators

### AST shape (already defined; documenting for clarity)

```json
{
  "type": "group",
  "operator": "AND",
  "conditions": [
    {
      "type": "condition",
      "field": "order.total_cost",
      "operator": "greater_than",
      "value": 500
    },
    {
      "type": "condition",
      "field": "requester.role_ids",
      "operator": "intersects",
      "value": ["role-uuid-1", "role-uuid-2"]
    },
    {
      "type": "group",
      "operator": "OR",
      "conditions": [
        {"type": "condition", "field": "order.delivery_space.building_id", "operator": "equals", "value": "building-uuid"},
        {"type": "condition", "field": "order.delivery_space.is_executive_floor", "operator": "equals", "value": true}
      ]
    }
  ]
}
```

### Operators by field type

| Field type | Operators |
|---|---|
| number | equals, not_equals, greater_than, less_than, greater_or_equal, less_or_equal, between, in, not_in |
| string | equals, not_equals, contains, starts_with, ends_with, in, not_in, regex_matches |
| boolean | equals (true/false) |
| date | equals, before, after, between, within_next, within_past, day_of_week_in, time_of_day_between |
| timestamp | (date operators) plus "is_business_hours", "is_after_hours" |
| uuid | equals, not_equals, in, not_in |
| uuid[] | intersects, contains, equals, is_empty |
| enum | equals, not_equals, in, not_in |
| object reference | (transparent — drill into nested fields with dot notation) |

### Reserved values

- `null` — tested as `is_null` / `is_not_null` rather than direct equality.
- `now()` — built-in for date/timestamp comparisons.
- `requester.tenant_id` — auto-bound (we don't expose; it's implicit).

### Validation

- Server validates AST shape on save: every condition has valid `field` per domain schema, `operator` is valid for that field type, `value` matches expected type.
- Client validates same; surfaces inline errors before save.
- Type coercion is explicit (e.g. user enters "500" in number field; we coerce + validate; reject "abc").

---

## 6. Template system

### Existing templates (service rules domain)

Seeded in `service_rule_templates` (migration 00149):

1. **item_blackout** — make a catalog item unavailable for a date range.
2. **item_requires_lead_time** — item needs N hours/days advance notice.
3. **item_requires_approval** — every order of this item needs approval.
4. **item_cost_approval_threshold** — orders over €X need approval.
5. **item_capacity_approval_threshold** — orders for >N people need approval.
6. **category_hidden** — entire category not browsable for certain roles/locations.
7. **menu_unavailable** — menu offline for a date range or by location.

### Template definition

```typescript
interface RuleTemplate {
  template_key: string;                 // unique id
  name: string;                         // human-readable
  description: string;
  domain: RuleDomain;
  category: 'approval' | 'availability' | 'capacity' | 'restriction';
  effect_default: Effect;
  applies_when_template: any;           // JSON with {{params}} placeholders
  param_specs: ParamSpec[];
  approval_config_template?: any;
  active: boolean;
}

interface ParamSpec {
  name: string;
  label: string;                        // shown in UI
  description?: string;
  type: 'number' | 'string' | 'boolean' | 'date' | 'date_range' | 'time_of_day_range' | 'days_of_week_multiselect' | 'entity_picker' | 'entity_multipicker' | 'enum_picker';
  entity_type?: EntityType;             // for entity_picker variants
  enum_options?: {value: string; label: string}[];
  required: boolean;
  default?: any;
  validation?: {min?: number; max?: number; pattern?: string};
}
```

### Template authoring UX (admin-facing)

When admin picks a template:

1. **Title bar:** Template name + description + "Edit raw" toggle (advanced).
2. **Params form:** generated from `param_specs`, one Field per spec with appropriate input.
3. **Effect selector:** dropdown showing template's `effect_default` + alternatives appropriate to domain.
4. **Approval config:** if effect = require_approval, expand `approval_config_template` form (approver target, threshold, escalation).
5. **Live preview pane:** "If you publish this rule, it would match the following events from the last 30 days: [list]".
6. **Buttons:** Save as draft / Publish / Cancel.

### Adding new templates

- Templates are seeded data — added via migration.
- For Tier 1, ship with the current 7 service-rule templates + ~5 room-booking-rule templates (defined in this spec, see §6.5).
- Every new domain ships with at least 3 templates covering its most common rule patterns.

### Room-booking template proposals (for parallel domain implementation)

1. **room_blackout_window** — room unavailable for a date range / day-of-week / time-of-day.
2. **room_requires_approval** — booking this room requires approval.
3. **room_role_restricted** — only certain roles can book this room.
4. **room_capacity_minimum** — booking requires headcount ≥ N.
5. **room_lead_time** — must book at least N hours/days in advance.

(Future: visitor, parking, asset templates seeded similarly when those domains land.)

---

## 7. Field / operator / value vocabulary

### Field domains per rule domain

**Service rules (`applies_when` for orders / order_line_items):**
- `requester.*` — id, role_ids, department_id, cost_center_id, org_node_id, default_location_id, manager_person_id.
- `order.*` — total_cost, headcount, delivery_date, delivery_time, lead_time_minutes, cost_center_id.
- `order_line_item.*` — catalog_item_id, quantity, unit_price, line_total, dietary_tags, requires_asset.
- `catalog_item.*` — id, category, subcategory, dietary_tags, fulfillment_team_id.
- `menu.*` — id, vendor_id, fulfillment_team_id.
- `space.*` — id, building_id, floor, type, is_executive_floor, is_after_hours.
- `vendor.*` — id, fulfillment_mode, owning_team_id.
- `asset.*` — id, asset_type_id, condition.
- `time.*` — current_time_of_day, current_day_of_week, current_date.

**Room-booking rules (`applies_when` for reservations):**
- `requester.*` — same as above.
- `reservation.*` — start_at, end_at, duration_minutes, attendee_count, headcount, recurrence_pattern.
- `space.*` — id, building_id, floor, capacity, type, space_group_ids, is_executive.
- `time.*` — same.

**Visitor rules (future):**
- `visitor.*`, `host.*`, `space.*` (lobby), `time.*`.

**Parking rules (future):**
- `requester.*`, `parking_spot.*`, `time.*`.

### Operators

See §5 — comprehensive list per field type.

### Values

- Static: scalar literal, enum value.
- Entity: looked up via EntityPicker (resolved to UUID at save time).
- Function: `now()`, `today()`, `start_of_business_hours()`.
- Reference to another field: `requester.cost_center_id` referenced as a value in another condition.

---

## 8. EntityPicker primitive library

The combobox primitive used everywhere — rule builder, admin forms, approval routing, anywhere we currently have UUID inputs.

### `EntityPicker<T>` API

```tsx
<EntityPicker
  entityType="catalog_item"
  value={selectedId}
  onChange={setSelectedId}
  required
  label="Catalog item"
  placeholder="Search catalog items..."
  allowClear
  filter={{ active: true, category: 'food_and_drinks' }}  // optional filter passed to backend
/>
```

### Variants

- `EntityPicker` — single-select.
- `EntityMultiPicker` — multi-select with chips.
- `EntityHierarchicalPicker` — tree view (e.g. spaces have site → building → floor → room hierarchy).
- `EntityComboPicker` — combobox with inline create ("can't find it? + create new").

### Per-entity-type adapter

Each entity type has a registered adapter:

```typescript
const catalogItemAdapter: EntityPickerAdapter<CatalogItem> = {
  searchEndpoint: '/admin/catalog-items?q={q}&limit=50',
  getEndpoint: '/admin/catalog-items/:id',
  renderItem: (item) => (<><Image src={item.image_url} /><span>{item.name}</span><span className="text-muted">{item.category}</span></>),
  renderSelected: (item) => item.name,
  cacheKeyPrefix: 'catalog-items',
  staleTime: 30_000,
};
```

### Async + caching

- React Query backing (per `docs/react-query-guidelines.md`).
- Search debounced 300ms.
- Recent selections cached locally (per user) for snappy reopens.
- Selected value(s) eagerly fetched + cached so the chip render is instant.

### Accessibility

- Full keyboard navigation (arrow keys, enter, escape).
- ARIA combobox role + ARIA-live region for search results.
- Screen reader labels for current selection + status.
- Clear focus indicators per polish rules.

### Rollout

Build the canonical `EntityPicker` first; replace all existing UUID inputs across admin (rule editor, vendor service area, cost center default approver, bundle template, etc.) as a sweep. This is its own ~1 week sub-task within the rule builder spec.

---

## 9. Rule editor UI — template flow + advanced flow

### Page layout

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Back to rules    Rule: Catering over €500 needs VP approval  │
│ [Save draft] [Publish]  [Switch to advanced mode]               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ ┌─ Editor (main) ────────────┐  ┌─ Live Preview ──────────────┐ │
│ │                             │  │ Last 30 days impact:        │ │
│ │ Template: Item cost ...     │  │                             │ │
│ │ ────────────────────────    │  │ ✓ Would have matched 12     │ │
│ │ Min cost:  [   500 ] EUR    │  │   events                    │ │
│ │ Categories: [Catering ×]    │  │ ✗ 412 events not matched    │ │
│ │ Approver:   [VP Finance ▼] │  │                             │ │
│ │ Threshold:  €500           │  │ Events that would match:    │ │
│ │ Effect:     Require approval│  │  • 2026-04-15 — board lunch │ │
│ │                             │  │  • 2026-04-20 — exec dinner │ │
│ │ Denial msg: "..."           │  │  ... [show all]             │ │
│ └─────────────────────────────┘  └─────────────────────────────┘ │
│                                                                  │
│ [Test with simulator]  [View as raw JSON]  [Version history]    │
└─────────────────────────────────────────────────────────────────┘
```

### Template mode (default for new rules)

1. **Template gallery** (modal or full-page) — categorized list with search:
   - Categories: Approval, Availability, Capacity, Restriction.
   - Each card: icon, name, description, "Use this template" button.
2. **Template form** (after picking):
   - Title editable (defaults to "[Template name] for [target]").
   - Param fields rendered from `param_specs` — typed UI per param.
   - Effect selector with default + alternatives.
   - Approval config form (if applicable).
   - Denial / warning message text area.
   - Priority slider (auto-suggested based on specificity bucket; admin override).
3. **Preview** updates live as user fills params.
4. **Publish** writes rule to DB + creates `service_rule_versions` row + invalidates resolver cache.

### Advanced mode (visual builder)

Toggle "Switch to advanced mode" exposes the full AST editor:

```
Conditions (ALL of)
├─ requester.role_ids INTERSECTS [Manager, VP Finance]
├─ order.total_cost > 500
└─ Conditions (ANY of)
   ├─ order.delivery_space.is_executive_floor = true
   └─ order.delivery_space.building_id = HQ
```

UI:
- Tree of condition groups with AND / OR toggles.
- Drag-handle to reorder conditions (visual only; reorder doesn't change semantics).
- "+" buttons to add condition or sub-group.
- "×" buttons to remove.
- Each condition row: FieldPicker, OperatorPicker, ValueEditor.
- Indentation conveys nesting; vertical lines connect siblings.

Save creates a rule with `template_id = null` (custom rule, not template-derived).

### Edit raw JSON (escape hatch)

A toggle on the title bar reveals a JSON editor showing the current `applies_when` AST. Useful for:
- Debugging.
- Power users who genuinely prefer JSON.
- Importing rules from another system.

Edits in JSON sync back to the visual builder on save (re-render the visual representation).

### Validation + errors

- Inline errors per condition (e.g. "operator INTERSECTS not valid for number field").
- Top banner errors at save (e.g. "missing required value in condition 3").
- AST schema validated server-side as belt-and-braces.

### Shortcuts

- `?` opens shortcut help.
- `Cmd+S` saves draft.
- `Cmd+Enter` publishes.
- `Cmd+/` switches between visual and JSON.

---

## 10. Rule preview / dry-run

### Mechanism

`RuleDryRunService.runDryRun(ruleAst, targetType, targetId, tenantId, lookbackDays = 30)`:
- Loads relevant historical entities (orders, bookings, etc.) over last N days.
- Re-runs `applies_when` evaluation against each.
- Returns: matched_count, total_count, list of matched entities (limited to first 100), list of would-have-blocked / would-have-required-approval / etc. by effect.

### UI

- Right-pane "Live preview" panel.
- Updates 500ms after rule edit settles.
- Shows: match count, sample matched events (top 10 with details), expand to see all.
- For approval-effect rules: "12 events would have required approval — first time this would have escalated to VP: 2026-04-15."
- For deny-effect rules: "These 12 events would have been denied — affected requesters: 8 unique people."

### Performance

- Rule eval is fast (~5ms per entity). 30 days at 500 events/day = 15k evaluations = ~75ms total.
- Cache dry-run results per (ruleAst hash, targetType, targetId, lookbackDays) for 60s — admin scrolls back and forth without re-running.

---

## 11. Simulator

### Replace today's JSON simulator with structured form

Sub-page `/admin/.../rules/:id/simulate`:

**Scenario builder (left pane):**
- Form-driven scenario authoring using same EntityPicker library.
- Every field in the rule's `ServiceEvaluationContext` (or domain's context) gets a typed input.
- Defaults sensible (today's date, requester = current admin, sample item, etc.).
- "Save scenario" → adds to `service_rule_simulation_scenarios` for re-use.

**Simulation result (right pane):**
- "Effect: REQUIRE_APPROVAL"
- "Matched: 1 rule"
- Per-rule trace: rule name + every condition evaluated true/false.
- "Approval routed to: Marleen V. (cost-center default approver)."

### Saved scenarios

- Library of scenarios per tenant ("typical board lunch", "after-hours catering", "executive AV setup").
- Run any rule against any scenario in 1 click.
- Used in CI / automated rule-regression testing too.

---

## 12. Rule debugger — "why did this match?"

### Use case

Desk operator complains: "This order shouldn't have required approval." Admin investigates by looking up the order in the rule debugger.

### UI

`/admin/.../rules/debug?entity=order&id=<uuid>`:
- Top section: entity summary (order details, requester, etc.).
- Resolution result: effect applied, matched rules ranked by priority.
- Per-matched-rule:
  - Rule name + link to edit.
  - Trace: each condition evaluated, with input value + result (✓ or ✗).
  - Specificity bucket.
- For non-matched but candidate rules: "Considered but did not match" expandable section with same trace.
- Override panel (admin with `rules:override` permission): manually re-route or skip approval for this entity.

### Backend

`RuleDebuggerService.debug(entityType, entityId, tenantId)`:
- Build evaluation context.
- Run resolver in trace mode (records every condition evaluated).
- Return structured trace.
- Audit: `rule.debug_inspected`.

---

## 13. Coverage matrix view

### For-target view

`/admin/.../rules/coverage?target_type=catalog_item&target_id=<uuid>`:
- Lists every rule that applies to this entity (directly or via inheritance).
- Sorted by specificity bucket (item-specific → menu → category → tenant).
- Each row: rule name, effect, priority, conditions summary, "edit" link.
- Visual indicator of rule precedence: "If this matches, X wins; if not, fall through to Y."

### For-rule view

`/admin/.../rules/coverage?rule_id=<uuid>`:
- Lists every entity this rule applies to.
- Useful for: "How broad is this rule? Does it accidentally cover items I didn't intend?"

### Use cases

- New admin orienting: "What rules govern catering at our HQ?"
- Audit: "Show me every rule that requires VP approval."
- Cleanup: "Find rules with no matches in last 90 days — candidates for archive."

---

## 14. Conflict detection

### Background scan

Nightly worker:
1. Pair-wise scan of active rules with overlapping target scope.
2. For each pair, sample N hypothetical contexts; check if effects conflict.
3. Flag conflicts to admin via in-app notification + health view.

### Definition of conflict

- Two rules both match the same evaluation context.
- Their effects contradict (e.g. one denies, one allows).
- Or: their priorities are equal (so the resolution is non-deterministic).

### UI

`/admin/.../rules/conflicts`:
- List of detected conflicts.
- Per-conflict: both rules + sample matching context + suggested resolution (adjust priority, narrow predicate, archive one).
- One-click "Adjust priorities" with recommended values.

---

## 15. Versioning + revert

### Existing schema

`service_rule_versions` (and parallel for room rules) stores snapshot per version.

### UI

Tab on rule edit page: "Version history".
- List of versions: who, when, summary of change ("Added cost threshold", "Changed approver from X to Y").
- Diff view: side-by-side comparison of two versions (visual builder representation, not JSON).
- One-click revert: creates a new version reverting to selected version.
- Audit captures revert.

### Diff calculation

- AST-level diff using existing `service_rule_versions.snapshot` jsonb.
- Render as: added conditions, removed conditions, modified conditions (old → new), changed effect, changed approval config.

---

## 16. Phased delivery

### Sprint 1 (3 wks): Foundation + service rule template flow

- `EntityPicker` primitive library (replaces UUID inputs everywhere — sweep all admin forms).
- Rule schema service backend + frontend integration.
- Template gallery + template form for service rules (covers 7 existing seeded templates).
- Live preview panel + dry-run service.
- Replace existing JSON editor at `/admin/booking-services/rules/:id` with new template-driven UI.
- Save / publish flow with versioning.

**Acceptance:** non-technical admin can author "Catering over €500 needs VP approval" entirely via template + form, no JSON visible.

### Sprint 2 (2 wks): Advanced builder + simulator + debugger

- Visual AST editor (advanced mode) for service rules.
- Replace JSON simulator with form-driven scenario builder.
- Rule debugger UI (look up an order, see why rules matched).
- Edit raw JSON escape hatch.

**Acceptance:** admin can author rules outside template library; simulate against scenarios; debug why a specific order matched.

### Sprint 3 (2 wks): Domain extension + coverage + conflict detection

- Add `room_booking_rules` domain support (5 seeded templates).
- Coverage matrix view (for-target + for-rule).
- Conflict detection background scan + UI.
- Versioning + revert UI.

**Acceptance:** room booking rules use the same builder; admins can see all rules that apply to a target; conflicts surface automatically.

### Sprint 4 (~1 wk): Polish + i18n + docs

- i18n: NL + FR translations for builder labels, template descriptions, error messages.
- Accessibility audit (keyboard nav, screen reader, focus).
- Performance audit (preview latency, large rule library).
- In-app help: contextual tooltips + getting-started checklist.

**Total: ~8 weeks** (can compress to ~6 weeks with two engineers parallel on builder UI vs primitive library).

---

## 17. Performance + scale

### Render

- Template form: trivial (tens of fields max).
- Advanced builder: virtualized only if rule has >50 conditions (rare; warn user).
- EntityPicker: server-side search + 50-row paging; instant UX.

### Backend

- Rule load: simple SELECT per rule.
- Dry-run: 30 days × 500 events/day = 15k evaluations × ~5ms = 75ms total. Acceptable.
- Coverage matrix: indexed; <100ms.
- Debugger trace: same as resolver; sub-100ms.
- Conflict detection: nightly batch; doesn't impact live UX.

### Caching

- Domain schema: cached client-side per session (rarely changes).
- Dry-run results: cached 60s per (rule hash, target).
- EntityPicker results: React Query staleTime 30-60s per query.

---

## 18. Acceptance criteria

### Sprint 1

1. Admin can replace any existing UUID input with EntityPicker (rule target, approver picker, cost center selector, etc.) — sweep complete.
2. Admin opens `/admin/booking-services/rules/new` → picks "Item cost approval threshold" template → fills params (catalog item, threshold €500, approver) → previews 12 matched events → publishes → rule active.
3. Authoring this rule never shows JSON or raw UUIDs.
4. Existing JSON-authored rules continue to work + render in visual builder when re-opened.
5. Live preview updates within 1s of edit.

### Sprint 2

6. Admin opens advanced builder, drags AND/OR groups, adds conditions, saves.
7. Simulator: admin builds scenario via form, runs rule against it, sees effect + trace.
8. Admin pastes order ID into debugger, sees all matched rules with per-condition trace.
9. Edit raw JSON toggle works bidirectionally without data loss.

### Sprint 3

10. Same builder works for room booking rules; admin authors a "Boardroom requires VP approval" rule with the same flow.
11. Coverage matrix shows all rules applying to a specific catalog item.
12. Conflict detection finds + surfaces a deliberate test conflict (two rules with same priority, opposite effects).
13. Versioning: admin views history, diffs two versions, reverts; new version recorded.

### Sprint 4

14. Builder localized in NL + FR.
15. Keyboard-only authoring possible end-to-end.
16. Lighthouse / accessibility audit ≥95 on rule editor pages.

---

## 19. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Visual builder still too complex for non-technical admin | Medium | High | Heavy reliance on templates (cover ~80% of cases); advanced mode is opt-in; user testing during sprint 1 with FM-director-equivalent users |
| EntityPicker performance with 10k+ catalog items | Low | Medium | Server-side search with indexed name + category; debounced; paged 50/scroll |
| AST migration when we add new field types later | Medium | Low | Versioned AST schema; migration scripts for breaking changes; default-tolerant evaluator |
| Dry-run skewed by historical data being unrepresentative | Medium | Low | Show date range explicitly; admin can extend lookback window; warn if <10 events in window |
| Two engineers stepping on each other (builder UI vs primitives) | Low | Low | Clean module boundary; primitive library frozen by mid-sprint-1 |
| Power users miss raw JSON freedom | Low | Low | Edit-raw escape hatch always available |
| Test/simulation scenarios drift from real rule context shape | Medium | Medium | Scenario authoring uses same context schema as resolver; CI catches divergence |
| Conflict detection produces false positives | Medium | Low | Tune sample count; allow admin to dismiss; conflicts are advisory not blocking |

---

## 20. Open questions

1. **Should rule edits require a draft → publish flow, or save-on-blur?** Recommend draft → publish (with explicit Publish button); rules are consequential.
2. **Who can publish vs who can draft?** Recommend draft = `rules:write`, publish = `rules:publish` permission. Lets junior admins author + senior approves.
3. **Template versioning** — when we update a seeded template's `param_specs`, do existing rules re-pickup? Recommend no — existing rules retain their original template snapshot; template versioning explicit.
4. **Inline create from EntityPicker** ("can't find catalog item? + create new") — feasible for low-friction items; risky for heavy entities. Default off; opt-in per entity type.
5. **Mobile / tablet authoring** — is rule authoring ever done from mobile? Probably not; defer responsive optimization.
6. **Auto-archive rules that haven't matched in 90 days** — opt-in tenant setting; warn before archiving.
7. **Allow conditions on Outlook event metadata (subject regex)?** Adds power but expands attack surface (subject is user-controlled). Defer until specific demand.
8. **Bulk publish across rules** (e.g. "publish all 5 of these draft rules together")? Defer to v2.

---

## 21. Out of scope

- AI-assisted rule generation ("describe the rule in English, we generate the AST").
- External system actions (rules trigger only Prequest-internal effects).
- Rule sharing across tenants (templates are seeded; tenant-specific rules don't sync).
- Workflow orchestration (separate React Flow editor).
- Custom field type registration per tenant.
- Automated rule documentation generation (admin-facing docs are out of scope; we surface descriptions inline).

---

## 22. References

- [`docs/booking-services-roadmap.md`](../../booking-services-roadmap.md) §9.1.2 — original Tier 1 backlog item.
- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §F4 + §G1 — parity gate annotation.
- [`docs/competitive-benchmark.md`](../../competitive-benchmark.md) — ServiceNow Flow Designer benchmark.
- Existing schema migration: 00141 (service_rules + service_rule_versions + service_rule_templates + service_rule_simulation_scenarios), 00149 (template seed).
- Sibling specs:
  - `2026-04-26-linked-services-design.md` — linked services + rule resolution.
  - `2026-04-27-microsoft-graph-integration-design.md` — sibling foundational integration.
  - `2026-04-27-vendor-portal-phase-a-daglijst-design.md` — sibling vendor-side foundational item.
- React Query patterns: `docs/react-query-guidelines.md`.
- Form composition: `apps/web/src/components/ui/field.tsx` + project rule in `CLAUDE.md`.
- Settings page layout: `apps/web/src/components/ui/settings-page.tsx`.

---

**Maintenance rule:** when implementation diverges from spec, update spec first, then code. Same convention as `docs/assignments-routing-fulfillment.md` and `docs/visibility.md`.
