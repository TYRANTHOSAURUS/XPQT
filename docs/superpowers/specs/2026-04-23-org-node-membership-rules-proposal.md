# Conditional / rule-based org-node membership — proposal

**Date:** 2026-04-23
**Status:** Proposal — parked for future. Not scheduled, not implemented.
**Builds on:** [`2026-04-22-organisations-and-admin-template-design.md`](2026-04-22-organisations-and-admin-template-design.md)

---

## 1. Problem

Today, persons join an org node only via explicit manual assignment (`person_org_memberships` upsert from the person form or the org detail page). For tenants with thousands of employees, this is the same per-person bottleneck that org-node location grants were designed to remove — just one layer up. Onboarding still requires an admin to click through every new hire and pick their org node, even when the assignment is mechanically derivable from existing person attributes (e.g. "everyone with `@prequest.nl` belongs to the Prequest org").

We want **standing rules** that auto-populate org membership from person attributes, evaluated on insert/update, with manual assignment still possible alongside.

## 2. Proposed shape

### 2.1 Data model

New table:

```sql
create table public.org_node_membership_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  org_node_id uuid not null references public.org_nodes(id) on delete cascade,
  attribute text not null,                 -- 'email' | 'type' | 'manager_person_id' | 'cost_center'
  operator  text not null,                 -- 'equals' | 'ends_with' | 'starts_with' | 'contains' | 'in_list'
  value     text not null,                 -- pattern; for 'in_list' a JSON array stringified
  created_by_user_id uuid references public.users(id),
  created_at timestamptz not null default now()
);
```

Multiple rules on the same node combine with **OR** (any match → membership). AND-within-a-group is intentionally out of v1 scope; revisit if needed.

Add a column to the existing join table:

```sql
alter table public.person_org_memberships
  add column source text not null default 'manual'
    check (source in ('manual', 'rule'));
```

`source = 'rule'` rows are owned by the auto-evaluator and may be removed when a rule no longer matches. `source = 'manual'` rows are sacrosanct — they survive rule changes.

### 2.2 Evaluation

A SQL function `evaluate_membership_rules_for_person(person_id, tenant_id)`:

1. Loads all `org_node_membership_rules` for the tenant.
2. Loads the person's relevant attributes.
3. For each rule, computes match.
4. Reconciles `person_org_memberships` rows where `source = 'rule'`:
   - Inserts memberships for newly matched (org_node_id, person_id) pairs.
   - Deletes rule-source memberships that no longer match.
   - Manual memberships are never touched.
5. Never sets `is_primary=true` (rule-matches are always secondary; admin promotes manually).

Triggers:
- `AFTER INSERT OR UPDATE` on `persons` (when `email`, `type`, `manager_person_id`, or `cost_center` changes) → call evaluator for that person.
- `AFTER INSERT OR UPDATE OR DELETE` on `org_node_membership_rules` → re-evaluate all persons in the tenant. (For a tenant with 5000 persons and a handful of rules, this is < 1s in practice; if it ever becomes slow, defer to a background job.)

### 2.3 UI

On the **organisation detail page**, below the existing "Members" section, add a new section **"Auto-add rules"**:

- Composer row: `<OrgNodeMembershipRuleComposer>` — three controls (Attribute combobox · Operator combobox · Value input) + "Add rule" button.
- Existing rules listed below as removable chips/cards. Each shows its current match count ("matches 23 people").
- Empty state: "No rules. Members of this organisation are added manually."

In the **Members section**, every member row gets a small provenance badge:
- `Manual` (default style, muted) — added explicitly via the form or org detail.
- `Rule: email ends with @prequest.nl` — added by an evaluator pass; clicking the badge could later jump to the rule.

This makes "why is this person in this org?" visible without the admin guessing.

### 2.4 Permissions

Reuse existing `organisations:manage`. Anyone who can manage org nodes can manage their rules.

### 2.5 API surface

- `GET /org-nodes/:id/membership-rules` — list rules + match counts.
- `POST /org-nodes/:id/membership-rules` — body `{ attribute, operator, value }`. Returns the new rule.
- `DELETE /org-nodes/:id/membership-rules/:ruleId` — removes the rule and any rule-source memberships it created.

Both endpoints trigger the evaluator synchronously; response includes the affected person count for admin feedback.

## 3. Open questions (decide before implementation)

1. **Attribute scope in v1** — just `email`, or all four (`email`, `type`, `manager_person_id`, `cost_center`)? Recommendation: **all four**, cheap to add, obvious uses for each.
2. **Manager-chain matching** — should `manager_person_id equals X` cascade down the reporting tree, or only direct reports? Probably **direct only** in v1; "chain" is its own feature with cycle/depth concerns.
3. **Two memberships, neither primary** — when a rule-matched person is also manually added to a different org, the person's primary stays whichever was set first (or `none`). Admin can promote via the person form. Confirm.
4. **Rule conflicts across orgs** — if a person matches rules on three different orgs, they get three memberships. All become non-primary. Acceptable for v1.
5. **Rule edits vs. delete** — editing a rule (change `value` from `@prequest.nl` to `@prequest.com`) should trigger reconcile equivalent to delete-then-create. Implement as: tear down all rule-source memberships from this rule_id, then re-evaluate.
6. **Backfill on rule create** — first-time evaluation can be slow on a 5000-person tenant. Run inline if < 2s; otherwise add a "Rule queued for evaluation" UX with a background job. Decide once we measure.

## 4. Acceptance criteria (when we pick this up)

- Creating a rule with `attribute=email, operator=ends_with, value=@prequest.nl` immediately adds rule-source memberships for every matching person and shows the count in the UI.
- Inserting a new person whose email matches an existing rule auto-creates the membership.
- Updating a person's email so they no longer match removes the rule-source membership but leaves any manual memberships and `is_primary` flag for that person untouched.
- Deleting a rule removes all rule-source memberships it created in one transaction.
- Member list shows provenance badges (`Manual` vs `Rule: …`) for every row.
- Portal scope cascade for rule-source memberships behaves identically to manual memberships — `portal_authorized_root_matches` does not change.

## 5. Risks

| # | Risk | Mitigation |
|---|------|------------|
| 1 | `BEFORE/AFTER UPDATE` re-eval trigger on `persons` becomes a hot path. | Only fire when one of the four matched attributes changes; check OLD vs NEW in the trigger body. |
| 2 | Rule eval after CRUD on rules table re-walks every person in the tenant. | Acceptable at < 5000 persons. Background-job fallback at higher scale. |
| 3 | Provenance confusion when a person matches multiple rules on the same org. | Storage allows it; reconciler dedupes by `(person_id, org_node_id)`. UI shows a single badge with rule count if > 1. |
| 4 | Manual membership accidentally turned into rule-matched on a re-eval bug. | The reconciler MUST filter `where source = 'rule'` on every delete and insert. Cover with tests. |
| 5 | Email-suffix matching against a column without an index. | `persons.email` already has `idx_persons_tenant_email`. For `LIKE '%suffix'`, that index won't help — but at < 10k rows it doesn't matter. Reconsider for larger tenants. |

## 6. Out of scope (future-future)

- AND combinator within a rule group ("email ends with X AND type = employee").
- Custom SQL predicate rules (admin-supplied WHERE clause). Power users only; not needed for the 90% case.
- Reporting-chain matching ("everyone in Sarah's tree" — 3 levels deep).
- Rules that **remove** someone from another org as a side effect.
- Time-bounded rules ("contractors auto-join during their contract window").
- Rule-driven primary-membership designation (today, primary stays manual-only).

---

**To pick this up:** start a brainstorm session with this proposal as the seed. Resolve the open questions in §3, then run `superpowers:writing-plans` against the resulting design. The data-model migration is small (one new table + one column on the existing join table); most of the work is the evaluator function + UI composer + provenance badge.
