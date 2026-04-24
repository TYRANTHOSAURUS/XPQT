# Seed Migration Chain Runbook

How to apply database + seed changes in the correct order so a new or updated example-data implementation works on the first attempt.

This is the operational runbook for:

- creating a new example-data implementation
- updating an existing one
- applying it locally
- applying it to the hosted Supabase project without drift

Primary related docs:

- [centralised-example-data-seed.md](./centralised-example-data-seed.md)
- [database-seed-plan.md](./database-seed-plan.md)

## Core Rule

Always apply changes in this order:

1. Runtime/schema migrations
2. Seed SQL migrations
3. PostgREST schema reload
4. Generator script
5. Verification checks

Do not run the generator before the schema and seed SQL are fully applied.

That is how you end up with:

- missing columns
- old SQL functions
- broken predicates
- portal `500`s
- partial example data

## What Counts As Each Layer

### 1. Runtime/schema migrations

These are migrations that define or change:

- tables
- constraints
- indexes
- SQL functions / RPCs
- predicates
- criteria evaluation
- routing behavior
- portal visibility behavior

Examples:

- `00099_criteria_sets_org_support.sql`
- `00103_request_type_coverage_matrix.sql`

These must be live before any seed that depends on them.

### 2. Seed SQL migrations

These are deterministic example-data migrations:

- reset / cleanup
- foundation
- catalog
- enrichment

For the current TSS implementation, that means:

- `00100_seed_centralised_example_reset.sql`
- `00102_seed_centralised_example_foundation.sql`
- `00104_seed_centralised_example_catalog.sql`
- `00105_centralised_example_catalog_enrichment.sql`

### 3. Generator script

This is the last step.

For the current implementation:

- [`apps/api/scripts/centralised-example-data-seed.mjs`](../apps/api/scripts/centralised-example-data-seed.mjs)

It creates or updates:

- auth users
- generated people
- bulk assets
- historical tickets
- activity / approvals / workflow history

It assumes the SQL layer is already correct.

## Non-Negotiable Rules

### Rule 1: Never patch a broken remote seed by only rerunning the generator

If runtime/schema migrations are missing, the generator will not save you.

Example:

- old `criteria_matches()` still on remote
- seed uses org-based criteria
- portal visibility RPC crashes

Fix the migration chain first. Then run the generator.

### Rule 2: Do not edit old migrations that are already part of the shared chain unless they are still purely local

Once a migration has been applied remotely, treat it as history.

If you need to change seeded data:

- add a new forward migration
- do not silently rewrite the past

Good:

- `00105_centralised_example_catalog_enrichment.sql`

Bad:

- changing an old remote-applied migration and hoping every environment matches again

### Rule 3: Base seed and upgrade seed are different things

Use:

- base seed migrations for clean rebuilds
- enrichment / upgrade migrations for already-seeded tenants

If the tenant already exists remotely, do not assume a fresh reset is acceptable.

### Rule 4: Every portal-facing request type must be complete

A request type is not finished unless it has:

- name
- meaningful description
- icon
- keywords
- category binding
- form variant
- coverage rule
- correct audience rules if restricted

### Rule 5: Add guardrails to the generator for things that must never regress

The generator should fail fast if critical seed assumptions are broken.

Current guardrails already check:

- admin has `tickets:read_all`
- admin has `tickets:write_all`
- active request type count is high enough
- required portal request types exist
- descriptions are strong enough
- keywords are strong enough

## The Two Safe Flows

## Flow A: Fresh Rebuild

Use this when you want to fully rebuild the example tenant from scratch.

### Local

Preferred local command:

```bash
pnpm db:reset:centralised-example-data
```

That does:

1. `supabase db reset`
2. runs all migrations in numeric order
3. runs the generator script

If you are not using the CLI locally, you must manually reproduce the same order:

1. apply all migrations in `supabase/migrations` in numeric order
2. reload schema
3. run the generator

### Remote / Hosted Supabase

Apply every pending migration in numeric order with `psql`.

Example shape:

```bash
export PGPASSWORD="$SUPABASE_DB_PASS"
export REMOTE_DB="postgresql://postgres@db.<project-ref>.supabase.co:5432/postgres?sslmode=require"

psql "$REMOTE_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/00099_criteria_sets_org_support.sql
psql "$REMOTE_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/00100_seed_centralised_example_reset.sql
psql "$REMOTE_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/00102_seed_centralised_example_foundation.sql
psql "$REMOTE_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/00104_seed_centralised_example_catalog.sql
psql "$REMOTE_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/00105_centralised_example_catalog_enrichment.sql
psql "$REMOTE_DB" -c "notify pgrst, 'reload schema';"
```

Then run the generator:

```bash
ALLOW_REMOTE_DEMO_SEED=true \
SUPABASE_URL="https://<project-ref>.supabase.co" \
SUPABASE_SECRET_KEY="<service-role-secret>" \
node apps/api/scripts/centralised-example-data-seed.mjs
```

Do not swap the order.

## Flow B: Upgrade An Already-Seeded Tenant

Use this when the tenant already exists and you want to improve or extend it without wiping everything.

This is the safer default for the hosted project.

### Order

1. Add any missing runtime/schema migration
2. Add a forward seed enrichment migration
3. Apply those migrations remotely
4. Reload schema
5. Rerun the generator only if the change affects generated/auth/history data

Example:

- add `00105_centralised_example_catalog_enrichment.sql`
- apply it remotely
- reload schema
- rerun generator only if the script depends on the new request types

## How To Create A New Example-Data Implementation Safely

If you are building a new implementation variant, follow this structure.

### Step 1: Decide what belongs in SQL and what belongs in the script

Put in SQL:

- deterministic relational data
- categories
- request types
- coverage
- audience
- routing defaults
- workflows
- SLAs
- vendors
- fixed named people

Put in the script:

- auth users
- bulk generated people
- generated assets
- historical ticket activity

### Step 2: Create migrations in this shape

Use separate forward migrations:

1. `..._reset.sql`
2. `..._foundation.sql`
3. `..._catalog.sql`
4. `..._enrichment.sql` as needed later

Do not compress everything into one giant mutable file.

### Step 3: Make the base seed self-sufficient

A fresh rebuild must work with:

- runtime/schema migrations
- base seed SQL
- generator

It should not require manual hotfixes afterwards.

### Step 4: Add guardrails immediately

If the implementation has invariants, encode them in the script.

Examples:

- minimum request type count
- required named request types
- required admin permissions
- no weak descriptions
- no missing category bindings

### Step 5: Add upgrade migrations for already-running tenants

If a tenant may already exist remotely, add a forward enrichment migration instead of assuming a wipe.

This is how you avoid “works on reset, breaks on remote”.

## Verification Checklist

Run these checks after applying the chain.

### 1. Critical SQL functions exist and are current

Examples:

```sql
select proname
from pg_proc
where proname in (
  'criteria_matches',
  'request_type_visible_ids',
  'request_type_requestable_trace'
);
```

### 2. Admin role has required permissions

```sql
select name, permissions
from public.roles
where tenant_id = '00000000-0000-0000-0000-000000000001'
  and lower(name) = 'admin';
```

Expected:

- contains `tickets:read_all`
- contains `tickets:write_all`

### 3. Request type count is sane

```sql
select count(*)
from public.request_types
where tenant_id = '00000000-0000-0000-0000-000000000001'
  and active = true;
```

For the current centralised example, this should not be below `40`.

### 4. Portal visibility works for Thomas

```sql
select count(*)
from public.request_type_visible_ids(
  '95000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001'
);
```

This must return rows, not error.

### 5. Generator completes without guardrail failure

If the generator exits with a guardrail error, do not ignore it.

That means the chain is incomplete or the seed is inconsistent.

## Common Failure Modes

### Failure: Portal catalog 500 for admin or Thomas

Usually means:

- old criteria function still on remote
- audience rules depend on newer org-aware logic

Fix:

- apply missing runtime/schema migration first

### Failure: Tickets load for agents but fail for admin

Usually means:

- admin role missing `tickets:read_all`

Fix:

- repair seed foundation migration
- update remote role row if already seeded

### Failure: Fresh reset looks good, remote still broken

Usually means:

- local reset ran full chain
- remote only got some seed files
- runtime migration was skipped

Fix:

- diff the actual remote-applied migration chain
- apply missing runtime migrations before rerunning generator

### Failure: Portal looks thin after reseed

Usually means:

- request types were added only to the script assumptions, not the SQL seed
- or old seed SQL was never enriched

Fix:

- update base catalog seed
- add forward enrichment migration for already-seeded tenants
- rerun generator if it references the new request types

## Minimum Release Discipline

Before saying a new example-data implementation is done:

1. Fresh rebuild passes
2. Upgrade path passes
3. Hosted project has the same runtime/schema chain
4. Generator passes guardrails
5. Portal login for Thomas works
6. Portal catalog is populated and readable

If any of those fail, the implementation is not finished.

## Current Recommended Commands

### Fresh local rebuild

```bash
pnpm db:reset:centralised-example-data
```

### Generator only

```bash
pnpm seed:centralised-example-data
```

Use generator-only only when the schema and seed SQL are already correct.

### Hosted migration apply with psql

```bash
export PGPASSWORD="$SUPABASE_DB_PASS"
export REMOTE_DB="postgresql://postgres@db.<project-ref>.supabase.co:5432/postgres?sslmode=require"

psql "$REMOTE_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/<migration-file>.sql
psql "$REMOTE_DB" -c "notify pgrst, 'reload schema';"
```

### Hosted generator run

```bash
ALLOW_REMOTE_DEMO_SEED=true \
SUPABASE_URL="https://<project-ref>.supabase.co" \
SUPABASE_SECRET_KEY="<service-role-secret>" \
node apps/api/scripts/centralised-example-data-seed.mjs
```

## Final Rule

Do not think in terms of “run the seed”.

Think in terms of:

- migrate runtime
- migrate seed structure
- reload schema
- generate dynamic data
- verify

That is the proper chain.
