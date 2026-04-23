# Supabase SQL tests

Integration-style SQL fixtures that exercise DB-level logic that a TS unit
test can't easily reach (precedence walks, CHECK constraint interactions,
trigger chains). Each file is a self-contained plpgsql script that:

1. Clears any stale state for a fixed test tenant (UUIDs prefixed with `ffff…`)
2. Seeds fixtures
3. Asserts expected behavior with `raise exception`
4. Tears down the test tenant

Run a file locally:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -v ON_ERROR_STOP=1 \
  -f supabase/tests/<file>.sql
```

Run against remote (ad-hoc; prefer local):

```bash
PGPASSWORD="$(grep -E '^SUPABASE_DB_PASS=' .env | cut -d= -f2-)" \
  psql "postgresql://postgres@db.<ref>.supabase.co:5432/postgres" \
  -v ON_ERROR_STOP=1 \
  -f supabase/tests/<file>.sql
```

These files are NOT migrations — the Supabase CLI never picks them up. They
are also not wired into CI today; run them manually after touching a
function/trigger/RPC they cover.

## Current tests

- `scope_override_precedence.test.sql` — 8 cases covering live-doc §6.3
  precedence (exact_space > ancestor_space (inherit) > space_group > tenant)
  plus null-space, disjoint space, inherit=false, and all-inactive paths for
  `public.request_type_effective_scope_override`.
