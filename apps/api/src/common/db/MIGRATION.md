# Migrating from Supabase REST → DbService

`DbService` is a direct Postgres pool that bypasses the Supabase REST hop
(saves ~70–90 ms per call). Use it for **hot paths** and **bulk
operations** where REST overhead dominates the budget.

Keep `SupabaseService` for: Auth, Storage, Realtime, anything that needs
the user's JWT for RLS, and cold paths where the REST overhead is
irrelevant.

## Quick reference — the four common patterns

### 1. RPC calls (functions that return jsonb / scalar)

```ts
// Before
const { data, error } = await this.supabase.admin.rpc('scheduler_data', {
  p_tenant_id: tenantId,
  p_start_at: startAt,
});
if (error) throw error;
const result = data;

// After
const result = await this.db.rpc<SchedulerData>('scheduler_data', {
  p_tenant_id: tenantId,
  p_start_at: startAt,
});
```

### 2. Single-row read (`maybeSingle`)

```ts
// Before
const { data, error } = await this.supabase.admin
  .from('users')
  .select('id, person_id')
  .eq('tenant_id', tenantId)
  .eq('auth_uid', authUid)
  .maybeSingle();
if (error) throw error;

// After
const data = await this.db.queryOne<{ id: string; person_id: string | null }>(
  `select id, person_id
     from public.users
    where tenant_id = $1 and auth_uid = $2
    limit 1`,
  [tenantId, authUid],
);
```

### 3. Multi-row read

```ts
// Before
const { data, error } = await this.supabase.admin
  .from('reservations')
  .select('*')
  .eq('tenant_id', tenantId)
  .in('status', ['confirmed', 'checked_in'])
  .lt('start_at', cutoff);
if (error) throw error;
const rows = data ?? [];

// After
const rows = await this.db.queryMany<Reservation>(
  `select *
     from public.reservations
    where tenant_id = $1
      and status = any($2::text[])
      and start_at < $3`,
  [tenantId, ['confirmed', 'checked_in'], cutoff],
);
```

Notes:
- For `IN`, prefer `= any($n::text[])` (or `::uuid[]`, `::int[]`). Pass a
  JS array as the parameter — node-postgres encodes it correctly.
- For `is null`, use `is null` directly (not a parameter). For nullable
  filters, use `coalesce` or `($n::uuid is null or column = $n)`.

### 4. Insert / update with `returning *`

```ts
// Before
const { data, error } = await this.supabase.admin
  .from('reservations')
  .update({ status: 'cancelled' })
  .eq('tenant_id', tenantId)
  .eq('id', id)
  .select('*')
  .single();
if (error) throw error;

// After
const data = await this.db.queryOne<Reservation>(
  `update public.reservations
      set status = $3
    where tenant_id = $1 and id = $2
    returning *`,
  [tenantId, id, 'cancelled'],
);
if (!data) throw new NotFoundException();
```

## Bulk inserts — use a single round-trip

The biggest performance win comes from batching. `pg` accepts arrays
that map to `unnest`, letting you insert N rows in one query:

```ts
const ids = rows.map((r) => r.id);
const titles = rows.map((r) => r.title);

await this.db.query(
  `insert into public.notifications (id, title)
   select * from unnest($1::uuid[], $2::text[])`,
  [ids, titles],
);
```

Replaces N sequential REST calls with one round-trip. For a 100-row
insert, expect ~10 ms instead of ~10 s.

## Transactions

```ts
await this.db.tx(async (client) => {
  await client.query('insert into a ...', [...]);
  await client.query('update b ...', [...]);
  // Commits if the callback resolves, rolls back on throw.
});
```

Issue every query inside the transaction through `client` — not
`this.db.query`, which would grab a different connection from the pool.

## Tenant scoping — still your job

`DbService` does not enforce RLS (same as `supabase.admin` today). Every
query MUST have `tenant_id = $N` in the WHERE clause, and every insert
must populate `tenant_id`. The same review checklist applies.

## When NOT to migrate

- Anything using a user-scoped Supabase client (`forUser(jwt)`) — RLS is
  the whole point.
- Storage, Realtime, Edge Functions — no PG equivalent in this service.
- Cold paths used once per session: the migration cost outweighs the win.

## How to validate a migration

1. Typecheck passes (`pnpm --filter @prequest/api exec tsc --noEmit`).
2. Affected jest specs pass.
3. Smoke-test the endpoint locally against the running API.
4. Check the controller's elapsed-ms log line drops by ~70–90 ms.
