# Case / Work Order Model + Scope Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split tickets into cases (requester-facing, owned by a team) and work orders (executor-facing children), wire routing_rules as a first-match pre-step in the resolver, and add space-group + domain-parent hierarchies so shared-team and cross-domain fallback scenarios work without per-location seeding.

**Architecture:** A single `tickets` table carries a new `ticket_kind` column (`case` | `work_order`). Children use existing `parent_ticket_id`. A DB trigger rolls parent status up from child state. The resolver becomes a single coherent engine that walks: routing_rules → asset → location chain (expanded with space-group peers) → domain fallback (parent-domain chain) → request-type default → unassigned. A new `DispatchService` creates child work orders with their own SLA timer and assignee. Visibility scoping is out of scope — it gets its own plan.

**Tech Stack:** NestJS, TypeScript, Supabase Postgres (RLS), Jest.

---

## File Structure

**New:**
- `supabase/migrations/00030_case_workorder_and_scope_hierarchy.sql` — schema additions + rollup trigger
- `apps/api/src/modules/ticket/dispatch.service.ts` — creates child work orders
- `apps/api/src/modules/ticket/dispatch.service.spec.ts` — multi-child dispatch tests

**Modified:**
- `apps/api/src/modules/routing/resolver.types.ts` — extend `ChosenBy`, add rule loading types
- `apps/api/src/modules/routing/resolver-repository.ts` — add `loadRoutingRules`, `domainChain`, `spaceGroupPeers`
- `apps/api/src/modules/routing/resolver.service.ts` — rules pre-step, group-expanded chain, domain fallback
- `apps/api/src/modules/routing/routing.service.ts` — thin wrapper: calls resolver, persists decision
- `apps/api/src/modules/routing/resolver.service.spec.ts` — new tests for rules + domain fallback
- `apps/api/src/modules/routing/scenarios.spec.ts` — flip 2b + 5b to passing
- `apps/api/src/modules/ticket/ticket.service.ts` — skip auto-route for `work_order`, add `kind` filter
- `apps/api/src/modules/ticket/ticket.controller.ts` — `POST /tickets/:id/dispatch`, `kind` query filter
- `apps/api/src/modules/ticket/ticket.module.ts` — register DispatchService

---

## Task 1: Migration — ticket_kind, space_groups, domain_parents, rollup trigger

**Files:**
- Create: `supabase/migrations/00030_case_workorder_and_scope_hierarchy.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00030_case_workorder_and_scope_hierarchy.sql
-- Case/work-order split, space groups, domain hierarchy, parent-status rollup.

-- ── 1. ticket_kind ────────────────────────────────────────────
alter table public.tickets
  add column if not exists ticket_kind text not null default 'case'
    check (ticket_kind in ('case', 'work_order'));

create index if not exists idx_tickets_kind on public.tickets (tenant_id, ticket_kind);
create index if not exists idx_tickets_parent_kind
  on public.tickets (parent_ticket_id, ticket_kind)
  where parent_ticket_id is not null;

-- ── 2. Space groups ───────────────────────────────────────────
-- A space group lets admins treat several unrelated spaces as one routing target
-- (solves: "Locations B/C/D → FM Shared" when B/C/D have no common ancestor).
create table if not exists public.space_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

alter table public.space_groups enable row level security;
create policy "tenant_isolation" on public.space_groups
  using (tenant_id = public.current_tenant_id());

create trigger set_space_groups_updated_at before update on public.space_groups
  for each row execute function public.set_updated_at();

create table if not exists public.space_group_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  space_group_id uuid not null references public.space_groups(id) on delete cascade,
  space_id uuid not null references public.spaces(id) on delete cascade,
  unique (space_group_id, space_id)
);

alter table public.space_group_members enable row level security;
create policy "tenant_isolation" on public.space_group_members
  using (tenant_id = public.current_tenant_id());

create index if not exists idx_sgm_group on public.space_group_members (space_group_id);
create index if not exists idx_sgm_space on public.space_group_members (space_id);

-- location_teams can now point to a space_group instead of a single space.
alter table public.location_teams
  add column if not exists space_group_id uuid references public.space_groups(id) on delete cascade;

-- space_id is no longer NOT NULL (it was implicitly required).  Drop and recreate the check
-- so EITHER space_id OR space_group_id must be set.
alter table public.location_teams alter column space_id drop not null;
alter table public.location_teams
  drop constraint if exists location_teams_scope_check;
alter table public.location_teams
  add constraint location_teams_scope_check
  check ((space_id is not null) <> (space_group_id is not null));

-- Existing unique (space_id, domain) doesn't cover groups; add a parallel one.
create unique index if not exists uniq_location_teams_group_domain
  on public.location_teams (space_group_id, domain)
  where space_group_id is not null;

create index if not exists idx_location_teams_group_domain
  on public.location_teams (space_group_id, domain);

-- ── 3. Domain hierarchy ───────────────────────────────────────
-- Admin-managed parent chain for domains: "doors" → "fm" means a request with
-- domain="doors" can fall back to "fm" if no "doors" team exists at a scope.
create table if not exists public.domain_parents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  domain text not null,
  parent_domain text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, domain),
  check (domain <> parent_domain)
);

alter table public.domain_parents enable row level security;
create policy "tenant_isolation" on public.domain_parents
  using (tenant_id = public.current_tenant_id());

create index if not exists idx_domain_parents_tenant on public.domain_parents (tenant_id);

-- ── 4. Parent-status rollup trigger ───────────────────────────
-- When a work_order's status_category changes, recompute the parent case:
--   * if any child is 'in_progress' → parent 'in_progress'
--   * else if any child not in ('resolved','closed') → parent 'assigned'
--   * else (all resolved/closed) → parent 'resolved'
-- Parent status never goes backward past 'resolved' via this trigger — a human
-- must explicitly close/reopen the parent case.
create or replace function public.rollup_parent_status()
returns trigger
language plpgsql
as $$
declare
  parent_row record;
  any_in_progress boolean;
  any_open boolean;
begin
  if new.parent_ticket_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.status_category is not distinct from old.status_category then
    return new;
  end if;

  select * into parent_row from public.tickets where id = new.parent_ticket_id;
  if not found then
    return new;
  end if;

  select
    bool_or(status_category = 'in_progress'),
    bool_or(status_category not in ('resolved', 'closed'))
  into any_in_progress, any_open
  from public.tickets
  where parent_ticket_id = new.parent_ticket_id
    and ticket_kind = 'work_order';

  if any_in_progress then
    update public.tickets set status_category = 'in_progress'
    where id = new.parent_ticket_id and status_category <> 'in_progress'
      and status_category not in ('resolved', 'closed');
  elsif any_open then
    update public.tickets set status_category = 'assigned'
    where id = new.parent_ticket_id
      and status_category in ('new')
      and status_category not in ('resolved', 'closed');
  else
    update public.tickets
    set status_category = 'resolved',
        resolved_at = coalesce(resolved_at, now())
    where id = new.parent_ticket_id
      and status_category not in ('resolved', 'closed');
  end if;

  return new;
end;
$$;

drop trigger if exists rollup_parent_status_trg on public.tickets;
create trigger rollup_parent_status_trg
  after insert or update of status_category on public.tickets
  for each row
  when (new.ticket_kind = 'work_order' and new.parent_ticket_id is not null)
  execute function public.rollup_parent_status();

-- ── 5. Reload PostgREST schema cache ──────────────────────────
notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply locally and verify**

Run: `pnpm db:reset`
Expected: migration 00030 applies without error; final line prints completion.

- [ ] **Step 3: Smoke-check schema**

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\d public.tickets" \
  | grep -E "ticket_kind|parent_ticket_id"
```
Expected: see `ticket_kind` and `parent_ticket_id` columns listed.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00030_case_workorder_and_scope_hierarchy.sql
git commit -m "feat(db): add ticket_kind, space_groups, domain_parents, parent-status rollup"
```

- [ ] **Step 5: Ask user before pushing to remote**

Do **not** run `pnpm db:push` without explicit user confirmation. Ask:
> "Migration 00030 applies cleanly locally. Push to remote Supabase?"

---

## Task 2: Extend resolver types for rules + domain + group

**Files:**
- Modify: `apps/api/src/modules/routing/resolver.types.ts`

- [ ] **Step 1: Extend ChosenBy and add rule/context types**

Replace the entire file with:

```typescript
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
  | 'space_group_team'
  | 'domain_fallback'
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
  loaded?: {
    request_type?: LoadedRequestType | null;
    asset?: LoadedAsset | null;
    location_chain?: string[];
    domain_chain?: string[];
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

export interface RoutingRuleRecord {
  id: string;
  name: string;
  priority: number;
  conditions: Array<{ field: string; operator: string; value: unknown }>;
  action_assign_team_id: string | null;
  action_assign_user_id: string | null;
}

export interface LocationTeamHit {
  team_id: string | null;
  vendor_id: string | null;
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
  rule_name?: string | null;
  trace: TraceEntry[];
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter @prequest/api build`
Expected: compiles (the new `ChosenBy` values are not yet used; TS won't error).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/routing/resolver.types.ts
git commit -m "feat(routing): extend resolver types for rules, space groups, domain fallback"
```

---

## Task 3: Extend repository with rules, domain chain, group lookup

**Files:**
- Modify: `apps/api/src/modules/routing/resolver-repository.ts`

- [ ] **Step 1: Add three new methods**

Replace the entire file with:

```typescript
import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import {
  LoadedAsset,
  LoadedRequestType,
  LocationTeamHit,
  RoutingRuleRecord,
} from './resolver.types';

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
    const raw = data as Record<string, unknown>;
    const type = Array.isArray(raw.type) ? (raw.type as unknown[])[0] : raw.type;
    return { ...(raw as object), type } as LoadedAsset;
  }

  async locationChain(spaceId: string): Promise<string[]> {
    const chain: string[] = [];
    let current: string | null = spaceId;
    for (let i = 0; current && i < 10; i++) {
      chain.push(current);
      const result: { data: { parent_id: string | null } | null } = await this.supabase.admin
        .from('spaces')
        .select('parent_id')
        .eq('id', current)
        .maybeSingle();
      current = result.data?.parent_id ?? null;
    }
    return chain;
  }

  async locationTeam(spaceId: string, domain: string): Promise<LocationTeamHit | null> {
    const { data } = await this.supabase.admin
      .from('location_teams')
      .select('team_id, vendor_id')
      .eq('space_id', spaceId)
      .eq('domain', domain)
      .maybeSingle();
    return (data as LocationTeamHit | null) ?? null;
  }

  async spaceGroupTeam(spaceId: string, domain: string): Promise<LocationTeamHit | null> {
    const { data: memberships } = await this.supabase.admin
      .from('space_group_members')
      .select('space_group_id')
      .eq('space_id', spaceId);
    const groupIds = (memberships ?? []).map((m) => (m as { space_group_id: string }).space_group_id);
    if (groupIds.length === 0) return null;

    const { data } = await this.supabase.admin
      .from('location_teams')
      .select('team_id, vendor_id')
      .in('space_group_id', groupIds)
      .eq('domain', domain)
      .limit(1)
      .maybeSingle();
    return (data as LocationTeamHit | null) ?? null;
  }

  async domainChain(tenantId: string, domain: string): Promise<string[]> {
    const chain: string[] = [domain];
    let current = domain;
    for (let i = 0; i < 10; i++) {
      const { data } = await this.supabase.admin
        .from('domain_parents')
        .select('parent_domain')
        .eq('tenant_id', tenantId)
        .eq('domain', current)
        .maybeSingle();
      const parent = (data as { parent_domain: string } | null)?.parent_domain;
      if (!parent || chain.includes(parent)) break;
      chain.push(parent);
      current = parent;
    }
    return chain;
  }

  async loadRoutingRules(tenantId: string): Promise<RoutingRuleRecord[]> {
    const { data } = await this.supabase.admin
      .from('routing_rules')
      .select('id, name, priority, conditions, action_assign_team_id, action_assign_user_id')
      .eq('tenant_id', tenantId)
      .eq('active', true)
      .order('priority', { ascending: false });
    return (data as RoutingRuleRecord[] | null) ?? [];
  }
}
```

- [ ] **Step 2: Verify compile**

Run: `pnpm --filter @prequest/api build`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/routing/resolver-repository.ts
git commit -m "feat(routing): repository support for rules, space groups, domain chain"
```

---

## Task 4: ResolverService — rules pre-step + group/domain expansion (TDD)

**Files:**
- Modify: `apps/api/src/modules/routing/resolver.service.ts`
- Test: `apps/api/src/modules/routing/resolver.service.spec.ts`

- [ ] **Step 1: Write failing tests for rule pre-step**

Append this `describe` block to `apps/api/src/modules/routing/resolver.service.spec.ts` (inside the existing top-level describe):

```typescript
  describe('routing_rules pre-step', () => {
    it('first matching active rule wins before any other logic', async () => {
      const repo = stubRepo({
        loadRoutingRules: jest.fn().mockResolvedValue([
          {
            id: 'r1', name: 'VIP', priority: 100,
            conditions: [{ field: 'priority', operator: 'equals', value: 'urgent' }],
            action_assign_team_id: 'vip-team', action_assign_user_id: null,
          },
        ]),
        loadRequestType: jest.fn().mockResolvedValue({
          id: 'rt', domain: 'fm', fulfillment_strategy: 'fixed',
          default_team_id: 'normal-team', default_vendor_id: null, asset_type_filter: [],
        }),
      });
      const svc = new ResolverService(repo as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt', priority: 'urgent' }));
      expect(d.chosen_by).toBe('rule');
      expect(d.rule_id).toBe('r1');
      expect(d.target).toEqual({ kind: 'team', team_id: 'vip-team' });
    });

    it('rules with no match fall through to the resolver chain', async () => {
      const repo = stubRepo({
        loadRoutingRules: jest.fn().mockResolvedValue([
          {
            id: 'r1', name: 'VIP', priority: 100,
            conditions: [{ field: 'priority', operator: 'equals', value: 'urgent' }],
            action_assign_team_id: 'vip-team', action_assign_user_id: null,
          },
        ]),
        loadRequestType: jest.fn().mockResolvedValue({
          id: 'rt', domain: 'fm', fulfillment_strategy: 'fixed',
          default_team_id: 'normal-team', default_vendor_id: null, asset_type_filter: [],
        }),
      });
      const svc = new ResolverService(repo as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt', priority: 'medium' }));
      expect(d.chosen_by).toBe('request_type_default');
      expect(d.target).toEqual({ kind: 'team', team_id: 'normal-team' });
    });
  });

  describe('space group expansion', () => {
    it('matches space_group_team when no per-space row exists', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue({
          id: 'rt', domain: 'fm', fulfillment_strategy: 'location',
          default_team_id: null, default_vendor_id: null, asset_type_filter: [],
        }),
        locationChain: jest.fn().mockResolvedValue(['locB']),
        locationTeam: jest.fn().mockResolvedValue(null),
        spaceGroupTeam: jest.fn(async (sid: string, dom: string) =>
          sid === 'locB' && dom === 'fm' ? { team_id: 'fm-shared', vendor_id: null } : null),
      });
      const svc = new ResolverService(repo as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt', location_id: 'locB', domain: 'fm' }));
      expect(d.chosen_by).toBe('space_group_team');
      expect(d.target).toEqual({ kind: 'team', team_id: 'fm-shared' });
    });
  });

  describe('domain fallback', () => {
    it('falls back to parent domain when exact domain has no team at any scope', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue({
          id: 'rt', domain: 'doors', fulfillment_strategy: 'location',
          default_team_id: null, default_vendor_id: null, asset_type_filter: [],
        }),
        locationChain: jest.fn().mockResolvedValue(['locC', 'region-west']),
        domainChain: jest.fn().mockResolvedValue(['doors', 'fm']),
        locationTeam: jest.fn(async (sid: string, dom: string) =>
          sid === 'region-west' && dom === 'fm' ? { team_id: 'region-west-fm', vendor_id: null } : null),
      });
      const svc = new ResolverService(repo as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt', location_id: 'locC', domain: 'doors' }));
      expect(d.chosen_by).toBe('domain_fallback');
      expect(d.target).toEqual({ kind: 'team', team_id: 'region-west-fm' });
    });
  });
```

Also update the `stubRepo` helper at the top of the same file to include the new methods:

```typescript
function stubRepo(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    loadRequestType: jest.fn().mockResolvedValue(null),
    loadAsset: jest.fn().mockResolvedValue(null),
    locationChain: jest.fn().mockResolvedValue([]),
    locationTeam: jest.fn().mockResolvedValue(null),
    spaceGroupTeam: jest.fn().mockResolvedValue(null),
    domainChain: jest.fn().mockResolvedValue([]),
    loadRoutingRules: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}
```

- [ ] **Step 2: Run tests — expect failures**

Run: `pnpm --filter @prequest/api test -- resolver.service.spec.ts`
Expected: the three new tests FAIL (TypeError or assertion errors — no rule/group/domain logic exists yet).

- [ ] **Step 3: Rewrite ResolverService**

Replace the entire file `apps/api/src/modules/routing/resolver.service.ts` with:

```typescript
import { Injectable } from '@nestjs/common';
import { ResolverRepository } from './resolver-repository';
import {
  AssignmentTarget,
  ChosenBy,
  FulfillmentShape,
  LocationTeamHit,
  ResolverContext,
  ResolverDecision,
  RoutingRuleRecord,
  TraceEntry,
} from './resolver.types';

@Injectable()
export class ResolverService {
  constructor(private readonly repo: ResolverRepository) {}

  async resolve(context: ResolverContext): Promise<ResolverDecision> {
    const trace: TraceEntry[] = [];
    const loaded = await this.hydrate(context);

    const ruleHit = await this.tryRules(context, trace);
    if (ruleHit) return ruleHit;

    const shape: FulfillmentShape = loaded.request_type?.fulfillment_strategy ?? 'fixed';

    if (shape === 'asset' || shape === 'auto') {
      const hit = this.tryAsset(loaded.asset, trace);
      if (hit) return this.done(trace, hit.step, shape, hit.target);
    }

    if ((shape === 'location' || shape === 'auto') && loaded.location_chain) {
      const hit = await this.tryLocationChain(loaded.location_chain, loaded.domain_chain ?? [], trace);
      if (hit) return this.done(trace, hit.step, shape, hit.target);
    }

    const rt = loaded.request_type;
    if (rt) {
      const rtDefault = this.pickTarget(rt.default_team_id, rt.default_vendor_id);
      if (rtDefault) {
        trace.push({ step: 'request_type_default', matched: true, reason: `request type ${rt.id}`, target: rtDefault });
        return this.done(trace, 'request_type_default', shape, rtDefault);
      }
      trace.push({ step: 'request_type_default', matched: false, reason: `request type ${rt.id} has no default`, target: null });
    }

    trace.push({ step: 'unassigned', matched: true, reason: 'no candidates matched', target: null });
    return { target: null, chosen_by: 'unassigned', strategy: shape, trace };
  }

  // ── Rules pre-step ────────────────────────────────────────────
  private async tryRules(context: ResolverContext, trace: TraceEntry[]): Promise<ResolverDecision | null> {
    const rules = await this.repo.loadRoutingRules(context.tenant_id);
    const ruleCtx: Record<string, unknown> = {
      ticket_type_id: context.request_type_id,
      request_type_id: context.request_type_id,
      domain: context.domain,
      location_id: context.location_id,
      priority: context.priority,
      asset_id: context.asset_id,
    };

    for (const rule of rules) {
      if (!this.matchesConditions(rule.conditions, ruleCtx)) continue;
      const target: AssignmentTarget | null = rule.action_assign_team_id
        ? { kind: 'team', team_id: rule.action_assign_team_id }
        : rule.action_assign_user_id
        ? { kind: 'user', user_id: rule.action_assign_user_id }
        : null;
      if (!target) continue;
      trace.push({ step: 'rule', matched: true, reason: `rule ${rule.name}`, target });
      return {
        target,
        chosen_by: 'rule',
        strategy: 'rule',
        rule_id: rule.id,
        rule_name: rule.name,
        trace,
      };
    }
    return null;
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
        case 'in': return Array.isArray(c.value) && (c.value as unknown[]).includes(actual);
        case 'not_in': return Array.isArray(c.value) && !(c.value as unknown[]).includes(actual);
        case 'exists': return actual !== null && actual !== undefined;
        default: return false;
      }
    });
  }

  // ── Asset branch ──────────────────────────────────────────────
  private tryAsset(
    asset: ResolverContext['loaded'] extends infer L ? (L extends { asset?: infer A } ? A : never) : never,
    trace: TraceEntry[],
  ): { step: ChosenBy; target: AssignmentTarget } | null {
    if (!asset) {
      trace.push({ step: 'asset_override', matched: false, reason: 'no asset in context', target: null });
      return null;
    }
    const override = this.pickTarget(asset.override_team_id, asset.override_vendor_id);
    if (override) {
      trace.push({ step: 'asset_override', matched: true, reason: 'asset override', target: override });
      return { step: 'asset_override', target: override };
    }
    trace.push({ step: 'asset_override', matched: false, reason: 'no asset override', target: null });

    const typeDefault = this.pickTarget(asset.type.default_team_id, asset.type.default_vendor_id);
    if (typeDefault) {
      trace.push({ step: 'asset_type_default', matched: true, reason: `asset type ${asset.asset_type_id}`, target: typeDefault });
      return { step: 'asset_type_default', target: typeDefault };
    }
    trace.push({ step: 'asset_type_default', matched: false, reason: `asset type ${asset.asset_type_id} has no default`, target: null });
    return null;
  }

  // ── Location chain walk (with group + domain-parent fallback) ─
  private async tryLocationChain(
    chain: string[],
    domainChain: string[],
    trace: TraceEntry[],
  ): Promise<{ step: ChosenBy; target: AssignmentTarget } | null> {
    if (domainChain.length === 0) {
      trace.push({ step: 'location_team', matched: false, reason: 'no domain in context', target: null });
      return null;
    }

    for (let d = 0; d < domainChain.length; d++) {
      const dom = domainChain[d];
      for (let s = 0; s < chain.length; s++) {
        const spaceId = chain[s];
        const hit = await this.repo.locationTeam(spaceId, dom);
        const target = this.fromHit(hit);
        if (target) {
          const step: ChosenBy =
            d > 0 ? 'domain_fallback'
            : s === 0 ? 'location_team'
            : 'parent_location_team';
          trace.push({ step, matched: true, reason: `space ${spaceId} domain ${dom}`, target });
          return { step, target };
        }
        const groupHit = await this.repo.spaceGroupTeam(spaceId, dom);
        const groupTarget = this.fromHit(groupHit);
        if (groupTarget) {
          const step: ChosenBy = d > 0 ? 'domain_fallback' : 'space_group_team';
          trace.push({ step, matched: true, reason: `space ${spaceId} (via group) domain ${dom}`, target: groupTarget });
          return { step, target: groupTarget };
        }
      }
    }
    trace.push({ step: 'location_team', matched: false, reason: 'no location match across domain chain', target: null });
    return null;
  }

  // ── Hydration ────────────────────────────────────────────────
  private async hydrate(context: ResolverContext) {
    const request_type = context.request_type_id
      ? await this.repo.loadRequestType(context.request_type_id)
      : null;
    const asset = context.asset_id ? await this.repo.loadAsset(context.asset_id) : null;
    const primaryLocation = context.location_id ?? asset?.assigned_space_id ?? null;
    const location_chain = primaryLocation ? await this.repo.locationChain(primaryLocation) : [];
    const domain_chain = context.domain
      ? await this.repo.domainChain(context.tenant_id, context.domain)
      : [];
    context.loaded = { request_type, asset, location_chain, domain_chain };
    return context.loaded;
  }

  // ── Helpers ──────────────────────────────────────────────────
  private fromHit(hit: LocationTeamHit | null): AssignmentTarget | null {
    if (!hit) return null;
    return this.pickTarget(hit.team_id, hit.vendor_id);
  }

  private pickTarget(team_id: string | null | undefined, vendor_id: string | null | undefined): AssignmentTarget | null {
    if (team_id) return { kind: 'team', team_id };
    if (vendor_id) return { kind: 'vendor', vendor_id };
    return null;
  }

  private done(trace: TraceEntry[], chosen_by: ChosenBy, strategy: FulfillmentShape, target: AssignmentTarget): ResolverDecision {
    return { target, chosen_by, strategy, trace };
  }
}
```

- [ ] **Step 4: Run tests — expect all pass**

Run: `pnpm --filter @prequest/api test -- resolver.service.spec.ts`
Expected: all tests in the file pass (including the three new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/routing/resolver.service.ts \
        apps/api/src/modules/routing/resolver.service.spec.ts
git commit -m "feat(routing): rules pre-step + space group + domain fallback in resolver"
```

---

## Task 5: Simplify RoutingService to a thin façade

**Files:**
- Modify: `apps/api/src/modules/routing/routing.service.ts`

- [ ] **Step 1: Replace with delegation-only implementation**

Replace the entire file with:

```typescript
import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { ResolverService } from './resolver.service';
import {
  AssignmentTarget,
  ChosenBy,
  FulfillmentShape,
  ResolverContext,
  TraceEntry,
} from './resolver.types';

export interface RoutingEvaluation {
  target: AssignmentTarget | null;
  chosen_by: ChosenBy;
  rule_id: string | null;
  rule_name: string | null;
  strategy: FulfillmentShape | 'rule';
  trace: TraceEntry[];
}

@Injectable()
export class RoutingService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly resolver: ResolverService,
  ) {}

  async evaluate(context: ResolverContext): Promise<RoutingEvaluation> {
    const decision = await this.resolver.resolve(context);
    return {
      target: decision.target,
      chosen_by: decision.chosen_by,
      rule_id: decision.rule_id ?? null,
      rule_name: decision.rule_name ?? null,
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
}
```

- [ ] **Step 2: Run existing resolver/routing tests**

Run: `pnpm --filter @prequest/api test -- routing`
Expected: resolver.service.spec.ts passes; scenarios.spec.ts may have a few failures from old assumptions — fix in Task 6.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/routing/routing.service.ts
git commit -m "refactor(routing): RoutingService becomes a thin façade over resolver"
```

---

## Task 6: Update scenario tests — 2b + 5b pass, add multi-child expectations

**Files:**
- Modify: `apps/api/src/modules/routing/scenarios.spec.ts`

- [ ] **Step 1: Update scenarios to reflect new capabilities**

Replace `apps/api/src/modules/routing/scenarios.spec.ts` with:

```typescript
/**
 * Scenario tests for the 7 canonical enterprise routing patterns.
 * Updated: 2b now via space groups; 5b now via domain fallback; 4 moves to dispatch.spec.
 */
import { ResolverService } from './resolver.service';
import { ResolverContext } from './resolver.types';

function repo(over: Partial<Record<string, jest.Mock>> = {}) {
  return {
    loadRequestType: jest.fn().mockResolvedValue(null),
    loadAsset: jest.fn().mockResolvedValue(null),
    locationChain: jest.fn().mockResolvedValue([]),
    locationTeam: jest.fn().mockResolvedValue(null),
    spaceGroupTeam: jest.fn().mockResolvedValue(null),
    domainChain: jest.fn(async (_t: string, d: string) => [d]),
    loadRoutingRules: jest.fn().mockResolvedValue([]),
    ...over,
  };
}

function ctx(over: Partial<ResolverContext> = {}): ResolverContext {
  return {
    tenant_id: 't1',
    ticket_id: 'tk1',
    request_type_id: 'rt',
    domain: null,
    priority: 'medium',
    asset_id: null,
    location_id: null,
    ...over,
  };
}

describe('canonical enterprise routing scenarios', () => {
  it('Scenario 1: local team per location', async () => {
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'it', fulfillment_strategy: 'location',
        default_team_id: null, default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['locA']),
      locationTeam: jest.fn(async (sid, dom) =>
        sid === 'locA' && dom === 'it' ? { team_id: 'service-desk-A', vendor_id: null } : null),
    }) as never);
    const d = await svc.resolve(ctx({ location_id: 'locA', domain: 'it' }));
    expect(d.target).toEqual({ kind: 'team', team_id: 'service-desk-A' });
    expect(d.chosen_by).toBe('location_team');
  });

  it('Scenario 2a: shared team via parent-space walk', async () => {
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'fm', fulfillment_strategy: 'location',
        default_team_id: null, default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['locB', 'region-east']),
      locationTeam: jest.fn(async (sid, dom) =>
        sid === 'region-east' && dom === 'fm' ? { team_id: 'fm-shared', vendor_id: null } : null),
    }) as never);
    const d = await svc.resolve(ctx({ location_id: 'locB', domain: 'fm' }));
    expect(d.target).toEqual({ kind: 'team', team_id: 'fm-shared' });
    expect(d.chosen_by).toBe('parent_location_team');
  });

  it('Scenario 2b: shared team across unrelated locations via space group', async () => {
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'fm', fulfillment_strategy: 'location',
        default_team_id: null, default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['locC']),
      spaceGroupTeam: jest.fn(async (sid, dom) =>
        sid === 'locC' && dom === 'fm' ? { team_id: 'fm-shared', vendor_id: null } : null),
    }) as never);
    const d = await svc.resolve(ctx({ location_id: 'locC', domain: 'fm' }));
    expect(d.target).toEqual({ kind: 'team', team_id: 'fm-shared' });
    expect(d.chosen_by).toBe('space_group_team');
  });

  it('Scenario 3: fixed owner by request type', async () => {
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'catering', fulfillment_strategy: 'fixed',
        default_team_id: 'catering-desk', default_vendor_id: null, asset_type_filter: [],
      }),
    }) as never);
    const d = await svc.resolve(ctx({ domain: 'catering' }));
    expect(d.target).toEqual({ kind: 'team', team_id: 'catering-desk' });
    expect(d.chosen_by).toBe('request_type_default');
  });

  // Scenario 4 (owner + vendor split) moves to dispatch.service.spec.ts —
  // the parent case routes to FM A (service desk), a child work order carries Vendor X.

  it('Scenario 5a: fallback via parent-space walk', async () => {
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'doors', fulfillment_strategy: 'location',
        default_team_id: null, default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['locC', 'region-west']),
      locationTeam: jest.fn(async (sid, dom) =>
        sid === 'region-west' && dom === 'doors' ? { team_id: 'region-west-doors', vendor_id: null } : null),
    }) as never);
    const d = await svc.resolve(ctx({ location_id: 'locC', domain: 'doors' }));
    expect(d.target).toEqual({ kind: 'team', team_id: 'region-west-doors' });
    expect(d.chosen_by).toBe('parent_location_team');
  });

  it('Scenario 5b: cross-domain fallback via domain hierarchy', async () => {
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'doors', fulfillment_strategy: 'location',
        default_team_id: null, default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['locC', 'region-west']),
      domainChain: jest.fn().mockResolvedValue(['doors', 'fm']),
      locationTeam: jest.fn(async (sid, dom) =>
        sid === 'region-west' && dom === 'fm' ? { team_id: 'region-west-fm', vendor_id: null } : null),
    }) as never);
    const d = await svc.resolve(ctx({ location_id: 'locC', domain: 'doors' }));
    expect(d.target).toEqual({ kind: 'team', team_id: 'region-west-fm' });
    expect(d.chosen_by).toBe('domain_fallback');
  });

  it('Scenario 6: building-specific vendor override wins over default', async () => {
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'fm', fulfillment_strategy: 'location',
        default_team_id: 'fm-shared', default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['A1', 'campus']),
      locationTeam: jest.fn(async (sid, dom) =>
        sid === 'A1' && dom === 'fm' ? { team_id: null, vendor_id: 'vendor-Z' } : null),
    }) as never);
    const d = await svc.resolve(ctx({ location_id: 'A1', domain: 'fm' }));
    expect(d.target).toEqual({ kind: 'vendor', vendor_id: 'vendor-Z' });
    expect(d.chosen_by).toBe('location_team');
  });

  it.skip('Scenario 7: visibility — deferred to a separate plan (list-endpoint scoping)', () => {});
});
```

- [ ] **Step 2: Run scenarios**

Run: `pnpm --filter @prequest/api test -- scenarios.spec.ts`
Expected: scenarios 1, 2a, 2b, 3, 5a, 5b, 6 all pass. Scenario 7 skipped.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/routing/scenarios.spec.ts
git commit -m "test(routing): scenarios 2b (space group) and 5b (domain fallback) now pass"
```

---

## Task 7: Ticket filter + skip auto-route for work orders

**Files:**
- Modify: `apps/api/src/modules/ticket/ticket.service.ts`
- Modify: `apps/api/src/modules/ticket/ticket.controller.ts`

- [ ] **Step 1: Add `ticket_kind` to filters and create DTO**

In `apps/api/src/modules/ticket/ticket.service.ts`, extend `CreateTicketDto` and `TicketListFilters`:

Find:
```typescript
export interface CreateTicketDto {
  ticket_type_id?: string;
  parent_ticket_id?: string;
  title: string;
```

Replace with:
```typescript
export interface CreateTicketDto {
  ticket_type_id?: string;
  parent_ticket_id?: string;
  ticket_kind?: 'case' | 'work_order';
  title: string;
```

Find:
```typescript
export interface TicketListFilters {
  status_category?: string;
  priority?: string;
  assigned_team_id?: string;
```

Replace with:
```typescript
export interface TicketListFilters {
  status_category?: string;
  priority?: string;
  ticket_kind?: 'case' | 'work_order';
  assigned_team_id?: string;
```

- [ ] **Step 2: Apply filter in `list()`**

Find (around line 119):
```typescript
    if (filters.assigned_team_id) query = query.eq('assigned_team_id', filters.assigned_team_id);
```

Insert **before** that line:
```typescript
    if (filters.ticket_kind) query = query.eq('ticket_kind', filters.ticket_kind);
```

- [ ] **Step 3: Pass `ticket_kind` through create insert**

Find (around line 180-190):
```typescript
        parent_ticket_id: dto.parent_ticket_id,
```

Insert after it:
```typescript
        ticket_kind: dto.ticket_kind ?? 'case',
```

- [ ] **Step 4: Skip auto-routing for work orders**

Find (around line 307):
```typescript
    if (!data.assigned_team_id && !data.assigned_user_id && !data.assigned_vendor_id) {
```

Replace with:
```typescript
    const isWorkOrder = data.ticket_kind === 'work_order';
    if (!isWorkOrder && !data.assigned_team_id && !data.assigned_user_id && !data.assigned_vendor_id) {
```

- [ ] **Step 5: Add `kind` query param to controller**

In `apps/api/src/modules/ticket/ticket.controller.ts`, find the `list()` method signature and add `kind`:

Find:
```typescript
  async list(
    @Query('status_category') statusCategory?: string,
    @Query('priority') priority?: string,
```

Replace with:
```typescript
  async list(
    @Query('status_category') statusCategory?: string,
    @Query('priority') priority?: string,
    @Query('kind') ticketKind?: 'case' | 'work_order',
```

And find:
```typescript
    return this.ticketService.list({
      status_category: statusCategory,
      priority,
```

Replace with:
```typescript
    return this.ticketService.list({
      status_category: statusCategory,
      priority,
      ticket_kind: ticketKind,
```

- [ ] **Step 6: Build**

Run: `pnpm --filter @prequest/api build`
Expected: compiles.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/ticket/ticket.service.ts apps/api/src/modules/ticket/ticket.controller.ts
git commit -m "feat(tickets): ticket_kind on create/list; skip auto-routing for work orders"
```

---

## Task 8: DispatchService — create child work order (TDD)

**Files:**
- Create: `apps/api/src/modules/ticket/dispatch.service.ts`
- Create: `apps/api/src/modules/ticket/dispatch.service.spec.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/api/src/modules/ticket/dispatch.service.spec.ts`:

```typescript
import { DispatchService, DispatchDto } from './dispatch.service';

type ParentRow = {
  id: string;
  tenant_id: string;
  ticket_type_id: string | null;
  location_id: string | null;
  asset_id: string | null;
  priority: string;
  title: string;
  ticket_kind: string;
  requester_person_id: string | null;
};

function makeParent(over: Partial<ParentRow> = {}): ParentRow {
  return {
    id: 'parent-1',
    tenant_id: 't1',
    ticket_type_id: 'rt-1',
    location_id: 'loc-1',
    asset_id: null,
    priority: 'medium',
    title: 'Broken window',
    ticket_kind: 'case',
    requester_person_id: 'person-1',
    ...over,
  };
}

function makeDeps(parent: ParentRow) {
  const inserted: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];

  const ticketService = {
    getById: jest.fn(async (_id: string) => parent),
    addActivity: jest.fn(async (_id: string, act: Record<string, unknown>) => {
      activities.push(act);
    }),
  };

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'tickets') {
          return {
            insert: (row: Record<string, unknown>) => {
              inserted.push(row);
              return {
                select: () => ({
                  single: async () => ({ data: { ...row, id: `child-${inserted.length}` }, error: null }),
                }),
              };
            },
          } as unknown;
        }
        if (table === 'request_types') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({ data: { domain: 'fm', sla_policy_id: 'sla-1' }, error: null }),
              }),
            }),
          } as unknown;
        }
        return {} as unknown;
      }),
    },
  };

  const routingService = {
    evaluate: jest.fn().mockResolvedValue({
      target: { kind: 'vendor', vendor_id: 'vendor-X' },
      chosen_by: 'request_type_default',
      rule_id: null, rule_name: null, strategy: 'fixed', trace: [],
    }),
    recordDecision: jest.fn().mockResolvedValue(undefined),
  };

  const slaService = { startTimers: jest.fn().mockResolvedValue(undefined) };

  return { ticketService, supabase, routingService, slaService, inserted, activities };
}

describe('DispatchService', () => {
  const tenantCtx = { id: 't1', subdomain: 't1' };
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue(tenantCtx);
  });

  it('creates a child work_order with parent context copied', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent);
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
    );
    const dto: DispatchDto = { title: 'Install replacement glass', assigned_vendor_id: 'vendor-X' };
    const child = await svc.dispatch(parent.id, dto);

    expect(child.parent_ticket_id).toBe(parent.id);
    expect(child.ticket_kind).toBe('work_order');
    expect(inserted[0].location_id).toBe(parent.location_id);
    expect(inserted[0].ticket_type_id).toBe(parent.ticket_type_id);
    expect(inserted[0].priority).toBe(parent.priority);
    expect(inserted[0].assigned_vendor_id).toBe('vendor-X');
    expect(slaService.startTimers).toHaveBeenCalledWith(expect.any(String), 't1', 'sla-1');
  });

  it('runs resolver when no assignee given in DTO', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent);
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
    );
    await svc.dispatch(parent.id, { title: 'Investigate' });
    expect(routingService.evaluate).toHaveBeenCalled();
    expect(inserted[0].assigned_vendor_id).toBe('vendor-X');
  });

  it('rejects dispatch on a ticket that is already a work_order', async () => {
    const parent = makeParent({ ticket_kind: 'work_order' });
    const deps = makeDeps(parent);
    const svc = new DispatchService(
      deps.supabase as never,
      deps.ticketService as never,
      deps.routingService as never,
      deps.slaService as never,
    );
    await expect(svc.dispatch(parent.id, { title: 'x' })).rejects.toThrow(/work_order/);
  });

  it('supports multiple children on one parent (broken-window scenario)', async () => {
    const parent = makeParent({ title: 'Broken window in Building A' });
    const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent);
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
    );
    await svc.dispatch(parent.id, { title: 'Replace window pane', assigned_vendor_id: 'glazier' });
    await svc.dispatch(parent.id, { title: 'Buy replacement glass', assigned_vendor_id: 'supplier' });
    await svc.dispatch(parent.id, { title: 'Clean up debris', assigned_vendor_id: 'janitorial' });
    expect(inserted).toHaveLength(3);
    expect(inserted.map((c) => c.assigned_vendor_id)).toEqual(['glazier', 'supplier', 'janitorial']);
    expect(inserted.every((c) => c.parent_ticket_id === parent.id)).toBe(true);
    expect(inserted.every((c) => c.ticket_kind === 'work_order')).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect failure (service doesn't exist)**

Run: `pnpm --filter @prequest/api test -- dispatch.service.spec.ts`
Expected: FAIL with "Cannot find module './dispatch.service'".

- [ ] **Step 3: Implement DispatchService**

Create `apps/api/src/modules/ticket/dispatch.service.ts`:

```typescript
import { BadRequestException, Injectable, Inject, forwardRef } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RoutingService } from '../routing/routing.service';
import { SlaService } from '../sla/sla.service';
import { TicketService } from './ticket.service';

export interface DispatchDto {
  title: string;
  description?: string;
  assigned_team_id?: string;
  assigned_user_id?: string;
  assigned_vendor_id?: string;
  priority?: string;
  interaction_mode?: 'internal' | 'external';
  ticket_type_id?: string;
  asset_id?: string;
  location_id?: string;
}

@Injectable()
export class DispatchService {
  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => TicketService)) private readonly tickets: TicketService,
    @Inject(forwardRef(() => RoutingService)) private readonly routingService: RoutingService,
    private readonly slaService: SlaService,
  ) {}

  async dispatch(parentId: string, dto: DispatchDto) {
    const tenant = TenantContext.current();
    const parent = (await this.tickets.getById(parentId)) as Record<string, unknown>;
    if (!parent) throw new BadRequestException(`parent ${parentId} not found`);
    if (parent.ticket_kind === 'work_order') {
      throw new BadRequestException('cannot dispatch from a work_order; dispatch from the parent case');
    }

    const ticketTypeId = dto.ticket_type_id ?? (parent.ticket_type_id as string | null);
    const locationId = dto.location_id ?? (parent.location_id as string | null);
    const assetId = dto.asset_id ?? (parent.asset_id as string | null);
    const priority = dto.priority ?? ((parent.priority as string | null) ?? 'medium');

    const row: Record<string, unknown> = {
      tenant_id: tenant.id,
      parent_ticket_id: parentId,
      ticket_kind: 'work_order',
      ticket_type_id: ticketTypeId,
      title: dto.title,
      description: dto.description ?? null,
      priority,
      interaction_mode: dto.interaction_mode ?? 'internal',
      location_id: locationId,
      asset_id: assetId,
      requester_person_id: (parent.requester_person_id as string | null) ?? null,
      status: 'new',
      status_category: 'new',
      assigned_team_id: dto.assigned_team_id ?? null,
      assigned_user_id: dto.assigned_user_id ?? null,
      assigned_vendor_id: dto.assigned_vendor_id ?? null,
    };

    let routingCtx: Parameters<RoutingService['evaluate']>[0] | null = null;
    if (!row.assigned_team_id && !row.assigned_user_id && !row.assigned_vendor_id && ticketTypeId) {
      const rtCfg = await this.loadRequestTypeDomain(ticketTypeId);
      routingCtx = {
        tenant_id: tenant.id,
        ticket_id: 'pending',
        request_type_id: ticketTypeId,
        domain: rtCfg.domain,
        priority,
        asset_id: assetId,
        location_id: locationId,
      };
      const evaluation = await this.routingService.evaluate(routingCtx);
      if (evaluation.target) {
        if (evaluation.target.kind === 'team') row.assigned_team_id = evaluation.target.team_id;
        if (evaluation.target.kind === 'user') row.assigned_user_id = evaluation.target.user_id;
        if (evaluation.target.kind === 'vendor') row.assigned_vendor_id = evaluation.target.vendor_id;
        row.status_category = 'assigned';
      }
    } else if (row.assigned_team_id || row.assigned_user_id || row.assigned_vendor_id) {
      row.status_category = 'assigned';
    }

    const { data: inserted, error } = await this.supabase.admin
      .from('tickets')
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    const child = inserted as Record<string, unknown>;

    if (routingCtx) {
      routingCtx.ticket_id = child.id as string;
      const evaluation = await this.routingService.evaluate(routingCtx);
      await this.routingService.recordDecision(child.id as string, routingCtx, evaluation);
    }

    if (ticketTypeId) {
      const cfg = await this.loadRequestTypeSla(ticketTypeId);
      if (cfg.sla_policy_id) {
        await this.slaService.startTimers(child.id as string, tenant.id, cfg.sla_policy_id);
        await this.supabase.admin.from('tickets')
          .update({ sla_id: cfg.sla_policy_id })
          .eq('id', child.id as string);
      }
    }

    await this.tickets.addActivity(parentId, {
      activity_type: 'system_event',
      visibility: 'system',
      metadata: {
        event: 'dispatched',
        child_id: child.id,
        assigned_team_id: row.assigned_team_id,
        assigned_user_id: row.assigned_user_id,
        assigned_vendor_id: row.assigned_vendor_id,
      },
    });

    return child;
  }

  private async loadRequestTypeDomain(id: string): Promise<{ domain: string | null }> {
    const { data } = await this.supabase.admin
      .from('request_types')
      .select('domain')
      .eq('id', id)
      .single();
    return { domain: (data as { domain: string | null } | null)?.domain ?? null };
  }

  private async loadRequestTypeSla(id: string): Promise<{ sla_policy_id: string | null }> {
    const { data } = await this.supabase.admin
      .from('request_types')
      .select('sla_policy_id')
      .eq('id', id)
      .single();
    return { sla_policy_id: (data as { sla_policy_id: string | null } | null)?.sla_policy_id ?? null };
  }
}
```

- [ ] **Step 4: Register in module**

Replace `apps/api/src/modules/ticket/ticket.module.ts` with:

```typescript
import { Module, forwardRef } from '@nestjs/common';
import { TicketService } from './ticket.service';
import { TicketController } from './ticket.controller';
import { DispatchService } from './dispatch.service';
import { RoutingModule } from '../routing/routing.module';
import { SlaModule } from '../sla/sla.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { ApprovalModule } from '../approval/approval.module';

@Module({
  imports: [
    RoutingModule,
    SlaModule,
    forwardRef(() => WorkflowModule),
    forwardRef(() => ApprovalModule),
  ],
  providers: [TicketService, DispatchService],
  controllers: [TicketController],
  exports: [TicketService, DispatchService],
})
export class TicketModule {}
```

- [ ] **Step 5: Run tests — expect all pass**

Run: `pnpm --filter @prequest/api test -- dispatch.service.spec.ts`
Expected: all four tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/ticket/dispatch.service.ts \
        apps/api/src/modules/ticket/dispatch.service.spec.ts \
        apps/api/src/modules/ticket/ticket.module.ts
git commit -m "feat(tickets): DispatchService creates child work orders with SLA + routing"
```

---

## Task 9: Dispatch endpoint on TicketController

**Files:**
- Modify: `apps/api/src/modules/ticket/ticket.controller.ts`

- [ ] **Step 1: Inject DispatchService and add endpoint**

At the top of `apps/api/src/modules/ticket/ticket.controller.ts`, update the imports and constructor:

Find:
```typescript
import {
  TicketService,
  CreateTicketDto,
  UpdateTicketDto,
  AddActivityDto,
  ReassignDto,
} from './ticket.service';

@Controller('tickets')
export class TicketController {
  constructor(private readonly ticketService: TicketService) {}
```

Replace with:
```typescript
import {
  TicketService,
  CreateTicketDto,
  UpdateTicketDto,
  AddActivityDto,
  ReassignDto,
} from './ticket.service';
import { DispatchService, DispatchDto } from './dispatch.service';

@Controller('tickets')
export class TicketController {
  constructor(
    private readonly ticketService: TicketService,
    private readonly dispatchService: DispatchService,
  ) {}
```

Then add a new method anywhere inside the class body (after the `reassign` method is a good spot):

```typescript
  @Post(':id/dispatch')
  async dispatch(@Param('id') id: string, @Body() dto: DispatchDto) {
    return this.dispatchService.dispatch(id, dto);
  }
```

- [ ] **Step 2: Build**

Run: `pnpm --filter @prequest/api build`
Expected: compiles.

- [ ] **Step 3: Smoke test via API**

Start dev: `pnpm dev:api` (background) then create a parent case and dispatch:

```bash
# Replace TENANT + PARENT_ID with real values after boot
curl -X POST http://localhost:3000/tickets/PARENT_ID/dispatch \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: TENANT_ID" \
  -d '{"title":"Replace pane","assigned_vendor_id":"VENDOR_ID"}'
```
Expected: 201 with a child ticket object, `ticket_kind="work_order"`, `parent_ticket_id=PARENT_ID`.

(Skip if no live data; tests cover it.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/ticket/ticket.controller.ts
git commit -m "feat(tickets): POST /tickets/:id/dispatch endpoint"
```

---

## Task 10: End-to-end sanity pass

- [ ] **Step 1: Run the full API test suite**

Run: `pnpm --filter @prequest/api test`
Expected: all green.

- [ ] **Step 2: Build the API**

Run: `pnpm --filter @prequest/api build`
Expected: compiles with zero errors.

- [ ] **Step 3: Ask user to push migration**

If tests pass and user confirms, run: `pnpm db:push`

(Per CLAUDE.md: always get user confirmation first. Do **not** run without it.)

- [ ] **Step 4: Verify remote schema**

After push, smoke-check via the API that work-order creation and parent rollup behave correctly on remote data.

---

## Self-Review Notes

- **Spec coverage:** Scenarios 1/2a/2b/3/5a/5b/6 handled by resolver tests. Scenario 4 (owner+vendor) covered by parent/child + DispatchService multi-child test. Scenario 7 (visibility) intentionally deferred.
- **Placeholders:** none — every step has complete code or exact commands.
- **Type consistency:** `DispatchDto` defined in Task 8 and imported in Task 9. `ticket_kind` string literal `'case' | 'work_order'` used consistently. `ChosenBy` additions (`rule`, `space_group_team`, `domain_fallback`) referenced in both resolver.service.ts and tests.
- **Known risk:** the parent-status rollup trigger treats `new` → `assigned` when any child exists — if a case is created, a child is added, then the child resolves, the parent will land in `resolved`. This is intentional (matches the broken-window flow). A case that should remain open after its single child resolves must have its status set manually.
