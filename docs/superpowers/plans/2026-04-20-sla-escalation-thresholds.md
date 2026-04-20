# SLA Escalation Thresholds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `sla_policies.escalation_thresholds` from a dead-weight jsonb stub into a working escalation engine that notifies users/teams (or the requester's manager) and reassigns tickets when an SLA timer crosses a configured percent. Admin UI becomes a proper list-of-rows editor; ticket detail surfaces an audit trail.

**Architecture:** The existing minute-cron (`SlaService.checkBreaches`) grows a third pass that reads policy thresholds, computes percent elapsed, and fires `notify` or `escalate` actions exactly once per crossing. Idempotency + audit live in a new `sla_threshold_crossings` table with a DB-level unique constraint. Frontend replaces the current draft-row footgun with an inline horizontal row editor and a compact "Escalations" list on ticket detail.

**Tech Stack:** NestJS + Supabase (PostgreSQL + RLS) + existing `NotificationService` + existing `BusinessHoursService` on the API. React 19 + shadcn Field primitives + existing `PersonCombobox` / team `Select` on the web. Jest for backend unit tests.

**Spec reference:** `docs/superpowers/specs/2026-04-20-sla-escalation-thresholds-design.md`

---

## File Structure

**New files**

- `supabase/migrations/00037_sla_threshold_crossings.sql` — crossings table + indexes + partial index on `sla_timers` + one-time legacy-threshold migration.
- `apps/api/src/modules/sla/sla-threshold.types.ts` — shared TypeScript interfaces (`EscalationThreshold`, `SlaThresholdCrossing`, `TimerType`).
- `apps/api/src/modules/sla/sla-threshold.helpers.ts` — pure functions (`percentElapsed`, `selectApplicableThresholds`) extracted for easy unit testing.
- `apps/api/src/modules/sla/sla-threshold.helpers.spec.ts` — Jest tests for the helpers.
- `apps/api/src/modules/sla/sla-policy.controller.spec.ts` — Jest tests for validation.
- `apps/web/src/components/admin/sla-threshold-row.tsx` — inline horizontal row editor, reusable.
- `apps/web/src/components/desk/ticket-sla-escalations.tsx` — compact per-ticket history list.

**Modified files**

- `apps/api/src/modules/sla/sla.service.ts` — threshold pass; private helpers for fire + write; new `listCrossingsForTicket`.
- `apps/api/src/modules/sla/sla-policy.controller.ts` — threshold validation in `create` / `update`.
- `apps/api/src/modules/sla/sla.controller.ts` — new `GET /sla/tickets/:ticketId/crossings`.
- `apps/api/src/modules/sla/sla.module.ts` — import `TicketModule` (for `TicketVisibilityService`) and `NotificationModule`.
- `apps/web/src/pages/admin/sla-policies.tsx` — replace draft-row pattern with list-of-rows editor using `<SlaThresholdRow>`.
- `apps/web/src/components/desk/ticket-detail.tsx` — mount `<TicketSlaEscalations>` in the SLA sidebar area (around line 937).

---

## Task 1: DB migration — crossings table, indexes, legacy cleanup

**Files:**
- Create: `supabase/migrations/00037_sla_threshold_crossings.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- SLA threshold crossings — per-fire audit + idempotency for escalation thresholds.
-- See docs/superpowers/specs/2026-04-20-sla-escalation-thresholds-design.md

create table public.sla_threshold_crossings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  sla_timer_id uuid not null references public.sla_timers(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  at_percent integer not null check (at_percent between 1 and 200),
  timer_type text not null check (timer_type in ('response', 'resolution')),
  action text not null check (action in ('notify', 'escalate', 'skipped_no_manager')),
  target_type text not null,
  target_id uuid,
  notification_id uuid references public.notifications(id),
  fired_at timestamptz not null default now(),
  unique (sla_timer_id, at_percent, timer_type)
);

alter table public.sla_threshold_crossings enable row level security;

create policy "tenant_isolation" on public.sla_threshold_crossings
  using (tenant_id = public.current_tenant_id());

create index idx_sla_crossings_timer on public.sla_threshold_crossings (sla_timer_id);
create index idx_sla_crossings_ticket on public.sla_threshold_crossings (ticket_id, fired_at desc);
create index idx_sla_crossings_tenant on public.sla_threshold_crossings (tenant_id);

-- Partial index for the threshold-pass scan in SlaService.checkBreaches.
create index idx_sla_timers_active on public.sla_timers (tenant_id, due_at)
  where breached = false and paused = false and completed_at is null;

-- One-time cleanup: drop any legacy threshold rows that lack a structured target.
-- The old shape was { at_percent, action, notify: string }; the new shape requires
-- target_type + target_id. Admins reconfigure via the new UI.
update public.sla_policies
set escalation_thresholds = (
  select coalesce(jsonb_agg(t), '[]'::jsonb)
  from jsonb_array_elements(escalation_thresholds) as t
  where t ? 'target_type'
)
where escalation_thresholds is not null
  and escalation_thresholds <> '[]'::jsonb;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply migration locally**

Run: `pnpm db:reset 2>&1 | tail -5`
Expected: `Applying migration 00037_sla_threshold_crossings.sql...` and no errors.

- [ ] **Step 3: Verify table and index exist**

Run:
```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "\d public.sla_threshold_crossings" | head -30
```
Expected: table definition with the 12 columns and the `(sla_timer_id, at_percent, timer_type)` unique constraint.

- [ ] **Step 4: Confirm with the user before pushing to remote**

Per `CLAUDE.md`: "Always confirm with the user before running `pnpm db:push` or `supabase db push`."
Ask: "Migration applied locally and verified. Push to remote Supabase now?"
On approval, run: `PGPASSWORD='<db_password>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f supabase/migrations/00037_sla_threshold_crossings.sql`
Do NOT push without explicit user go-ahead.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00037_sla_threshold_crossings.sql
git commit -m "feat(sla): add sla_threshold_crossings table for escalation audit"
```

---

## Task 2: Shared types + pure helpers (TDD)

**Files:**
- Create: `apps/api/src/modules/sla/sla-threshold.types.ts`
- Create: `apps/api/src/modules/sla/sla-threshold.helpers.ts`
- Create: `apps/api/src/modules/sla/sla-threshold.helpers.spec.ts`

- [ ] **Step 1: Create the types file**

`apps/api/src/modules/sla/sla-threshold.types.ts`:
```ts
export type TimerType = 'response' | 'resolution';
export type ThresholdTimerScope = TimerType | 'both';
export type ThresholdAction = 'notify' | 'escalate';
export type ThresholdTargetType = 'user' | 'team' | 'manager_of_requester';
export type RecordedAction = ThresholdAction | 'skipped_no_manager';

export interface EscalationThreshold {
  at_percent: number;          // 1..200
  timer_type: ThresholdTimerScope;
  action: ThresholdAction;
  target_type: ThresholdTargetType;
  target_id: string | null;    // null when target_type === 'manager_of_requester'
}

export interface SlaTimerRow {
  id: string;
  tenant_id: string;
  ticket_id: string;
  sla_policy_id: string;
  timer_type: TimerType;
  target_minutes: number;
  started_at: string;
  due_at: string;
  total_paused_minutes: number;
}

export interface CrossingKey {
  sla_timer_id: string;
  at_percent: number;
  timer_type: TimerType;
}

export function crossingKey(k: CrossingKey): string {
  return `${k.sla_timer_id}|${k.at_percent}|${k.timer_type}`;
}
```

- [ ] **Step 2: Write failing tests for the helpers**

`apps/api/src/modules/sla/sla-threshold.helpers.spec.ts`:
```ts
import {
  percentElapsed,
  selectApplicableThresholds,
} from './sla-threshold.helpers';
import type { EscalationThreshold, SlaTimerRow } from './sla-threshold.types';

const baseTimer: SlaTimerRow = {
  id: 't1',
  tenant_id: 'tenant',
  ticket_id: 'ticket',
  sla_policy_id: 'policy',
  timer_type: 'resolution',
  target_minutes: 240,
  started_at: '2026-04-20T10:00:00Z',
  due_at: '2026-04-20T14:00:00Z',
  total_paused_minutes: 0,
};

describe('percentElapsed', () => {
  it('returns 0 at start', () => {
    expect(percentElapsed(baseTimer, new Date('2026-04-20T10:00:00Z'))).toBe(0);
  });

  it('returns 50 at midpoint', () => {
    expect(percentElapsed(baseTimer, new Date('2026-04-20T12:00:00Z'))).toBe(50);
  });

  it('returns 100 at due_at', () => {
    expect(percentElapsed(baseTimer, new Date('2026-04-20T14:00:00Z'))).toBe(100);
  });

  it('returns >100 past due_at', () => {
    expect(percentElapsed(baseTimer, new Date('2026-04-20T16:00:00Z'))).toBe(150);
  });

  it('returns 0 when due equals start (defensive)', () => {
    const degenerate = { ...baseTimer, due_at: baseTimer.started_at };
    expect(percentElapsed(degenerate, new Date(baseTimer.started_at))).toBe(0);
  });
});

describe('selectApplicableThresholds', () => {
  const thresholds: EscalationThreshold[] = [
    { at_percent: 80, timer_type: 'resolution', action: 'notify', target_type: 'user', target_id: 'u1' },
    { at_percent: 100, timer_type: 'resolution', action: 'escalate', target_type: 'team', target_id: 't1' },
    { at_percent: 80, timer_type: 'response', action: 'notify', target_type: 'user', target_id: 'u2' },
    { at_percent: 50, timer_type: 'both', action: 'notify', target_type: 'user', target_id: 'u3' },
  ];

  it('returns thresholds whose at_percent is <= elapsed and timer_type matches', () => {
    const out = selectApplicableThresholds({
      percent: 85,
      timerType: 'resolution',
      timerId: 't1',
      thresholds,
      firedKeys: new Set(),
    });
    // 80/resolution + 50/both apply; 100/resolution not yet; 80/response wrong type.
    expect(out.map((t) => `${t.at_percent}/${t.timer_type}`).sort()).toEqual([
      '50/both',
      '80/resolution',
    ]);
  });

  it('excludes thresholds already fired', () => {
    const fired = new Set(['t1|80|resolution']);
    const out = selectApplicableThresholds({
      percent: 85,
      timerType: 'resolution',
      timerId: 't1',
      thresholds,
      firedKeys: fired,
    });
    expect(out.map((t) => `${t.at_percent}/${t.timer_type}`).sort()).toEqual(['50/both']);
  });

  it('treats "both" as matching either timer type', () => {
    const onlyBoth: EscalationThreshold[] = [
      { at_percent: 10, timer_type: 'both', action: 'notify', target_type: 'user', target_id: 'u1' },
    ];
    const onResponse = selectApplicableThresholds({
      percent: 20,
      timerType: 'response',
      timerId: 't1',
      thresholds: onlyBoth,
      firedKeys: new Set(),
    });
    const onResolution = selectApplicableThresholds({
      percent: 20,
      timerType: 'resolution',
      timerId: 't1',
      thresholds: onlyBoth,
      firedKeys: new Set(),
    });
    expect(onResponse).toHaveLength(1);
    expect(onResolution).toHaveLength(1);
  });

  it('returns empty when percent is below every threshold', () => {
    const out = selectApplicableThresholds({
      percent: 5,
      timerType: 'resolution',
      timerId: 't1',
      thresholds,
      firedKeys: new Set(),
    });
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/api && npx jest src/modules/sla/sla-threshold.helpers.spec.ts 2>&1 | tail -20`
Expected: FAIL — cannot find module `./sla-threshold.helpers`.

- [ ] **Step 4: Implement the helpers**

`apps/api/src/modules/sla/sla-threshold.helpers.ts`:
```ts
import type {
  EscalationThreshold,
  SlaTimerRow,
  TimerType,
} from './sla-threshold.types';
import { crossingKey } from './sla-threshold.types';

export function percentElapsed(timer: SlaTimerRow, now: Date): number {
  const start = new Date(timer.started_at).getTime();
  const due = new Date(timer.due_at).getTime();
  const total = due - start;
  if (total <= 0) return 0;
  const elapsed = now.getTime() - start;
  return (elapsed / total) * 100;
}

export interface SelectArgs {
  percent: number;
  timerType: TimerType;
  timerId: string;
  thresholds: EscalationThreshold[];
  firedKeys: Set<string>;
}

export function selectApplicableThresholds(args: SelectArgs): EscalationThreshold[] {
  const { percent, timerType, timerId, thresholds, firedKeys } = args;
  return thresholds.filter((t) => {
    const matchesTimer = t.timer_type === timerType || t.timer_type === 'both';
    if (!matchesTimer) return false;
    if (percent < t.at_percent) return false;
    const key = crossingKey({
      sla_timer_id: timerId,
      at_percent: t.at_percent,
      timer_type: timerType,
    });
    return !firedKeys.has(key);
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx jest src/modules/sla/sla-threshold.helpers.spec.ts 2>&1 | tail -10`
Expected: PASS — all assertions green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/sla/sla-threshold.types.ts apps/api/src/modules/sla/sla-threshold.helpers.ts apps/api/src/modules/sla/sla-threshold.helpers.spec.ts
git commit -m "feat(sla): add pure helpers for threshold selection and percent math"
```

---

## Task 3: Policy controller validation (TDD)

**Files:**
- Create: `apps/api/src/modules/sla/sla-policy.controller.spec.ts`
- Modify: `apps/api/src/modules/sla/sla-policy.controller.ts`

- [ ] **Step 1: Extract a pure validator alongside the controller**

Add to the top of `apps/api/src/modules/sla/sla-policy.controller.ts` (above the `@Controller` decorator, after the imports):
```ts
import type { EscalationThreshold, ThresholdTimerScope, ThresholdAction, ThresholdTargetType } from './sla-threshold.types';

const TIMER_SCOPES: readonly ThresholdTimerScope[] = ['response', 'resolution', 'both'];
const ACTIONS: readonly ThresholdAction[] = ['notify', 'escalate'];
const TARGET_TYPES: readonly ThresholdTargetType[] = ['user', 'team', 'manager_of_requester'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateEscalationThresholds(input: unknown): EscalationThreshold[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new BadRequestException('escalation_thresholds must be an array');
  const seen = new Set<string>();
  const out: EscalationThreshold[] = [];
  for (const [i, raw] of input.entries()) {
    if (!raw || typeof raw !== 'object') {
      throw new BadRequestException(`escalation_thresholds[${i}] must be an object`);
    }
    const t = raw as Record<string, unknown>;
    const at = t.at_percent;
    if (typeof at !== 'number' || !Number.isInteger(at) || at < 1 || at > 200) {
      throw new BadRequestException(`escalation_thresholds[${i}].at_percent must be an integer in [1, 200]`);
    }
    if (!TIMER_SCOPES.includes(t.timer_type as ThresholdTimerScope)) {
      throw new BadRequestException(`escalation_thresholds[${i}].timer_type must be one of ${TIMER_SCOPES.join(', ')}`);
    }
    if (!ACTIONS.includes(t.action as ThresholdAction)) {
      throw new BadRequestException(`escalation_thresholds[${i}].action must be one of ${ACTIONS.join(', ')}`);
    }
    if (!TARGET_TYPES.includes(t.target_type as ThresholdTargetType)) {
      throw new BadRequestException(`escalation_thresholds[${i}].target_type must be one of ${TARGET_TYPES.join(', ')}`);
    }
    const targetType = t.target_type as ThresholdTargetType;
    let targetId: string | null = null;
    if (targetType === 'manager_of_requester') {
      if (t.target_id !== null && t.target_id !== undefined) {
        throw new BadRequestException(`escalation_thresholds[${i}].target_id must be null for manager_of_requester`);
      }
    } else {
      if (typeof t.target_id !== 'string' || !UUID_RE.test(t.target_id)) {
        throw new BadRequestException(`escalation_thresholds[${i}].target_id must be a uuid`);
      }
      targetId = t.target_id;
    }
    const key = `${at}|${t.timer_type}`;
    if (seen.has(key)) {
      throw new BadRequestException(`escalation_thresholds has duplicate (at_percent=${at}, timer_type=${String(t.timer_type)})`);
    }
    seen.add(key);
    out.push({
      at_percent: at,
      timer_type: t.timer_type as ThresholdTimerScope,
      action: t.action as ThresholdAction,
      target_type: targetType,
      target_id: targetId,
    });
  }
  return out;
}
```

Also at the top, if `BadRequestException` isn't imported yet, add `BadRequestException` to the `@nestjs/common` import.

- [ ] **Step 2: Write failing tests for the validator**

`apps/api/src/modules/sla/sla-policy.controller.spec.ts`:
```ts
import { BadRequestException } from '@nestjs/common';
import { validateEscalationThresholds } from './sla-policy.controller';

const u1 = '00000000-0000-0000-0000-000000000001';
const u2 = '00000000-0000-0000-0000-000000000002';

describe('validateEscalationThresholds', () => {
  it('returns [] for null or undefined', () => {
    expect(validateEscalationThresholds(null)).toEqual([]);
    expect(validateEscalationThresholds(undefined)).toEqual([]);
  });

  it('accepts a well-formed array', () => {
    const input = [
      { at_percent: 80, timer_type: 'response', action: 'notify', target_type: 'user', target_id: u1 },
      { at_percent: 100, timer_type: 'resolution', action: 'escalate', target_type: 'team', target_id: u2 },
      { at_percent: 120, timer_type: 'both', action: 'notify', target_type: 'manager_of_requester', target_id: null },
    ];
    expect(validateEscalationThresholds(input)).toHaveLength(3);
  });

  it('rejects non-integer or out-of-range at_percent', () => {
    expect(() => validateEscalationThresholds([{ at_percent: 0, timer_type: 'response', action: 'notify', target_type: 'user', target_id: u1 }])).toThrow(BadRequestException);
    expect(() => validateEscalationThresholds([{ at_percent: 201, timer_type: 'response', action: 'notify', target_type: 'user', target_id: u1 }])).toThrow(BadRequestException);
    expect(() => validateEscalationThresholds([{ at_percent: 80.5, timer_type: 'response', action: 'notify', target_type: 'user', target_id: u1 }])).toThrow(BadRequestException);
  });

  it('rejects unknown timer_type / action / target_type', () => {
    expect(() => validateEscalationThresholds([{ at_percent: 80, timer_type: 'bogus', action: 'notify', target_type: 'user', target_id: u1 }])).toThrow(BadRequestException);
    expect(() => validateEscalationThresholds([{ at_percent: 80, timer_type: 'response', action: 'delete', target_type: 'user', target_id: u1 }])).toThrow(BadRequestException);
    expect(() => validateEscalationThresholds([{ at_percent: 80, timer_type: 'response', action: 'notify', target_type: 'nobody', target_id: u1 }])).toThrow(BadRequestException);
  });

  it('rejects missing target_id for user/team', () => {
    expect(() => validateEscalationThresholds([{ at_percent: 80, timer_type: 'response', action: 'notify', target_type: 'user', target_id: null }])).toThrow(BadRequestException);
    expect(() => validateEscalationThresholds([{ at_percent: 80, timer_type: 'response', action: 'notify', target_type: 'team', target_id: 'not-a-uuid' }])).toThrow(BadRequestException);
  });

  it('rejects non-null target_id for manager_of_requester', () => {
    expect(() => validateEscalationThresholds([{ at_percent: 80, timer_type: 'response', action: 'notify', target_type: 'manager_of_requester', target_id: u1 }])).toThrow(BadRequestException);
  });

  it('rejects duplicate (at_percent, timer_type) pairs', () => {
    const dup = [
      { at_percent: 80, timer_type: 'response', action: 'notify', target_type: 'user', target_id: u1 },
      { at_percent: 80, timer_type: 'response', action: 'escalate', target_type: 'team', target_id: u2 },
    ];
    expect(() => validateEscalationThresholds(dup)).toThrow(BadRequestException);
  });
});
```

- [ ] **Step 3: Run tests — first implementation pass must already satisfy them**

Run: `cd apps/api && npx jest src/modules/sla/sla-policy.controller.spec.ts 2>&1 | tail -10`
Expected: PASS on all seven cases. If anything fails, fix the validator, do not loosen the test.

- [ ] **Step 4: Wire the validator into `create` and `update`**

In `apps/api/src/modules/sla/sla-policy.controller.ts`, change `create` and `update` so they validate before passing to Supabase. Note: when `escalation_thresholds` is absent from the PATCH dto, do NOT pass it through (otherwise the validator writes `[]` and clobbers existing thresholds).

Replace the existing `@Post` and `@Patch` blocks with:
```ts
@Post()
async create(@Body() dto: { name: string; response_time_minutes?: number; resolution_time_minutes?: number; escalation_thresholds?: unknown; [k: string]: unknown }) {
  const tenant = TenantContext.current();
  const payload: Record<string, unknown> = { ...dto, tenant_id: tenant.id };
  if ('escalation_thresholds' in dto) {
    payload.escalation_thresholds = validateEscalationThresholds(dto.escalation_thresholds);
  }
  const { data, error } = await this.supabase.admin
    .from('sla_policies')
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data;
}

@Patch(':id')
async update(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
  const tenant = TenantContext.current();
  const payload: Record<string, unknown> = { ...dto };
  if ('escalation_thresholds' in dto) {
    payload.escalation_thresholds = validateEscalationThresholds(dto.escalation_thresholds);
  }
  const { data, error } = await this.supabase.admin
    .from('sla_policies')
    .update(payload)
    .eq('id', id)
    .eq('tenant_id', tenant.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}
```

- [ ] **Step 5: Typecheck + rerun tests**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | head -10 && npx jest src/modules/sla 2>&1 | tail -10`
Expected: no type errors, all SLA tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/sla/sla-policy.controller.ts apps/api/src/modules/sla/sla-policy.controller.spec.ts
git commit -m "feat(sla): validate escalation_thresholds shape on policy create/update"
```

---

## Task 4: SLA module wiring (TicketVisibility + Notification)

**Files:**
- Modify: `apps/api/src/modules/sla/sla.module.ts`

- [ ] **Step 1: Update the module to import TicketModule and NotificationModule**

Replace the file contents with:
```ts
import { Module, forwardRef } from '@nestjs/common';
import { SlaService } from './sla.service';
import { BusinessHoursService } from './business-hours.service';
import { SlaController } from './sla.controller';
import { SlaPolicyController } from './sla-policy.controller';
import { NotificationModule } from '../notification/notification.module';
import { TicketModule } from '../ticket/ticket.module';

@Module({
  imports: [NotificationModule, forwardRef(() => TicketModule)],
  providers: [SlaService, BusinessHoursService],
  controllers: [SlaController, SlaPolicyController],
  exports: [SlaService],
})
export class SlaModule {}
```

`forwardRef` protects against a circular import (TicketModule already imports SlaModule indirectly via ticket.service; if there isn't one today, `forwardRef` is harmless insurance).

- [ ] **Step 2: If TicketModule imports SlaModule, symmetrize**

Run: `grep -n "SlaModule\|SlaService" /Users/x/Desktop/XPQT/apps/api/src/modules/ticket/ticket.module.ts`
If any match, change that import to `forwardRef(() => SlaModule)` too. Otherwise skip.

- [ ] **Step 3: Build to verify module graph**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | tail -5`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/sla/sla.module.ts apps/api/src/modules/ticket/ticket.module.ts
git commit -m "chore(sla): import notification + ticket modules for escalation wiring"
```

---

## Task 5: SlaService — resolve target helper (TDD-flavoured)

**Files:**
- Modify: `apps/api/src/modules/sla/sla.service.ts`

- [ ] **Step 1: Add imports at the top of `sla.service.ts`**

```ts
import { NotificationService } from '../notification/notification.service';
import { TicketVisibilityService } from '../ticket/ticket-visibility.service';
import type {
  EscalationThreshold,
  SlaTimerRow,
  TimerType,
  ThresholdTargetType,
  RecordedAction,
} from './sla-threshold.types';
import { crossingKey } from './sla-threshold.types';
import { percentElapsed, selectApplicableThresholds } from './sla-threshold.helpers';
```

- [ ] **Step 2: Inject the new deps into the constructor**

Replace:
```ts
constructor(
  private readonly supabase: SupabaseService,
  private readonly businessHours: BusinessHoursService,
) {}
```
with:
```ts
constructor(
  private readonly supabase: SupabaseService,
  private readonly businessHours: BusinessHoursService,
  private readonly notifications: NotificationService,
  private readonly visibility: TicketVisibilityService,
) {}
```

- [ ] **Step 3: Add the target-resolution helper as a private method on `SlaService`**

Append inside the class (before the closing `}`):
```ts
/**
 * Resolve an escalation-threshold target to either a `persons.id` or a `teams.id`.
 * Returns null for `manager_of_requester` when the requester has no manager — the
 * caller should record a `skipped_no_manager` crossing and move on.
 */
private async resolveTarget(
  threshold: EscalationThreshold,
  ticketId: string,
): Promise<{ personId?: string; teamId?: string } | null> {
  if (threshold.target_type === 'user' && threshold.target_id) {
    return { personId: threshold.target_id };
  }
  if (threshold.target_type === 'team' && threshold.target_id) {
    return { teamId: threshold.target_id };
  }
  if (threshold.target_type === 'manager_of_requester') {
    const { data: ticket } = await this.supabase.admin
      .from('tickets')
      .select('requester_person_id')
      .eq('id', ticketId)
      .single();
    const requesterId = ticket?.requester_person_id as string | null;
    if (!requesterId) return null;
    const { data: requester } = await this.supabase.admin
      .from('persons')
      .select('manager_person_id')
      .eq('id', requesterId)
      .single();
    const managerId = requester?.manager_person_id as string | null;
    if (!managerId) return null;
    return { personId: managerId };
  }
  return null;
}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | tail -5`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sla/sla.service.ts
git commit -m "feat(sla): add resolveTarget helper for escalation thresholds"
```

---

## Task 6: SlaService — fire + write crossing

**Files:**
- Modify: `apps/api/src/modules/sla/sla.service.ts`

- [ ] **Step 1: Add a helper to look up ticket context used by firing**

Append to `SlaService`:
```ts
private async loadTicketForFire(ticketId: string) {
  const { data, error } = await this.supabase.admin
    .from('tickets')
    .select('id, tenant_id, title, assigned_user_id, assigned_team_id, requester_person_id, watchers')
    .eq('id', ticketId)
    .single();
  if (error) throw error;
  return data as {
    id: string;
    tenant_id: string;
    title: string;
    assigned_user_id: string | null;
    assigned_team_id: string | null;
    requester_person_id: string | null;
    watchers: string[] | null;
  };
}

private async loadPolicyName(policyId: string): Promise<string> {
  const { data } = await this.supabase.admin
    .from('sla_policies')
    .select('name')
    .eq('id', policyId)
    .single();
  return (data?.name as string) ?? 'SLA policy';
}

private buildNotificationCopy(args: {
  ticketId: string;
  ticketTitle: string;
  atPercent: number;
  timerType: TimerType;
  policyName: string;
  actionVerb: 'Notified' | 'Escalated to';
  targetName: string;
  dueAt: string;
}) {
  // There's no ticket.number column yet; short-id is the pragmatic display stand-in.
  const shortId = args.ticketId.slice(0, 8);
  const subject = `[Ticket ${shortId}] SLA ${args.timerType} at ${args.atPercent}%`;
  const body = `Ticket "${args.ticketTitle}" has reached ${args.atPercent}% of its ${args.timerType} SLA (${args.policyName}). ${args.actionVerb} ${args.targetName}. Target: ${args.dueAt}.`;
  return { subject, body };
}
```

- [ ] **Step 2: Add the "fire one threshold" method**

Append to `SlaService`:
```ts
/**
 * Fire a single threshold for a single timer. Writes a crossing row (the idempotency
 * record), sends notifications, and — for `escalate` — reassigns the ticket.
 * Swallows `23505` (unique_violation) so racing cron ticks are safe.
 */
private async fireThreshold(
  timer: SlaTimerRow,
  threshold: EscalationThreshold,
): Promise<void> {
  const ticket = await this.loadTicketForFire(timer.ticket_id);
  const policyName = await this.loadPolicyName(timer.sla_policy_id);
  const resolved = await this.resolveTarget(threshold, ticket.id);

  // Skip path — record a crossing so we don't retry forever.
  if (!resolved) {
    await this.writeCrossing({
      tenant_id: ticket.tenant_id,
      sla_timer_id: timer.id,
      ticket_id: ticket.id,
      at_percent: threshold.at_percent,
      timer_type: timer.timer_type,
      action: 'skipped_no_manager',
      target_type: threshold.target_type,
      target_id: null,
      notification_id: null,
    });
    await this.emitEvent(ticket.tenant_id, ticket.id, 'sla_threshold_crossed', {
      timer_type: timer.timer_type,
      at_percent: threshold.at_percent,
      action: 'skipped_no_manager',
      target_type: threshold.target_type,
    });
    return;
  }

  // Compute notification copy.
  const targetName = await this.resolveTargetName(resolved);
  const { subject, body } = this.buildNotificationCopy({
    ticketId: ticket.id,
    ticketTitle: ticket.title,
    atPercent: threshold.at_percent,
    timerType: timer.timer_type,
    policyName,
    actionVerb: threshold.action === 'escalate' ? 'Escalated to' : 'Notified',
    targetName,
    dueAt: timer.due_at,
  });

  // Reassignment for `escalate`.
  let reassigned = false;
  if (threshold.action === 'escalate') {
    reassigned = await this.applyReassignment(ticket, resolved);
    if (reassigned) {
      await this.writeActivity(ticket, threshold, policyName);
    }
  }

  // Fan out notifications.
  let firstNotificationId: string | null = null;
  const notifyArgs = {
    notification_type: 'sla_threshold_crossed',
    related_entity_type: 'ticket',
    related_entity_id: ticket.id,
    subject,
    body,
  };
  if (resolved.teamId) {
    const sent = await this.notifications.sendToTeam(resolved.teamId, notifyArgs);
    firstNotificationId = (sent?.[0]?.id as string) ?? null;
  } else if (resolved.personId) {
    const sent = await this.notifications.send({ ...notifyArgs, recipient_person_id: resolved.personId });
    firstNotificationId = (sent?.[0]?.id as string) ?? null;
  }

  // Write crossing (idempotency anchor) — unique constraint swallows duplicates.
  await this.writeCrossing({
    tenant_id: ticket.tenant_id,
    sla_timer_id: timer.id,
    ticket_id: ticket.id,
    at_percent: threshold.at_percent,
    timer_type: timer.timer_type,
    action: threshold.action,
    target_type: threshold.target_type,
    target_id: resolved.personId ?? resolved.teamId ?? null,
    notification_id: firstNotificationId,
  });

  await this.emitEvent(ticket.tenant_id, ticket.id, 'sla_threshold_crossed', {
    timer_type: timer.timer_type,
    at_percent: threshold.at_percent,
    action: threshold.action,
    target_type: threshold.target_type,
    target_id: resolved.personId ?? resolved.teamId,
    reassigned,
  });
}

private async resolveTargetName(resolved: { personId?: string; teamId?: string }): Promise<string> {
  if (resolved.personId) {
    const { data } = await this.supabase.admin
      .from('persons')
      .select('first_name, last_name')
      .eq('id', resolved.personId)
      .single();
    if (!data) return 'person';
    return `${(data.first_name as string) ?? ''} ${(data.last_name as string) ?? ''}`.trim() || 'person';
  }
  if (resolved.teamId) {
    const { data } = await this.supabase.admin
      .from('teams')
      .select('name')
      .eq('id', resolved.teamId)
      .single();
    return (data?.name as string) ?? 'team';
  }
  return 'target';
}

/**
 * Reassign ticket based on resolved target. Returns true if an assignment actually changed.
 * For user targets: set assigned_user_id, keep assigned_team_id; move previous user to watchers.
 * For team targets: set assigned_team_id, null assigned_user_id; move previous user to watchers.
 */
private async applyReassignment(
  ticket: { id: string; tenant_id: string; assigned_user_id: string | null; assigned_team_id: string | null; watchers: string[] | null },
  resolved: { personId?: string; teamId?: string },
): Promise<boolean> {
  const updates: Record<string, unknown> = {};
  let changed = false;
  const newWatchers = new Set<string>((ticket.watchers as string[] | null) ?? []);

  if (resolved.teamId) {
    if (ticket.assigned_team_id !== resolved.teamId) {
      updates.assigned_team_id = resolved.teamId;
      updates.assigned_user_id = null;
      if (ticket.assigned_user_id) newWatchers.add(ticket.assigned_user_id);
      changed = true;
    }
  } else if (resolved.personId) {
    // Note: assigned_user_id references public.users(id) in the tickets schema.
    // resolveTarget returns a person id for user/manager targets; look up the user.
    const { data: user } = await this.supabase.admin
      .from('users')
      .select('id, person_id')
      .eq('person_id', resolved.personId)
      .single();
    const newAssigneeUserId = (user?.id as string) ?? null;
    if (newAssigneeUserId && ticket.assigned_user_id !== newAssigneeUserId) {
      updates.assigned_user_id = newAssigneeUserId;
      if (ticket.assigned_user_id) newWatchers.add(ticket.assigned_user_id);
      changed = true;
    }
  }

  if (changed) {
    updates.watchers = Array.from(newWatchers);
    await this.supabase.admin.from('tickets').update(updates).eq('id', ticket.id);
  }
  return changed;
}

private async writeCrossing(row: {
  tenant_id: string;
  sla_timer_id: string;
  ticket_id: string;
  at_percent: number;
  timer_type: TimerType;
  action: RecordedAction;
  target_type: ThresholdTargetType;
  target_id: string | null;
  notification_id: string | null;
}) {
  const { error } = await this.supabase.admin
    .from('sla_threshold_crossings')
    .insert(row);
  // Ignore unique_violation (23505) — another cron tick beat us to it.
  if (error && (error as { code?: string }).code !== '23505') throw error;
}

private async writeActivity(
  ticket: { id: string; tenant_id: string },
  threshold: EscalationThreshold,
  policyName: string,
) {
  await this.supabase.admin.from('ticket_activities').insert({
    tenant_id: ticket.tenant_id,
    ticket_id: ticket.id,
    activity_type: 'system_event',
    visibility: 'system',
    content: `SLA escalated — ${policyName} at ${threshold.at_percent}% of ${threshold.timer_type}`,
    metadata: {
      source: 'sla_escalation',
      at_percent: threshold.at_percent,
      timer_type: threshold.timer_type,
      target_type: threshold.target_type,
    },
  });
}

private async emitEvent(
  tenantId: string,
  ticketId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  await this.supabase.admin.from('domain_events').insert({
    tenant_id: tenantId,
    event_type: eventType,
    entity_type: 'ticket',
    entity_id: ticketId,
    payload,
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | tail -10`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/sla/sla.service.ts
git commit -m "feat(sla): add fireThreshold with reassignment, notifications, audit"
```

---

## Task 7: SlaService — threshold pass in the cron

**Files:**
- Modify: `apps/api/src/modules/sla/sla.service.ts`

- [ ] **Step 1: Add the orchestrator method**

Append to `SlaService`:
```ts
/**
 * Threshold pass — runs after breach + at-risk detection in the minute cron.
 * Bounded to 500 active timers per tick to protect the cron; overflow picks up next tick.
 */
private async processThresholds(now: Date) {
  const { data: timers } = await this.supabase.admin
    .from('sla_timers')
    .select('id, tenant_id, ticket_id, sla_policy_id, timer_type, target_minutes, started_at, due_at, total_paused_minutes')
    .eq('breached', false)
    .eq('paused', false)
    .is('completed_at', null)
    .order('due_at', { ascending: true })
    .limit(500);

  const timerRows = (timers ?? []) as SlaTimerRow[];
  if (timerRows.length === 0) return;

  // Load distinct policies used by this batch in one query.
  const policyIds = Array.from(new Set(timerRows.map((t) => t.sla_policy_id)));
  const { data: policies } = await this.supabase.admin
    .from('sla_policies')
    .select('id, escalation_thresholds')
    .in('id', policyIds);
  const thresholdsByPolicy = new Map<string, EscalationThreshold[]>();
  for (const p of policies ?? []) {
    const raw = (p.escalation_thresholds as EscalationThreshold[] | null) ?? [];
    thresholdsByPolicy.set(p.id as string, raw);
  }

  // Load existing crossings for this batch in one query.
  const timerIds = timerRows.map((t) => t.id);
  const { data: crossings } = await this.supabase.admin
    .from('sla_threshold_crossings')
    .select('sla_timer_id, at_percent, timer_type')
    .in('sla_timer_id', timerIds);
  const firedKeys = new Set<string>(
    (crossings ?? []).map((c) =>
      crossingKey({
        sla_timer_id: c.sla_timer_id as string,
        at_percent: c.at_percent as number,
        timer_type: c.timer_type as TimerType,
      }),
    ),
  );

  // Iterate timers and fire applicable thresholds sequentially.
  for (const timer of timerRows) {
    try {
      const thresholds = thresholdsByPolicy.get(timer.sla_policy_id) ?? [];
      if (thresholds.length === 0) continue;
      const percent = percentElapsed(timer, now);
      const applicable = selectApplicableThresholds({
        percent,
        timerType: timer.timer_type,
        timerId: timer.id,
        thresholds,
        firedKeys,
      });
      // Fire in ascending percent order so "80 notify" always precedes "100 escalate".
      applicable.sort((a, b) => a.at_percent - b.at_percent);
      for (const threshold of applicable) {
        await this.fireThreshold(timer, threshold);
        // Track in-memory so a single tick doesn't try to fire the same key twice
        // across the two iterations of a `both`-scoped threshold.
        firedKeys.add(
          crossingKey({
            sla_timer_id: timer.id,
            at_percent: threshold.at_percent,
            timer_type: timer.timer_type,
          }),
        );
      }
    } catch (err) {
      await this.emitEvent(timer.tenant_id, timer.ticket_id, 'sla_threshold_fire_failed', {
        timer_id: timer.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Keep going — one bad ticket does not starve the batch.
    }
  }
}
```

- [ ] **Step 2: Call the pass at the end of `checkBreaches`**

In `SlaService.checkBreaches`, after the existing at-risk loop (end of the method), add:
```ts
// Threshold-crossing pass — fires notify/escalate actions.
await this.processThresholds(now);
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | tail -5`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/sla/sla.service.ts
git commit -m "feat(sla): add threshold pass to minute cron (fires escalations)"
```

---

## Task 8: GET /sla/tickets/:ticketId/crossings endpoint

**Files:**
- Modify: `apps/api/src/modules/sla/sla.service.ts`
- Modify: `apps/api/src/modules/sla/sla.controller.ts`

- [ ] **Step 1: Add the service method**

Append to `SlaService`:
```ts
/**
 * List threshold crossings for a ticket, ordered newest first, with the target's
 * resolved display name joined in. Intended for the ticket-detail escalations panel.
 */
async listCrossingsForTicket(ticketId: string) {
  const { data: rows, error } = await this.supabase.admin
    .from('sla_threshold_crossings')
    .select('id, fired_at, timer_type, at_percent, action, target_type, target_id, notification_id')
    .eq('ticket_id', ticketId)
    .order('fired_at', { ascending: false });
  if (error) throw error;

  // Resolve target display names in two batched lookups (persons + teams).
  const personIds = (rows ?? []).filter((r) => r.target_type === 'user' || r.target_type === 'manager_of_requester').map((r) => r.target_id).filter((x): x is string => !!x);
  const teamIds = (rows ?? []).filter((r) => r.target_type === 'team').map((r) => r.target_id).filter((x): x is string => !!x);

  const personNames = new Map<string, string>();
  if (personIds.length > 0) {
    const { data } = await this.supabase.admin.from('persons').select('id, first_name, last_name').in('id', personIds);
    for (const p of data ?? []) {
      const name = `${(p.first_name as string) ?? ''} ${(p.last_name as string) ?? ''}`.trim() || 'person';
      personNames.set(p.id as string, name);
    }
  }
  const teamNames = new Map<string, string>();
  if (teamIds.length > 0) {
    const { data } = await this.supabase.admin.from('teams').select('id, name').in('id', teamIds);
    for (const t of data ?? []) teamNames.set(t.id as string, (t.name as string) ?? 'team');
  }

  return (rows ?? []).map((r) => ({
    ...r,
    target_name: r.target_id
      ? (r.target_type === 'team' ? teamNames.get(r.target_id) : personNames.get(r.target_id)) ?? null
      : null,
  }));
}
```

- [ ] **Step 2: Add the controller route with visibility check**

Replace the contents of `apps/api/src/modules/sla/sla.controller.ts` with:
```ts
import { Controller, Get, Param, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { SlaService } from './sla.service';
import { TicketVisibilityService } from '../ticket/ticket-visibility.service';
import { TenantContext } from '../../common/tenant-context';

@Controller('sla')
export class SlaController {
  constructor(
    private readonly slaService: SlaService,
    private readonly visibility: TicketVisibilityService,
  ) {}

  @Get('tickets/:ticketId/status')
  async getTicketSlaStatus(@Param('ticketId') ticketId: string) {
    return this.slaService.getTicketSlaStatus(ticketId);
  }

  @Get('tickets/:ticketId/crossings')
  async getTicketSlaCrossings(@Req() request: Request, @Param('ticketId') ticketId: string) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    const tenant = TenantContext.current();
    const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
    await this.visibility.assertVisible(ticketId, ctx, 'read');
    return this.slaService.listCrossingsForTicket(ticketId);
  }
}
```

- [ ] **Step 3: Register TicketVisibilityService as a controller-level dep**

`TicketVisibilityService` is already exported from `TicketModule`, which Task 4 imported into `SlaModule`. Verify Nest resolves it:

Run: `cd apps/api && npx tsc --noEmit 2>&1 | tail -5`
Expected: no errors.

Run: `cd apps/api && pnpm test -- --testPathPattern=sla 2>&1 | tail -15` (or `npx jest src/modules/sla`) — existing + new SLA tests still pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/sla/sla.service.ts apps/api/src/modules/sla/sla.controller.ts
git commit -m "feat(sla): GET /sla/tickets/:id/crossings for escalation history"
```

---

## Task 9: Web — shared types + API for crossings

**Files:**
- Modify: `apps/web/src/pages/admin/sla-policies.tsx` (types only for now)
- Create: none yet — types inlined so the frontend imports stay minimal.

- [ ] **Step 1: Update the `EscalationThreshold` type in `sla-policies.tsx`**

Replace the existing interface:
```ts
interface EscalationThreshold {
  at_percent: number;
  action: 'notify' | 'escalate';
  notify: string;
}
```
with:
```ts
export type ThresholdTimerScope = 'response' | 'resolution' | 'both';
export type ThresholdAction = 'notify' | 'escalate';
export type ThresholdTargetType = 'user' | 'team' | 'manager_of_requester';

export interface EscalationThreshold {
  at_percent: number;
  timer_type: ThresholdTimerScope;
  action: ThresholdAction;
  target_type: ThresholdTargetType;
  target_id: string | null;
}
```

- [ ] **Step 2: Typecheck — expect breakage in the file you'll fix next**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | head -30`
Expected: errors pointing at `newEscNotify`, `addEscalation`, the draft UI — those are the rows Task 10 rewrites. Do not yet attempt to fix them.

- [ ] **Step 3: No commit yet** — changes are only coherent once Task 10 lands.

---

## Task 10: Web — SlaThresholdRow component

**Files:**
- Create: `apps/web/src/components/admin/sla-threshold-row.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { PersonCombobox } from '@/components/person-combobox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Trash2 } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import type {
  EscalationThreshold,
  ThresholdAction,
  ThresholdTargetType,
  ThresholdTimerScope,
} from '@/pages/admin/sla-policies';

interface Team { id: string; name: string }

interface SlaThresholdRowProps {
  value: EscalationThreshold;
  onChange: (next: EscalationThreshold) => void;
  onRemove: () => void;
  index: number;
}

export function SlaThresholdRow({ value, onChange, onRemove, index }: SlaThresholdRowProps) {
  const { data: teams } = useApi<Team[]>('/teams', []);

  const patch = (partial: Partial<EscalationThreshold>) => onChange({ ...value, ...partial });

  const percentInvalid =
    !Number.isFinite(value.at_percent) || value.at_percent < 1 || value.at_percent > 200;
  const targetInvalid =
    value.target_type !== 'manager_of_requester' && !value.target_id;

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md bg-muted/40 px-3 py-2">
      <span className="text-xs text-muted-foreground self-center">At</span>

      <Input
        id={`esc-pct-${index}`}
        type="number"
        value={value.at_percent}
        onChange={(e) => patch({ at_percent: parseInt(e.target.value || '0', 10) })}
        className={`h-8 w-16 text-sm ${percentInvalid ? 'border-red-500' : ''}`}
        min={1}
        max={200}
      />
      <span className="text-xs text-muted-foreground self-center">% of</span>

      <Select value={value.timer_type} onValueChange={(v) => patch({ timer_type: (v ?? 'resolution') as ThresholdTimerScope })}>
        <SelectTrigger className="h-8 w-32 text-sm"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="response">Response</SelectItem>
          <SelectItem value="resolution">Resolution</SelectItem>
          <SelectItem value="both">Both</SelectItem>
        </SelectContent>
      </Select>

      <span className="text-xs text-muted-foreground self-center">→</span>

      <Select value={value.action} onValueChange={(v) => patch({ action: (v ?? 'notify') as ThresholdAction })}>
        <SelectTrigger className="h-8 w-36 text-sm"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="notify">Notify</SelectItem>
          <SelectItem value="escalate">Escalate (reassign)</SelectItem>
        </SelectContent>
      </Select>

      <Select
        value={value.target_type}
        onValueChange={(v) => patch({
          target_type: (v ?? 'user') as ThresholdTargetType,
          target_id: null,
        })}
      >
        <SelectTrigger className="h-8 w-44 text-sm"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="user">User</SelectItem>
          <SelectItem value="team">Team</SelectItem>
          <SelectItem value="manager_of_requester">Requester's manager</SelectItem>
        </SelectContent>
      </Select>

      {value.target_type === 'user' && (
        <div className={`flex-1 min-w-[220px] ${targetInvalid ? 'ring-1 ring-red-500 rounded-md' : ''}`}>
          <PersonCombobox
            value={value.target_id ?? ''}
            onChange={(id) => patch({ target_id: id || null })}
          />
        </div>
      )}

      {value.target_type === 'team' && (
        <Select value={value.target_id ?? ''} onValueChange={(v) => patch({ target_id: v || null })}>
          <SelectTrigger className={`h-8 w-52 text-sm ${targetInvalid ? 'border-red-500' : ''}`}>
            <SelectValue placeholder="Pick a team…" />
          </SelectTrigger>
          <SelectContent>
            {(teams ?? []).map((t) => (
              <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {value.target_type === 'manager_of_requester' && (
        <span className="text-xs text-muted-foreground self-center">
          Uses the requester's manager from their profile.
        </span>
      )}

      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onRemove}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function isThresholdValid(t: EscalationThreshold): boolean {
  if (!Number.isInteger(t.at_percent) || t.at_percent < 1 || t.at_percent > 200) return false;
  if (t.target_type === 'manager_of_requester') return true;
  return !!t.target_id;
}
```

- [ ] **Step 2: Check `PersonCombobox` signature matches**

Run: `grep -n "interface\|PersonComboboxProps\|export function PersonCombobox" /Users/x/Desktop/XPQT/apps/web/src/components/person-combobox.tsx | head -10`
If props differ from `{ value: string | null; onChange: (id: string | null) => void }`, adjust the usage in step 1 accordingly. Rerun after.

- [ ] **Step 3: Typecheck (component in isolation is still broken until Task 11 imports it correctly)**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | head -30`
Expected: the old sla-policies.tsx is still broken from Task 9 but the new component itself is clean. No regression in other files.

- [ ] **Step 4: No commit yet** — bundle with Task 11 so the web app is green at every commit.

---

## Task 11: Web — refactor admin dialog to list-of-rows editor

**Files:**
- Modify: `apps/web/src/pages/admin/sla-policies.tsx`

- [ ] **Step 1: Delete the draft-row state and handlers**

In `SlaPoliciesPage`, remove:
- `newEscPercent`, `setNewEscPercent`
- `newEscAction`, `setNewEscAction`
- `newEscNotify`, `setNewEscNotify`
- `addEscalation` function
- `removeEscalation` function
- The auto-commit block added in the earlier footgun fix inside `handleSave`.

Also remove the `setNewEscPercent('')` / `setNewEscAction('notify')` / `setNewEscNotify('')` lines from `resetForm`.

- [ ] **Step 2: Add new handlers for the list editor**

In `SlaPoliciesPage`, add near the existing escalations state:
```ts
const addThreshold = () => {
  setEscalations((prev) => [
    ...prev,
    {
      at_percent: 100,
      timer_type: 'resolution',
      action: 'notify',
      target_type: 'user',
      target_id: null,
    },
  ]);
};

const updateThreshold = (index: number, next: EscalationThreshold) => {
  setEscalations((prev) => prev.map((t, i) => (i === index ? next : t)));
};

const removeThreshold = (index: number) => {
  setEscalations((prev) => prev.filter((_, i) => i !== index));
};
```

- [ ] **Step 3: Import the new component and validator**

At the top of the file, add:
```ts
import { SlaThresholdRow, isThresholdValid } from '@/components/admin/sla-threshold-row';
```

- [ ] **Step 4: Replace the FieldSet contents**

Find the existing `<FieldSet>` with `<FieldLegend variant="label">Escalation Thresholds</FieldLegend>` and replace its children (everything inside the fieldset) with:
```tsx
<FieldSet>
  <FieldLegend variant="label">Escalation Thresholds</FieldLegend>
  <FieldDescription>
    Fire actions when an SLA timer reaches a percent of its target.
  </FieldDescription>
  {escalations.length === 0 ? (
    <FieldDescription>
      No thresholds yet. Click Add threshold to notify or reassign when a ticket nears or misses its SLA.
    </FieldDescription>
  ) : (
    <div className="space-y-2">
      {escalations.map((t, i) => (
        <SlaThresholdRow
          key={i}
          index={i}
          value={t}
          onChange={(next) => updateThreshold(i, next)}
          onRemove={() => removeThreshold(i)}
        />
      ))}
    </div>
  )}
  <Button variant="outline" size="sm" className="self-start mt-1" onClick={addThreshold}>
    + Add threshold
  </Button>
</FieldSet>
```

- [ ] **Step 5: Gate Save on threshold validity**

Replace the Save button's `disabled` condition:
```tsx
<Button
  onClick={handleSave}
  disabled={!name.trim() || !escalations.every(isThresholdValid)}
>
  {editId ? 'Save' : 'Create'}
</Button>
```

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | tail -10`
Expected: clean.

- [ ] **Step 7: Manual smoke in the browser**

Run: `pnpm dev:web` in a separate terminal (if not already running).
Open the Admin → SLA Policies page → edit any policy.
Verify:
- Existing thresholds render as rows (if the policy has any after the migration; otherwise the empty-state copy shows).
- Adding a threshold inserts a row with defaults `100 / resolution / notify / user / (pick one)`.
- Save is disabled until a target is picked.
- Saving persists; reopening shows the row restored.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/admin/sla-threshold-row.tsx apps/web/src/pages/admin/sla-policies.tsx
git commit -m "feat(web): list-of-rows editor for SLA escalation thresholds"
```

---

## Task 12: Web — Ticket detail Escalations section

**Files:**
- Create: `apps/web/src/components/desk/ticket-sla-escalations.tsx`
- Modify: `apps/web/src/components/desk/ticket-detail.tsx` (around line 937, after the existing SLA block)

- [ ] **Step 1: Create the new component**

```tsx
import { useApi } from '@/hooks/use-api';

interface Crossing {
  id: string;
  fired_at: string;
  timer_type: 'response' | 'resolution';
  at_percent: number;
  action: 'notify' | 'escalate' | 'skipped_no_manager';
  target_type: 'user' | 'team' | 'manager_of_requester';
  target_id: string | null;
  target_name: string | null;
  notification_id: string | null;
}

function describe(c: Crossing): { main: string; muted: boolean } {
  const when = new Date(c.fired_at).toLocaleString();
  const label = `${when} — ${capitalize(c.timer_type)} ${c.at_percent}%`;
  if (c.action === 'skipped_no_manager') {
    return { main: `${label} — skipped (no manager on record)`, muted: true };
  }
  const verb = c.action === 'escalate' ? 'Escalated to' : 'Notified';
  const who = c.target_name ?? (c.target_type === 'manager_of_requester' ? "requester's manager" : 'target');
  return { main: `${label} → ${verb} ${who}`, muted: false };
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface Props { ticketId: string }

export function TicketSlaEscalations({ ticketId }: Props) {
  const { data, loading } = useApi<Crossing[]>(`/sla/tickets/${ticketId}/crossings`, [ticketId]);
  if (loading) return null;
  if (!data || data.length === 0) return null;

  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1.5">Escalations</div>
      <ul className="space-y-1">
        {data.map((c) => {
          const { main, muted } = describe(c);
          return (
            <li
              key={c.id}
              className={`text-xs ${muted ? 'text-muted-foreground italic' : ''}`}
            >
              {main}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Mount the component in ticket-detail**

In `apps/web/src/components/desk/ticket-detail.tsx`, locate the SLA `<div>` block (around line 937 — the comment reads `{/* SLA */}`). Directly after that block's closing tag, insert:
```tsx
<TicketSlaEscalations ticketId={displayedTicket!.id} />
```

At the top of the file, add the import alongside the others:
```ts
import { TicketSlaEscalations } from '@/components/desk/ticket-sla-escalations';
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | tail -10`
Expected: clean.

- [ ] **Step 4: Manual smoke — PR body checklist from the spec**

Run: `pnpm dev` in the repo root (API + web).
Execute all three scenarios from the spec §10 manual checklist:
1. Policy `80% / response / notify / user` → create ticket → wait ≤1min → notification appears.
2. Policy `100% / resolution / escalate / team` → artificially advance `sla_timers.started_at` so percent ≥ 100 → after one cron tick, `assigned_team_id` changes, old assignee lands in `watchers`, ticket activities show "SLA escalated", and the Escalations panel renders on the ticket.
3. Policy `120% / resolution / notify / manager_of_requester` on a requester with null `manager_person_id` → crossing row shows the muted "skipped (no manager on record)" line.

If any fail, fix in the backend and re-verify before committing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/desk/ticket-sla-escalations.tsx apps/web/src/components/desk/ticket-detail.tsx
git commit -m "feat(web): show SLA escalation history on ticket detail"
```

---

## Task 13: Integration smoke + final typecheck

**Files:** none new — run the full stack.

- [ ] **Step 1: Clean any leftover test data from design phase**

During design a test threshold was written directly to the remote "Standard" policy. Clean it up:

```bash
PGPASSWORD='<db_password>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -c "update sla_policies set escalation_thresholds = '[]'::jsonb where name = 'Standard';"
```

Ask the user for the password — don't hard-code it.

- [ ] **Step 2: Run the full API test suite**

Run: `cd apps/api && pnpm test 2>&1 | tail -20`
Expected: all green.

- [ ] **Step 3: Typecheck both apps**

Run in parallel:
- `cd apps/api && npx tsc --noEmit`
- `cd apps/web && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 4: Smoke the cron locally**

Run: `pnpm dev:api` and wait for the minute cron to tick. In local Supabase, advance a timer:
```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "update sla_timers set started_at = now() - interval '30 minutes' where ticket_id = '<your-test-ticket-id>';"
```
Within 1 minute, `select * from sla_threshold_crossings where ticket_id = '<id>';` shows rows and `select * from notifications order by created_at desc limit 5;` has the escalation notification.

- [ ] **Step 5: Final commit if any fixes landed during smoke**

```bash
git status
git add <anything touched>
git commit -m "fix(sla): <specific fix>"
```

- [ ] **Step 6: Summarize**

Write a short summary in the PR body using the spec's manual-smoke checklist plus the actual fires observed during smoke. Link to the spec.

---

## Self-review notes

- Every spec section maps to at least one task: data model → T1, shared types → T2, validation → T3, module wiring → T4, engine passes → T5/T6/T7, new endpoint → T8, admin UI → T9-T11, ticket-detail UI → T12, smoke → T13.
- No `TODO`, `TBD`, or "fill in details" remain; every step contains either exact code or an exact command.
- Type names (`EscalationThreshold`, `SlaTimerRow`, `ThresholdTimerScope`, `ThresholdAction`, `ThresholdTargetType`, `RecordedAction`) are defined once in `sla-threshold.types.ts` and re-used consistently.
- Commits land after each coherent unit (migration, helpers, validation, wiring, engine, endpoint, UI pair). No task leaves the codebase in a broken state at commit time except Tasks 9-10, which are explicitly bundled with Task 11's commit.
- One piece of known cleanup: the test threshold on the remote "Standard" policy added during design is wiped in Task 13 Step 1.
