# Cell-based multi-tenancy — readiness audit & plan

**Status:** designed-for, not built. No action required today.
**Last reviewed:** 2026-04-30
**Owner:** platform / infra

## Why this doc exists

Prequest is multi-tenant by default — one shared Supabase project, one shared
NestJS API, RLS for isolation. That's the right shape today: 26 of 30 target
tenants are small, the per-tenant isolation cost would dwarf the cloud savings,
and we already have the foundations (`tenant_id` everywhere, RLS, AsyncLocalStorage
context propagation, GDPR baseline shipped).

But the 4 large tenants (5000 users · 20 locations · ~100 tickets/day ·
~300 reservations/day each) plus future enterprise prospects will eventually
push on three fronts that single-cell multi-tenancy can't fully answer:

1. **Data residency** — "where physically does our data live, and only ours?"
2. **Noisy-neighbor risk** — one tenant's hot scheduler view shouldn't degrade
   the rest of the pool.
3. **Blast radius** — one bad migration / RLS regression shouldn't take all
   30 tenants down at once.

The mature answer for SaaS at this scale is **cell-based architecture**: the
current shared deployment is "cell A", and the tenant directory can route any
tenant to a different cell when it's worth doing. We don't run a second cell
today, but every architectural decision should leave that door open.

This doc is the contract for keeping that door open.

## What's already in place ✅

| Seam | Where |
|---|---|
| Tenant directory aware of cells | `apps/api/src/common/tenant-context.ts` — `TenantInfo` carries `tier: 'standard' \| 'enterprise'` and `db_connection?: string`. |
| Edge tenant resolution | `apps/api/src/common/middleware/tenant.middleware.ts` — header → subdomain → fallback, runs request inside `AsyncLocalStorage`. |
| `tenant_id` on every business table + RLS | All migrations under `supabase/migrations/`. ~395 references to `TenantContext.current()` across modules. |
| No cross-tenant joins in product code | RLS predicates would crash anything that tried; discipline holds. |
| Tenant-scoped storage paths | `${tenant.id}/avatar/...`, `${tenant.id}/tickets/...`, `pdfStoragePath()` in `daily-list.service.ts`, and similar across `portal`, `service-catalog`, `portal-appearance`, `privacy-compliance`. |

## What's missing 🔴

These are the gaps to fix *only when triggered* — see triggers below. Listed
in order of "cheap to retrofit later" to "expensive to retrofit later."

### 1. Realtime channels not tenant-prefixed (cheap, do early)

Channels today: `bundle-lines:${bundleId}`, `desk-scheduler:${hash}`,
`portal-picker:${spaceIds}` — see `apps/web/src/components/booking-detail/use-realtime-bundle.ts`,
`apps/web/src/pages/desk/scheduler/hooks/use-realtime-scheduler.ts`,
`apps/web/src/pages/portal/book-room/hooks/use-realtime-availability.ts`.

UUIDs make collisions improbable, but a future bug that broadcasts a payload
to the wrong channel name has zero isolation. Should be:

```ts
.channel(`tenant:${tenantId}:bundle-lines:${bundleId}`)
```

### 2. `SupabaseService` is a single client, not a factory

`apps/api/src/common/supabase/supabase.service.ts` builds one admin client
from one `SUPABASE_URL` at `onModuleInit`. There's no path today to route
tenant A to one Supabase project and tenant B to another, even though
`TenantInfo.db_connection` was clearly designed to enable it.

Future shape:

```ts
@Injectable()
export class SupabaseService {
  private clientsByCellId = new Map<string, SupabaseClient>();

  getAdmin(tenant?: TenantInfo): SupabaseClient {
    const cellId = this.resolveCell(tenant ?? TenantContext.current());
    return this.clientsByCellId.get(cellId) ?? this.buildClient(cellId);
  }
}
```

Migrate callers gradually: introduce `getAdmin(tenant)` that today returns
the same singleton, then over time replace direct `.admin` access at the
call sites. Most of the work is mechanical.

### 3. Migrations script assumes one DB

`pnpm db:push` is literally `supabase db push` — single Supabase project link.
Per-cell migrations would need:

- A cell registry file (`infra/cells.json` or similar) listing each cell's
  Supabase project ref + DB connection.
- A wrapper script that loops `supabase db push --project-ref <ref>` per cell.
- An `applied_migrations` audit per cell so partial failures are recoverable.

Not hard to write — but writing it under deadline pressure is much worse than
writing it ahead.

### 4. Background workers are global, not tenant-sharded 🔴 biggest gap

Every `@Cron` runs across all tenants in one process from one Node instance:

| File | Cron | Scope |
|---|---|---|
| `apps/api/src/modules/sla/sla.service.ts` | every minute | all tenants' timers |
| `apps/api/src/modules/daily-list/daily-list-scheduler.service.ts` | every 5 min | all tenants |
| `apps/api/src/modules/daily-list/status-inference.service.ts` | every 5 min | all tenants |
| `apps/api/src/modules/reservations/check-in.service.ts` | every 5 min | all tenants — comment literally says *"single-instance assumed at this scale"* |
| `apps/api/src/modules/reservations/booking-notifications.service.ts` | every 5 min | all tenants |
| `apps/api/src/modules/reservations/recurrence.service.ts` | daily 03:00 | all tenants |
| `apps/api/src/modules/calendar-sync/*.service.ts` | hourly | all tenants |
| `apps/api/src/modules/privacy-compliance/audit-outbox.worker.ts` | every 30s | all tenants |
| `apps/api/src/modules/privacy-compliance/retention.worker.ts` | daily | all tenants |
| `apps/api/src/modules/webhook/webhook-event.service.ts` | daily | all tenants |

A hot tenant slows everyone. Future shape: cron tick enumerates active cells
+ tenants and either dispatches per-tenant work to a queue (BullMQ / Inngest /
Supabase Queues) or shards by `tenant_id % N`.

### 5. No queue layer yet — when one is added, namespace from day one

There's no BullMQ / Redis queue today. Every async path is in-process `@Cron`.
When the first queue is introduced (likely as part of the GDPR audit-outbox
hardening, MS Graph integration, or notification delivery), job names MUST
include `tenant_id`:

```
tenant:<tenant_id>:audit-outbox:flush
tenant:<tenant_id>:graph-sync:user-batch
```

Not `audit-outbox:flush` with `tenant_id` in the payload. The name is the
isolation boundary the queue infrastructure operates on.

## Cheap wins — do these whenever it's convenient

These are reversible 30-min changes that prevent a class of bugs without
locking in any infrastructure. None require committing to a second cell.

- [ ] Prefix all Realtime channel names with `tenant:${tenant.id}:` (3 hooks
      in web, ~30 min).
- [ ] Add `SupabaseService.getAdmin(tenant?: TenantInfo)` that today returns
      the same singleton but is the future seam. Migrate hot-path callers to
      use it; leave cold paths on `.admin` until convenient.
- [ ] When the first queue ships, namespace job names by `tenant_id` (one-line
      decision at the start; very expensive to change once jobs are running).
- [ ] When adding a new `@Cron`, default to passing a tenant filter into the
      query, even if today the filter is "all tenants in cell A". Cheaper than
      retrofitting a global query into a sharded one later.

## Triggers to actually build cell B

Don't pre-split. Don't even spin up cell B for testing until one of these
fires. Each is a signal you'd notice — none are invisible.

1. **Single tenant > ~30% of total DB load** (read or write). Their workload
   is dominating the shared pool's sizing decisions and you're paying for
   their headroom across the other 29 tenants.
2. **Contractual data-residency or isolation requirement** that logical
   isolation (RLS in a single Supabase project) demonstrably can't satisfy.
   Most procurement teams accept logical isolation if you can articulate the
   controls; some won't.
3. **Compliance scope creep** — one tenant pulls HIPAA / SOC 2 Type II /
   IRAP / sector-specific requirements that would force the whole platform up
   to that bar unnecessarily. Easier to scope a dedicated cell to that bar
   than to lift the whole platform.
4. **Sustained scheduler / list query latency > 300ms p95** that indexes can't
   fix. At that point the shared pool is the bottleneck and a second cell
   for the heaviest tenant gives you breathing room while you re-architect.

## What "build cell B" actually means

When the trigger fires, the work is — in rough order:

1. Decide cell topology: separate Supabase project per cell vs separate
   schema/role per cell on the same project. Strongly prefer separate project
   for residency / blast radius reasons.
2. Stand up cell B (Supabase + Render service or shared API connecting to
   both cells via the factory built in §2 above).
3. Implement the per-cell migration runner (§3 above).
4. Implement tenant move tooling (export tenant from cell A, import into cell
   B, swap directory entry, smoke). The hardest single piece — start it
   *before* you need it once the trigger has fired.
5. Audit every `@Cron` for tenant filtering (§4 above).
6. Audit Realtime + storage path / queue naming for cell-aware paths (§1, §5).
7. Update `vercel.json` / Render config so the API can talk to N Supabase
   projects, not 1.

Estimated cost: 4–8 weeks of one engineer, depending on how much of the
"cheap wins" list above has already been done by then.

## Decision log

- **2026-04-30** — Audit confirmed: schema and middleware are cell-aware, but
  the runtime (single `SupabaseService` client, single `db:push`, global
  `@Cron`s) assumes one cell. No action taken; doc captures plan for when a
  trigger fires. Cheap wins (Realtime channel naming, `getAdmin(tenant)`)
  flagged as do-when-convenient.

## Non-goals

- Building a second cell speculatively. Real infra cost, no payoff yet.
- Migrating any current tenant to a dedicated cell before a trigger fires.
- Replacing Supabase. The cell model is compatible with Supabase-per-cell.
