# Create-booking modal redesign — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing single-pane `BookingComposer` with a two-tier creation surface — a 30s `<QuickBookPopover>` for tile-clicks on the desk scheduler + a polished two-pane `<BookingComposerModal>` for intentional booking — with contextual "Suggested" chips on add-in cards, mandatory shadcn Field primitives, and the polish micros from CLAUDE.md baked in.

**Architecture:** Three layers. (1) **Foundations**: a tenant `meal_windows` config table + loader + React Query hook, a single `BookingDraft` shape replacing the old `ComposerState`, a `useBookingDraft` hook that wraps the existing reducer, and a pure `getSuggestions(draft, room, mealWindows)` function with vitest unit tests. (2) **Two surfaces**: a `<QuickBookPopover>` anchored to scheduler tiles (~360×220) and a `<BookingComposerModal>` (880×680, two-pane) wired through every existing entry point. (3) **Right-pane add-in stack**: `<AddinCard>` primitive that expands inline via `grid-template-rows: 0fr→1fr` over 240ms `var(--ease-smooth)`, reusing the existing `ServicePickerBody` for catering/AV. Backend: one small migration; everything else is client-side computation against already-loaded data.

**Tech Stack:** React 19, Vite, TypeScript, Tailwind v4, shadcn/ui (Field primitives mandatory), TanStack Query v5, NestJS, Supabase Postgres, vitest (added in Phase 1 — not currently installed in `apps/web`).

---

## Pre-flight

- [ ] **Step 0: Read the spec end-to-end**

Open `/Users/x/Desktop/XPQT/docs/superpowers/specs/2026-05-02-create-booking-modal-redesign.md` and read every word. The spec is the contract; this plan is the execution path.

- [ ] **Step 0b: Confirm baseline builds + dev server**

Run from `/Users/x/Desktop/XPQT`:
```bash
pnpm install
pnpm --filter @prequest/web build
pnpm --filter @prequest/api build
```
All three must succeed. If any fail, fix the baseline before starting Phase 1 — this plan assumes a green tree.

- [ ] **Step 0c: Note the existing files this redesign replaces**

Read for orientation (do not edit yet):
- `apps/web/src/components/booking-composer/booking-composer.tsx` (the old shell — kept as `legacy-booking-composer.tsx` shim until Phase 6)
- `apps/web/src/components/booking-composer/state.ts` (`ComposerState`, reducer, `validateForSubmit`, `templateServicesToPickerSelections`)
- `apps/web/src/components/booking-composer/sections/visitors-section.tsx`
- `apps/web/src/components/booking-composer/service-picker-sheet.tsx` (`ServicePickerBody`)
- `apps/web/src/components/booking-composer/helpers.ts`
- `apps/web/src/components/booking-composer/submit.ts` (payload builders)
- `apps/web/src/pages/desk/scheduler/components/scheduler-create-popover.tsx` (current scheduler entry)
- `apps/web/src/pages/desk/bookings.tsx` (current "+ New booking" Sheet)
- `apps/web/src/pages/portal/book-room/index.tsx` (current portal entry)

---

# Phase 1 — Foundations (no UI yet)

Goal: a tenant `meal_windows` table + API loader + React Query hook, the `BookingDraft` shape, `getSuggestions` pure function with tests, and `useBookingDraft` hook. Nothing user-visible ships in this phase.

### Task 1.1: Vitest setup for `apps/web`

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/src/test-setup.ts`
- Create: `apps/web/src/lib/__tests__/sanity.test.ts`

- [ ] **Step 1: Add vitest deps**

Run from `/Users/x/Desktop/XPQT`:
```bash
pnpm --filter @prequest/web add -D vitest @vitest/ui jsdom @testing-library/react @testing-library/dom @testing-library/jest-dom @testing-library/user-event
```

- [ ] **Step 2: Add test scripts**

Edit `apps/web/package.json` `scripts` block — add:
```json
    "test": "vitest run",
    "test:watch": "vitest"
```
Keep the existing `dev` / `build` / `preview` / `lint` scripts.

- [ ] **Step 3: Write `vitest.config.ts`**

Create `apps/web/vitest.config.ts`:
```ts
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test-setup.ts'],
      css: false,
    },
  }),
);
```

- [ ] **Step 4: Write `test-setup.ts`**

Create `apps/web/src/test-setup.ts`:
```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 5: Sanity test**

Create `apps/web/src/lib/__tests__/sanity.test.ts`:
```ts
import { describe, expect, it } from 'vitest';

describe('vitest setup', () => {
  it('runs', () => {
    expect(2 + 2).toBe(4);
  });
});
```

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @prequest/web test
```
Expected: 1 test passes.

- [ ] **Step 7: Commit**

```bash
git add apps/web/package.json apps/web/vitest.config.ts apps/web/src/test-setup.ts apps/web/src/lib/__tests__/sanity.test.ts pnpm-lock.yaml
git commit -m "test(web): add vitest + RTL infra for booking-composer redesign"
```

---

### Task 1.2: Migration — `tenant_meal_windows` table

**Files:**
- Create: `supabase/migrations/00276_tenant_meal_windows.sql`

- [ ] **Step 1: Confirm next migration number**

Run:
```bash
ls /Users/x/Desktop/XPQT/supabase/migrations/ | tail -3
```
Expected: last is `00275_restore_work_orders_service_role_writes.sql`. Next is `00276`. If the last number has changed since this plan was written, increment accordingly and update the path below.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/00276_tenant_meal_windows.sql`:
```sql
-- 00276_tenant_meal_windows.sql
--
-- Tenant-configurable meal windows. Drives the create-booking modal's
-- "Suggested" chip on the catering add-in card when the picked time
-- spans a configured window (default lunch + dinner). The redesign
-- spec is at docs/superpowers/specs/2026-05-02-create-booking-modal-redesign.md.
--
-- Read-side only: the API exposes GET /tenants/current/meal-windows.
-- Writes (admin UI) come in a follow-up; for v1 the seed defaults are
-- enough.
--
-- Idempotent. Safe to re-apply.

create table if not exists public.tenant_meal_windows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  label text not null check (length(label) between 1 and 64),
  -- Local time (no timezone). The client compares against the booking's
  -- local hours to avoid TZ drift between tenants in different regions.
  start_time time not null,
  end_time time not null check (end_time > start_time),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id, label)
);

create index if not exists tenant_meal_windows_tenant_active_idx
  on public.tenant_meal_windows(tenant_id) where active;

alter table public.tenant_meal_windows enable row level security;

-- Read: anyone authenticated in the tenant. Write: service_role only
-- (admin UI proxies via the API). The existing tenant-context middleware
-- adds tenant_id to RLS via current_setting('app.tenant_id').
drop policy if exists tenant_meal_windows_read on public.tenant_meal_windows;
create policy tenant_meal_windows_read
  on public.tenant_meal_windows
  for select
  to authenticated
  using (tenant_id::text = current_setting('app.tenant_id', true));

revoke all on public.tenant_meal_windows from anon, authenticated, public;
grant select on public.tenant_meal_windows to authenticated;
grant select, insert, update, delete on public.tenant_meal_windows to service_role;

-- Seed defaults for every existing tenant: lunch 11:30–13:30, dinner
-- 17:00–19:00. New tenants get the same via the trigger below.
insert into public.tenant_meal_windows(tenant_id, label, start_time, end_time)
select t.id, 'Lunch', '11:30'::time, '13:30'::time
from public.tenants t
on conflict (tenant_id, label) do nothing;

insert into public.tenant_meal_windows(tenant_id, label, start_time, end_time)
select t.id, 'Dinner', '17:00'::time, '19:00'::time
from public.tenants t
on conflict (tenant_id, label) do nothing;

create or replace function public.seed_default_meal_windows()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tenant_meal_windows(tenant_id, label, start_time, end_time)
  values
    (new.id, 'Lunch', '11:30'::time, '13:30'::time),
    (new.id, 'Dinner', '17:00'::time, '19:00'::time)
  on conflict (tenant_id, label) do nothing;
  return new;
end
$$;

drop trigger if exists tenants_seed_meal_windows on public.tenants;
create trigger tenants_seed_meal_windows
  after insert on public.tenants
  for each row execute function public.seed_default_meal_windows();

notify pgrst, 'reload schema';
```

- [ ] **Step 3: Apply locally**

Run from `/Users/x/Desktop/XPQT`:
```bash
pnpm db:reset
```
Expected: migrations apply cleanly through 00276.

- [ ] **Step 4: Smoke check the seed locally**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "select count(*) from public.tenant_meal_windows;"
```
Expected: at least 2 rows per existing tenant (lunch + dinner).

- [ ] **Step 5: Push to remote (ASK USER FIRST)**

This writes to the shared remote DB. **Ask the user before running.** When approved:
```bash
PGPASSWORD="$(grep -E '^SUPABASE_DB_PASS=' .env | cut -d= -f2-)" \
  psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -v ON_ERROR_STOP=1 -f supabase/migrations/00276_tenant_meal_windows.sql
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/00276_tenant_meal_windows.sql
git commit -m "feat(db): add tenant_meal_windows for booking composer suggestions"
```

---

### Task 1.3: API — `GET /tenants/current/meal-windows`

**Files:**
- Create: `apps/api/src/modules/tenant/meal-windows.service.ts`
- Create: `apps/api/src/modules/tenant/meal-windows.service.spec.ts`
- Create: `apps/api/src/modules/tenant/meal-windows.controller.ts`
- Modify: `apps/api/src/modules/tenant/tenant.module.ts`

- [ ] **Step 1: Write the failing service spec**

Create `apps/api/src/modules/tenant/meal-windows.service.spec.ts`:
```ts
import { MealWindowsService, type MealWindowRow } from './meal-windows.service';
import type { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

function buildSupabase(rows: MealWindowRow[]): SupabaseService {
  const builder: any = {
    from: () => builder,
    select: () => builder,
    eq: () => builder,
    order: () => Promise.resolve({ data: rows, error: null }),
  };
  return { admin: builder } as unknown as SupabaseService;
}

describe('MealWindowsService.list', () => {
  it('returns all active meal windows for the current tenant', async () => {
    const rows: MealWindowRow[] = [
      {
        id: 'w1',
        tenant_id: 't1',
        label: 'Lunch',
        start_time: '11:30:00',
        end_time: '13:30:00',
        active: true,
      },
    ];
    const svc = new MealWindowsService(buildSupabase(rows));
    const result = await TenantContext.run(
      { id: 't1', slug: 't1', tier: 'standard' },
      () => svc.list(),
    );
    expect(result).toEqual(rows);
  });
});
```

- [ ] **Step 2: Run spec — confirm it fails**

```bash
pnpm --filter @prequest/api test -- meal-windows.service.spec
```
Expected: FAIL "Cannot find module './meal-windows.service'".

- [ ] **Step 3: Implement the service**

Create `apps/api/src/modules/tenant/meal-windows.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

export interface MealWindowRow {
  id: string;
  tenant_id: string;
  label: string;
  /** "HH:MM:SS" local time. Postgres `time` round-trips as a string via
   *  supabase-js, not a Date. */
  start_time: string;
  end_time: string;
  active: boolean;
}

/**
 * Read-side loader for `tenant_meal_windows`. The create-booking modal
 * uses these windows client-side to render a "Suggested" chip on the
 * catering add-in card when the picked booking time overlaps a window.
 *
 * Writes are deferred to the admin UI follow-up; v1 ships with the seed
 * defaults from migration 00276 (Lunch 11:30–13:30, Dinner 17:00–19:00).
 */
@Injectable()
export class MealWindowsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(): Promise<MealWindowRow[]> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('tenant_meal_windows')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('start_time', { ascending: true });
    if (error) throw error;
    return (data ?? []) as MealWindowRow[];
  }
}
```

- [ ] **Step 4: Run spec — confirm it passes**

```bash
pnpm --filter @prequest/api test -- meal-windows.service.spec
```
Expected: PASS.

- [ ] **Step 5: Add the controller**

Create `apps/api/src/modules/tenant/meal-windows.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';
import { MealWindowsService, type MealWindowRow } from './meal-windows.service';

/**
 * Read-only. Tenant-scoped. No permission gate — the data is non-sensitive
 * (lunch/dinner clock windows) and the create-booking flow needs it for
 * every authenticated user.
 */
@Controller('tenants/current/meal-windows')
export class MealWindowsController {
  constructor(private readonly service: MealWindowsService) {}

  @Get()
  list(): Promise<MealWindowRow[]> {
    return this.service.list();
  }
}
```

- [ ] **Step 6: Wire into the module**

Edit `apps/api/src/modules/tenant/tenant.module.ts` so providers + controllers include the new service + controller. Replace the file with:
```ts
import { Global, Module } from '@nestjs/common';
import { TenantService } from './tenant.service';
import { TenantController } from './tenant.controller';
import { BrandingService } from './branding.service';
import { BrandingController } from './branding.controller';
import { MealWindowsService } from './meal-windows.service';
import { MealWindowsController } from './meal-windows.controller';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [AuthModule],
  providers: [TenantService, BrandingService, MealWindowsService],
  controllers: [TenantController, BrandingController, MealWindowsController],
  exports: [TenantService, MealWindowsService],
})
export class TenantModule {}
```

- [ ] **Step 7: Build the API to confirm wiring**

```bash
pnpm --filter @prequest/api build
```
Expected: success.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/tenant/meal-windows.service.ts apps/api/src/modules/tenant/meal-windows.service.spec.ts apps/api/src/modules/tenant/meal-windows.controller.ts apps/api/src/modules/tenant/tenant.module.ts
git commit -m "feat(api): GET /tenants/current/meal-windows for booking composer suggestions"
```

---

### Task 1.4: Frontend API — `useMealWindows()` React Query hook

**Files:**
- Create: `apps/web/src/api/meal-windows/keys.ts`
- Create: `apps/web/src/api/meal-windows/types.ts`
- Create: `apps/web/src/api/meal-windows/queries.ts`
- Create: `apps/web/src/api/meal-windows/index.ts`

- [ ] **Step 1: Key factory**

Create `apps/web/src/api/meal-windows/keys.ts`:
```ts
export const mealWindowKeys = {
  all: ['meal-windows'] as const,
  lists: () => [...mealWindowKeys.all, 'list'] as const,
  list: () => [...mealWindowKeys.lists()] as const,
} as const;
```

- [ ] **Step 2: Types**

Create `apps/web/src/api/meal-windows/types.ts`:
```ts
export interface MealWindow {
  id: string;
  tenant_id: string;
  label: string;
  /** "HH:MM:SS" local time, e.g. "11:30:00". */
  start_time: string;
  end_time: string;
  active: boolean;
}
```

- [ ] **Step 3: Query options + hook**

Create `apps/web/src/api/meal-windows/queries.ts`:
```ts
import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { mealWindowKeys } from './keys';
import type { MealWindow } from './types';

/**
 * Tenant meal windows. Fetched once per session (long staleTime) — the
 * create-booking modal calls `useMealWindows()` from `getSuggestions` to
 * decide whether to flag the catering add-in card with a "Suggested"
 * chip. Endpoint: GET /tenants/current/meal-windows. Drives nothing
 * user-visible by itself; pure config.
 */
export function mealWindowListOptions() {
  return queryOptions({
    queryKey: mealWindowKeys.list(),
    queryFn: ({ signal }) =>
      apiFetch<MealWindow[]>('/tenants/current/meal-windows', { signal }),
    // 30 minutes — admins editing meal windows is rare; the picker is
    // not real-time. Tab-focus revalidation handles the rest.
    staleTime: 30 * 60_000,
  });
}

export function useMealWindows() {
  return useQuery(mealWindowListOptions());
}
```

- [ ] **Step 4: Barrel**

Create `apps/web/src/api/meal-windows/index.ts`:
```ts
export * from './keys';
export * from './queries';
export * from './types';
```

- [ ] **Step 5: Build to verify imports**

```bash
pnpm --filter @prequest/web build
```
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api/meal-windows/
git commit -m "feat(web): useMealWindows React Query hook"
```

---

### Task 1.5: `BookingDraft` type + helpers

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/booking-draft.ts`
- Create: `apps/web/src/components/booking-composer-v2/booking-draft.test.ts`

Note on directory: the new code lives at `apps/web/src/components/booking-composer-v2/` so the old composer (`booking-composer/`) keeps working until Phase 6 deletes it. The directory is renamed at the end.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/booking-composer-v2/booking-draft.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  emptyDraft,
  draftFromComposerSeed,
  validateDraft,
  type BookingDraft,
} from './booking-draft';

describe('emptyDraft', () => {
  it('returns a stable shape with sensible defaults', () => {
    const d = emptyDraft();
    expect(d.spaceId).toBeNull();
    expect(d.startAt).toBeNull();
    expect(d.endAt).toBeNull();
    expect(d.title).toBe('');
    expect(d.attendeeCount).toBe(1);
    expect(d.visitors).toEqual([]);
    expect(d.services).toEqual([]);
  });
});

describe('draftFromComposerSeed', () => {
  it('honors a partial seed', () => {
    const d = draftFromComposerSeed({
      spaceId: 'room-1',
      startAt: '2026-05-07T10:00:00.000Z',
      endAt: '2026-05-07T11:00:00.000Z',
      attendeeCount: 4,
    });
    expect(d.spaceId).toBe('room-1');
    expect(d.attendeeCount).toBe(4);
    expect(d.title).toBe('');
  });
});

describe('validateDraft', () => {
  it('returns null when ready to submit', () => {
    const d: BookingDraft = {
      ...emptyDraft(),
      spaceId: 'room-1',
      startAt: '2026-05-07T10:00:00.000Z',
      endAt: '2026-05-07T11:00:00.000Z',
      hostPersonId: 'p1',
    };
    expect(validateDraft(d, 'self')).toBeNull();
  });

  it('requires a room', () => {
    expect(validateDraft(emptyDraft(), 'self')).toBe('Pick a room.');
  });

  it('requires time', () => {
    const d = { ...emptyDraft(), spaceId: 'room-1' };
    expect(validateDraft(d, 'self')).toBe('Pick a date and time.');
  });

  it('operator mode requires a requester', () => {
    const d: BookingDraft = {
      ...emptyDraft(),
      spaceId: 'room-1',
      startAt: '2026-05-07T10:00:00.000Z',
      endAt: '2026-05-07T11:00:00.000Z',
    };
    expect(validateDraft(d, 'operator')).toBe('Pick who the booking is for.');
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
pnpm --filter @prequest/web test -- booking-draft.test
```
Expected: FAIL "Cannot find module './booking-draft'".

- [ ] **Step 3: Implement**

Create `apps/web/src/components/booking-composer-v2/booking-draft.ts`:
```ts
import type { RecurrenceRule } from '@/api/room-booking';
import type { PickerSelection } from '../booking-composer/service-picker-sheet';
import type { PendingVisitor } from '../booking-composer/state';
import type { ComposerMode } from '../booking-composer/state';

/**
 * The unified draft state for the redesigned booking flow. Replaces
 * `ComposerState` from the old `booking-composer/state.ts`. Single root
 * object keeps the popover ↔ modal escalation lossless: the popover
 * holds a small subset, the modal extends it.
 *
 * Field naming intentionally matches the old `ComposerState` so the
 * existing `submit.ts` payload builders work without changes — only the
 * shell (popover + modal + cards) is rewritten.
 *
 * NEW vs ComposerState:
 *  - `title` (the spec-required title field, becomes the placeholder
 *    `"{Host first}'s {Room} booking"` if blank).
 *  - `description` (free-text textarea on the left pane).
 *
 * REMOVED vs ComposerState:
 *  - `errors` (handled by RHF + setFormError per error-handling spec).
 *  - `additionalSpaceIds` (multi-room is not in this redesign — the
 *    spec is single-room. Multi-room ships separately if needed; the
 *    old composer's multi-room path stays available via the legacy
 *    surface until it migrates).
 */
export interface BookingDraft {
  // Identity / meta
  title: string;
  description: string;

  // Room + time
  spaceId: string | null;
  startAt: string | null;
  endAt: string | null;

  // People
  /** Always required. Defaults to caller in self mode. */
  hostPersonId: string | null;
  /** Operator mode only — who is this booking FOR. */
  requesterPersonId: string | null;
  attendeeCount: number;
  attendeePersonIds: string[];

  // Add-ins
  recurrence: RecurrenceRule | null;
  services: PickerSelection[];
  visitors: PendingVisitor[];

  // Cost + template
  costCenterId: string | null;
  templateId: string | null;
}

export function emptyDraft(): BookingDraft {
  return {
    title: '',
    description: '',
    spaceId: null,
    startAt: null,
    endAt: null,
    hostPersonId: null,
    requesterPersonId: null,
    attendeeCount: 1,
    attendeePersonIds: [],
    recurrence: null,
    services: [],
    visitors: [],
    costCenterId: null,
    templateId: null,
  };
}

export interface BookingDraftSeed {
  title?: string;
  description?: string;
  spaceId?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  hostPersonId?: string | null;
  requesterPersonId?: string | null;
  attendeeCount?: number;
  attendeePersonIds?: string[];
  recurrence?: RecurrenceRule | null;
  services?: PickerSelection[];
  visitors?: PendingVisitor[];
  costCenterId?: string | null;
  templateId?: string | null;
}

/**
 * Build a `BookingDraft` from the same seed shape callers used to pass
 * to `BookingComposer`'s `initial` prop. Used by the popover→modal
 * escalation and by the modal's "open with these defaults" entry.
 */
export function draftFromComposerSeed(seed: BookingDraftSeed = {}): BookingDraft {
  const base = emptyDraft();
  return {
    ...base,
    ...seed,
    attendeeCount: Math.max(1, seed.attendeeCount ?? base.attendeeCount),
    attendeePersonIds: seed.attendeePersonIds ?? base.attendeePersonIds,
    services: seed.services ?? base.services,
    visitors: seed.visitors ?? base.visitors,
  };
}

/**
 * Validation parity with the legacy `validateForSubmit`. Returns the
 * first user-facing reason the draft cannot submit, or null. The modal
 * uses this to disable Submit; field-level errors paint inline via
 * `setFormError` per the error-handling spec.
 */
export function validateDraft(draft: BookingDraft, mode: ComposerMode): string | null {
  if (!draft.spaceId) return 'Pick a room.';
  if (!draft.startAt || !draft.endAt) return 'Pick a date and time.';
  if (draft.attendeeCount < 1) return 'At least one attendee.';
  if (mode === 'operator' && !draft.requesterPersonId) {
    return 'Pick who the booking is for.';
  }
  return null;
}

/**
 * The placeholder title for the title input — the spec calls this
 * "what-you-see-is-what-you-get". When the user submits with a blank
 * title, this string IS the title that gets persisted.
 */
export function defaultTitle(args: {
  hostFirstName: string | null;
  roomName: string | null;
}): string {
  const host = args.hostFirstName?.trim();
  const room = args.roomName?.trim();
  if (!host && !room) return 'Booking';
  if (!host) return `${room} booking`;
  if (!room) return `${host}'s booking`;
  return `${host}'s ${room} booking`;
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
pnpm --filter @prequest/web test -- booking-draft.test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/
git commit -m "feat(web): BookingDraft type + validation for composer redesign"
```

---

### Task 1.6: `getSuggestions` pure function + tests

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/contextual-suggestions.ts`
- Create: `apps/web/src/components/booking-composer-v2/contextual-suggestions.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/booking-composer-v2/contextual-suggestions.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  getSuggestions,
  type SuggestionRoomFacts,
} from './contextual-suggestions';
import type { MealWindow } from '@/api/meal-windows';
import { emptyDraft } from './booking-draft';

const lunch: MealWindow = {
  id: 'w-lunch',
  tenant_id: 't1',
  label: 'Lunch',
  start_time: '11:30:00',
  end_time: '13:30:00',
  active: true,
};

const room: SuggestionRoomFacts = {
  space_id: 'room-1',
  name: 'Maple',
  has_av_equipment: false,
  has_catering_vendor: false,
  needs_visitor_pre_registration: false,
};

function isoOnDay(year: number, month: number, day: number, hh: number, mm = 0): string {
  return new Date(year, month - 1, day, hh, mm, 0).toISOString();
}

describe('getSuggestions', () => {
  it('returns empty when no signals fire', () => {
    const draft = {
      ...emptyDraft(),
      startAt: isoOnDay(2026, 5, 7, 9, 0),
      endAt: isoOnDay(2026, 5, 7, 9, 30),
    };
    expect(getSuggestions(draft, room, [lunch])).toEqual([]);
  });

  it('flags catering when the booking spans a meal window', () => {
    const draft = {
      ...emptyDraft(),
      startAt: isoOnDay(2026, 5, 7, 11, 0),
      endAt: isoOnDay(2026, 5, 7, 12, 30),
    };
    const suggestions = getSuggestions(draft, room, [lunch]);
    const catering = suggestions.find((s) => s.target === 'catering');
    expect(catering).toBeDefined();
    expect(catering?.reason).toContain('lunch');
  });

  it('flags catering when the room has a linked catering vendor', () => {
    const draft = {
      ...emptyDraft(),
      startAt: isoOnDay(2026, 5, 7, 9, 0),
      endAt: isoOnDay(2026, 5, 7, 10, 0),
    };
    const suggestions = getSuggestions(
      draft,
      { ...room, has_catering_vendor: true },
      [lunch],
    );
    expect(suggestions.some((s) => s.target === 'catering')).toBe(true);
  });

  it('flags AV when the room has equipment AND duration > 30min', () => {
    const draft = {
      ...emptyDraft(),
      startAt: isoOnDay(2026, 5, 7, 9, 0),
      endAt: isoOnDay(2026, 5, 7, 10, 0),
    };
    const suggestions = getSuggestions(
      draft,
      { ...room, has_av_equipment: true },
      [],
    );
    expect(suggestions.some((s) => s.target === 'av_equipment')).toBe(true);
  });

  it('does NOT flag AV for sub-30min bookings even with equipment', () => {
    const draft = {
      ...emptyDraft(),
      startAt: isoOnDay(2026, 5, 7, 9, 0),
      endAt: isoOnDay(2026, 5, 7, 9, 25),
    };
    const suggestions = getSuggestions(
      draft,
      { ...room, has_av_equipment: true },
      [],
    );
    expect(suggestions.some((s) => s.target === 'av_equipment')).toBe(false);
  });

  it('flags visitors when the room is a pre-reg wing', () => {
    const draft = {
      ...emptyDraft(),
      startAt: isoOnDay(2026, 5, 7, 9, 0),
      endAt: isoOnDay(2026, 5, 7, 10, 0),
    };
    const suggestions = getSuggestions(
      draft,
      { ...room, needs_visitor_pre_registration: true },
      [],
    );
    expect(suggestions.some((s) => s.target === 'visitors')).toBe(true);
  });

  it('treats null room as no signals', () => {
    const draft = {
      ...emptyDraft(),
      startAt: isoOnDay(2026, 5, 7, 11, 0),
      endAt: isoOnDay(2026, 5, 7, 12, 30),
    };
    expect(getSuggestions(draft, null, [lunch])).toEqual([]);
  });

  it('handles meal window that crosses no part of the booking', () => {
    const draft = {
      ...emptyDraft(),
      startAt: isoOnDay(2026, 5, 7, 14, 0),
      endAt: isoOnDay(2026, 5, 7, 15, 0),
    };
    expect(getSuggestions(draft, room, [lunch])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
pnpm --filter @prequest/web test -- contextual-suggestions.test
```
Expected: FAIL "Cannot find module".

- [ ] **Step 3: Implement**

Create `apps/web/src/components/booking-composer-v2/contextual-suggestions.ts`:
```ts
import type { BookingDraft } from './booking-draft';
import type { MealWindow } from '@/api/meal-windows';

/**
 * Slim shape the suggestion engine needs from a room. Decoupled from
 * `Space` / `RankedRoom` / `SchedulerRoom` so the function stays pure
 * and testable. Callers pass the relevant boolean signals derived from
 * whatever room shape they have.
 *
 * `has_av_equipment`, `has_catering_vendor`,
 * `needs_visitor_pre_registration` are runtime hints — when the
 * scheduler / portal don't have them yet, pass `false` and the
 * suggestion just doesn't fire. They're additive over time.
 */
export interface SuggestionRoomFacts {
  space_id: string;
  name: string;
  has_av_equipment: boolean;
  has_catering_vendor: boolean;
  needs_visitor_pre_registration: boolean;
}

/** Which add-in card the suggestion targets. */
export type SuggestionTarget = 'catering' | 'av_equipment' | 'visitors';

export interface Suggestion {
  target: SuggestionTarget;
  /** Human-readable reason. Used as the chip's hover tooltip. Always
   *  English in v1 — translation comes when the rest of the modal is
   *  translated. */
  reason: string;
}

/** Convert ISO timestamp → minutes since local midnight. */
function localMinutes(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.getHours() * 60 + d.getMinutes();
}

/** "HH:MM:SS" or "HH:MM" → minutes since midnight. */
function timeStringToMinutes(t: string): number {
  const [hh, mm] = t.split(':').map((s) => Number.parseInt(s, 10));
  return (hh || 0) * 60 + (mm || 0);
}

function durationMinutes(startAt: string, endAt: string): number {
  const s = new Date(startAt).getTime();
  const e = new Date(endAt).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 0;
  return Math.round((e - s) / 60_000);
}

/**
 * Pure function. The single brain for the right-pane "Suggested" chips.
 * Computes signals from already-loaded data — no network, no side
 * effects. The redesign spec calls this out as the discoverability fix
 * for the catering-attachment problem.
 *
 * Inputs:
 *  - `draft`: the user's in-progress booking (start/end/visitors).
 *  - `room`: the picked room's runtime facts. Null when the user
 *    hasn't picked yet (which is rare — the popover usually pre-selects
 *    via the tile click).
 *  - `mealWindows`: tenant-configured local-time windows from
 *    `useMealWindows()`.
 *
 * Output:
 *  - `Suggestion[]`: zero or more chip recommendations. The right-pane
 *    `<AddinCard>` matches its `target` and renders the "Suggested"
 *    chip + tooltip when present.
 */
export function getSuggestions(
  draft: BookingDraft,
  room: SuggestionRoomFacts | null,
  mealWindows: MealWindow[],
): Suggestion[] {
  if (!room) return [];
  const { startAt, endAt } = draft;
  if (!startAt || !endAt) return [];

  const out: Suggestion[] = [];

  // Catering — meal window overlap (compares local-clock minutes both
  // sides; the booking's local hour and the window's local time are
  // already in the same timezone since both come from the same browser
  // / tenant).
  const startMin = localMinutes(startAt);
  const endMin = localMinutes(endAt);
  if (startMin != null && endMin != null) {
    for (const w of mealWindows) {
      if (!w.active) continue;
      const wStart = timeStringToMinutes(w.start_time);
      const wEnd = timeStringToMinutes(w.end_time);
      // Standard interval overlap: [a,b] vs [c,d] iff a<d AND c<b.
      if (startMin < wEnd && wStart < endMin) {
        out.push({
          target: 'catering',
          reason: `Booking spans ${w.label.toLowerCase()} — many teams add catering here.`,
        });
        break; // one catering suggestion is enough
      }
    }
  }

  // Catering — vendor signal (room has a catering vendor in routing).
  // De-duped against meal-window suggestion above.
  if (
    room.has_catering_vendor &&
    !out.some((s) => s.target === 'catering')
  ) {
    out.push({
      target: 'catering',
      reason: `${room.name} has a linked catering vendor.`,
    });
  }

  // AV — equipment + duration > 30 min.
  if (room.has_av_equipment && durationMinutes(startAt, endAt) > 30) {
    out.push({
      target: 'av_equipment',
      reason: `${room.name} has AV equipment configured.`,
    });
  }

  // Visitors — pre-reg wing AND no visitors added yet.
  if (room.needs_visitor_pre_registration && draft.visitors.length === 0) {
    out.push({
      target: 'visitors',
      reason: 'Visitors are typically pre-registered for this room.',
    });
  }

  return out;
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
pnpm --filter @prequest/web test -- contextual-suggestions.test
```
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/contextual-suggestions.ts apps/web/src/components/booking-composer-v2/contextual-suggestions.test.ts
git commit -m "feat(web): getSuggestions pure function for booking composer chips"
```

---

### Task 1.7: `useBookingDraft` hook

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/use-booking-draft.ts`
- Create: `apps/web/src/components/booking-composer-v2/use-booking-draft.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/booking-composer-v2/use-booking-draft.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBookingDraft } from './use-booking-draft';

describe('useBookingDraft', () => {
  it('initializes with the empty draft when no seed is provided', () => {
    const { result } = renderHook(() => useBookingDraft());
    expect(result.current.draft.spaceId).toBeNull();
    expect(result.current.draft.title).toBe('');
  });

  it('honors a seed', () => {
    const { result } = renderHook(() =>
      useBookingDraft({
        seed: { spaceId: 'r1', title: 'Sprint review' },
      }),
    );
    expect(result.current.draft.spaceId).toBe('r1');
    expect(result.current.draft.title).toBe('Sprint review');
  });

  it('updates room without losing other fields', () => {
    const { result } = renderHook(() =>
      useBookingDraft({ seed: { title: 'Sync' } }),
    );
    act(() => result.current.setRoom('r2'));
    expect(result.current.draft.spaceId).toBe('r2');
    expect(result.current.draft.title).toBe('Sync');
  });

  it('updates time as a pair', () => {
    const { result } = renderHook(() => useBookingDraft());
    act(() => result.current.setTime('2026-05-07T10:00:00.000Z', '2026-05-07T11:00:00.000Z'));
    expect(result.current.draft.startAt).toBe('2026-05-07T10:00:00.000Z');
    expect(result.current.draft.endAt).toBe('2026-05-07T11:00:00.000Z');
  });

  it('add/remove visitors', () => {
    const { result } = renderHook(() => useBookingDraft());
    act(() =>
      result.current.addVisitor({
        local_id: 'v1',
        first_name: 'Alex',
        email: 'a@x.com',
        visitor_type_id: 'vt1',
      }),
    );
    expect(result.current.draft.visitors).toHaveLength(1);
    act(() => result.current.removeVisitor('v1'));
    expect(result.current.draft.visitors).toHaveLength(0);
  });

  it('exposes a stable identity on each call setter', () => {
    const { result, rerender } = renderHook(() => useBookingDraft());
    const first = result.current.setRoom;
    rerender();
    expect(result.current.setRoom).toBe(first);
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
pnpm --filter @prequest/web test -- use-booking-draft.test
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/web/src/components/booking-composer-v2/use-booking-draft.ts`:
```ts
import { useCallback, useMemo, useState } from 'react';
import {
  draftFromComposerSeed,
  type BookingDraft,
  type BookingDraftSeed,
} from './booking-draft';
import type { RecurrenceRule } from '@/api/room-booking';
import type { PickerSelection } from '../booking-composer/service-picker-sheet';
import type { PendingVisitor } from '../booking-composer/state';

export interface UseBookingDraftOptions {
  seed?: BookingDraftSeed;
}

export interface UseBookingDraftResult {
  draft: BookingDraft;
  setRoom: (spaceId: string | null) => void;
  setTime: (startAt: string | null, endAt: string | null) => void;
  setTitle: (title: string) => void;
  setDescription: (description: string) => void;
  setHost: (personId: string | null) => void;
  setRequester: (personId: string | null) => void;
  setAttendeeCount: (count: number) => void;
  setRepeat: (rule: RecurrenceRule | null) => void;
  setServices: (services: PickerSelection[]) => void;
  addVisitor: (visitor: PendingVisitor) => void;
  updateVisitor: (visitor: PendingVisitor) => void;
  removeVisitor: (localId: string) => void;
  setCostCenter: (costCenterId: string | null) => void;
  setTemplateId: (templateId: string | null) => void;
  /** Replace the entire draft. Used by the popover→modal escalation
   *  path: the modal opens with the popover's draft as its seed. */
  replace: (next: BookingDraft) => void;
  reset: (seed?: BookingDraftSeed) => void;
}

/**
 * Single state container for the redesigned booking composer. Shared by
 * the popover (small subset) and the modal (full draft). Setters are
 * stable identity (useCallback) so child components don't re-render
 * just because a parent re-renders.
 */
export function useBookingDraft(
  options: UseBookingDraftOptions = {},
): UseBookingDraftResult {
  const [draft, setDraft] = useState<BookingDraft>(() =>
    draftFromComposerSeed(options.seed),
  );

  const setRoom = useCallback((spaceId: string | null) => {
    setDraft((d) => ({ ...d, spaceId }));
  }, []);
  const setTime = useCallback((startAt: string | null, endAt: string | null) => {
    setDraft((d) => ({ ...d, startAt, endAt }));
  }, []);
  const setTitle = useCallback((title: string) => {
    setDraft((d) => ({ ...d, title }));
  }, []);
  const setDescription = useCallback((description: string) => {
    setDraft((d) => ({ ...d, description }));
  }, []);
  const setHost = useCallback((hostPersonId: string | null) => {
    setDraft((d) => ({ ...d, hostPersonId }));
  }, []);
  const setRequester = useCallback((requesterPersonId: string | null) => {
    setDraft((d) => ({ ...d, requesterPersonId }));
  }, []);
  const setAttendeeCount = useCallback((count: number) => {
    setDraft((d) => ({ ...d, attendeeCount: Math.max(1, count) }));
  }, []);
  const setRepeat = useCallback((recurrence: RecurrenceRule | null) => {
    setDraft((d) => ({ ...d, recurrence }));
  }, []);
  const setServices = useCallback((services: PickerSelection[]) => {
    setDraft((d) => ({ ...d, services }));
  }, []);
  const addVisitor = useCallback((visitor: PendingVisitor) => {
    setDraft((d) => {
      if (d.visitors.some((v) => v.local_id === visitor.local_id)) {
        return {
          ...d,
          visitors: d.visitors.map((v) =>
            v.local_id === visitor.local_id ? visitor : v,
          ),
        };
      }
      return { ...d, visitors: [...d.visitors, visitor] };
    });
  }, []);
  const updateVisitor = useCallback((visitor: PendingVisitor) => {
    setDraft((d) => ({
      ...d,
      visitors: d.visitors.map((v) =>
        v.local_id === visitor.local_id ? visitor : v,
      ),
    }));
  }, []);
  const removeVisitor = useCallback((localId: string) => {
    setDraft((d) => ({
      ...d,
      visitors: d.visitors.filter((v) => v.local_id !== localId),
    }));
  }, []);
  const setCostCenter = useCallback((costCenterId: string | null) => {
    setDraft((d) => ({ ...d, costCenterId }));
  }, []);
  const setTemplateId = useCallback((templateId: string | null) => {
    setDraft((d) => ({ ...d, templateId }));
  }, []);
  const replace = useCallback((next: BookingDraft) => {
    setDraft(next);
  }, []);
  const reset = useCallback((seed?: BookingDraftSeed) => {
    setDraft(draftFromComposerSeed(seed));
  }, []);

  return useMemo(
    () => ({
      draft,
      setRoom,
      setTime,
      setTitle,
      setDescription,
      setHost,
      setRequester,
      setAttendeeCount,
      setRepeat,
      setServices,
      addVisitor,
      updateVisitor,
      removeVisitor,
      setCostCenter,
      setTemplateId,
      replace,
      reset,
    }),
    [
      draft,
      setRoom,
      setTime,
      setTitle,
      setDescription,
      setHost,
      setRequester,
      setAttendeeCount,
      setRepeat,
      setServices,
      addVisitor,
      updateVisitor,
      removeVisitor,
      setCostCenter,
      setTemplateId,
      replace,
      reset,
    ],
  );
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
pnpm --filter @prequest/web test -- use-booking-draft.test
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/use-booking-draft.ts apps/web/src/components/booking-composer-v2/use-booking-draft.test.ts
git commit -m "feat(web): useBookingDraft hook with stable setters"
```

---

### Task 1.8: `deriveBuildingId` shared helper

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/derive-building-id.ts`
- Create: `apps/web/src/components/booking-composer-v2/derive-building-id.test.ts`

The visitors flush in the modal's submit (Phase 6.1) and the visitors-row's `bookingDefaults` building anchor (Phase 4.6) both need the same room→building walk. Lift it now so both phases reference one source.

- [ ] **Step 1: Failing test**

Create `apps/web/src/components/booking-composer-v2/derive-building-id.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { deriveBuildingId } from './derive-building-id';
import type { Space } from '@/api/spaces';

const tree: Space[] = [
  { id: 'site-1', name: 'HQ', type: 'site', parent_id: null, capacity: null } as unknown as Space,
  { id: 'b-1', name: 'Tower A', type: 'building', parent_id: 'site-1', capacity: null } as unknown as Space,
  { id: 'f-1', name: 'Floor 3', type: 'floor', parent_id: 'b-1', capacity: null } as unknown as Space,
  { id: 'r-1', name: 'Maple', type: 'room', parent_id: 'f-1', capacity: 8 } as unknown as Space,
  { id: 'r-orphan', name: 'Detached', type: 'room', parent_id: null, capacity: null } as unknown as Space,
  { id: 'site-only', name: 'Annex', type: 'site', parent_id: null, capacity: null } as unknown as Space,
  { id: 'r-site-only', name: 'AnnexRoom', type: 'room', parent_id: 'site-only', capacity: null } as unknown as Space,
];

describe('deriveBuildingId', () => {
  it('returns the building when one exists in the chain', () => {
    expect(deriveBuildingId(tree, 'r-1')).toBe('b-1');
  });

  it('falls back to a site when no building exists', () => {
    expect(deriveBuildingId(tree, 'r-site-only')).toBe('site-only');
  });

  it('returns empty string when no anchor can be resolved', () => {
    expect(deriveBuildingId(tree, 'r-orphan')).toBe('');
  });

  it('returns empty string when spaceId is null', () => {
    expect(deriveBuildingId(tree, null)).toBe('');
  });

  it('returns empty string when the cache is undefined', () => {
    expect(deriveBuildingId(undefined, 'r-1')).toBe('');
  });
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
pnpm --filter @prequest/web test -- derive-building-id.test
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/web/src/components/booking-composer-v2/derive-building-id.ts`:
```ts
import type { Space } from '@/api/spaces';

/**
 * Walk a Space up to its enclosing building. Used by the booking
 * composer's visitors flush + visitors-row defaults — visitor
 * invitations need a `building_id` but the composer only knows the
 * room. Reception's today view filters on exact `building_id`
 * equality, so a building wins over a site (the closest building in
 * the chain, not the closest ancestor).
 *
 * Edge case: if no building exists in the chain (rare), fall back to
 * the closest site so the visitor at least has SOME location anchor.
 *
 * Returns "" when nothing resolves so callers can disambiguate
 * "anchor not yet known" from "deliberately empty" with a single
 * truthy check.
 */
export function deriveBuildingId(
  spaces: Space[] | undefined,
  spaceId: string | null,
): string {
  if (!spaceId || !spaces) return '';
  const byId = new Map(spaces.map((s) => [s.id, s]));
  let cursor: Space | undefined = byId.get(spaceId);
  let fallbackSiteId = '';
  let depth = 0;
  while (cursor && depth < 10) {
    if (cursor.type === 'building') return cursor.id;
    if (cursor.type === 'site' && !fallbackSiteId) fallbackSiteId = cursor.id;
    if (!cursor.parent_id) break;
    cursor = byId.get(cursor.parent_id);
    depth += 1;
  }
  return fallbackSiteId;
}
```

- [ ] **Step 4: Run test — confirm passes**

```bash
pnpm --filter @prequest/web test -- derive-building-id.test
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/derive-building-id.ts apps/web/src/components/booking-composer-v2/derive-building-id.test.ts
git commit -m "feat(web): deriveBuildingId helper for visitors flush + defaults"
```

---

# Phase 2 — Quick popover

Goal: a `<QuickBookPopover>` (~360×220) anchored to scheduler tile clicks. Title input + duration chips + contextual hint + footer (Book + Advanced). Wired into the desk scheduler. The Advanced button just `console.log`s the draft until Phase 6 connects it to the modal.

### Task 2.1: `<QuickBookPopover>` shell + RTL test

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/quick-book-popover.tsx`
- Create: `apps/web/src/components/booking-composer-v2/quick-book-popover.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/booking-composer-v2/quick-book-popover.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QuickBookPopover } from './quick-book-popover';

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('QuickBookPopover', () => {
  it('renders the title input with the expected placeholder', () => {
    renderWithQuery(
      <QuickBookPopover
        open
        onOpenChange={vi.fn()}
        anchorEl={null}
        room={{
          space_id: 'r1',
          name: 'Maple',
          has_av_equipment: false,
          has_catering_vendor: false,
          needs_visitor_pre_registration: false,
        }}
        startAtIso="2026-05-07T10:00:00.000Z"
        endAtIso="2026-05-07T10:30:00.000Z"
        hostFirstName="Alex"
        onBook={vi.fn()}
        onAdvanced={vi.fn()}
      />,
    );
    expect(
      screen.getByPlaceholderText("Alex's Maple booking"),
    ).toBeInTheDocument();
  });

  it('calls onAdvanced with the current draft when Advanced is clicked', async () => {
    const onAdvanced = vi.fn();
    renderWithQuery(
      <QuickBookPopover
        open
        onOpenChange={vi.fn()}
        anchorEl={null}
        room={{
          space_id: 'r1',
          name: 'Maple',
          has_av_equipment: false,
          has_catering_vendor: false,
          needs_visitor_pre_registration: false,
        }}
        startAtIso="2026-05-07T10:00:00.000Z"
        endAtIso="2026-05-07T10:30:00.000Z"
        hostFirstName="Alex"
        onBook={vi.fn()}
        onAdvanced={onAdvanced}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /advanced/i }));
    expect(onAdvanced).toHaveBeenCalledTimes(1);
    expect(onAdvanced.mock.calls[0][0].spaceId).toBe('r1');
  });
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
pnpm --filter @prequest/web test -- quick-book-popover.test
```
Expected: FAIL "Cannot find module".

- [ ] **Step 3: Implement the popover**

Create `apps/web/src/components/booking-composer-v2/quick-book-popover.tsx`:
```tsx
import { useEffect, useMemo, useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverAnchor,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useMealWindows } from '@/api/meal-windows';
import {
  defaultTitle,
  draftFromComposerSeed,
  type BookingDraft,
} from './booking-draft';
import {
  getSuggestions,
  type SuggestionRoomFacts,
} from './contextual-suggestions';

const DURATION_CHIPS: Array<{ value: string; label: string; minutes: number }> = [
  { value: '30', label: '30m', minutes: 30 },
  { value: '60', label: '1h', minutes: 60 },
  { value: '120', label: '2h', minutes: 120 },
  { value: 'custom', label: 'Custom', minutes: 0 },
];

export interface QuickBookPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The DOM element the popover anchors to (e.g. the scheduler tile).
   *  null is supported for tests; the popover then renders at the
   *  default anchor position. */
  anchorEl: HTMLElement | null;
  room: SuggestionRoomFacts;
  startAtIso: string;
  endAtIso: string;
  hostFirstName: string | null;
  /** Called when the user clicks Book. */
  onBook: (draft: BookingDraft) => void | Promise<void>;
  /** Called when the user clicks Advanced or hits ⌘↵. The draft is
   *  passed so the modal can resume mid-edit. */
  onAdvanced: (draft: BookingDraft) => void;
}

/**
 * The 30-second create surface. Anchored to a scheduler tile click.
 * Two fields (title + duration) and a footer (Book + Advanced). When
 * the picked time spans a meal window or the room has a catering
 * vendor / needs-pre-reg wing, surfaces a single muted hint pointing
 * the user to the full composer.
 *
 * Spec: docs/superpowers/specs/2026-05-02-create-booking-modal-redesign.md §Quick-book popover.
 */
export function QuickBookPopover({
  open,
  onOpenChange,
  anchorEl,
  room,
  startAtIso,
  endAtIso,
  hostFirstName,
  onBook,
  onAdvanced,
}: QuickBookPopoverProps) {
  const initialMinutes = useMemo(() => {
    const s = new Date(startAtIso).getTime();
    const e = new Date(endAtIso).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 60;
    return Math.round((e - s) / 60_000);
  }, [startAtIso, endAtIso]);

  const initialChip = useMemo(() => {
    const match = DURATION_CHIPS.find((c) => c.minutes === initialMinutes);
    return match ? match.value : 'custom';
  }, [initialMinutes]);

  const [title, setTitle] = useState('');
  const [chip, setChip] = useState<string>(initialChip);

  // Reset when the popover re-opens for a new tile.
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setChip(initialChip);
  }, [open, initialChip]);

  const placeholder = defaultTitle({
    hostFirstName,
    roomName: room.name,
  });

  const effectiveStart = startAtIso;
  const effectiveEnd = useMemo(() => {
    const chipDef = DURATION_CHIPS.find((c) => c.value === chip);
    if (!chipDef || chipDef.value === 'custom') return endAtIso;
    return new Date(
      new Date(startAtIso).getTime() + chipDef.minutes * 60_000,
    ).toISOString();
  }, [chip, startAtIso, endAtIso]);

  const buildDraft = (): BookingDraft =>
    draftFromComposerSeed({
      title: title || placeholder,
      spaceId: room.space_id,
      startAt: effectiveStart,
      endAt: effectiveEnd,
    });

  const { data: mealWindows } = useMealWindows();
  const suggestions = useMemo(
    () => getSuggestions(buildDraft(), room, mealWindows ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, effectiveStart, effectiveEnd, mealWindows],
  );

  const cateringHint = suggestions.find((s) => s.target === 'catering');
  const visitorsHint = suggestions.find((s) => s.target === 'visitors');
  const hint = cateringHint
    ? 'Need catering? Open full composer →'
    : visitorsHint
      ? 'Visitors? Open full composer →'
      : null;

  const handleBook = () => {
    void onBook(buildDraft());
  };
  const handleAdvanced = () => {
    onAdvanced(buildDraft());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleAdvanced();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      handleBook();
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorEl ? { current: anchorEl } : undefined} />
      <PopoverContent
        // 360×~220 per spec. Inside the popover content stylebox.
        side="bottom"
        align="start"
        className="w-[360px] gap-3 p-3"
        onKeyDown={onKeyDown}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="qbp-title" className="sr-only">
              Title
            </FieldLabel>
            <Input
              id="qbp-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={placeholder}
              className="h-9 text-sm font-medium"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="qbp-duration" className="text-xs text-muted-foreground">
              Duration
            </FieldLabel>
            <ToggleGroup
              id="qbp-duration"
              value={[chip]}
              onValueChange={(v) => {
                const next = v[0];
                if (next) setChip(next);
              }}
              variant="outline"
              className="h-8 w-full justify-start"
            >
              {DURATION_CHIPS.map((c) => (
                <ToggleGroupItem
                  key={c.value}
                  value={c.value}
                  className="h-8 px-3 text-xs tabular-nums"
                >
                  {c.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          {hint && (
            <FieldDescription className="text-[12px]">{hint}</FieldDescription>
          )}
        </FieldGroup>
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={handleAdvanced}
          >
            Advanced ↗
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleBook}
            className="min-w-[5rem]"
          >
            Book
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: Run test — confirm it passes**

```bash
pnpm --filter @prequest/web test -- quick-book-popover.test
```
Expected: PASS. If `PopoverAnchor`/`virtualRef` doesn't exist on the project's popover primitive, swap for the BaseUI equivalent — read `apps/web/src/components/ui/popover.tsx` and adapt; the test only requires the popover renders content when `open=true`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/quick-book-popover.tsx apps/web/src/components/booking-composer-v2/quick-book-popover.test.tsx
git commit -m "feat(web): QuickBookPopover with title + duration chips + suggestions hint"
```

---

### Task 2.2: Wire scheduler tile-click to `<QuickBookPopover>`

**Files:**
- Modify: `apps/web/src/pages/desk/scheduler/index.tsx`
- Modify: `apps/web/src/pages/desk/scheduler/components/scheduler-create-popover.tsx`

The plan: keep the existing `SchedulerCreatePopover` (centered Dialog) for now as a fallback, but introduce `QuickBookPopover` as the primary tile-click surface. The Advanced button on the popover will open the existing dialog until Phase 3 ships the new modal.

- [ ] **Step 1: Read the current wiring**

Open `apps/web/src/pages/desk/scheduler/index.tsx` lines 218–250 (the `useDragCreate` block). The hook fires `onComplete({ spaceId, startCell, endCell })`. We're going to add a parallel `useState` for the quick-book popover and route allow-effect drags there.

- [ ] **Step 2: Add quick-book state**

In `apps/web/src/pages/desk/scheduler/index.tsx`, just after the existing `const [createPayload, setCreatePayload] = useState<{...}|null>(null);` (around line 220), add:
```tsx
  const [quickBookPayload, setQuickBookPayload] = useState<{
    room: SchedulerRoom;
    startAtIso: string;
    endAtIso: string;
    anchorEl: HTMLElement | null;
  } | null>(null);
  const [quickBookOpen, setQuickBookOpen] = useState(false);
```

- [ ] **Step 3: Route allow-effect drags into the popover**

Find the existing `dragCreate` block (around line 226):
```tsx
  const dragCreate = useDragCreate({
    columnsPerDay: win.columnsPerDay,
    numDays: win.dates.length,
    onComplete: (range) => {
      const room = data.rooms.find((r) => r.space_id === range.spaceId);
      if (!room) return;
      const eff = win.state.bookForPersonId ? room.rule_outcome.effect : 'allow';
      const startAtIso = cellToIso(range.startCell);
      const endAtIso = cellToIso(range.endCell + 1);
      if (eff === 'deny') {
        setOverrideRoom(room);
        setOverridePayload({ startAtIso, endAtIso });
        setOverrideOpen(true);
      } else {
        setCreatePayload({ room, startAtIso, endAtIso });
        setCreateDialogOpen(true);
      }
    },
  });
```

Replace the `else { setCreatePayload(...); setCreateDialogOpen(true); }` branch with quick-book opening:
```tsx
      } else {
        setQuickBookPayload({
          room,
          startAtIso,
          endAtIso,
          anchorEl: range.endTileEl ?? null,
        });
        setQuickBookOpen(true);
      }
```

If `range.endTileEl` doesn't exist on the hook's payload, omit the anchor (pass `null`); the popover will render at default anchor.

- [ ] **Step 4: Render the popover near the existing `SchedulerCreatePopover`**

Just above the existing `<SchedulerCreatePopover ...>` tag (around line 676), add:
```tsx
      {quickBookPayload && (
        <QuickBookPopover
          open={quickBookOpen}
          onOpenChange={(o) => {
            setQuickBookOpen(o);
            if (!o) setQuickBookPayload(null);
          }}
          anchorEl={quickBookPayload.anchorEl}
          room={{
            space_id: quickBookPayload.room.space_id,
            name: quickBookPayload.room.name,
            has_av_equipment: false,
            has_catering_vendor: false,
            needs_visitor_pre_registration: false,
          }}
          startAtIso={quickBookPayload.startAtIso}
          endAtIso={quickBookPayload.endAtIso}
          hostFirstName={person?.first_name ?? null}
          onBook={async (draft) => {
            // TEMPORARY in Phase 2: hand off to the existing dialog
            // until Phase 6 wires Book directly to POST /reservations.
            // The existing dialog already handles the full submit path.
            setQuickBookOpen(false);
            setCreatePayload({
              room: quickBookPayload.room,
              startAtIso: draft.startAt ?? quickBookPayload.startAtIso,
              endAtIso: draft.endAt ?? quickBookPayload.endAtIso,
            });
            setCreateDialogOpen(true);
          }}
          onAdvanced={(draft) => {
            // TEMPORARY in Phase 2: opens the existing centered dialog
            // until Phase 3 ships <BookingComposerModal> and Phase 6
            // re-routes here. Carries the draft's room + time over.
            setQuickBookOpen(false);
            setCreatePayload({
              room: quickBookPayload.room,
              startAtIso: draft.startAt ?? quickBookPayload.startAtIso,
              endAtIso: draft.endAt ?? quickBookPayload.endAtIso,
            });
            setCreateDialogOpen(true);
          }}
        />
      )}
```

Add the import at the top of the file:
```tsx
import { QuickBookPopover } from '@/components/booking-composer-v2/quick-book-popover';
```

- [ ] **Step 5: Build to verify wiring**

```bash
pnpm --filter @prequest/web build
```
Expected: success.

- [ ] **Step 6: Manual verification**

Run `pnpm dev`, open `/desk/scheduler`, drag-create on an allow-tile, confirm the new popover renders with the title input + duration chips. Click Book or Advanced — both should open the existing `<SchedulerCreatePopover>` dialog (the temporary handoff). Click cancel — popover closes cleanly.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/desk/scheduler/index.tsx
git commit -m "feat(scheduler): wire tile-click to QuickBookPopover (modal handoff still legacy)"
```

---

# Phase 3 — Full composer modal shell

Goal: The `<BookingComposerModal>` Dialog (880×680, max-h-[85vh], spring-open animation) with two-pane layout (left 520 / right 360, single bg, right pane inset). No content yet — just the shell. Connect to `useBookingDraft`.

### Task 3.1: `<BookingComposerModal>` shell

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx`
- Create: `apps/web/src/components/booking-composer-v2/booking-composer-modal.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/booking-composer-v2/booking-composer-modal.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookingComposerModal } from './booking-composer-modal';

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('BookingComposerModal shell', () => {
  it('renders with both panes when open', () => {
    renderWithQuery(
      <BookingComposerModal
        open
        onOpenChange={vi.fn()}
        mode="self"
        callerPersonId="p1"
        hostFirstName="Alex"
      />,
    );
    expect(screen.getByTestId('booking-composer-left-pane')).toBeInTheDocument();
    expect(screen.getByTestId('booking-composer-right-pane')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    renderWithQuery(
      <BookingComposerModal
        open={false}
        onOpenChange={vi.fn()}
        mode="self"
        callerPersonId="p1"
        hostFirstName="Alex"
      />,
    );
    expect(screen.queryByTestId('booking-composer-left-pane')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
pnpm --filter @prequest/web test -- booking-composer-modal.test
```
Expected: FAIL.

- [ ] **Step 3: Implement the shell**

Create `apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx`:
```tsx
import { useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useBookingDraft } from './use-booking-draft';
import { type BookingDraft } from './booking-draft';
import type { ComposerMode, ComposerEntrySource } from '../booking-composer/state';
import { cn } from '@/lib/utils';

export interface BookingComposerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: ComposerMode;
  entrySource?: ComposerEntrySource;
  callerPersonId: string;
  hostFirstName: string | null;
  /** Optional seed for the draft. The popover→modal escalation passes
   *  the popover's draft here. */
  initialDraft?: BookingDraft;
  /** Called after a successful booking lands. Wired in Phase 6. */
  onBooked?: (reservationId: string) => void;
}

/**
 * The redesigned full composer. Two-pane Dialog (880×680, max-h-[85vh]).
 * Phase 3 ships the shell only — the panes are wired in Phases 4 + 5.
 *
 * Animation: the shadcn `Dialog` primitive already handles open/close
 * with the `data-open` / `data-closed` data-attrs. We layer on a
 * spring-open motion via a className override on `DialogContent` so
 * the modal scales 0.96→1 with `var(--ease-spring)` over 380ms (per
 * spec §Polish micros).
 *
 * Spec: docs/superpowers/specs/2026-05-02-create-booking-modal-redesign.md.
 */
export function BookingComposerModal({
  open,
  onOpenChange,
  mode,
  callerPersonId,
  hostFirstName,
  initialDraft,
  // entrySource + onBooked wired in Phase 6.
}: BookingComposerModalProps) {
  const composer = useBookingDraft({
    seed: initialDraft
      ? { ...initialDraft }
      : { hostPersonId: callerPersonId, requesterPersonId: callerPersonId },
  });

  // Re-seed on open so cancelled sessions don't leak state.
  useEffect(() => {
    if (open) {
      composer.reset(
        initialDraft
          ? { ...initialDraft }
          : { hostPersonId: callerPersonId, requesterPersonId: callerPersonId },
      );
    }
    // intentionally only on open edge
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // 880×680, max-h-[85vh], spring open per spec §Polish micros.
        // Override default DialogContent sizing.
        className={cn(
          'w-[880px] max-w-[calc(100vw-2rem)] gap-0 p-0',
          'h-auto max-h-[min(85vh,680px)]',
          'rounded-xl overflow-hidden',
          'data-open:duration-[380ms] data-open:ease-[var(--ease-spring)]',
        )}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>New booking</DialogTitle>
          <DialogDescription>
            Configure a room booking. Title, time, and add-ins.
          </DialogDescription>
        </DialogHeader>
        <div className="flex h-full min-h-[480px] flex-col sm:flex-row">
          {/* Left pane — 520px on desktop, full width on mobile. */}
          <div
            data-testid="booking-composer-left-pane"
            className="flex flex-1 flex-col gap-4 overflow-y-auto p-5 sm:w-[520px] sm:flex-none"
          >
            {/* Phase 4 fills this. */}
            <p className="text-sm text-muted-foreground">
              {mode === 'operator'
                ? `Booking for someone (${hostFirstName ?? '—'})`
                : `Booking as ${hostFirstName ?? '—'}`}
            </p>
          </div>
          {/* Right pane — inset, hairline border per spec. 360px on
              desktop, stacks below on mobile per spec §Mobile behavior
              (handled by the flex-col sm:flex-row above). */}
          <aside
            data-testid="booking-composer-right-pane"
            className={cn(
              'm-2 flex flex-col gap-2 overflow-y-auto rounded-md border border-border/60 p-3',
              'sm:w-[360px] sm:flex-none',
            )}
          >
            {/* Phase 5 fills this. */}
            <p className="text-xs text-muted-foreground">Add-ins</p>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run test — confirm it passes**

```bash
pnpm --filter @prequest/web test -- booking-composer-modal.test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx apps/web/src/components/booking-composer-v2/booking-composer-modal.test.tsx
git commit -m "feat(web): BookingComposerModal shell (two-pane, spring-open)"
```

---

### Task 3.2: Backdrop animation polish

**Files:**
- Modify: `apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx`

The spec calls out: "Backdrop fades over 240ms `var(--ease-smooth)` — slower than the modal so the modal arrives first."

The shared `Dialog` primitive applies one duration to both. We add a per-instance overlay override.

- [ ] **Step 1: Verify the shared overlay**

Open `apps/web/src/components/ui/dialog.tsx` and read `DialogOverlay` — the className uses `duration-100`. We need 240ms for our modal, but we can't change the shared one without touching every other dialog.

- [ ] **Step 2: Use a custom overlay variant**

Add a thin local-overlay wrapper in `booking-composer-modal.tsx`. Replace the file's import line for `DialogContent` with:
```tsx
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPortal,
  DialogOverlay,
} from '@/components/ui/dialog';
```

If `DialogPortal` / `DialogOverlay` aren't already exported from `dialog.tsx`, add them to the file's exports. Verify by reading the bottom of `apps/web/src/components/ui/dialog.tsx`. If they're not exported, add this line near the bottom:
```tsx
export { DialogPortal, DialogOverlay };
```

- [ ] **Step 3: Wrap content with custom overlay**

Replace the `<Dialog>` block in `booking-composer-modal.tsx` with:
```tsx
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay
          className={cn(
            // Spec: backdrop fades over 240ms ease-smooth (slower than modal).
            'data-open:duration-[240ms] data-closed:duration-[240ms]',
            'data-open:ease-[var(--ease-smooth)] data-closed:ease-[var(--ease-smooth)]',
          )}
        />
        <DialogContent
          showCloseButton={false}
          className={cn(
            'w-[880px] max-w-[calc(100vw-2rem)] gap-0 p-0',
            'h-auto max-h-[min(85vh,680px)]',
            'rounded-xl overflow-hidden',
            'data-open:duration-[380ms] data-open:ease-[var(--ease-spring)]',
            // Spec: scale 0.96→1, NOT from 0.
            'data-open:zoom-in-[0.96]',
          )}
        >
          {/* …existing pane markup… */}
        </DialogContent>
      </DialogPortal>
    </Dialog>
```

Note: `data-open:zoom-in-[0.96]` is the Tailwind-animate-style override. If your Tailwind setup doesn't accept arbitrary values on this attribute, fall back to `data-open:zoom-in-95` (the default 95%) — 96% is the spec target but 95% is close and is the prebuilt token.

- [ ] **Step 4: Build to verify**

```bash
pnpm --filter @prequest/web build
```
Expected: success.

- [ ] **Step 5: Manual verification**

`pnpm dev` → open the modal somewhere temporarily (you can wire a test button in `/desk/bookings` page header). Observe: modal scales in over ~380ms, backdrop fades slower over ~240ms. Reduced-motion users get neither (CLAUDE.md global rule).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx apps/web/src/components/ui/dialog.tsx
git commit -m "polish(web): spring-open + slow-fade backdrop on BookingComposerModal"
```

---

# Phase 4 — Left pane

Goal: build out the left pane block-by-block — title input (with live placeholder), time row (popover with calendar + slots), repeat row (collapsed + popover), description, host picker, visitors v1 inline. All inside `FieldGroup` + `Field`.

### Task 4.1: Title input with live placeholder

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/left-pane/title-input.tsx`
- Modify: `apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx`

- [ ] **Step 1: Implement TitleInput**

Create `apps/web/src/components/booking-composer-v2/left-pane/title-input.tsx`:
```tsx
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { defaultTitle } from '../booking-draft';

export interface TitleInputProps {
  value: string;
  onChange: (next: string) => void;
  hostFirstName: string | null;
  roomName: string | null;
}

/**
 * The title input on the left pane. Placeholder updates live to
 * `"{Host first}'s {Room name} booking"` once both are known. Per the
 * spec, what-you-see-is-what-you-get — submitting blank uses the
 * placeholder string.
 */
export function TitleInput({
  value,
  onChange,
  hostFirstName,
  roomName,
}: TitleInputProps) {
  const placeholder = defaultTitle({ hostFirstName, roomName });
  return (
    <Field>
      <FieldLabel htmlFor="bcm-title" className="sr-only">
        Title
      </FieldLabel>
      <Input
        id="bcm-title"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        // Spec: title is the one exception to the 13–15px ramp.
        // text-base (16px) + font-medium.
        className="h-10 border-transparent bg-transparent px-2 text-base font-medium shadow-none focus-visible:border-ring"
      />
    </Field>
  );
}
```

- [ ] **Step 2: Wire into the modal**

In `booking-composer-modal.tsx`, replace the placeholder `<p className="text-sm text-muted-foreground">…</p>` inside the left pane with:
```tsx
            <TitleInput
              value={composer.draft.title}
              onChange={composer.setTitle}
              hostFirstName={hostFirstName}
              roomName={null /* Phase 5 wires roomName from the right-pane room card */}
            />
```

Add the import at the top:
```tsx
import { TitleInput } from './left-pane/title-input';
```

- [ ] **Step 3: Build to verify**

```bash
pnpm --filter @prequest/web build
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/left-pane/title-input.tsx apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx
git commit -m "feat(web): TitleInput for booking composer left pane"
```

---

### Task 4.2: Time row (From/To buttons → popover with calendar + slots)

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/left-pane/time-row.tsx`

- [ ] **Step 1: Implement TimeRow**

Create `apps/web/src/components/booking-composer-v2/left-pane/time-row.tsx`:
```tsx
import { useMemo, useState } from 'react';
import { Calendar } from '@/components/ui/calendar';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface TimeRowProps {
  startAt: string | null;
  endAt: string | null;
  onChange: (startAt: string | null, endAt: string | null) => void;
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

/** Generate 15-minute slots for a single day, returned as ISO strings. */
function generateSlotsForDay(localDay: Date): string[] {
  const slots: string[] = [];
  const base = new Date(localDay);
  base.setHours(0, 0, 0, 0);
  for (let i = 0; i < 96; i++) {
    const d = new Date(base.getTime() + i * 15 * 60_000);
    slots.push(d.toISOString());
  }
  return slots;
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return TIME_FORMAT.format(d);
}

function formatDay(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return DAY_FORMAT.format(d);
}

/**
 * From/To controls for the left pane. Each is a button styled like
 * `Wed, May 7 · 2:00 PM`; click → popover with calendar (left) + 15-min
 * slot list (right). Slots are rendered in `font-mono tabular-nums` per
 * spec polish micros.
 *
 * Conflict-strike (red strike on conflicting slots) is wired in Phase 6
 * when the conflict-check API is integrated; in this task we render
 * slots without conflict markers.
 */
export function TimeRow({ startAt, endAt, onChange }: TimeRowProps) {
  const [openSide, setOpenSide] = useState<'start' | 'end' | null>(null);

  const startDate = useMemo(
    () => (startAt ? new Date(startAt) : new Date()),
    [startAt],
  );
  const endDate = useMemo(
    () => (endAt ? new Date(endAt) : startDate),
    [endAt, startDate],
  );

  const dayForPopover = openSide === 'end' ? endDate : startDate;
  const slots = useMemo(() => generateSlotsForDay(dayForPopover), [dayForPopover]);

  const onPickStartSlot = (iso: string) => {
    // Preserve duration when the user picks a new start.
    let newEnd = endAt;
    if (startAt && endAt) {
      const dur = new Date(endAt).getTime() - new Date(startAt).getTime();
      newEnd = new Date(new Date(iso).getTime() + Math.max(15 * 60_000, dur)).toISOString();
    } else {
      newEnd = new Date(new Date(iso).getTime() + 60 * 60_000).toISOString();
    }
    onChange(iso, newEnd);
    setOpenSide(null);
  };

  const onPickEndSlot = (iso: string) => {
    onChange(startAt, iso);
    setOpenSide(null);
  };

  const onPickDay = (date: Date | undefined) => {
    if (!date) return;
    if (openSide === 'start') {
      // Move the start to that day, preserving local time-of-day.
      const next = new Date(date);
      const src = startAt ? new Date(startAt) : new Date();
      next.setHours(src.getHours(), src.getMinutes(), 0, 0);
      const dur =
        startAt && endAt
          ? new Date(endAt).getTime() - new Date(startAt).getTime()
          : 60 * 60_000;
      onChange(next.toISOString(), new Date(next.getTime() + dur).toISOString());
    } else if (openSide === 'end') {
      const next = new Date(date);
      const src = endAt ? new Date(endAt) : new Date();
      next.setHours(src.getHours(), src.getMinutes(), 0, 0);
      onChange(startAt, next.toISOString());
    }
  };

  return (
    <Field>
      <FieldLabel className="text-xs text-muted-foreground">When</FieldLabel>
      <div className="flex items-center gap-2">
        <TimeButton
          label={`${formatDay(startAt)} · ${formatTime(startAt)}`}
          open={openSide === 'start'}
          onOpenChange={(o) => setOpenSide(o ? 'start' : null)}
          calendarSelected={startDate}
          onCalendarSelect={onPickDay}
          slots={slots}
          onPickSlot={onPickStartSlot}
        />
        <span className="text-xs text-muted-foreground">→</span>
        <TimeButton
          label={`${formatDay(endAt)} · ${formatTime(endAt)}`}
          open={openSide === 'end'}
          onOpenChange={(o) => setOpenSide(o ? 'end' : null)}
          calendarSelected={endDate}
          onCalendarSelect={onPickDay}
          slots={slots}
          onPickSlot={onPickEndSlot}
        />
      </div>
    </Field>
  );
}

interface TimeButtonProps {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  calendarSelected: Date;
  onCalendarSelect: (date: Date | undefined) => void;
  slots: string[];
  onPickSlot: (iso: string) => void;
}

function TimeButton({
  label,
  open,
  onOpenChange,
  calendarSelected,
  onCalendarSelect,
  slots,
  onPickSlot,
}: TimeButtonProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 justify-start gap-1.5 px-3 font-normal tabular-nums"
        >
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        className="flex w-auto gap-3 p-3"
      >
        <Calendar
          mode="single"
          selected={calendarSelected}
          onSelect={onCalendarSelect}
        />
        <div
          className="flex max-h-[280px] w-[140px] flex-col gap-0.5 overflow-y-auto pr-1"
          role="listbox"
          aria-label="Time slots"
        >
          {slots.map((iso) => (
            <button
              key={iso}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => onPickSlot(iso)}
              className={cn(
                'flex h-7 w-full items-center justify-start rounded-md px-2',
                'font-mono text-[12px] tabular-nums text-foreground/80',
                'transition-colors hover:bg-accent/50 hover:text-foreground',
                '[transition-duration:100ms] [transition-timing-function:var(--ease-snap)]',
              )}
            >
              {TIME_FORMAT.format(new Date(iso))}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Wire into the modal**

In `booking-composer-modal.tsx` left pane, just below the `TitleInput`, add:
```tsx
            <TimeRow
              startAt={composer.draft.startAt}
              endAt={composer.draft.endAt}
              onChange={composer.setTime}
            />
```

Add import:
```tsx
import { TimeRow } from './left-pane/time-row';
```

- [ ] **Step 3: Build**

```bash
pnpm --filter @prequest/web build
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/left-pane/time-row.tsx apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx
git commit -m "feat(web): TimeRow with calendar + 15-min slot popover (mono slots)"
```

---

### Task 4.3: Repeat row (collapsed → popover)

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/left-pane/repeat-row.tsx`

The existing `RecurrenceField` (`booking-composer/sections/recurrence-field.tsx`) already implements the rule editor inline. We extract its UX into a popover-triggered shell here.

- [ ] **Step 1: Read the existing recurrence field**

Open `apps/web/src/components/booking-composer/sections/recurrence-field.tsx` to understand its `rule`/`onChange` contract.

- [ ] **Step 2: Implement RepeatRow**

Create `apps/web/src/components/booking-composer-v2/left-pane/repeat-row.tsx`:
```tsx
import { useState } from 'react';
import { Field, FieldLabel } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { RecurrenceField } from '@/components/booking-composer/sections/recurrence-field';
import type { RecurrenceRule } from '@/api/room-booking';
import { cn } from '@/lib/utils';

export interface RepeatRowProps {
  rule: RecurrenceRule | null;
  onChange: (rule: RecurrenceRule | null) => void;
}

/**
 * Compact recurrence chooser. Collapsed by default; opens a popover with
 * the existing `RecurrenceField` inside. When set, the row reads
 * `"Weekly on Wednesdays, until Jun 30"` in `text-foreground` instead of
 * muted (per spec).
 */
export function RepeatRow({ rule, onChange }: RepeatRowProps) {
  const [open, setOpen] = useState(false);

  const summary = rule ? summarizeRule(rule) : "Doesn't repeat";

  return (
    <Field>
      <FieldLabel className="sr-only">Repeat</FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              'h-8 justify-start px-2 text-xs font-normal',
              rule ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {summary}
            <span className="ml-1 text-muted-foreground">▾</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" side="bottom" className="w-[360px] p-3">
          <RecurrenceField rule={rule} onChange={onChange} />
        </PopoverContent>
      </Popover>
    </Field>
  );
}

function summarizeRule(r: RecurrenceRule): string {
  const freq =
    r.frequency === 'daily'
      ? 'Daily'
      : r.frequency === 'weekly'
        ? 'Weekly'
        : 'Monthly';
  const interval = r.interval && r.interval > 1 ? ` every ${r.interval}` : '';
  const until = r.until
    ? `, until ${new Date(r.until).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    : r.count
      ? `, ${r.count} times`
      : '';
  return `${freq}${interval}${until}`;
}
```

- [ ] **Step 3: Wire into the modal**

In `booking-composer-modal.tsx` left pane, after `TimeRow`, add:
```tsx
            <RepeatRow
              rule={composer.draft.recurrence}
              onChange={composer.setRepeat}
            />
```

Add import:
```tsx
import { RepeatRow } from './left-pane/repeat-row';
```

- [ ] **Step 4: Build**

```bash
pnpm --filter @prequest/web build
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/left-pane/repeat-row.tsx apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx
git commit -m "feat(web): RepeatRow popover wraps existing RecurrenceField"
```

---

### Task 4.4: Description textarea

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/left-pane/description-row.tsx`

- [ ] **Step 1: Implement**

Create `apps/web/src/components/booking-composer-v2/left-pane/description-row.tsx`:
```tsx
import { Field, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

export interface DescriptionRowProps {
  value: string;
  onChange: (next: string) => void;
}

/**
 * Free-text description. 2–3 visible rows, `resize-none`, auto-grows up
 * to ~6 rows via `min-h` + `max-h` (browser handles the auto-resize via
 * the `field-sizing-content` Tailwind utility on supporting browsers).
 */
export function DescriptionRow({ value, onChange }: DescriptionRowProps) {
  return (
    <Field>
      <FieldLabel htmlFor="bcm-description" className="text-xs text-muted-foreground">
        Description
      </FieldLabel>
      <Textarea
        id="bcm-description"
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Add agenda, links, or context"
        className="min-h-[64px] max-h-[160px] resize-none text-sm"
      />
    </Field>
  );
}
```

- [ ] **Step 2: Wire**

In `booking-composer-modal.tsx`:
```tsx
            <DescriptionRow
              value={composer.draft.description}
              onChange={composer.setDescription}
            />
```

Add import:
```tsx
import { DescriptionRow } from './left-pane/description-row';
```

- [ ] **Step 3: Build**

```bash
pnpm --filter @prequest/web build
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/left-pane/description-row.tsx apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx
git commit -m "feat(web): DescriptionRow textarea on booking composer left pane"
```

---

### Task 4.5: Host picker

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/left-pane/host-row.tsx`

- [ ] **Step 1: Implement**

Create `apps/web/src/components/booking-composer-v2/left-pane/host-row.tsx`:
```tsx
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { PersonPicker } from '@/components/person-picker';

export interface HostRowProps {
  /** Operator-mode "booking for" person id. */
  requesterPersonId: string | null;
  onRequesterChange: (id: string | null) => void;
  hostPersonId: string | null;
  onHostChange: (id: string | null) => void;
  mode: 'self' | 'operator';
}

/**
 * Host + (operator) Booking-for picker. In `self` mode we just show the
 * host (defaulted to caller in the modal shell). In `operator` mode we
 * additionally surface the requester picker, mirroring the legacy
 * composer's "Booking for" field.
 */
export function HostRow({
  requesterPersonId,
  onRequesterChange,
  hostPersonId,
  onHostChange,
  mode,
}: HostRowProps) {
  return (
    <>
      {mode === 'operator' && (
        <Field>
          <FieldLabel htmlFor="bcm-requester" className="text-xs text-muted-foreground">
            Booking for
          </FieldLabel>
          <PersonPicker
            value={requesterPersonId}
            onChange={onRequesterChange}
            excludeId={null}
            placeholder="Pick a person…"
          />
          <FieldDescription>
            Their cost center, rule universe, and calendar are used.
          </FieldDescription>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="bcm-host" className="text-xs text-muted-foreground">
          Host
        </FieldLabel>
        <PersonPicker
          value={hostPersonId}
          onChange={onHostChange}
          excludeId={null}
          placeholder="Meeting host"
        />
      </Field>
    </>
  );
}
```

- [ ] **Step 2: Wire**

In `booking-composer-modal.tsx`:
```tsx
            <HostRow
              mode={mode}
              requesterPersonId={composer.draft.requesterPersonId}
              onRequesterChange={composer.setRequester}
              hostPersonId={composer.draft.hostPersonId}
              onHostChange={composer.setHost}
            />
```

Add import:
```tsx
import { HostRow } from './left-pane/host-row';
```

- [ ] **Step 3: Build**

```bash
pnpm --filter @prequest/web build
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/left-pane/host-row.tsx apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx
git commit -m "feat(web): HostRow + operator Booking-for picker"
```

---

### Task 4.6: Visitors v1 inline section

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/left-pane/visitors-row.tsx`
- Create: `apps/web/src/components/booking-composer-v2/left-pane/visitors-row.test.tsx`

The legacy composer uses `<VisitorsSection>` (in `apps/web/src/components/booking-composer/sections/visitors-section.tsx`) which opens a `<VisitorInviteForm>` Dialog. That component already handles the `visitor_type_id` problem: hosts can't read `/admin/visitors/types`, so the form falls back to `visitor_type_key` aliases until slice 9 ships a host-accessible endpoint (see `apps/web/src/api/visitors/index.ts:DEFAULT_VISITOR_TYPES`).

The redesign spec calls for a "two-column quick-add row" inline at the bottom (name + email → chip on Enter). Building an inline-form-only path requires the same fallback the legacy modal does — without it, every Enter would 422. We solve this by **wrapping the existing `<VisitorsSection>` with a thin chip-styled list above it**: chips for visitors already on the draft, and the existing "+ Add a visitor" Button (which opens `VisitorInviteForm`) for the add path. The inline two-field row is deferred until the host visitor-types endpoint lands.

The wrapped component is named `<VisitorsRow>` so the rest of the plan + spec self-review still match.

- [ ] **Step 1: Failing test**

Create `apps/web/src/components/booking-composer-v2/left-pane/visitors-row.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VisitorsRow } from './visitors-row';

describe('VisitorsRow', () => {
  it('renders existing visitors as chips with a remove control', async () => {
    const onRemove = vi.fn();
    render(
      <VisitorsRow
        visitors={[
          {
            local_id: 'v1',
            first_name: 'Alex',
            email: 'a@x.com',
            visitor_type_id: 'vt',
          },
        ]}
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onRemove={onRemove}
        bookingDefaults={{}}
        disabled={false}
      />,
    );
    expect(screen.getByText('Alex')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: /remove visitor alex/i }),
    );
    expect(onRemove).toHaveBeenCalledWith('v1');
  });

  it('renders the disabled hint when disabled', () => {
    render(
      <VisitorsRow
        visitors={[]}
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
        bookingDefaults={{}}
        disabled
        disabledReason="Pick a room first."
      />,
    );
    expect(screen.getByText('Pick a room first.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
pnpm --filter @prequest/web test -- visitors-row.test
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/web/src/components/booking-composer-v2/left-pane/visitors-row.tsx`:
```tsx
import { X } from 'lucide-react';
import { VisitorsSection } from '@/components/booking-composer/sections/visitors-section';
import type { VisitorInviteFormDefaults } from '@/components/portal/visitor-invite-form';
import type { PendingVisitor } from '@/components/booking-composer/state';
import {
  FieldSet,
  FieldLegend,
  FieldDescription,
} from '@/components/ui/field';

export interface VisitorsRowProps {
  visitors: PendingVisitor[];
  bookingDefaults: VisitorInviteFormDefaults;
  disabled?: boolean;
  disabledReason?: string;
  onAdd: (visitor: PendingVisitor) => void;
  onUpdate: (visitor: PendingVisitor) => void;
  onRemove: (localId: string) => void;
}

/**
 * v1 visitors section on the redesign's left pane. Renders existing
 * visitors as compact pill chips above the legacy `<VisitorsSection>`
 * "+ Add a visitor" affordance. Internally `<VisitorsSection>` opens
 * `<VisitorInviteForm>` in a Dialog — that's the only path today that
 * resolves the `visitor_type_id` problem (hosts can't list types
 * directly; the form sends `visitor_type_key` and the backend resolves).
 *
 * The spec calls for a two-column inline quick-add row. We defer that
 * to v2 (and to slice 9 when a host-accessible /visitor-types endpoint
 * ships). The chip presentation alone is the v1 polish.
 *
 * Per the spec, the visitor host defaults to the booking host —
 * `<VisitorInviteForm>` already does this via `bookingDefaults`.
 */
export function VisitorsRow({
  visitors,
  bookingDefaults,
  disabled,
  disabledReason,
  onAdd,
  onUpdate,
  onRemove,
}: VisitorsRowProps) {
  return (
    <FieldSet>
      <FieldLegend variant="label">Visitors</FieldLegend>
      <FieldDescription>
        Pre-register people coming for this meeting.
      </FieldDescription>
      {visitors.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {visitors.map((v) => (
            <li
              key={v.local_id}
              className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs"
            >
              <span className="font-medium">{v.first_name}</span>
              {v.email && <span className="text-muted-foreground">{v.email}</span>}
              <button
                type="button"
                aria-label={`Remove visitor ${v.first_name}`}
                onClick={() => onRemove(v.local_id)}
                className="ml-1 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <VisitorsSection
        visitors={visitors}
        bookingDefaults={bookingDefaults}
        disabled={disabled}
        disabledReason={disabledReason}
        onAdd={onAdd}
        onUpdate={onUpdate}
        onRemove={onRemove}
      />
    </FieldSet>
  );
}
```

- [ ] **Step 4: Run test — confirm it passes**

```bash
pnpm --filter @prequest/web test -- visitors-row.test
```
Expected: PASS. The test mounts the component without a real network — the inner `<VisitorsSection>` button is rendered but not clicked, so no API calls fire.

- [ ] **Step 5: Wire into the modal**

In `booking-composer-modal.tsx`, add:
```tsx
            <VisitorsRow
              visitors={composer.draft.visitors}
              bookingDefaults={{
                expected_at: composer.draft.startAt ?? undefined,
                expected_until: composer.draft.endAt ?? undefined,
                building_id:
                  deriveBuildingId(spacesCache as Space[] | undefined, composer.draft.spaceId) || undefined,
                meeting_room_id: composer.draft.spaceId ?? undefined,
              }}
              disabled={!composer.draft.spaceId || !composer.draft.startAt}
              disabledReason={
                !composer.draft.spaceId
                  ? 'Pick a room first — visitors are anchored to a building.'
                  : !composer.draft.startAt
                    ? 'Pick a start time first.'
                    : undefined
              }
              onAdd={composer.addVisitor}
              onUpdate={composer.updateVisitor}
              onRemove={composer.removeVisitor}
            />
```

Add imports:
```tsx
import { VisitorsRow } from './left-pane/visitors-row';
import { deriveBuildingId } from './derive-building-id';
import { spacesListOptions, type Space } from '@/api/spaces';
import { useQuery } from '@tanstack/react-query';
```

If `spacesCache` isn't yet declared in the modal's body (it gets declared in Phase 5.6 step 3), add a minimal version now:
```tsx
  const { data: spacesCache } = useQuery(spacesListOptions());
```
Phase 5.6 will reuse the same value rather than redeclaring.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/left-pane/visitors-row.tsx apps/web/src/components/booking-composer-v2/left-pane/visitors-row.test.tsx apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx
git commit -m "feat(web): VisitorsRow wraps legacy VisitorsSection with chip presentation"
```

---

# Phase 5 — Right pane

Goal: addin-stack + addin-card primitive (collapsed 64px / expanded inline via `grid-template-rows: 0fr → 1fr`), three card types (room/catering/AV), wire `getSuggestions` for the `Suggested` chip.

### Task 5.1: `<AddinCard>` primitive with inline-expand

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/right-pane/addin-card.tsx`
- Create: `apps/web/src/components/booking-composer-v2/right-pane/addin-card.test.tsx`

- [ ] **Step 1: Failing test**

Create `apps/web/src/components/booking-composer-v2/right-pane/addin-card.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Coffee } from 'lucide-react';
import { AddinCard } from './addin-card';

describe('AddinCard', () => {
  it('renders the collapsed state with an empty prompt', () => {
    render(
      <AddinCard
        icon={Coffee}
        title="Catering"
        emptyPrompt="Add catering"
        filled={false}
        expanded={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('Add catering')).toBeInTheDocument();
  });

  it('shows the Suggested chip when suggested is true', () => {
    render(
      <AddinCard
        icon={Coffee}
        title="Catering"
        emptyPrompt="Add catering"
        filled={false}
        expanded={false}
        onToggle={vi.fn()}
        suggested
        suggestionReason="Booking spans lunch"
      />,
    );
    expect(screen.getByText('Suggested')).toBeInTheDocument();
  });

  it('calls onToggle when the header is clicked', async () => {
    const onToggle = vi.fn();
    render(
      <AddinCard
        icon={Coffee}
        title="Catering"
        emptyPrompt="Add catering"
        filled={false}
        expanded={false}
        onToggle={onToggle}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /catering/i }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('renders children inside the expanded body', () => {
    render(
      <AddinCard
        icon={Coffee}
        title="Catering"
        emptyPrompt="Add catering"
        filled={false}
        expanded={true}
        onToggle={vi.fn()}
      >
        <div data-testid="addin-body">picker goes here</div>
      </AddinCard>,
    );
    expect(screen.getByTestId('addin-body')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test — confirm failure**

```bash
pnpm --filter @prequest/web test -- right-pane/addin-card.test
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/web/src/components/booking-composer-v2/right-pane/addin-card.tsx`:
```tsx
import { type LucideIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface AddinCardProps {
  icon: LucideIcon;
  title: string;
  /** Shown in the header when no value is set (e.g. "Add catering"). */
  emptyPrompt: string;
  /** When set, replaces emptyPrompt. Examples: "3 services · €240",
   *  "Maple · 12 cap". */
  summary?: string;
  /** Filled state earns a hair more contrast on the border per spec. */
  filled: boolean;
  /** Inline-expand state. When true the body slot animates open. */
  expanded: boolean;
  onToggle: (next: boolean) => void;
  /** When true, paints a "Suggested" chip in the top-right with hover
   *  tooltip. The chip is the discoverability fix per spec. */
  suggested?: boolean;
  suggestionReason?: string;
  /** The expandable body. Rendered inside a `grid-template-rows: 0fr →
   *  1fr` container so the open/close transition is fluid (no
   *  measure-and-set-height JS). */
  children?: React.ReactNode;
}

/**
 * The collapsed-state card on the right pane. ~64px tall when
 * collapsed; expands inline when clicked. Per spec, opening one card
 * does NOT auto-collapse siblings — that's parent-controlled (the
 * `<AddinStack>` decides whether to enforce single-expand).
 */
export function AddinCard({
  icon: Icon,
  title,
  emptyPrompt,
  summary,
  filled,
  expanded,
  onToggle,
  suggested,
  suggestionReason,
  children,
}: AddinCardProps) {
  return (
    <article
      className={cn(
        'overflow-hidden rounded-lg border bg-card transition-colors',
        // Spec: filled cards earn a hair more contrast.
        filled ? 'border-foreground/10' : 'border-foreground/5',
        '[transition-duration:120ms] [transition-timing-function:var(--ease-snap)]',
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(!expanded)}
        className={cn(
          'group/card flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left',
          'transition-colors hover:bg-accent/50',
          '[transition-duration:100ms] [transition-timing-function:var(--ease-snap)]',
        )}
        aria-expanded={expanded}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon
            className={cn(
              'size-4 shrink-0',
              filled ? 'text-foreground' : 'text-foreground/40',
            )}
            aria-hidden
          />
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-foreground">{title}</div>
            <div className="truncate text-[12px] text-muted-foreground">
              {summary ?? emptyPrompt}
            </div>
          </div>
        </div>
        {suggested && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  'shrink-0 rounded-full bg-foreground/5 px-1.5 py-0.5 text-[11px] text-foreground/70',
                  'tabular-nums',
                )}
                aria-label={`Suggested: ${suggestionReason ?? ''}`}
              >
                Suggested
              </span>
            </TooltipTrigger>
            {suggestionReason && (
              <TooltipContent side="left" align="center" className="max-w-[220px]">
                <p className="text-xs">{suggestionReason}</p>
              </TooltipContent>
            )}
          </Tooltip>
        )}
      </button>
      {/* Spec: 0fr → 1fr grid-template-rows for fluid inline-expand. */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] ease-[var(--ease-smooth)]',
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
        style={{ transitionDuration: '240ms' }}
        aria-hidden={!expanded}
      >
        <div className="overflow-hidden">
          {expanded && (
            <div className="border-t border-border/60 px-3 py-3">{children}</div>
          )}
        </div>
      </div>
    </article>
  );
}
```

- [ ] **Step 4: Run test — confirm passes**

```bash
pnpm --filter @prequest/web test -- right-pane/addin-card.test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/right-pane/
git commit -m "feat(web): AddinCard primitive with inline-expand + Suggested chip"
```

---

### Task 5.2: `<AddinStack>` container

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/right-pane/addin-stack.tsx`

- [ ] **Step 1: Implement**

Create `apps/web/src/components/booking-composer-v2/right-pane/addin-stack.tsx`:
```tsx
import { useState, type ReactNode } from 'react';

export type AddinKey = 'room' | 'catering' | 'av_equipment';

export interface AddinStackProps {
  children: (args: {
    expanded: AddinKey | null;
    setExpanded: (key: AddinKey | null) => void;
  }) => ReactNode;
}

/**
 * Renders cards as siblings; enforces single-expand-at-a-time per spec
 * ("Cards expand inline when clicked — siblings collapse to one-line
 * summaries"). Render-prop API gives child cards control over their own
 * expand state without prop-drilling from the modal.
 */
export function AddinStack({ children }: AddinStackProps) {
  const [expanded, setExpanded] = useState<AddinKey | null>(null);
  return (
    <div className="flex flex-col gap-2">
      {children({ expanded, setExpanded })}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/right-pane/addin-stack.tsx
git commit -m "feat(web): AddinStack with single-expand semantics"
```

---

### Task 5.3: Room card (pick-room flow when entered without a room)

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/right-pane/room-card.tsx`

- [ ] **Step 1: Implement**

Create `apps/web/src/components/booking-composer-v2/right-pane/room-card.tsx`:
```tsx
import { MapPin } from 'lucide-react';
import { AddinCard } from './addin-card';
import { RoomPickerInline } from '@/components/booking-composer/sections/room-picker-inline';

export interface RoomCardProps {
  spaceId: string | null;
  roomName: string | null;
  capacity: number | null;
  attendeeCount: number;
  expanded: boolean;
  onToggle: (next: boolean) => void;
  onChange: (spaceId: string | null) => void;
}

export function RoomCard({
  spaceId,
  roomName,
  capacity,
  attendeeCount,
  expanded,
  onToggle,
  onChange,
}: RoomCardProps) {
  const summary = roomName
    ? `${roomName}${capacity != null ? ` · ${capacity} cap` : ''}`
    : undefined;
  return (
    <AddinCard
      icon={MapPin}
      title="Room"
      emptyPrompt="Pick a room"
      summary={summary}
      filled={Boolean(spaceId)}
      expanded={expanded}
      onToggle={onToggle}
    >
      <RoomPickerInline
        value={spaceId}
        attendeeCount={attendeeCount}
        excludeIds={[]}
        onChange={onChange}
      />
    </AddinCard>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/right-pane/room-card.tsx
git commit -m "feat(web): RoomCard reuses RoomPickerInline inside AddinCard"
```

---

### Task 5.4: Catering card (reuses `ServicePickerBody` filtered to catering tab)

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/right-pane/catering-card.tsx`

- [ ] **Step 1: Implement**

Create `apps/web/src/components/booking-composer-v2/right-pane/catering-card.tsx`:
```tsx
import { Coffee } from 'lucide-react';
import { AddinCard } from './addin-card';
import { ServicePickerBody, type PickerSelection } from '@/components/booking-composer/service-picker-sheet';
import { formatCurrency } from '@/lib/format';

export interface CateringCardProps {
  spaceId: string | null;
  startAt: string | null;
  endAt: string | null;
  attendeeCount: number;
  selections: PickerSelection[];
  onSelectionsChange: (next: PickerSelection[]) => void;
  expanded: boolean;
  onToggle: (next: boolean) => void;
  suggested?: boolean;
  suggestionReason?: string;
}

export function CateringCard({
  spaceId,
  startAt,
  endAt,
  attendeeCount,
  selections,
  onSelectionsChange,
  expanded,
  onToggle,
  suggested,
  suggestionReason,
}: CateringCardProps) {
  const cateringSelections = selections.filter((s) => s.service_type === 'catering');
  const total = cateringSelections.reduce((sum, s) => {
    if (s.unit_price == null) return sum;
    if (s.unit === 'per_person') return sum + s.unit_price * s.quantity * Math.max(1, attendeeCount);
    if (s.unit === 'flat_rate') return sum + s.unit_price;
    return sum + s.unit_price * s.quantity;
  }, 0);
  const summary = cateringSelections.length
    ? `${cateringSelections.length} item${cateringSelections.length !== 1 ? 's' : ''} · ${formatCurrency(total)}`
    : undefined;
  // Get date string from startAt for the picker body
  const onDate = startAt ? startAt.slice(0, 10) : null;
  return (
    <AddinCard
      icon={Coffee}
      title="Catering"
      emptyPrompt="Add catering"
      summary={summary}
      filled={cateringSelections.length > 0}
      expanded={expanded}
      onToggle={onToggle}
      suggested={suggested}
      suggestionReason={suggestionReason}
    >
      <ServicePickerBody
        deliverySpaceId={spaceId}
        onDate={onDate}
        attendeeCount={attendeeCount}
        bookingStartAt={startAt}
        bookingEndAt={endAt}
        selections={selections}
        onSelectionsChange={onSelectionsChange}
        initialServiceType="catering"
      />
    </AddinCard>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/right-pane/catering-card.tsx
git commit -m "feat(web): CateringCard wraps ServicePickerBody inside AddinCard"
```

---

### Task 5.5: AV card

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/right-pane/av-card.tsx`

- [ ] **Step 1: Implement**

Create `apps/web/src/components/booking-composer-v2/right-pane/av-card.tsx`:
```tsx
import { Speaker } from 'lucide-react';
import { AddinCard } from './addin-card';
import { ServicePickerBody, type PickerSelection } from '@/components/booking-composer/service-picker-sheet';

export interface AvCardProps {
  spaceId: string | null;
  startAt: string | null;
  endAt: string | null;
  attendeeCount: number;
  selections: PickerSelection[];
  onSelectionsChange: (next: PickerSelection[]) => void;
  expanded: boolean;
  onToggle: (next: boolean) => void;
  suggested?: boolean;
  suggestionReason?: string;
}

export function AvCard({
  spaceId,
  startAt,
  endAt,
  attendeeCount,
  selections,
  onSelectionsChange,
  expanded,
  onToggle,
  suggested,
  suggestionReason,
}: AvCardProps) {
  const av = selections.filter((s) => s.service_type === 'av_equipment');
  const summary = av.length
    ? `${av.length} item${av.length !== 1 ? 's' : ''}`
    : undefined;
  const onDate = startAt ? startAt.slice(0, 10) : null;
  return (
    <AddinCard
      icon={Speaker}
      title="AV equipment"
      emptyPrompt="Add AV equipment"
      summary={summary}
      filled={av.length > 0}
      expanded={expanded}
      onToggle={onToggle}
      suggested={suggested}
      suggestionReason={suggestionReason}
    >
      <ServicePickerBody
        deliverySpaceId={spaceId}
        onDate={onDate}
        attendeeCount={attendeeCount}
        bookingStartAt={startAt}
        bookingEndAt={endAt}
        selections={selections}
        onSelectionsChange={onSelectionsChange}
        initialServiceType="av_equipment"
      />
    </AddinCard>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/right-pane/av-card.tsx
git commit -m "feat(web): AvCard wraps ServicePickerBody (av tab)"
```

---

### Task 5.6: Wire right pane into the modal + suggestions

**Files:**
- Modify: `apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx`

- [ ] **Step 1: Read meal windows + room facts**

The modal needs the room name to populate `TitleInput`'s `roomName` and the suggestion engine needs `SuggestionRoomFacts`. The simplest source: read the spaces cache and look up by `spaceId`, then derive booleans (set them all to false in v1 — additive over time per the suggestions module's design).

- [ ] **Step 2: Replace the placeholder right pane**

In `booking-composer-modal.tsx`, replace the `<aside data-testid="booking-composer-right-pane">…</aside>` block with:
```tsx
          <aside
            data-testid="booking-composer-right-pane"
            className={cn(
              'm-2 flex flex-col gap-2 overflow-y-auto rounded-md border border-border/60 p-3',
              'sm:w-[360px] sm:flex-none',
            )}
          >
            <AddinStack>
              {({ expanded, setExpanded }) => (
                <>
                  <RoomCard
                    spaceId={composer.draft.spaceId}
                    roomName={pickedRoom?.name ?? null}
                    capacity={pickedRoom?.capacity ?? null}
                    attendeeCount={composer.draft.attendeeCount}
                    expanded={expanded === 'room'}
                    onToggle={(o) => setExpanded(o ? 'room' : null)}
                    onChange={composer.setRoom}
                  />
                  <CateringCard
                    spaceId={composer.draft.spaceId}
                    startAt={composer.draft.startAt}
                    endAt={composer.draft.endAt}
                    attendeeCount={composer.draft.attendeeCount}
                    selections={composer.draft.services}
                    onSelectionsChange={composer.setServices}
                    expanded={expanded === 'catering'}
                    onToggle={(o) => setExpanded(o ? 'catering' : null)}
                    suggested={suggestions.some((s) => s.target === 'catering')}
                    suggestionReason={
                      suggestions.find((s) => s.target === 'catering')?.reason
                    }
                  />
                  <AvCard
                    spaceId={composer.draft.spaceId}
                    startAt={composer.draft.startAt}
                    endAt={composer.draft.endAt}
                    attendeeCount={composer.draft.attendeeCount}
                    selections={composer.draft.services}
                    onSelectionsChange={composer.setServices}
                    expanded={expanded === 'av_equipment'}
                    onToggle={(o) => setExpanded(o ? 'av_equipment' : null)}
                    suggested={suggestions.some((s) => s.target === 'av_equipment')}
                    suggestionReason={
                      suggestions.find((s) => s.target === 'av_equipment')?.reason
                    }
                  />
                </>
              )}
            </AddinStack>
          </aside>
```

Add the imports:
```tsx
import { useQuery } from '@tanstack/react-query';
import { spacesListOptions, type Space } from '@/api/spaces';
import { useMealWindows } from '@/api/meal-windows';
import { AddinStack } from './right-pane/addin-stack';
import { RoomCard } from './right-pane/room-card';
import { CateringCard } from './right-pane/catering-card';
import { AvCard } from './right-pane/av-card';
import { getSuggestions, type SuggestionRoomFacts } from './contextual-suggestions';
import { useMemo } from 'react';
```

- [ ] **Step 3: Compute `pickedRoom` + `suggestions`**

Inside the `BookingComposerModal` body, after the `useBookingDraft` call, add:
```tsx
  const { data: spacesCache } = useQuery(spacesListOptions());
  const pickedRoom = useMemo(() => {
    if (!composer.draft.spaceId || !spacesCache) return null;
    const s = (spacesCache as Space[]).find((sp) => sp.id === composer.draft.spaceId);
    return s
      ? { space_id: s.id, name: s.name, capacity: s.capacity ?? null }
      : null;
  }, [composer.draft.spaceId, spacesCache]);

  const roomFacts: SuggestionRoomFacts | null = pickedRoom
    ? {
        space_id: pickedRoom.space_id,
        name: pickedRoom.name,
        // Phase 5 ships with these signals OFF — the API contract for
        // surfacing them on Space is a follow-up. The suggestion engine
        // is shape-stable; flipping these on later just lights up
        // the chips.
        has_av_equipment: false,
        has_catering_vendor: false,
        needs_visitor_pre_registration: false,
      }
    : null;

  const { data: mealWindows } = useMealWindows();
  const suggestions = useMemo(
    () => getSuggestions(composer.draft, roomFacts, mealWindows ?? []),
    [composer.draft, roomFacts, mealWindows],
  );
```

- [ ] **Step 4: Update `<TitleInput>` to use `pickedRoom?.name`**

Find the `<TitleInput .../>` line in the left pane and replace `roomName={null /* … */}` with:
```tsx
              roomName={pickedRoom?.name ?? null}
```

- [ ] **Step 5: Build**

```bash
pnpm --filter @prequest/web build
```
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx
git commit -m "feat(web): wire right-pane add-in stack + Suggested chips into modal"
```

---

# Phase 6 — Wiring + cleanup

Goal: Submit handler, popover→modal escalation, all entry points wired (scheduler tile-click pre-existing flow re-pointed; `/desk/bookings` "+ New"; portal "Book a room"), mobile responsive, delete the old `BookingComposer`, doc updates.

### Task 6.1: Submit handler — POST + visitors flush + toasts + traceId

**Files:**
- Modify: `apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx`

- [ ] **Step 1: Lift submit logic from the legacy composer**

Read `apps/web/src/components/booking-composer/booking-composer.tsx` `handleSubmit` (lines ~503–629) — note the contract: `useCreateBooking().mutateAsync(payload)` followed by visitors flush (`createInvitation.mutateAsync({...})`) and a success toast. We're going to recreate that logic here, simplified for single-room only.

- [ ] **Step 2: Add submit + footer to the modal**

Open `booking-composer-modal.tsx`. Add imports:
```tsx
import { useCreateBooking } from '@/api/room-booking';
import { useCreateInvitation } from '@/api/visitors';
import { buildBookingPayload } from '@/components/booking-composer/submit';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { toastError, toastSuccess } from '@/lib/toast';
import { validateDraft } from './booking-draft';
```

- [ ] **Step 3: Add submit handler inside the component**

Inside `BookingComposerModal`, just before the `return` block:
```tsx
  const createBooking = useCreateBooking();
  const createInvitation = useCreateInvitation();
  const validation = validateDraft(composer.draft, mode);
  const submitting = createBooking.isPending;

  const handleSubmit = async () => {
    if (validation) return;
    // The legacy submit.ts builder takes the old ComposerState shape.
    // BookingDraft is field-compatible for the subset it needs (spaceId,
    // start/end, attendees, requester, services, costCenter, recurrence,
    // template, notes). We map title→notes-prefix is NOT done; backend
    // accepts a separate title field. Keep title in the payload via the
    // existing payload builder — confirm by reading
    // apps/web/src/components/booking-composer/submit.ts.
    //
    // Since BookingDraft adds `title` + `description` not in the legacy
    // ComposerState, we extend the payload after the builder runs.
    const adapter = {
      spaceId: composer.draft.spaceId!,
      additionalSpaceIds: [],
      startAt: composer.draft.startAt!,
      endAt: composer.draft.endAt!,
      attendeeCount: composer.draft.attendeeCount,
      attendeePersonIds: composer.draft.attendeePersonIds,
      requesterPersonId: composer.draft.requesterPersonId,
      hostPersonId: composer.draft.hostPersonId,
      costCenterId: composer.draft.costCenterId,
      recurrence: composer.draft.recurrence,
      services: composer.draft.services,
      visitors: composer.draft.visitors,
      templateId: composer.draft.templateId,
      notes: composer.draft.description,
      errors: {},
    };
    const payload = buildBookingPayload({
      state: adapter,
      mode,
      entrySource: 'desk-list',
      callerPersonId,
    });
    if (!payload) return;
    // Append title — payload shape supports it; backend reservations
    // controller ignores unknown fields if not yet wired (gracefully
    // degrades to no title until a follow-up). Verified by reading
    // apps/api/src/modules/reservations/reservations.controller.ts.
    const titled = {
      ...payload,
      title: composer.draft.title || undefined,
    };

    try {
      const result = await createBooking.mutateAsync(titled);
      const reservationId = (result as { id?: string }).id;
      const bundleId = (result as { booking_bundle_id?: string }).booking_bundle_id ?? null;

      // Visitors flush — same pattern as legacy composer. Failures are
      // per-row toasts; the booking itself is already saved.
      if (composer.draft.visitors.length > 0 && reservationId) {
        for (const v of composer.draft.visitors) {
          try {
            await createInvitation.mutateAsync({
              first_name: v.first_name,
              last_name: v.last_name,
              email: v.email,
              phone: v.phone,
              company: v.company,
              visitor_type_id: v.visitor_type_id,
              expected_at: composer.draft.startAt!,
              expected_until: composer.draft.endAt ?? undefined,
              // building_id resolution lives on the legacy composer via
              // resolveBuildingId(). For Phase 6, lift it: the Space row
              // carries parent_id; walk up to the building. If we don't
              // have a building, surface a per-row error and continue.
              building_id: deriveBuildingId(spacesCache as Space[] | undefined, composer.draft.spaceId),
              meeting_room_id: composer.draft.spaceId ?? undefined,
              booking_bundle_id: bundleId ?? undefined,
              reservation_id: reservationId,
            });
          } catch (err) {
            toastError(`Couldn't invite ${v.first_name}`, { error: err });
          }
        }
      }

      toastSuccess('Booked');
      onOpenChange(false);
      if (reservationId) onBooked?.(reservationId);
    } catch (err) {
      toastError("Couldn't book the room", {
        error: err,
        retry: () => handleSubmit(),
      });
    }
  };
```

- [ ] **Step 4: Confirm `deriveBuildingId` is imported**

The shared helper from Phase 1.8 should already be imported by the modal (added in Phase 4.6 step 5). If not, add:
```tsx
import { deriveBuildingId } from './derive-building-id';
```

- [ ] **Step 5: Add the footer**

Inside the `<DialogContent>`, after the two-pane `<div>`, add:
```tsx
        <footer className="flex items-center justify-end gap-2 border-t border-border/60 bg-background/85 px-5 py-3 backdrop-blur-md">
          {validation && (
            <span className="mr-auto text-xs text-amber-700 dark:text-amber-300">
              {validation}
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSubmit()}
            disabled={Boolean(validation) || submitting}
            className="min-w-[6rem]"
          >
            {submitting ? (
              <>
                <Loader2 className="mr-1 size-3.5 animate-spin" />
                Booking…
              </>
            ) : (
              'Book'
            )}
          </Button>
        </footer>
```

- [ ] **Step 6: Build**

```bash
pnpm --filter @prequest/web build
```
Expected: success. If `buildBookingPayload`'s expected `state` shape requires fields the adapter omits, copy them across; the `state` type is `ComposerState` and our adapter has every field except `errors`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx
git commit -m "feat(web): submit + visitors flush + footer in BookingComposerModal"
```

---

### Task 6.2: Popover → Modal escalation (Advanced ↗)

**Files:**
- Modify: `apps/web/src/pages/desk/scheduler/index.tsx`

- [ ] **Step 1: Replace the temporary handoff**

Open `apps/web/src/pages/desk/scheduler/index.tsx`. The Phase 2 wiring routes Book + Advanced into the legacy `SchedulerCreatePopover` dialog. Now we route Advanced into `<BookingComposerModal>` (Book stays on the legacy path for one more task because the popover doesn't have a real submit yet — wired in Task 6.3).

Add state above the `quickBookPayload` state:
```tsx
  const [composerModalOpen, setComposerModalOpen] = useState(false);
  const [composerModalSeed, setComposerModalSeed] = useState<BookingDraft | null>(null);
```

Add import:
```tsx
import { BookingComposerModal } from '@/components/booking-composer-v2/booking-composer-modal';
import type { BookingDraft } from '@/components/booking-composer-v2/booking-draft';
```

- [ ] **Step 2: Re-route `onAdvanced`**

Replace the popover's `onAdvanced` handler with:
```tsx
          onAdvanced={(draft) => {
            setQuickBookOpen(false);
            setComposerModalSeed(draft);
            setComposerModalOpen(true);
          }}
```

- [ ] **Step 3: Render the modal**

Just below the existing `<SchedulerCreatePopover .../>` block, add:
```tsx
      <BookingComposerModal
        open={composerModalOpen}
        onOpenChange={(o) => {
          setComposerModalOpen(o);
          if (!o) setComposerModalSeed(null);
        }}
        mode="operator"
        entrySource="desk-scheduler"
        callerPersonId={requesterPersonId}
        hostFirstName={person?.first_name ?? null}
        initialDraft={composerModalSeed ?? undefined}
        onBooked={() => {
          setComposerModalOpen(false);
        }}
      />
```

- [ ] **Step 4: Build + manual smoke**

```bash
pnpm --filter @prequest/web build
```
Then `pnpm dev` → drag-create on the scheduler → click Advanced in the popover → confirm `<BookingComposerModal>` opens with the room + time pre-populated.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/desk/scheduler/index.tsx
git commit -m "feat(scheduler): Advanced ↗ in QuickBook escalates to BookingComposerModal"
```

---

### Task 6.3: Popover Book → POST (no modal handoff)

**Files:**
- Modify: `apps/web/src/components/booking-composer-v2/quick-book-popover.tsx`

The popover's `onBook` is currently routed by the scheduler back into the legacy dialog. Replace with a direct POST so the 30s path actually books in 30s.

- [ ] **Step 1: Move submit into the popover itself**

In `quick-book-popover.tsx`, change `onBook` semantics from "I have a draft, please handle" to "the booking succeeded — here's the reservation id". Replace the prop:
```tsx
  /** Called after a successful POST. The wrapper can navigate or
   *  refresh as needed. */
  onBooked?: (reservationId: string) => void;
  /** Operator-mode only: the requester id passed into the payload. */
  callerPersonId: string;
  mode: 'self' | 'operator';
```

Remove the old `onBook` prop.

Add the booking call inside the popover. Add imports:
```tsx
import { useCreateBooking } from '@/api/room-booking';
import { buildBookingPayload } from '@/components/booking-composer/submit';
import { toastError, toastSuccess } from '@/lib/toast';
```

Inside the component, replace the old `handleBook`:
```tsx
  const createBooking = useCreateBooking();

  const handleBook = async () => {
    const draft = buildDraft();
    if (!draft.spaceId || !draft.startAt || !draft.endAt) return;
    const adapter = {
      spaceId: draft.spaceId,
      additionalSpaceIds: [],
      startAt: draft.startAt,
      endAt: draft.endAt,
      attendeeCount: draft.attendeeCount,
      attendeePersonIds: draft.attendeePersonIds,
      requesterPersonId: draft.requesterPersonId ?? callerPersonId,
      hostPersonId: draft.hostPersonId ?? callerPersonId,
      costCenterId: draft.costCenterId,
      recurrence: draft.recurrence,
      services: draft.services,
      visitors: draft.visitors,
      templateId: draft.templateId,
      notes: draft.description,
      errors: {},
    };
    const payload = buildBookingPayload({
      state: adapter,
      mode,
      entrySource: 'desk-scheduler',
      callerPersonId,
    });
    if (!payload) return;
    const titled = { ...payload, title: draft.title || undefined };
    try {
      const result = await createBooking.mutateAsync(titled);
      toastSuccess('Booked');
      onOpenChange(false);
      const reservationId = (result as { id?: string }).id;
      if (reservationId) onBooked?.(reservationId);
    } catch (err) {
      toastError("Couldn't book the room", {
        error: err,
        retry: () => handleBook(),
      });
    }
  };
```

- [ ] **Step 2: Update the test**

Open `quick-book-popover.test.tsx`. Replace the `onBook={vi.fn()}` props with `mode="self"`, `callerPersonId="p1"`, `onBooked={vi.fn()}`. Re-run:
```bash
pnpm --filter @prequest/web test -- quick-book-popover.test
```
Expected: PASS.

- [ ] **Step 3: Update the scheduler caller**

In `apps/web/src/pages/desk/scheduler/index.tsx`, the popover usage now needs `mode`, `callerPersonId`, and `onBooked` instead of `onBook`. Replace the popover wiring:
```tsx
        <QuickBookPopover
          open={quickBookOpen}
          onOpenChange={(o) => {
            setQuickBookOpen(o);
            if (!o) setQuickBookPayload(null);
          }}
          anchorEl={quickBookPayload.anchorEl}
          room={{
            space_id: quickBookPayload.room.space_id,
            name: quickBookPayload.room.name,
            has_av_equipment: false,
            has_catering_vendor: false,
            needs_visitor_pre_registration: false,
          }}
          startAtIso={quickBookPayload.startAtIso}
          endAtIso={quickBookPayload.endAtIso}
          hostFirstName={person?.first_name ?? null}
          mode="operator"
          callerPersonId={requesterPersonId}
          onBooked={() => {
            // The scheduler refreshes its data via realtime; nothing
            // explicit needed.
          }}
          onAdvanced={(draft) => {
            setQuickBookOpen(false);
            setComposerModalSeed(draft);
            setComposerModalOpen(true);
          }}
        />
```

- [ ] **Step 4: Build**

```bash
pnpm --filter @prequest/web build
```
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/quick-book-popover.tsx apps/web/src/components/booking-composer-v2/quick-book-popover.test.tsx apps/web/src/pages/desk/scheduler/index.tsx
git commit -m "feat(web): QuickBookPopover books directly via POST /reservations"
```

---

### Task 6.4: `/desk/bookings` "+ New booking" → `<BookingComposerModal>`

**Files:**
- Modify: `apps/web/src/pages/desk/bookings.tsx`

- [ ] **Step 1: Replace the Sheet wrapper**

In `apps/web/src/pages/desk/bookings.tsx`, find `composerSheet` (around line 296). Replace with a `<BookingComposerModal>` invocation:
```tsx
  const composerModal = (
    <BookingComposerModal
      open={composerOpen}
      onOpenChange={setComposerOpen}
      mode="operator"
      entrySource="desk-list"
      callerPersonId={person?.id ?? ''}
      hostFirstName={person?.first_name ?? null}
      onBooked={() => setComposerOpen(false)}
    />
  );
```

Replace the `<>` final return's `{composerSheet}` with `{composerModal}`.

Replace the legacy import:
```tsx
import { BookingComposerModal } from '@/components/booking-composer-v2/booking-composer-modal';
```
Remove the `BookingComposer` import line and unused `Sheet` imports.

- [ ] **Step 2: Build**

```bash
pnpm --filter @prequest/web build
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/desk/bookings.tsx
git commit -m "feat(desk): /desk/bookings + New uses BookingComposerModal"
```

---

### Task 6.5: Portal "Book a room" → `<BookingComposerModal>`

**Files:**
- Modify: `apps/web/src/pages/portal/book-room/index.tsx`

- [ ] **Step 1: Replace the dialog body**

The current portal flow opens a Dialog containing `<BookingComposer>` when `pendingPrimary` is set. Replace it with `<BookingComposerModal>`:
```tsx
      {pendingPrimary && requesterPersonId && (
        <BookingComposerModal
          open={Boolean(pendingPrimary)}
          onOpenChange={(o) => {
            if (!o) {
              setPendingPrimary(null);
              setPendingExtras([]);
            }
          }}
          mode="self"
          entrySource="portal"
          callerPersonId={requesterPersonId}
          hostFirstName={person?.first_name ?? null}
          initialDraft={draftFromComposerSeed({
            spaceId: pendingPrimary.space_id,
            startAt: startAtIso,
            endAt: endAtIso,
            attendeeCount: state.attendeeCount,
            templateId: activeTemplate?.id ?? null,
            costCenterId: activeTemplate?.payload?.default_cost_center_id ?? null,
            services: activeTemplate?.payload?.services
              ? templateServicesToPickerSelections(
                  activeTemplate.payload.services,
                  state.attendeeCount,
                )
              : undefined,
            hostPersonId: requesterPersonId,
          })}
          onBooked={(reservationId) => {
            if (reservationId) {
              navigate(`/portal/me/bookings/${reservationId}`);
            } else {
              navigate('/portal/me/bookings');
            }
          }}
        />
      )}
```

Replace imports:
```tsx
import { BookingComposerModal } from '@/components/booking-composer-v2/booking-composer-modal';
import { draftFromComposerSeed } from '@/components/booking-composer-v2/booking-draft';
```
Remove the legacy `BookingComposer` import + the `Dialog/DialogContent/DialogHeader/DialogTitle/DialogDescription` block. Keep `templateServicesToPickerSelections` from the legacy `state.ts` for now.

- [ ] **Step 2: Build**

```bash
pnpm --filter @prequest/web build
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/portal/book-room/index.tsx
git commit -m "feat(portal): book-room confirm uses BookingComposerModal"
```

---

### Task 6.6: Mobile responsive — popover→bottom sheet + modal accordion

**Files:**
- Modify: `apps/web/src/components/booking-composer-v2/quick-book-popover.tsx`
- Modify: `apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx`

- [ ] **Step 1: Bottom sheet for popover on mobile**

In `quick-book-popover.tsx`, detect mobile and switch the surface. Add import:
```tsx
import { useIsMobile } from '@/hooks/use-mobile';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetHeader,
} from '@/components/ui/sheet';
```

Replace the `return (...)` block with:
```tsx
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="rounded-t-xl p-3"
          onKeyDown={onKeyDown}
        >
          <SheetHeader>
            <SheetTitle className="sr-only">Quick book</SheetTitle>
          </SheetHeader>
          {/* Reuse the same body markup as the desktop popover. The
              body lives in a small inner render fn so we don't
              duplicate it. */}
          {renderBody()}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorEl ? { current: anchorEl } : undefined} />
      <PopoverContent
        side="bottom"
        align="start"
        className="w-[360px] gap-3 p-3"
        onKeyDown={onKeyDown}
      >
        {renderBody()}
      </PopoverContent>
    </Popover>
  );
}
```

Extract the body. Above `return`, add:
```tsx
  const renderBody = () => (
    <>
      <FieldGroup>
        {/* ...existing FieldGroup contents... */}
      </FieldGroup>
      <div className="flex items-center justify-between gap-2 pt-1">
        {/* ...existing footer... */}
      </div>
    </>
  );
```

Move the existing `FieldGroup` + footer markup inside `renderBody()`. **On mobile, hide the Advanced ↗ link** per spec — wrap the Advanced button with `{!isMobile && <Button …/>}`.

- [ ] **Step 2: Modal accordion on mobile**

In `booking-composer-modal.tsx`, the existing `flex-col sm:flex-row` already stacks on mobile. We need to ensure the right pane reads as an accordion of cards rather than competing for height. The `<AddinStack>` already renders cards stacked vertically — confirm by manual test on a 375px viewport.

Add to the `DialogContent` className: `sm:rounded-xl rounded-none` so on mobile it goes full-bleed. Replace the `max-h` line with:
```tsx
          'h-auto max-h-[min(85vh,680px)] sm:rounded-xl rounded-none sm:max-h-[min(85vh,680px)] max-h-screen',
```

- [ ] **Step 3: Build + manual mobile check**

```bash
pnpm --filter @prequest/web build
```
Then `pnpm dev`, open Chrome devtools, toggle device emulation to iPhone 14, drag-create on the scheduler. Confirm popover renders as bottom sheet + modal stacks panes vertically.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/booking-composer-v2/quick-book-popover.tsx apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx
git commit -m "feat(web): mobile responsive — popover→sheet, modal full-screen accordion"
```

---

### Task 6.7: Delete legacy `BookingComposer`

**Files:**
- Delete: `apps/web/src/components/booking-composer/booking-composer.tsx`
- Modify: `apps/web/src/components/booking-composer/state.ts` (move shared types into the v2 folder)
- Possibly modify: any remaining importers found by grep

- [ ] **Step 1: Find remaining importers**

```bash
grep -rn "@/components/booking-composer/booking-composer\|from '@/components/booking-composer'" /Users/x/Desktop/XPQT/apps/web/src/ 2>/dev/null
```
Expected: zero matches (Phases 6.4 + 6.5 removed the last consumers). If any remain, repoint them to `@/components/booking-composer-v2/booking-composer-modal`.

- [ ] **Step 2: Confirm `state.ts` is still used**

```bash
grep -rn "from '@/components/booking-composer/state'\|from '../booking-composer/state'" /Users/x/Desktop/XPQT/apps/web/src/ 2>/dev/null
```
Expected: matches in `booking-composer-v2/` (we use `PendingVisitor`, `ComposerMode`, etc.) and `submit.ts` itself. Keep `state.ts` since the v2 folder still imports `PendingVisitor`, `ComposerMode`, `ComposerEntrySource`. We're NOT migrating those types yet — that's a separate refactor.

- [ ] **Step 3: Delete the old composer file**

```bash
rm /Users/x/Desktop/XPQT/apps/web/src/components/booking-composer/booking-composer.tsx
```

Also delete the obsolete sections that v2 doesn't use:
```bash
# additional-rooms-field is multi-room, not in scope for the redesign.
# Keep it on disk in case the multi-room flow is reintroduced later.
```
(Don't delete `additional-rooms-field.tsx`, `recurrence-field.tsx`, `room-picker-inline.tsx`, `visitors-section.tsx`, `service-picker-sheet.tsx`, `helpers.ts`, `state.ts`, `submit.ts` — `v2` reuses them.)

- [ ] **Step 4: Build**

```bash
pnpm --filter @prequest/web build
```
Expected: success. If TypeScript reports unresolved imports, those are stale references — fix them by repointing to v2.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src/components/booking-composer/
git commit -m "chore(web): delete legacy booking-composer.tsx (v2 fully replaces it)"
```

---

### Task 6.8: Delete legacy `<SchedulerCreatePopover>` dialog

**Files:**
- Delete: `apps/web/src/pages/desk/scheduler/components/scheduler-create-popover.tsx`
- Modify: `apps/web/src/pages/desk/scheduler/index.tsx`

- [ ] **Step 1: Remove the legacy dialog from the scheduler**

In `apps/web/src/pages/desk/scheduler/index.tsx`, delete the import + JSX usage of `SchedulerCreatePopover`. Also remove the `createDialogOpen` / `createPayload` state; they were only used by that dialog.

- [ ] **Step 2: Delete the file**

```bash
rm /Users/x/Desktop/XPQT/apps/web/src/pages/desk/scheduler/components/scheduler-create-popover.tsx
```

- [ ] **Step 3: Build**

```bash
pnpm --filter @prequest/web build
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/desk/scheduler/index.tsx apps/web/src/pages/desk/scheduler/components/scheduler-create-popover.tsx
git commit -m "chore(scheduler): remove legacy SchedulerCreatePopover dialog"
```

---

### Task 6.9: Run the full test suite + smoke gate

**Files:**
- None (verification only)

- [ ] **Step 1: Run web tests**

```bash
pnpm --filter @prequest/web test
```
Expected: all pass (vitest sanity + booking-draft + contextual-suggestions + use-booking-draft + quick-book-popover + booking-composer-modal + addin-card + visitors-row).

- [ ] **Step 2: Run API tests**

```bash
pnpm --filter @prequest/api test
```
Expected: meal-windows.service.spec passes alongside the rest of the suite.

- [ ] **Step 3: Run lint**

```bash
pnpm --filter @prequest/web lint
```
Expected: clean (or only pre-existing warnings unrelated to this work).

- [ ] **Step 4: Run smoke gate**

In one terminal: `pnpm dev:api`. In another:
```bash
pnpm smoke:work-orders
```
Expected: exit 0. The redesign doesn't touch work orders, so this is a "did we break something else" gate.

- [ ] **Step 5: Manual smoke (10 minutes)**

`pnpm dev` and walk through:
1. `/desk/scheduler` → drag-create → popover appears with title input + duration chips → click Book → reservation persists, scheduler updates via realtime.
2. Same drag → click Advanced → modal opens with room + time pre-populated → fill title → click Book → success.
3. `/desk/bookings` → "+ New booking" → modal opens (operator mode) → pick room (right pane), pick time, add a visitor inline → click Book → reservation lands.
4. `/portal/book-room` → search rooms → click Book on a result → modal opens (self mode) → confirm.
5. Mobile (Chrome devtools, iPhone 14): scheduler tile → bottom sheet popover → Book works. /desk/bookings + New → modal stacks panes vertically → readable.

If any of these break, fix in a follow-up commit before declaring done.

- [ ] **Step 6: Commit (only if anything was patched in step 5)**

```bash
git add <whatever>
git commit -m "fix(booking-composer): <specific fix from manual smoke>"
```

---

### Task 6.10: Update docs + parked spec note

**Files:**
- Create: `apps/web/src/components/booking-composer-v2/README.md`
- Modify: `docs/superpowers/specs/2026-05-02-create-booking-modal-redesign.md` (add an "Implementation status" section)
- Modify: `docs/superpowers/specs/2026-05-02-visitors-on-booking-detail-design.md` (one-line note)

- [ ] **Step 1: Create the v2 README**

Create `apps/web/src/components/booking-composer-v2/README.md`:
```markdown
# booking-composer-v2

Redesigned create-booking surface. Replaces the single-pane
`booking-composer/booking-composer.tsx` with a two-tier flow:

- `<QuickBookPopover>` — anchored popover for scheduler tile-clicks
  (~360×220, title + duration chips + Advanced ↗).
- `<BookingComposerModal>` — full two-pane modal (880×680). Left
  pane = title/time/repeat/description/host/visitors. Right pane =
  room + catering + AV add-in cards with `Suggested` chips.

Spec: `docs/superpowers/specs/2026-05-02-create-booking-modal-redesign.md`.

## Files

- `booking-draft.ts` — single root state shape + validation + default
  title helper. Replaces the legacy `ComposerState`.
- `use-booking-draft.ts` — state container (stable setters).
- `contextual-suggestions.ts` — pure `getSuggestions(draft, room,
  mealWindows)`. Wires the `Suggested` chip on the right-pane cards.
- `quick-book-popover.tsx` — the 30s create surface.
- `booking-composer-modal.tsx` — the full two-pane modal.
- `left-pane/` — title-input, time-row, repeat-row, description-row,
  host-row, visitors-row.
- `right-pane/` — addin-stack, addin-card, room-card, catering-card,
  av-card.

## Reuses from the old composer (still alive)

- `service-picker-sheet.tsx` — `ServicePickerBody` is the catalog
  browser used inside the catering + AV cards.
- `sections/recurrence-field.tsx` — used inside `RepeatRow`.
- `sections/room-picker-inline.tsx` — used inside `RoomCard`.
- `state.ts` — `PendingVisitor`, `ComposerMode`, `ComposerEntrySource`
  type aliases. (Migrating these into v2 is a separate refactor.)
- `submit.ts` — `buildBookingPayload` is shared between the popover
  and the modal.
- `helpers.ts` — date/time math.

## Tests

`pnpm --filter @prequest/web test` runs the vitest suite. Pure
functions (`booking-draft`, `contextual-suggestions`,
`use-booking-draft`) have unit tests; components (`quick-book-popover`,
`addin-card`, `visitors-row`, `booking-composer-modal` shell) have
RTL tests.
```

- [ ] **Step 2: Append "Implementation status" to the spec**

Append to `docs/superpowers/specs/2026-05-02-create-booking-modal-redesign.md`:
```markdown

## Implementation status (2026-05-02)

Shipped (this PR / branch):
- Phase 1: `tenant_meal_windows` migration + API loader + `useMealWindows` hook + `BookingDraft` + `getSuggestions` + `useBookingDraft`.
- Phase 2: `<QuickBookPopover>` wired to scheduler tile-click.
- Phase 3: `<BookingComposerModal>` shell (two-pane, spring-open, slow-fade backdrop).
- Phase 4: Left pane — title, time (calendar + 15-min slots), repeat (popover), description, host, visitors v1 inline.
- Phase 5: Right pane — addin-stack + addin-card + room/catering/AV cards + `Suggested` chip via `getSuggestions`.
- Phase 6: Submit + escalation + all entry points migrated; legacy `BookingComposer` + `SchedulerCreatePopover` deleted.

Deferred:
- Visitors v2 smart entity recognition (the `<VisitorOrAttendeePicker>` swap).
- Backend-driven `has_av_equipment` / `has_catering_vendor` / `needs_visitor_pre_registration` signals on the Space row — Phase 5 ships with these gated to `false`. Lighting them up is additive: when the API contract widens, the suggestion engine starts firing without a redesign.
- Title persistence on `reservations` — the modal sends `title` in the payload; the backend ignores unknown fields today. A follow-up adds `reservations.title` + persists.
- Conflict-strike on the time-slot popover — wired in a follow-up once the lightweight conflict-check API is exposed.
- Admin UI for editing tenant meal windows. v1 ships with the seed defaults (Lunch 11:30–13:30, Dinner 17:00–19:00).
- Multi-room atomic bookings — not in scope for this redesign. Reintroduce by adding back the `additional-rooms-field` plumbing if needed.
```

- [ ] **Step 3: Add note to the parked visitors-on-booking-detail spec**

Append to `docs/superpowers/specs/2026-05-02-visitors-on-booking-detail-design.md` (if the file exists; verify with `ls` first):
```markdown

## Note (2026-05-02)

The `<AddVisitorToBookingDialog>` surface defined in this spec inherits
the polish from the create-booking modal redesign that landed today
(`docs/superpowers/specs/2026-05-02-create-booking-modal-redesign.md`).
Specifically: shadcn Field primitives mandatory, `var(--ease-snap)` /
`var(--ease-smooth)` motion tokens, hairlines over shadows, 4px
vertical grid. When this spec is implemented, follow the same shape
as `apps/web/src/components/booking-composer-v2/left-pane/visitors-row.tsx`.
```

If the spec file doesn't exist, skip this sub-step.

- [ ] **Step 4: Commit docs**

```bash
git add apps/web/src/components/booking-composer-v2/README.md docs/superpowers/specs/2026-05-02-create-booking-modal-redesign.md
git commit -m "docs(booking-composer): README + spec implementation status"
```

If the visitors-on-detail spec was modified:
```bash
git add docs/superpowers/specs/2026-05-02-visitors-on-booking-detail-design.md
git commit -m "docs(visitors): note that AddVisitorToBookingDialog inherits composer polish"
```

---

## Spec self-review

After completing all 6 phases, read the spec end-to-end one more time and confirm:

1. **Quick popover is shipped** (Phase 2 + 6.3).
2. **Two-pane modal at 880×680, max-h-85vh, single bg, right pane inset** (Phases 3 + 5).
3. **Spring-open modal + slow-fade backdrop** (Phase 3.2).
4. **Left pane order:** title → time → repeat → description → host → visitors (Phase 4 tasks 4.1–4.6 in order).
5. **Right pane:** room + catering + AV cards, inline-expand via `grid-template-rows: 0fr → 1fr`, single-expand-at-a-time (Phase 5).
6. **Suggested chip wired via `getSuggestions`** for catering (meal-window + vendor signal) and AV (equipment + duration > 30min) (Phase 5.6 + Phase 1.6).
7. **Field primitives everywhere** — every form block uses `FieldGroup`/`Field`/`FieldLabel` (Phase 4 tasks).
8. **Toast helpers** from `@/lib/toast` — Phase 6.1 + 6.3 use `toastSuccess`/`toastError`, never raw sonner.
9. **Polish micros:** easing tokens (`var(--ease-snap/smooth/spring)`), tabular-nums on time controls, hairlines over shadows, 4px grid (touched throughout).
10. **Mobile:** popover → bottom sheet, modal full-screen with stacked panes (Phase 6.6).
11. **All entry points migrated:** scheduler (Phase 2 + 6.2 + 6.3), `/desk/bookings` (6.4), portal (6.5).
12. **Legacy code deleted:** `booking-composer.tsx` (6.7) + `scheduler-create-popover.tsx` (6.8).
13. **Smoke gate green:** `pnpm smoke:work-orders` (6.9).

If any item is incomplete, add a remediation task and execute it. The plan is not done until the spec self-review passes.
