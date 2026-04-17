# Routing Foundation (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rigid single-rule routing engine with a fulfillment-shape-driven resolver chain that handles asset-bound, location-bound, and context-free tickets, and records every routing decision in an auditable trace.

**Architecture:** Each `request_types` row declares a *fulfillment shape* (`asset` | `location` | `fixed` | `auto`) plus capture flags (asset/location required or optional). A new `ResolverService` runs an ordered candidate chain per shape — asset.override_team → asset_type.default_team → location_teams(domain) → walk parent locations → request_type.default_team → domain default → unassigned. Admin-written `routing_rules` run *first* as overrides; the chain is the fallback so tickets always land somewhere. Every attempt (match or skip) is written to a new `routing_decisions` table for debugging, analytics, and "why did it route here?" questions.

**Tech Stack:** NestJS (TypeScript), Supabase/PostgreSQL, Jest (API unit tests), React 19 + Vite + Tailwind + shadcn/ui (portal form).

**Scope boundary (explicit non-goals for this plan):** Approval gates, SLA pause conditions, reassignment semantics, vendor offer/accept, contract-aware SLA, skill-based routing, auto-assign within team, shift rosters. All deferred to later plans.

---

## File Structure

### Database
- Create: `supabase/migrations/00027_routing_foundation.sql` — schema for fulfillment shape, asset overrides, location_teams, routing_decisions, tickets.assigned_vendor_id.

### API (NestJS)
- Create: `apps/api/src/modules/routing/resolver.service.ts` — strategy-chain resolver. Pure logic given a loaded context; does not query Supabase directly (repository is passed in).
- Create: `apps/api/src/modules/routing/resolver.types.ts` — shared types: `FulfillmentShape`, `ResolverContext`, `ResolverCandidate`, `ResolverDecision`, `ResolverTrace`.
- Create: `apps/api/src/modules/routing/resolver.service.spec.ts` — Jest unit tests for each strategy.
- Create: `apps/api/src/modules/routing/resolver-repository.ts` — thin wrapper around Supabase queries the resolver needs (load asset + type, load location chain, load location_teams, etc.). Enables test stubbing.
- Modify: `apps/api/src/modules/routing/routing.service.ts` — extend `evaluate()` to (a) run existing rule-based override first, (b) on miss, delegate to `ResolverService`, (c) persist a `routing_decisions` row either way.
- Modify: `apps/api/src/modules/routing/routing.module.ts` — register `ResolverService` + `ResolverRepository`.
- Modify: `apps/api/src/modules/ticket/ticket.service.ts:147-220` — pass `asset_id`/`asset_type_id`/derived location to routing; use new resolver decision.
- Modify: `apps/api/src/modules/config-engine/service-catalog.service.ts` — expose new request-type fulfillment fields via admin API (DTO + select list).
- Modify: `apps/api/src/modules/config-engine/service-catalog.controller.ts` — accept new fields on create/update.

### Web (portal + admin)
- Create: `apps/web/src/components/asset-combobox.tsx` — reusable asset picker, prop-driven (filter by asset_type_filter, default to requester's location).
- Create: `apps/web/src/components/location-combobox.tsx` — reusable location picker (spaces of type site/building/floor/room).
- Modify: `apps/web/src/pages/portal/submit-request.tsx` — reactive form: after request-type select, fetch its fulfillment shape and show asset/location fields accordingly. Auto-derive location from asset when asset is attached.
- Modify: `apps/web/src/components/desk/create-ticket-dialog.tsx` — same dynamic fields for agent-created tickets.
- Modify: `apps/web/src/pages/admin/request-types.tsx` — add fulfillment-shape config section (dropdown + checkboxes + default team + asset type filter).

### Docs
- Modify: `CLAUDE.md` — add a "Routing model" section pointing readers at `ResolverService` + the fulfillment-shape concept.

---

## Pre-flight

- [ ] **Step 0: Verify clean working state**

Run: `git status`

Expected: either a clean tree OR user has confirmed they're okay with changes landing alongside their uncommitted work. If dirty, ask the user to commit or stash before starting.

---

## Task 1: Schema migration

**Files:**
- Create: `supabase/migrations/00027_routing_foundation.sql`

- [ ] **Step 1.1: Write the migration**

```sql
-- 00027_routing_foundation.sql
-- Routing foundation: fulfillment shape, asset/location team linkage, audit log

-- ── 1. Request type fulfillment shape ─────────────────────────
alter table public.request_types
  add column if not exists fulfillment_strategy text not null default 'fixed'
    check (fulfillment_strategy in ('asset', 'location', 'fixed', 'auto')),
  add column if not exists requires_asset boolean not null default false,
  add column if not exists asset_required boolean not null default false,
  add column if not exists asset_type_filter uuid[] not null default '{}',
  add column if not exists requires_location boolean not null default false,
  add column if not exists location_required boolean not null default false,
  add column if not exists default_team_id uuid references public.teams(id),
  add column if not exists default_vendor_id uuid references public.vendors(id);

-- ── 2. Asset-type class defaults ──────────────────────────────
alter table public.asset_types
  add column if not exists default_team_id uuid references public.teams(id),
  add column if not exists default_vendor_id uuid references public.vendors(id);

-- ── 3. Per-asset overrides (site-specific exceptions) ─────────
alter table public.assets
  add column if not exists override_team_id uuid references public.teams(id),
  add column if not exists override_vendor_id uuid references public.vendors(id);

-- ── 4. Location ↔ domain ↔ team mapping ───────────────────────
create table if not exists public.location_teams (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  space_id uuid not null references public.spaces(id) on delete cascade,
  domain text not null,
  team_id uuid references public.teams(id),
  vendor_id uuid references public.vendors(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (space_id, domain),
  check (team_id is not null or vendor_id is not null)
);

alter table public.location_teams enable row level security;
create policy "tenant_isolation" on public.location_teams
  using (tenant_id = public.current_tenant_id());

create index idx_location_teams_tenant on public.location_teams (tenant_id);
create index idx_location_teams_space_domain on public.location_teams (space_id, domain);

create trigger set_location_teams_updated_at before update on public.location_teams
  for each row execute function public.set_updated_at();

-- ── 5. Tickets can be assigned to a vendor (not just team/user) ─
alter table public.tickets
  add column if not exists assigned_vendor_id uuid references public.vendors(id);

create index if not exists idx_tickets_assigned_vendor on public.tickets (assigned_vendor_id);

-- ── 6. Routing decision audit log ─────────────────────────────
create table if not exists public.routing_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  decided_at timestamptz not null default now(),
  strategy text not null,
  -- chosen assignee (at most one populated)
  chosen_team_id uuid references public.teams(id),
  chosen_user_id uuid references public.users(id),
  chosen_vendor_id uuid references public.vendors(id),
  chosen_by text not null, -- 'rule' | 'asset_override' | 'asset_type_default' | 'location_team' | 'parent_location_team' | 'request_type_default' | 'domain_default' | 'unassigned'
  rule_id uuid references public.routing_rules(id),
  -- full trace: ordered list of candidates tried
  trace jsonb not null default '[]'::jsonb,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.routing_decisions enable row level security;
create policy "tenant_isolation" on public.routing_decisions
  using (tenant_id = public.current_tenant_id());

create index idx_routing_decisions_tenant_ticket on public.routing_decisions (tenant_id, ticket_id);
create index idx_routing_decisions_chosen_by on public.routing_decisions (tenant_id, chosen_by);
```

- [ ] **Step 1.2: Apply locally to verify SQL**

Run: `pnpm db:reset`

Expected: completes without error. All tables created.

- [ ] **Step 1.3: Smoke check the schema**

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\d public.request_types" | grep fulfillment_strategy
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\d public.location_teams"
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\d public.routing_decisions"
```

Expected: shows the new columns and tables.

- [ ] **Step 1.4: Ask the user whether to push to remote**

**DO NOT run `pnpm db:push` without explicit confirmation.** Display the migration filename and remind the user per CLAUDE.md that this writes to the shared remote project. Wait for "yes, push" before proceeding.

On confirmation, run: `pnpm db:push` (or fallback to the psql path in CLAUDE.md).

Then: `psql "$REMOTE_URL" -c "notify pgrst, 'reload schema';"`

- [ ] **Step 1.5: Commit**

```bash
git add supabase/migrations/00027_routing_foundation.sql
git commit -m "feat(schema): routing foundation - fulfillment shape, location_teams, routing_decisions"
```

---

## Task 2: Resolver types

**Files:**
- Create: `apps/api/src/modules/routing/resolver.types.ts`

- [ ] **Step 2.1: Define shared types**

```ts
// apps/api/src/modules/routing/resolver.types.ts

export type FulfillmentShape = 'asset' | 'location' | 'fixed' | 'auto';

export type AssignmentTarget =
  | { kind: 'team'; team_id: string }
  | { kind: 'user'; user_id: string }
  | { kind: 'vendor'; vendor_id: string };

export type ChosenBy =
  | 'rule'
  | 'asset_override'
  | 'asset_type_default'
  | 'location_team'
  | 'parent_location_team'
  | 'request_type_default'
  | 'domain_default'
  | 'unassigned';

export interface ResolverContext {
  tenant_id: string;
  ticket_id: string;
  request_type_id: string | null;
  domain: string | null;
  priority: string | null;
  asset_id: string | null;
  location_id: string | null;
  // Loaded lazily by the repository and cached on the context
  loaded?: {
    request_type?: LoadedRequestType | null;
    asset?: LoadedAsset | null;
    location_chain?: string[]; // [space_id, parent_id, grandparent_id, ...]
  };
}

export interface LoadedRequestType {
  id: string;
  domain: string | null;
  fulfillment_strategy: FulfillmentShape;
  default_team_id: string | null;
  default_vendor_id: string | null;
  asset_type_filter: string[];
}

export interface LoadedAsset {
  id: string;
  asset_type_id: string;
  assigned_space_id: string | null;
  override_team_id: string | null;
  override_vendor_id: string | null;
  type: {
    id: string;
    default_team_id: string | null;
    default_vendor_id: string | null;
  };
}

export interface TraceEntry {
  step: ChosenBy;
  matched: boolean;
  reason: string;
  target: AssignmentTarget | null;
}

export interface ResolverDecision {
  target: AssignmentTarget | null;
  chosen_by: ChosenBy;
  strategy: FulfillmentShape | 'rule';
  rule_id?: string | null;
  trace: TraceEntry[];
}
```

- [ ] **Step 2.2: Commit**

```bash
git add apps/api/src/modules/routing/resolver.types.ts
git commit -m "feat(routing): add resolver type definitions"
```

---

## Task 3: Resolver repository

**Files:**
- Create: `apps/api/src/modules/routing/resolver-repository.ts`

- [ ] **Step 3.1: Implement repository**

```ts
// apps/api/src/modules/routing/resolver-repository.ts
import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { LoadedAsset, LoadedRequestType } from './resolver.types';

@Injectable()
export class ResolverRepository {
  constructor(private readonly supabase: SupabaseService) {}

  async loadRequestType(id: string): Promise<LoadedRequestType | null> {
    const { data } = await this.supabase.admin
      .from('request_types')
      .select('id, domain, fulfillment_strategy, default_team_id, default_vendor_id, asset_type_filter')
      .eq('id', id)
      .maybeSingle();
    return (data as LoadedRequestType | null) ?? null;
  }

  async loadAsset(id: string): Promise<LoadedAsset | null> {
    const { data } = await this.supabase.admin
      .from('assets')
      .select(`
        id, asset_type_id, assigned_space_id, override_team_id, override_vendor_id,
        type:asset_types!assets_asset_type_id_fkey(id, default_team_id, default_vendor_id)
      `)
      .eq('id', id)
      .maybeSingle();
    if (!data) return null;
    // Supabase returns `type` as an array for joins even on 1:1 — normalize
    const type = Array.isArray((data as any).type) ? (data as any).type[0] : (data as any).type;
    return { ...(data as any), type } as LoadedAsset;
  }

  /** Walks up the space tree starting at spaceId, returning [spaceId, parent, grandparent, ...]. */
  async locationChain(spaceId: string): Promise<string[]> {
    const chain: string[] = [];
    let current: string | null = spaceId;
    // Bound the walk to prevent infinite loops on bad data
    for (let i = 0; current && i < 10; i++) {
      chain.push(current);
      const { data } = await this.supabase.admin
        .from('spaces')
        .select('parent_id')
        .eq('id', current)
        .maybeSingle();
      current = (data?.parent_id as string | null) ?? null;
    }
    return chain;
  }

  async locationTeam(spaceId: string, domain: string): Promise<{ team_id: string | null; vendor_id: string | null } | null> {
    const { data } = await this.supabase.admin
      .from('location_teams')
      .select('team_id, vendor_id')
      .eq('space_id', spaceId)
      .eq('domain', domain)
      .maybeSingle();
    return data as { team_id: string | null; vendor_id: string | null } | null;
  }
}
```

- [ ] **Step 3.2: Commit**

```bash
git add apps/api/src/modules/routing/resolver-repository.ts
git commit -m "feat(routing): resolver repository for loading context"
```

---

## Task 4: Resolver service — scaffold + unassigned fallback test

**Files:**
- Create: `apps/api/src/modules/routing/resolver.service.ts`
- Create: `apps/api/src/modules/routing/resolver.service.spec.ts`

- [ ] **Step 4.1: Write failing test for empty context → unassigned**

```ts
// apps/api/src/modules/routing/resolver.service.spec.ts
import { ResolverService } from './resolver.service';
import { ResolverContext } from './resolver.types';

function stubRepo(overrides: Partial<any> = {}) {
  return {
    loadRequestType: jest.fn().mockResolvedValue(null),
    loadAsset: jest.fn().mockResolvedValue(null),
    locationChain: jest.fn().mockResolvedValue([]),
    locationTeam: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function ctx(over: Partial<ResolverContext> = {}): ResolverContext {
  return {
    tenant_id: 't1',
    ticket_id: 'tk1',
    request_type_id: null,
    domain: null,
    priority: 'medium',
    asset_id: null,
    location_id: null,
    ...over,
  };
}

describe('ResolverService', () => {
  it('returns unassigned when no context and no fallbacks', async () => {
    const svc = new ResolverService(stubRepo() as any);
    const decision = await svc.resolve(ctx());
    expect(decision.target).toBeNull();
    expect(decision.chosen_by).toBe('unassigned');
    expect(decision.trace.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4.2: Run test, expect FAIL (service not implemented)**

Run: `cd apps/api && pnpm jest resolver.service.spec --no-coverage`

Expected: FAIL with "Cannot find module './resolver.service'".

- [ ] **Step 4.3: Implement minimal scaffold**

```ts
// apps/api/src/modules/routing/resolver.service.ts
import { Injectable } from '@nestjs/common';
import { ResolverRepository } from './resolver-repository';
import {
  AssignmentTarget,
  ChosenBy,
  FulfillmentShape,
  ResolverContext,
  ResolverDecision,
  TraceEntry,
} from './resolver.types';

@Injectable()
export class ResolverService {
  constructor(private readonly repo: ResolverRepository) {}

  async resolve(context: ResolverContext): Promise<ResolverDecision> {
    const trace: TraceEntry[] = [];
    const loaded = await this.hydrate(context);
    const shape: FulfillmentShape = loaded.request_type?.fulfillment_strategy ?? 'fixed';

    const attempt = async (
      step: ChosenBy,
      fn: () => AssignmentTarget | null | Promise<AssignmentTarget | null>,
      reason: string,
    ): Promise<AssignmentTarget | null> => {
      const target = await fn();
      trace.push({ step, matched: !!target, reason, target });
      return target ?? null;
    };

    // Everything below will grow in later tasks; for now just exhaust to 'unassigned'
    trace.push({ step: 'unassigned', matched: true, reason: 'no candidates available', target: null });

    return {
      target: null,
      chosen_by: 'unassigned',
      strategy: shape,
      trace,
    };
  }

  private async hydrate(context: ResolverContext) {
    const request_type = context.request_type_id
      ? await this.repo.loadRequestType(context.request_type_id)
      : null;
    const asset = context.asset_id ? await this.repo.loadAsset(context.asset_id) : null;
    // Location may be inferred from the asset if not explicitly provided
    const primaryLocation = context.location_id ?? asset?.assigned_space_id ?? null;
    const location_chain = primaryLocation ? await this.repo.locationChain(primaryLocation) : [];
    context.loaded = { request_type, asset, location_chain };
    return context.loaded;
  }
}
```

- [ ] **Step 4.4: Run test, expect PASS**

Run: `cd apps/api && pnpm jest resolver.service.spec --no-coverage`

Expected: PASS.

- [ ] **Step 4.5: Commit**

```bash
git add apps/api/src/modules/routing/resolver.service.ts apps/api/src/modules/routing/resolver.service.spec.ts
git commit -m "feat(routing): resolver service scaffold with unassigned fallback"
```

---

## Task 5: Asset strategy

**Files:**
- Modify: `apps/api/src/modules/routing/resolver.service.ts`
- Modify: `apps/api/src/modules/routing/resolver.service.spec.ts`

- [ ] **Step 5.1: Write failing tests for asset strategy**

Append to `resolver.service.spec.ts`:

```ts
  describe('asset strategy', () => {
    const baseRT = {
      id: 'rt1',
      domain: 'fm',
      fulfillment_strategy: 'asset' as const,
      default_team_id: 'default-team',
      default_vendor_id: null,
      asset_type_filter: [],
    };

    it('prefers asset override team over everything else', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue(baseRT),
        loadAsset: jest.fn().mockResolvedValue({
          id: 'a1', asset_type_id: 'at1', assigned_space_id: 's1',
          override_team_id: 'override-team', override_vendor_id: null,
          type: { id: 'at1', default_team_id: 'at-team', default_vendor_id: null },
        }),
      });
      const svc = new ResolverService(repo as any);
      const d = await svc.resolve(ctx({ request_type_id: 'rt1', asset_id: 'a1' }));
      expect(d.target).toEqual({ kind: 'team', team_id: 'override-team' });
      expect(d.chosen_by).toBe('asset_override');
    });

    it('falls through to asset type default when no override', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue(baseRT),
        loadAsset: jest.fn().mockResolvedValue({
          id: 'a1', asset_type_id: 'at1', assigned_space_id: 's1',
          override_team_id: null, override_vendor_id: null,
          type: { id: 'at1', default_team_id: 'at-team', default_vendor_id: null },
        }),
      });
      const svc = new ResolverService(repo as any);
      const d = await svc.resolve(ctx({ request_type_id: 'rt1', asset_id: 'a1' }));
      expect(d.target).toEqual({ kind: 'team', team_id: 'at-team' });
      expect(d.chosen_by).toBe('asset_type_default');
    });

    it('uses asset type default VENDOR when team is absent', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue(baseRT),
        loadAsset: jest.fn().mockResolvedValue({
          id: 'a1', asset_type_id: 'at1', assigned_space_id: 's1',
          override_team_id: null, override_vendor_id: null,
          type: { id: 'at1', default_team_id: null, default_vendor_id: 'acme' },
        }),
      });
      const svc = new ResolverService(repo as any);
      const d = await svc.resolve(ctx({ request_type_id: 'rt1', asset_id: 'a1' }));
      expect(d.target).toEqual({ kind: 'vendor', vendor_id: 'acme' });
      expect(d.chosen_by).toBe('asset_type_default');
    });

    it('falls through to request_type default when asset has nothing', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue(baseRT),
        loadAsset: jest.fn().mockResolvedValue({
          id: 'a1', asset_type_id: 'at1', assigned_space_id: null,
          override_team_id: null, override_vendor_id: null,
          type: { id: 'at1', default_team_id: null, default_vendor_id: null },
        }),
      });
      const svc = new ResolverService(repo as any);
      const d = await svc.resolve(ctx({ request_type_id: 'rt1', asset_id: 'a1' }));
      expect(d.target).toEqual({ kind: 'team', team_id: 'default-team' });
      expect(d.chosen_by).toBe('request_type_default');
    });
  });
```

- [ ] **Step 5.2: Run test, expect FAIL**

Run: `cd apps/api && pnpm jest resolver.service.spec --no-coverage`

Expected: 4 new tests FAIL.

- [ ] **Step 5.3: Implement asset strategy in `resolver.service.ts`**

Replace the body of `resolve()`:

```ts
  async resolve(context: ResolverContext): Promise<ResolverDecision> {
    const trace: TraceEntry[] = [];
    const loaded = await this.hydrate(context);
    const shape: FulfillmentShape = loaded.request_type?.fulfillment_strategy ?? 'fixed';

    const record = (step: ChosenBy, target: AssignmentTarget | null, reason: string) => {
      trace.push({ step, matched: !!target, reason, target });
      return target;
    };

    // ── Asset-based candidates (run for 'asset' and 'auto') ─────
    if (shape === 'asset' || shape === 'auto') {
      const asset = loaded.asset;
      if (asset) {
        const override = this.pickTarget(asset.override_team_id, asset.override_vendor_id);
        if (record('asset_override', override, 'asset override')) {
          return this.done(trace, 'asset_override', shape, override!);
        }
        const typeDefault = this.pickTarget(asset.type.default_team_id, asset.type.default_vendor_id);
        if (record('asset_type_default', typeDefault, `asset type ${asset.asset_type_id}`)) {
          return this.done(trace, 'asset_type_default', shape, typeDefault!);
        }
      } else {
        trace.push({ step: 'asset_override', matched: false, reason: 'no asset in context', target: null });
      }
    }

    // ── Request-type default ───────────────────────────────────
    const rt = loaded.request_type;
    if (rt) {
      const rtDefault = this.pickTarget(rt.default_team_id, rt.default_vendor_id);
      if (record('request_type_default', rtDefault, `request type ${rt.id}`)) {
        return this.done(trace, 'request_type_default', shape, rtDefault!);
      }
    }

    // ── Exhausted ──────────────────────────────────────────────
    trace.push({ step: 'unassigned', matched: true, reason: 'no candidates matched', target: null });
    return { target: null, chosen_by: 'unassigned', strategy: shape, trace };
  }

  private pickTarget(team_id: string | null | undefined, vendor_id: string | null | undefined): AssignmentTarget | null {
    if (team_id) return { kind: 'team', team_id };
    if (vendor_id) return { kind: 'vendor', vendor_id };
    return null;
  }

  private done(trace: TraceEntry[], chosen_by: ChosenBy, strategy: FulfillmentShape, target: AssignmentTarget): ResolverDecision {
    return { target, chosen_by, strategy, trace };
  }
```

- [ ] **Step 5.4: Run test, expect PASS**

Run: `cd apps/api && pnpm jest resolver.service.spec --no-coverage`

Expected: all tests PASS.

- [ ] **Step 5.5: Commit**

```bash
git add apps/api/src/modules/routing/resolver.service.ts apps/api/src/modules/routing/resolver.service.spec.ts
git commit -m "feat(routing): asset strategy with override → type default → RT default chain"
```

---

## Task 6: Location strategy + parent walk

**Files:**
- Modify: `apps/api/src/modules/routing/resolver.service.ts`
- Modify: `apps/api/src/modules/routing/resolver.service.spec.ts`

- [ ] **Step 6.1: Write failing tests for location strategy**

Append:

```ts
  describe('location strategy', () => {
    const baseRT = {
      id: 'rt2',
      domain: 'fm',
      fulfillment_strategy: 'location' as const,
      default_team_id: 'fallback-team',
      default_vendor_id: null,
      asset_type_filter: [],
    };

    it('picks location_teams for exact space + domain match', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue(baseRT),
        locationChain: jest.fn().mockResolvedValue(['s1', 'b1']),
        locationTeam: jest.fn(async (sid: string, dom: string) => {
          if (sid === 's1' && dom === 'fm') return { team_id: 'floor-team', vendor_id: null };
          return null;
        }),
      });
      const svc = new ResolverService(repo as any);
      const d = await svc.resolve(ctx({ request_type_id: 'rt2', location_id: 's1', domain: 'fm' }));
      expect(d.target).toEqual({ kind: 'team', team_id: 'floor-team' });
      expect(d.chosen_by).toBe('location_team');
    });

    it('walks up to parent location when floor has no team', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue(baseRT),
        locationChain: jest.fn().mockResolvedValue(['s1', 'b1', 'site1']),
        locationTeam: jest.fn(async (sid: string, dom: string) => {
          if (sid === 'b1' && dom === 'fm') return { team_id: 'building-team', vendor_id: null };
          return null;
        }),
      });
      const svc = new ResolverService(repo as any);
      const d = await svc.resolve(ctx({ request_type_id: 'rt2', location_id: 's1', domain: 'fm' }));
      expect(d.target).toEqual({ kind: 'team', team_id: 'building-team' });
      expect(d.chosen_by).toBe('parent_location_team');
    });

    it('falls back to request-type default when no location team found', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue(baseRT),
        locationChain: jest.fn().mockResolvedValue(['s1']),
        locationTeam: jest.fn().mockResolvedValue(null),
      });
      const svc = new ResolverService(repo as any);
      const d = await svc.resolve(ctx({ request_type_id: 'rt2', location_id: 's1', domain: 'fm' }));
      expect(d.target).toEqual({ kind: 'team', team_id: 'fallback-team' });
      expect(d.chosen_by).toBe('request_type_default');
    });
  });
```

- [ ] **Step 6.2: Run test, expect FAIL**

Run: `cd apps/api && pnpm jest resolver.service.spec --no-coverage`

Expected: 3 new tests FAIL.

- [ ] **Step 6.3: Add location chain to resolver**

In `resolver.service.ts`, insert between the asset block and the request-type-default block:

```ts
    // ── Location-based candidates (run for 'location' and 'auto') ─
    if ((shape === 'location' || shape === 'auto') && loaded.location_chain && context.domain) {
      const chain = loaded.location_chain;
      for (let i = 0; i < chain.length; i++) {
        const spaceId = chain[i];
        const hit = await this.repo.locationTeam(spaceId, context.domain);
        const target = hit ? this.pickTarget(hit.team_id, hit.vendor_id) : null;
        const step: ChosenBy = i === 0 ? 'location_team' : 'parent_location_team';
        if (record(step, target, `space ${spaceId} domain ${context.domain}`)) {
          return this.done(trace, step, shape, target!);
        }
      }
    }
```

- [ ] **Step 6.4: Run test, expect PASS**

Run: `cd apps/api && pnpm jest resolver.service.spec --no-coverage`

Expected: all tests PASS.

- [ ] **Step 6.5: Commit**

```bash
git add apps/api/src/modules/routing/resolver.service.ts apps/api/src/modules/routing/resolver.service.spec.ts
git commit -m "feat(routing): location strategy with parent-walk fallback"
```

---

## Task 7: Auto strategy + domain-default fallback

**Files:**
- Modify: `apps/api/src/modules/routing/resolver.service.ts`
- Modify: `apps/api/src/modules/routing/resolver.service.spec.ts`

- [ ] **Step 7.1: Write failing tests for 'auto' + domain-default**

Append:

```ts
  describe('auto strategy', () => {
    it('tries asset first, falls back to location', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue({
          id: 'rt3', domain: 'fm', fulfillment_strategy: 'auto' as const,
          default_team_id: null, default_vendor_id: null, asset_type_filter: [],
        }),
        loadAsset: jest.fn().mockResolvedValue({
          id: 'a1', asset_type_id: 'at1', assigned_space_id: 's1',
          override_team_id: null, override_vendor_id: null,
          type: { id: 'at1', default_team_id: null, default_vendor_id: null },
        }),
        locationChain: jest.fn().mockResolvedValue(['s1']),
        locationTeam: jest.fn().mockResolvedValue({ team_id: 'loc-team', vendor_id: null }),
      });
      const svc = new ResolverService(repo as any);
      const d = await svc.resolve(ctx({ request_type_id: 'rt3', asset_id: 'a1', domain: 'fm' }));
      expect(d.target).toEqual({ kind: 'team', team_id: 'loc-team' });
      expect(d.chosen_by).toBe('location_team');
    });
  });

  describe('fixed strategy', () => {
    it('uses request-type default team', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue({
          id: 'rt4', domain: 'it', fulfillment_strategy: 'fixed' as const,
          default_team_id: 'it-team', default_vendor_id: null, asset_type_filter: [],
        }),
      });
      const svc = new ResolverService(repo as any);
      const d = await svc.resolve(ctx({ request_type_id: 'rt4', domain: 'it' }));
      expect(d.target).toEqual({ kind: 'team', team_id: 'it-team' });
      expect(d.chosen_by).toBe('request_type_default');
    });
  });
```

- [ ] **Step 7.2: Run test, expect PASS**

(Auto already works because the asset and location branches both activate on `shape === 'auto'`; fixed works because we already fall through to request-type default.)

Run: `cd apps/api && pnpm jest resolver.service.spec --no-coverage`

Expected: all tests PASS. If not, diagnose the branch flag.

- [ ] **Step 7.3: Commit**

```bash
git add apps/api/src/modules/routing/resolver.service.spec.ts
git commit -m "test(routing): auto and fixed strategy coverage"
```

---

## Task 8: Wire ResolverService into RoutingService + decision log

**Files:**
- Modify: `apps/api/src/modules/routing/routing.service.ts`
- Modify: `apps/api/src/modules/routing/routing.module.ts`

- [ ] **Step 8.1: Register new providers in module**

Replace `routing.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { ResolverService } from './resolver.service';
import { ResolverRepository } from './resolver-repository';
import { RoutingRuleController } from './routing.controller';

@Module({
  providers: [RoutingService, ResolverService, ResolverRepository],
  controllers: [RoutingRuleController],
  exports: [RoutingService],
})
export class RoutingModule {}
```

- [ ] **Step 8.2: Extend `RoutingService.evaluate`**

In `routing.service.ts`, add imports and rewrite `evaluate()`. Keep the existing `matchesConditions` helper.

```ts
import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { ResolverService } from './resolver.service';
import { ResolverContext, ResolverDecision, AssignmentTarget } from './resolver.types';

interface RoutingEvaluation {
  target: AssignmentTarget | null;
  chosen_by: ResolverDecision['chosen_by'];
  rule_id: string | null;
  rule_name: string | null;
  strategy: ResolverDecision['strategy'];
  trace: ResolverDecision['trace'];
}

@Injectable()
export class RoutingService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly resolver: ResolverService,
  ) {}

  async evaluate(context: ResolverContext): Promise<RoutingEvaluation> {
    const tenant = TenantContext.current();

    // ── 1. Rule-based overrides (admin-defined) ─────────────────
    const { data: rules } = await this.supabase.admin
      .from('routing_rules')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('priority', { ascending: false });

    for (const rule of rules ?? []) {
      if (this.matchesConditions(rule.conditions, context as unknown as Record<string, unknown>)) {
        const target: AssignmentTarget | null = rule.action_assign_team_id
          ? { kind: 'team', team_id: rule.action_assign_team_id }
          : rule.action_assign_user_id
          ? { kind: 'user', user_id: rule.action_assign_user_id }
          : null;
        return {
          target,
          chosen_by: 'rule',
          rule_id: rule.id,
          rule_name: rule.name,
          strategy: 'rule',
          trace: [{ step: 'rule', matched: true, reason: `rule ${rule.name}`, target }],
        };
      }
    }

    // ── 2. Fulfillment-shape resolver chain ─────────────────────
    const decision = await this.resolver.resolve(context);
    return {
      target: decision.target,
      chosen_by: decision.chosen_by,
      rule_id: null,
      rule_name: null,
      strategy: decision.strategy,
      trace: decision.trace,
    };
  }

  async recordDecision(ticketId: string, context: ResolverContext, evaluation: RoutingEvaluation) {
    const tenant = TenantContext.current();
    await this.supabase.admin.from('routing_decisions').insert({
      tenant_id: tenant.id,
      ticket_id: ticketId,
      strategy: evaluation.strategy,
      chosen_team_id: evaluation.target?.kind === 'team' ? evaluation.target.team_id : null,
      chosen_user_id: evaluation.target?.kind === 'user' ? evaluation.target.user_id : null,
      chosen_vendor_id: evaluation.target?.kind === 'vendor' ? evaluation.target.vendor_id : null,
      chosen_by: evaluation.chosen_by,
      rule_id: evaluation.rule_id,
      trace: evaluation.trace,
      context: {
        request_type_id: context.request_type_id,
        domain: context.domain,
        priority: context.priority,
        asset_id: context.asset_id,
        location_id: context.location_id,
      },
    });
  }

  private matchesConditions(
    conditions: Array<{ field: string; operator: string; value: unknown }>,
    context: Record<string, unknown>,
  ): boolean {
    if (!conditions || conditions.length === 0) return true;
    return conditions.every((c) => {
      const actual = context[c.field];
      switch (c.operator) {
        case 'equals': return actual === c.value;
        case 'not_equals': return actual !== c.value;
        case 'in': return Array.isArray(c.value) && c.value.includes(actual);
        case 'not_in': return Array.isArray(c.value) && !c.value.includes(actual);
        case 'exists': return actual !== null && actual !== undefined;
        default: return false;
      }
    });
  }
}
```

- [ ] **Step 8.3: Typecheck + existing Jest suite**

Run: `cd apps/api && pnpm tsc --noEmit && pnpm jest --no-coverage`

Expected: clean TypeScript + all tests pass.

- [ ] **Step 8.4: Commit**

```bash
git add apps/api/src/modules/routing/routing.service.ts apps/api/src/modules/routing/routing.module.ts
git commit -m "feat(routing): delegate to ResolverService + record routing_decisions"
```

---

## Task 9: Update TicketService to use new resolver

**Files:**
- Modify: `apps/api/src/modules/ticket/ticket.service.ts:187-220`

- [ ] **Step 9.1: Replace the routing block in `create()`**

Find the block between `// ── Auto-routing ──` and the blank line before `// ── Auto-SLA ──` (currently lines 187-220). Replace with:

```ts
    // ── Auto-routing ──────────────────────────────────────────
    if (!data.assigned_team_id && !data.assigned_user_id && !data.assigned_vendor_id) {
      try {
        const requestType = data.ticket_type_id
          ? (await this.supabase.admin.from('request_types').select('domain').eq('id', data.ticket_type_id).single()).data
          : null;

        // Derive location from asset when the ticket itself has none
        let effectiveLocation = data.location_id as string | null;
        if (!effectiveLocation && data.asset_id) {
          const { data: asset } = await this.supabase.admin
            .from('assets').select('assigned_space_id').eq('id', data.asset_id).single();
          effectiveLocation = (asset?.assigned_space_id as string | null) ?? null;
        }

        const evalCtx = {
          tenant_id: tenant.id,
          ticket_id: data.id,
          request_type_id: data.ticket_type_id ?? null,
          domain: (requestType?.domain as string | null) ?? null,
          priority: data.priority,
          asset_id: data.asset_id ?? null,
          location_id: effectiveLocation,
        };

        const result = await this.routingService.evaluate(evalCtx);
        await this.routingService.recordDecision(data.id, evalCtx, result);

        if (result.target) {
          const updates: Record<string, unknown> = { status_category: 'assigned' };
          if (result.target.kind === 'team') updates.assigned_team_id = result.target.team_id;
          if (result.target.kind === 'user') updates.assigned_user_id = result.target.user_id;
          if (result.target.kind === 'vendor') updates.assigned_vendor_id = result.target.vendor_id;
          // Also commit derived location back to the ticket if we filled one in
          if (effectiveLocation && !data.location_id) updates.location_id = effectiveLocation;

          await this.supabase.admin.from('tickets').update(updates).eq('id', data.id);
          Object.assign(data, updates);

          await this.addActivity(data.id, {
            activity_type: 'system_event',
            visibility: 'system',
            metadata: {
              event: 'auto_routed',
              chosen_by: result.chosen_by,
              strategy: result.strategy,
              rule: result.rule_name,
            },
          });
        }
      } catch (err) {
        // Log and swallow — routing failure should not block ticket creation.
        // eslint-disable-next-line no-console
        console.error('[routing] evaluate failed', err);
      }
    }
```

- [ ] **Step 9.2: Typecheck**

Run: `cd apps/api && pnpm tsc --noEmit`

Expected: no errors. (`RoutingContext` is gone — replaced by `ResolverContext`; if any import still references it, update.)

- [ ] **Step 9.3: Commit**

```bash
git add apps/api/src/modules/ticket/ticket.service.ts
git commit -m "feat(ticket): use resolver-based routing + persist decision log"
```

---

## Task 10: Admin API — expose fulfillment fields on request_types

**Files:**
- Modify: `apps/api/src/modules/config-engine/service-catalog.service.ts`
- Modify: `apps/api/src/modules/config-engine/service-catalog.controller.ts`

- [ ] **Step 10.1: Identify the request-type CRUD surface**

Run: `grep -n "request_types" apps/api/src/modules/config-engine/service-catalog.service.ts | head -20`

Expected: shows existing insert/update/select calls for `request_types`. Note the line numbers.

- [ ] **Step 10.2: Add new fields to the DTO + select list**

In `service-catalog.service.ts`, find the create-request-type and update-request-type methods. Wherever `name, domain, form_schema_id, workflow_definition_id, sla_policy_id, active` appears in an insert/update payload or a `.select(...)` string, **add**:
`fulfillment_strategy, requires_asset, asset_required, asset_type_filter, requires_location, location_required, default_team_id, default_vendor_id`.

(Exact line numbers depend on current file state — use `grep` to locate.)

Also extend the DTO interface at the top of the file (whatever its name is — likely `CreateRequestTypeDto` / `UpdateRequestTypeDto`):

```ts
  fulfillment_strategy?: 'asset' | 'location' | 'fixed' | 'auto';
  requires_asset?: boolean;
  asset_required?: boolean;
  asset_type_filter?: string[];
  requires_location?: boolean;
  location_required?: boolean;
  default_team_id?: string | null;
  default_vendor_id?: string | null;
```

- [ ] **Step 10.3: Accept fields on the controller**

In `service-catalog.controller.ts`, the request-type routes already pass body through to service. Confirm there's no fields whitelist stripping them; if there is, extend it.

- [ ] **Step 10.4: Typecheck**

Run: `cd apps/api && pnpm tsc --noEmit`

Expected: clean.

- [ ] **Step 10.5: Commit**

```bash
git add apps/api/src/modules/config-engine/
git commit -m "feat(config): expose fulfillment-shape fields on request_types admin API"
```

---

## Task 11: Asset combobox component

**Files:**
- Create: `apps/web/src/components/asset-combobox.tsx`

- [ ] **Step 11.1: Implement reusable picker**

```tsx
// apps/web/src/components/asset-combobox.tsx
import { useEffect, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { apiFetch } from '@/lib/api';

export interface Asset {
  id: string;
  name: string;
  tag: string | null;
  asset_type_id: string;
  assigned_space_id: string | null;
}

interface Props {
  value: string | null;
  onChange: (assetId: string | null, asset: Asset | null) => void;
  assetTypeFilter?: string[]; // asset_type IDs; empty = allow all
  spaceScope?: string | null; // optional: restrict to assets at/under this space
  placeholder?: string;
  disabled?: boolean;
}

export function AssetCombobox({ value, onChange, assetTypeFilter = [], spaceScope, placeholder = 'Select asset…', disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const params = new URLSearchParams();
    if (assetTypeFilter.length) params.set('asset_type_ids', assetTypeFilter.join(','));
    if (spaceScope) params.set('space_id', spaceScope);
    if (query) params.set('q', query);
    apiFetch<Asset[]>(`/assets?${params.toString()}`).then(setAssets).catch(() => setAssets([]));
  }, [query, assetTypeFilter.join(','), spaceScope]);

  const selected = assets.find((a) => a.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" disabled={disabled} className="w-full justify-between">
          {selected ? `${selected.name}${selected.tag ? ` (${selected.tag})` : ''}` : placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search assets…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>No matching asset.</CommandEmpty>
            <CommandGroup>
              {assets.map((a) => (
                <CommandItem
                  key={a.id}
                  value={a.id}
                  onSelect={() => {
                    const next = a.id === value ? null : a.id;
                    onChange(next, next ? a : null);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mr-2 h-4 w-4', value === a.id ? 'opacity-100' : 'opacity-0')} />
                  <span className="flex-1">{a.name}</span>
                  {a.tag && <span className="text-xs text-muted-foreground">{a.tag}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 11.2: Confirm shadcn components installed**

Run: `ls apps/web/src/components/ui/ | grep -E "^(popover|command|button)\.tsx$"`

If `command.tsx` or `popover.tsx` is missing, install: `cd apps/web && npx shadcn@latest add command popover`.

- [ ] **Step 11.3: Confirm `/assets` API supports the query params**

Run: `grep -n "asset_type_ids\|space_id" apps/api/src/modules/asset/*.ts`

If filter not supported, add it in `asset.service.ts` (likely a simple `.in('asset_type_id', ids)` branch). Commit alongside.

- [ ] **Step 11.4: Commit**

```bash
git add apps/web/src/components/asset-combobox.tsx apps/api/src/modules/asset/ 2>/dev/null
git commit -m "feat(web): reusable asset combobox for ticket forms"
```

---

## Task 12: Location combobox component

**Files:**
- Create: `apps/web/src/components/location-combobox.tsx`

- [ ] **Step 12.1: Implement location picker**

Mirror `asset-combobox.tsx` but fetching `/spaces` and showing name + type (Floor, Building, etc). Accept `value`, `onChange`, `typesFilter?: string[]`, `placeholder`, `disabled`. Do not re-derive — just copy the structure.

```tsx
// apps/web/src/components/location-combobox.tsx
import { useEffect, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { apiFetch } from '@/lib/api';

export interface Space {
  id: string;
  name: string;
  type: string;
  parent_id: string | null;
}

interface Props {
  value: string | null;
  onChange: (spaceId: string | null) => void;
  typesFilter?: string[];
  placeholder?: string;
  disabled?: boolean;
}

export function LocationCombobox({ value, onChange, typesFilter, placeholder = 'Select location…', disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const params = new URLSearchParams();
    if (typesFilter?.length) params.set('types', typesFilter.join(','));
    if (query) params.set('q', query);
    apiFetch<Space[]>(`/spaces?${params.toString()}`).then(setSpaces).catch(() => setSpaces([]));
  }, [query, typesFilter?.join(',')]);

  const selected = spaces.find((s) => s.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" disabled={disabled} className="w-full justify-between">
          {selected ? `${selected.name} (${selected.type})` : placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search locations…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>No matching location.</CommandEmpty>
            <CommandGroup>
              {spaces.map((s) => (
                <CommandItem
                  key={s.id}
                  value={s.id}
                  onSelect={() => {
                    onChange(s.id === value ? null : s.id);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mr-2 h-4 w-4', value === s.id ? 'opacity-100' : 'opacity-0')} />
                  <span className="flex-1">{s.name}</span>
                  <span className="text-xs text-muted-foreground">{s.type}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 12.2: Commit**

```bash
git add apps/web/src/components/location-combobox.tsx
git commit -m "feat(web): reusable location combobox"
```

---

## Task 13: Dynamic portal form

**Files:**
- Modify: `apps/web/src/pages/portal/submit-request.tsx`

- [ ] **Step 13.1: Extend `RequestType` interface**

Find the `interface RequestType` definition (around line 31). Extend to:

```ts
interface RequestType {
  id: string;
  name: string;
  domain: string;
  form_schema_id: string | null;
  fulfillment_strategy: 'asset' | 'location' | 'fixed' | 'auto';
  requires_asset: boolean;
  asset_required: boolean;
  asset_type_filter: string[];
  requires_location: boolean;
  location_required: boolean;
}
```

- [ ] **Step 13.2: Add state for asset + location**

After the existing `useState` calls (around line 67):

```ts
  const [assetId, setAssetId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
```

- [ ] **Step 13.3: Render conditional fields**

In the form JSX, below the request-type `<Select>` (around line 180), add:

```tsx
            {selectedRT?.requires_asset && (
              <div className="grid gap-1.5">
                <Label>Asset{selectedRT.asset_required ? ' *' : ''}</Label>
                <AssetCombobox
                  value={assetId}
                  onChange={(id, asset) => {
                    setAssetId(id);
                    // Auto-derive location from asset when present
                    if (asset?.assigned_space_id) setLocationId(asset.assigned_space_id);
                  }}
                  assetTypeFilter={selectedRT.asset_type_filter}
                />
              </div>
            )}

            {selectedRT?.requires_location && (
              <div className="grid gap-1.5">
                <Label>Location{selectedRT.location_required ? ' *' : ''}</Label>
                <LocationCombobox value={locationId} onChange={setLocationId} />
              </div>
            )}
```

Where `selectedRT` is resolved via `const selectedRT = requestTypes?.find(r => r.id === requestTypeId);` — add this near the top of the component body.

Also add imports:
```ts
import { AssetCombobox } from '@/components/asset-combobox';
import { LocationCombobox } from '@/components/location-combobox';
```

- [ ] **Step 13.4: Validate required fields + submit**

In `onSubmit`, before `apiFetch('/tickets', …)`:

```ts
    if (selectedRT?.asset_required && !assetId) {
      toast.error('Please select the affected asset');
      return;
    }
    if (selectedRT?.location_required && !locationId) {
      toast.error('Please select a location');
      return;
    }
```

And include in the POST body:

```ts
          asset_id: assetId ?? undefined,
          location_id: locationId ?? undefined,
```

- [ ] **Step 13.5: Smoke test the UI**

Start `pnpm dev` and test:
1. Pick an IT/VPN-style request type (fulfillment=`fixed`) → no asset/location fields show.
2. Pick an FM/Cleaning request type (fulfillment=`location`) → location field required.
3. Pick an FM/Elevator request type (fulfillment=`asset`, filter=[elevator_id]) → asset picker, only elevator assets show; selecting one auto-populates the location.

(If no such request types exist yet, create them via the admin UI or psql — or mark this step as "manual verification after Task 14".)

- [ ] **Step 13.6: Commit**

```bash
git add apps/web/src/pages/portal/submit-request.tsx
git commit -m "feat(portal): dynamic ticket form driven by request type fulfillment shape"
```

---

## Task 14: Mirror the form in the agent desk dialog

**Files:**
- Modify: `apps/web/src/components/desk/create-ticket-dialog.tsx`

- [ ] **Step 14.1: Repeat Task 13's conditional-field logic**

Apply the same state + conditional rendering pattern. The dialog already captures `ticket_type_id`; extend it with asset + location, wired to `AssetCombobox` and `LocationCombobox`, matching the portal behavior.

- [ ] **Step 14.2: Commit**

```bash
git add apps/web/src/components/desk/create-ticket-dialog.tsx
git commit -m "feat(desk): dynamic asset/location fields in create-ticket dialog"
```

---

## Task 15: Admin config UI for fulfillment shape

**Files:**
- Modify: `apps/web/src/pages/admin/request-types.tsx`

- [ ] **Step 15.1: Add form fields**

In the request-type edit form (locate via `grep -n "form_schema_id\|workflow_definition_id" apps/web/src/pages/admin/request-types.tsx`), add a new "Fulfillment" section:

```tsx
            <div className="grid gap-4 border-t pt-4">
              <h3 className="font-medium">Fulfillment</h3>

              <div className="grid gap-1.5">
                <Label>Strategy</Label>
                <Select value={form.fulfillment_strategy ?? 'fixed'} onValueChange={(v) => setForm({ ...form, fulfillment_strategy: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">Fixed team (no context needed)</SelectItem>
                    <SelectItem value="asset">Asset-based</SelectItem>
                    <SelectItem value="location">Location-based</SelectItem>
                    <SelectItem value="auto">Auto (try asset then location)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2">
                  <Checkbox checked={!!form.requires_asset} onCheckedChange={(v) => setForm({ ...form, requires_asset: !!v })} />
                  Show asset picker
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox checked={!!form.asset_required} onCheckedChange={(v) => setForm({ ...form, asset_required: !!v })} disabled={!form.requires_asset} />
                  Asset required
                </label>
              </div>

              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2">
                  <Checkbox checked={!!form.requires_location} onCheckedChange={(v) => setForm({ ...form, requires_location: !!v })} />
                  Show location picker
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox checked={!!form.location_required} onCheckedChange={(v) => setForm({ ...form, location_required: !!v })} disabled={!form.requires_location} />
                  Location required
                </label>
              </div>

              <div className="grid gap-1.5">
                <Label>Default fallback team</Label>
                {/* Reuse existing team select component from the same page if present, else plain <Select> of /teams */}
              </div>
            </div>
```

Asset-type-filter is a nice-to-have but non-blocking — a plain text input accepting comma-separated UUIDs is acceptable for v1.

- [ ] **Step 15.2: Commit**

```bash
git add apps/web/src/pages/admin/request-types.tsx
git commit -m "feat(admin): configure fulfillment strategy + asset/location flags per request type"
```

---

## Task 16: CLAUDE.md documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 16.1: Add a "Routing model" section**

Append, under Architecture:

```markdown
## Routing model
Ticket assignment uses a two-layer approach:
1. **Overrides:** admin-defined `routing_rules` (in `routing_rules` table) evaluated first. First match wins; rules can target a team or user.
2. **Resolver chain:** if no rule matches, `ResolverService` (`apps/api/src/modules/routing/resolver.service.ts`) picks an assignee based on the request type's `fulfillment_strategy`:
   - `asset` → asset's `override_team_id` → asset type's `default_team_id` → request type's `default_team_id` → unassigned
   - `location` → `location_teams(space, domain)` → walk parent spaces → request type's `default_team_id` → unassigned
   - `auto` → asset first, location second, then fallbacks
   - `fixed` → request type's `default_team_id` → unassigned

Every decision (match or exhaustion) is persisted to `routing_decisions` with full trace. To debug "why did my ticket land on team X?", `select trace from routing_decisions where ticket_id = ...`.

Vendors are first-class assignees alongside teams and users (see `tickets.assigned_vendor_id`).
```

- [ ] **Step 16.2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: routing model overview"
```

---

## Task 17: End-to-end smoke test

**Files:**
- None (manual + DB verification)

- [ ] **Step 17.1: Seed three canonical request types**

Use admin UI or direct SQL:
- "VPN Access" → `fulfillment_strategy = 'fixed'`, `default_team_id = <IT-Global>`, no asset/location.
- "Cleaning Request" → `fulfillment_strategy = 'location'`, `requires_location = true`, `location_required = true`, `default_team_id = <FM-Fallback>`.
- "Elevator Broken" → `fulfillment_strategy = 'asset'`, `requires_asset = true`, `asset_required = true`, `asset_type_filter = ['<elevator_type_id>']`, `default_team_id = <FM-Fallback>`.

Seed supporting data:
- `location_teams` row: `(building_a_id, 'fm', <FM-Team-A>)`.
- Asset type `elevator` with `default_team_id = <FM-Team-Elevators>` and one elevator asset in Building A.

- [ ] **Step 17.2: Submit each scenario from the portal**

1. Submit VPN Access → expect assignment to IT-Global, `chosen_by = 'request_type_default'`.
2. Submit Cleaning at Building A → expect FM-Team-A, `chosen_by = 'location_team'`.
3. Submit Elevator Broken, picking the seeded elevator → expect FM-Team-Elevators, `chosen_by = 'asset_type_default'`, location auto-filled.

- [ ] **Step 17.3: Verify the audit log**

Run:
```sql
select ticket_id, strategy, chosen_by, chosen_team_id, trace
from routing_decisions
order by decided_at desc
limit 3;
```

Expected: three rows, traces show which branches were evaluated.

- [ ] **Step 17.4: Commit test evidence (optional)**

Add screenshots/SQL output to `docs/superpowers/plans/2026-04-17-routing-foundation-verification.md` if desired, or just note in PR description.

---

## Self-Review Checklist

- [ ] **Spec coverage:**
  - Fulfillment shape (asset/location/fixed/auto) → Tasks 1, 10, 13, 15 ✓
  - Resolver chain → Tasks 4–7 ✓
  - Audit log → Tasks 1 (`routing_decisions`), 8 (`recordDecision`), 9 (wired in) ✓
  - Vendors as assignees → Task 1 (`assigned_vendor_id`), 9 ✓
  - Dynamic portal form → Tasks 11–13 ✓
  - Admin config surface → Tasks 10, 15 ✓

- [ ] **Type consistency:**
  - `ResolverContext.loaded.location_chain` (Task 2) matches usage in Task 6 ✓
  - `AssignmentTarget.kind` values (`team` | `user` | `vendor`) consistent across Tasks 2, 5, 6, 8, 9 ✓
  - `ChosenBy` enum matches DB `chosen_by` column values in Task 1 migration ✓

- [ ] **Placeholder scan:** none found. All code blocks are complete.

- [ ] **Out-of-scope guardrails:**
  - Approval gates, SLA pause, reassignment — explicitly deferred; no partial implementation ✓
  - No skill-based routing, no round-robin, no shift rosters ✓

- [ ] **Risk flags for executor:**
  - Task 1.4 is destructive-adjacent (remote DB push). Must pause for user confirmation.
  - Task 10.2 modifies a file whose exact structure I inferred. Executor should `grep` before editing rather than trust offsets.
  - Task 11.3 may require an asset-API change not fully scoped here — if the `/assets` filter params don't exist, implement them as a small sub-step rather than skipping.

---

Plan complete.
