# CI assertion strategy — current state, brittleness, and the invariant pattern

**Status:** Documented as next-step refactor. NOT yet implemented.
**Triggering condition:** before Step 2 or Step 4 destructive cutover (orders → service_orders, booking_bundles → bookings).
**Effort estimate:** ~half a day to convert the 11 existing assertions to YAML-driven invariants and write the generator.

---

## Current state — `scripts/ci-migration-asserts.sql`

11 hand-rolled assertions (A1..A11) gated by `.github/workflows/ci.yml`:

| ID  | What it asserts                                               | Brittle to                                                  |
|-----|---------------------------------------------------------------|-------------------------------------------------------------|
| A1  | No CASCADE FKs to `public.tickets` remain                     | Step 6 rename (`tickets` → `cases`) — table name hardcoded  |
| A2  | `tickets.ticket_kind` column does NOT exist                   | Same                                                        |
| A3  | `public.work_orders` is a real BASE TABLE                     | Stable; safe                                                |
| A4  | `public.activities` has polymorphic columns                   | Stable; safe                                                |
| A5  | Polymorphic FKs on sla_timers / workflow_instances / routing_decisions | Stable; safe                                         |
| A6  | tenant_id present on every tenant-scoped table                | Step 2 (orders → service_orders) — must edit the array      |
| A7  | `public.ticket_visibility_ids` exists                         | Step 6 rename — function name hardcoded                     |
| A8  | `public.user_has_permission` exists                           | Stable; safe                                                |
| A9  | Triggers present on `public.activities`                       | Stable; safe                                                |
| A10 | `public.scheduler_data` function exists (00242 effect check)  | Brittle to migration renumber                               |
| A11 | `bundle_is_visible_to_user` parity (behavioral)               | Step 4 rename (`booking_bundles` → `bookings`) — function name + table name hardcoded |

**The pattern these all share:** each assertion hardcodes specific identifiers — table names, column names, function names, constraint names. When Steps 2/4 destructive renames ship (`orders` → `service_orders`, `booking_bundles` → `bookings`), every assertion that mentions those tables silently rots. The assertions don't fail on the rename — they pass, because they're checking conditions that no longer mean what they originally meant.

**Concrete failure scenarios:**

- A6 lists `'orders'` and `'booking_bundles'` literally. After Step 2 rename, the `'orders'` check passes vacuously (table doesn't exist; `and exists (...)` short-circuit), and the new `'service_orders'` table is unprotected unless someone remembers to add it.
- A11 inserts into `public.booking_bundles` directly. After Step 4 rename, the INSERT either fails loudly (good, but unhelpful diagnostic) or hits the alias view (silently inserts into a stale shape).
- A1 / A2 / A7 mention `public.tickets` and `ticket_visibility_ids`. After Step 6 rename, these silently pass on the old (now empty) table while the new `cases` table accumulates problems.

**The 2026-04-30 data-loss class is what these assertions defend against.** If the assertions stop applying to the right tables, the next destructive cutover hits the same class of bug with no pre-flight gate.

---

## The pattern that scales — declarative invariants

Instead of one DO-block per concrete check, declare invariants as DATA. Examples:

- "Every table in the `tenant_scoped` set has a `tenant_id` column that is NOT NULL."
- "Every polymorphic column pair `(entity_kind, <kind>_id)` has a CHECK constraint that the FK matches the kind."
- "No CASCADE FKs target any table in the `aggregate_root` set."
- "Every table in the `audited` set has at least one trigger that writes to `activities`."

The invariants are tagged with sets (`tenant_scoped`, `aggregate_root`, `audited`, ...). The set memberships are the only thing that changes when a table is renamed or split. Add `service_orders` to `tenant_scoped`; the assertions automatically include it.

### Minimum-viable next step — `scripts/ci-invariants.yml`

Shape:

```yaml
sets:
  aggregate_root:
    - tickets         # to be renamed -> cases at Step 6 (if we ever do it)
    - work_orders
    - bookings        # currently a view; becomes table at Step 4
  tenant_scoped:
    - tickets
    - work_orders
    - activities
    - ticket_activities
    - persons
    - users
    # ... all currently in A6
    - service_orders  # add when Step 2 ships
  polymorphic_kind_owners:
    - { table: sla_timers,         kind_col: entity_kind, fk_cols: [case_id, work_order_id] }
    - { table: workflow_instances, kind_col: entity_kind, fk_cols: [case_id, work_order_id] }
    - { table: routing_decisions,  kind_col: entity_kind, fk_cols: [case_id, work_order_id] }
  canonical_predicates:
    - ticket_visibility_ids   # rename to case_visibility_ids at Step 6
    - user_has_permission
    - bundle_is_visible_to_user

invariants:
  - id: I1
    name: no_cascade_fks_to_aggregate_roots
    applies_to: aggregate_root
    rule: |
      select count(*) from pg_constraint
      where contype = 'f'
        and confrelid = format('public.%I', $table)::regclass
        and confdeltype = 'c';
    expect: 0
    message: |
      % CASCADE FK(s) to public.% remain. Cascade-delete data-loss hazard.
      Drop them by EXPLICIT name (see migration 00238 for the right pattern),
      do NOT use a LIKE-pattern DO block.

  - id: I2
    name: tenant_id_present
    applies_to: tenant_scoped
    rule: |
      select count(*) from information_schema.columns
       where table_schema = 'public'
         and table_name = $table
         and column_name = 'tenant_id';
    expect: ">= 1"
    message: |
      Tenant-scoped table public.% is missing tenant_id column.
      Cross-tenant leak hazard.

  - id: I3
    name: canonical_predicate_exists
    applies_to: canonical_predicates
    rule: |
      select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = $name;
    expect: ">= 1"

  - id: I4
    name: polymorphic_kind_columns_present
    applies_to: polymorphic_kind_owners
    rule: |
      select count(*) from information_schema.columns
       where table_schema = 'public'
         and table_name = $table
         and column_name = ANY (ARRAY[$kind_col] || $fk_cols);
    expect: "= cardinality(ARRAY[$kind_col] || $fk_cols)"

# Behavioral invariants (the A11 class — function actually does the right thing,
# not just exists). These stay hand-written because they need synthetic data
# fixtures. List them here so that the generator skips them and only emits
# structural assertions.
behavioral:
  - bundle_is_visible_to_user_parity   # current A11
```

### The generator — `scripts/gen-ci-asserts.{ts,py}`

Reads `ci-invariants.yml`, emits `scripts/ci-migration-asserts.sql`. Runs in CI as a verification step — if the generated SQL doesn't match the committed SQL, fail with "regenerate ci-migration-asserts.sql via `pnpm gen:ci-asserts`". This is the same pattern as Prisma migration generation or codegen for OpenAPI clients.

**Behavioral invariants** (currently A11) stay as hand-written DO blocks appended after the generated section. The generator emits a marker comment like `-- BEGIN BEHAVIORAL INVARIANTS (hand-written)` and preserves anything below it on regeneration.

### What this buys

- **Adding a new tenant-scoped table is one YAML line, not a SQL DO-block edit.**
- **Renaming a table at Step 2/4/6 is one YAML edit + the migration; assertions follow automatically.**
- **The set memberships are reviewable in PR.** A reviewer can ask "should `service_orders` really not be tenant-scoped?" and the answer is one line of YAML, not "go read 245 lines of nested DO blocks."
- **CI fails when the generator output drifts from the committed SQL.** No silent rot.

### What this does NOT buy

- Behavioral assertions (A11 class) still need hand-written fixtures. The generator only handles structural invariants (column exists, FK has the right action, function exists).
- Migration-effect assertions like A10 ("00242's `scheduler_data` function exists") are weakly typed. They're really "`scheduler_data` exists" — that's already covered by I3 if `scheduler_data` is added to a `canonical_helpers` set. A10 as currently written is closer to a "did the renumber not break anything" smoke than an invariant.
- Cross-table invariants (e.g., "every row in `work_orders` has a corresponding entry in `activities`") need a different mechanism — those are runtime data invariants, not schema invariants.

---

## When to implement

**Trigger:** before Step 2 or Step 4 destructive cutover lands (`orders` → `service_orders`, `booking_bundles` → `bookings`). Either of those would silently rot 4–6 of the existing assertions if the YAML pattern isn't in place first.

**Order of operations on the day:**

1. Land the YAML + generator + regenerated SQL as ONE PR before any destructive migration.
2. Verify CI is green on the regenerated assertions.
3. Land the destructive migration in a separate PR, with the YAML edit (rename in `aggregate_root`, `tenant_scoped`, `canonical_predicates`) included.
4. Verify CI is green on the post-rename assertions.

If the user pushes back ("isn't this gold-plating?"): the answer is "we already shipped two catastrophic data-loss incidents because of pattern-match brittleness in DDL. The current SQL is the same pattern at a different layer. Steps 2/4 will trigger the same class of failure unless we fix it first."

If the user accepts brittleness as the price ("we'll just remember to update the SQL when we rename"): document the decision here, mark this strategy as "rejected, hand-edit on each rename", and add a checklist item to the rename PR template.
