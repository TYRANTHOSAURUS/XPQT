# People & Users surface — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `/admin/persons` and `/admin/users` to parity with the rest of the admin app: split-view persons, full-shape person detail (avatar / default location / org / manager / linked user / activity / DSR), editable user detail with sign-in history + password reset + suspend + DSR, backed by a webhook-fed `auth_sign_in_events` table.

**Architecture:** Supabase delivery (Database Webhook on `auth.audit_log_entries` or Custom Auth Hook — verify against current Supabase docs in Task 4) → POST `/api/webhooks/auth/sign-in` → idempotent insert into `auth_sign_in_events` (idempotency key `(session_id, event_kind)`). Person/user detail pages read from new endpoints; persons page adopts `TableInspectorLayout`; the legacy persons edit dialog is removed in favor of the auto-save detail page.

**Tech Stack:** NestJS 10 (Jest 29 for tests), Supabase (Postgres + Auth + Storage), React 19 + TanStack Query 5 + shadcn/ui (no frontend test runner — frontend changes verified by smoke test in dev).

**Spec:** `docs/superpowers/specs/2026-04-28-people-and-users-surface-design.md`

**Frontend testing note:** The web app has no test runner configured (verified — `apps/web/package.json` has no `test` script and no Vitest/Jest dep). Frontend tasks are smoke-tested via `pnpm dev:web` against the local API. Adding a test runner is out of scope for this slice and tracked separately.

---

## Phase 1 — Backend foundation (login history)

### Task 1: Migration `00168_auth_sign_in_events.sql`

Create the table, indexes, RLS policy, and register the retention category.

**Files:**
- Create: `supabase/migrations/00168_auth_sign_in_events.sql`

- [ ] **Step 1: Verify next migration number**

```bash
ls supabase/migrations/ | tail -3
```

Expected: highest is `00167_gdpr_rls_hardening.sql`. New file is `00168_auth_sign_in_events.sql`.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/00168_auth_sign_in_events.sql`:

```sql
-- 00168 — auth_sign_in_events
-- Per-sign-in audit trail fed by Supabase Auth Hook webhook.
-- See docs/superpowers/specs/2026-04-28-people-and-users-surface-design.md.

create table public.auth_sign_in_events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  event_kind      text not null check (event_kind in ('sign_in', 'sign_out', 'sign_in_failed')),
  signed_in_at    timestamptz not null default now(),
  session_id      text,
  ip_address      inet,
  user_agent      text,
  country         text,
  city            text,
  method          text,
  provider        text,
  mfa_used        boolean not null default false,
  success         boolean not null default true,
  failure_reason  text,
  created_at      timestamptz not null default now()
);

create unique index auth_sign_in_events_session_event_uniq
  on public.auth_sign_in_events (session_id, event_kind)
  where session_id is not null;

create index auth_sign_in_events_user_signed_in_at
  on public.auth_sign_in_events (tenant_id, user_id, signed_in_at desc);

create index auth_sign_in_events_tenant_signed_in_at
  on public.auth_sign_in_events (tenant_id, signed_in_at desc);

alter table public.auth_sign_in_events enable row level security;

create policy "tenant_isolation" on public.auth_sign_in_events
  for all
  using (tenant_id = public.current_tenant_id());

-- Register the retention category. Picks up tenant default of 24 months.
-- The retention worker (privacy-compliance) purges rows past the policy.
insert into public.tenant_retention_settings (tenant_id, data_category, retention_days, cap_retention_days, legal_basis)
select id, 'auth_sign_in_events', 730, 1095, 'legitimate_interest'
  from public.tenants
on conflict (tenant_id, data_category) do nothing;

-- Add to the seed function so new tenants get the same default.
-- (Pattern lifted from 00162.) The function is replaced wholesale by other
-- migrations; this is an additive `insert ... on conflict do nothing` we
-- append after the existing inserts.
create or replace function public.seed_tenant_retention_defaults(p_tenant_id uuid)
returns void
language plpgsql
as $$
begin
  insert into public.tenant_retention_settings
    (tenant_id, data_category, retention_days, cap_retention_days, legal_basis)
  values
    (p_tenant_id, 'tickets',                    1095, 2555, 'legitimate_interest'),
    (p_tenant_id, 'reservations',               1095, 2555, 'legitimate_interest'),
    (p_tenant_id, 'persons',                    2555, 3650, 'legitimate_interest'),
    (p_tenant_id, 'visitor_records',             365,  730, 'legitimate_interest'),
    (p_tenant_id, 'audit_events',               2555, 3650, 'legal_obligation'),
    (p_tenant_id, 'personal_data_access_log',    365,  730, 'legitimate_interest'),
    (p_tenant_id, 'notifications',               180,  365, 'legitimate_interest'),
    (p_tenant_id, 'comments',                   1095, 2555, 'legitimate_interest'),
    (p_tenant_id, 'attachments',                1095, 2555, 'legitimate_interest'),
    (p_tenant_id, 'service_orders',             1095, 2555, 'legitimate_interest'),
    (p_tenant_id, 'check_ins',                  1095, 2555, 'legitimate_interest'),
    (p_tenant_id, 'login_sessions',              180,  365, 'legitimate_interest'),
    (p_tenant_id, 'integrations_ms_graph',      1095, 2555, 'legitimate_interest'),
    (p_tenant_id, 'gdpr_dsr_requests',          2555, 3650, 'legal_obligation'),
    (p_tenant_id, 'gdpr_legal_holds',           2555, 3650, 'legal_obligation'),
    (p_tenant_id, 'feature_flags_evaluations',   90,  180, 'legitimate_interest'),
    (p_tenant_id, 'auth_sign_in_events',         730, 1095, 'legitimate_interest')
  on conflict (tenant_id, data_category) do nothing;
end;
$$;
```

> **Verify before writing:** open `supabase/migrations/00162_gdpr_retention_settings.sql` and `supabase/migrations/00165_gdpr_tenant_seed_trigger.sql` to confirm the exact list of categories in the existing `seed_tenant_retention_defaults`. The list above must match what's currently there plus the new `auth_sign_in_events` row. If the list has drifted, copy the current function body and append only the new row.

- [ ] **Step 3: Apply migration locally**

```bash
pnpm db:reset
```

Expected: migration runs cleanly to the end. If `seed_tenant_retention_defaults` already exists with a different signature, fix the function body to match what's currently in the latest migration that defines it, then re-run.

- [ ] **Step 4: Verify table + retention row exist locally**

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "\d public.auth_sign_in_events"
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "select data_category, retention_days from public.tenant_retention_settings where data_category = 'auth_sign_in_events' limit 5;"
```

Expected: schema description prints columns + indexes; second query returns one row per tenant with `730` days.

- [ ] **Step 5: Push to remote (ASK USER FIRST)**

> **STOP.** Confirm with the user before running this. The project has standing permission per memory `feedback_db_push_authorized` for portal-scope work, but new workstreams should re-confirm.

```bash
pnpm db:push
```

If `db:push` fails (memory `supabase_remote_push`), fall back to:

```bash
PGPASSWORD='<db_password>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f supabase/migrations/00168_auth_sign_in_events.sql
PGPASSWORD='<db_password>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -c "NOTIFY pgrst, 'reload schema';"
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/00168_auth_sign_in_events.sql
git commit -m "feat(auth): add auth_sign_in_events table + retention category"
```

---

### Task 2: AuthEventsService

Insert sign-in/sign-out/sign-in-failed events from webhook payloads. Idempotent. Resolves tenant from `users` table.

**Files:**
- Create: `apps/api/src/modules/auth/auth-events.service.ts`
- Create: `apps/api/src/modules/auth/auth-events.service.spec.ts`

- [ ] **Step 1: Write the failing test for recordSignIn**

Create `apps/api/src/modules/auth/auth-events.service.spec.ts`:

```ts
import { AuthEventsService, type SupabaseAuthEvent } from './auth-events.service';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER   = '22222222-2222-2222-2222-222222222222';

interface InsertCall { table: string; row: Record<string, unknown>; }
interface UpdateCall { table: string; values: Record<string, unknown>; eq: Record<string, unknown>; }

function makeSupabase(opts: { userRow?: { tenant_id: string } | null; insertConflict?: boolean } = {}) {
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];

  const adminFrom = (table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: opts.userRow ?? { tenant_id: TENANT },
          error: null,
        }),
      }),
    }),
    insert: (row: Record<string, unknown>) => ({
      select: () => ({
        maybeSingle: async () => {
          if (opts.insertConflict) {
            return { data: null, error: { code: '23505' } };
          }
          inserts.push({ table, row });
          return { data: { id: 'evt-1' }, error: null };
        },
      }),
    }),
    update: (values: Record<string, unknown>) => ({
      eq: (col: string, val: unknown) => ({
        select: () => ({
          maybeSingle: async () => {
            updates.push({ table, values, eq: { [col]: val } });
            return { data: null, error: null };
          },
        }),
      }),
    }),
  });

  return {
    admin: { from: adminFrom },
    inserts,
    updates,
  };
}

describe('AuthEventsService', () => {
  it('inserts a sign_in row and updates last_login_at', async () => {
    const supabase = makeSupabase();
    const svc = new AuthEventsService(supabase as never);

    const event: SupabaseAuthEvent = {
      type: 'sign_in',
      user_id: USER,
      session_id: 'sess-abc',
      ip_address: '1.2.3.4',
      user_agent: 'Mozilla/5.0',
      method: 'password',
      provider: null,
      mfa_used: false,
      occurred_at: '2026-04-28T10:00:00Z',
    };

    await svc.recordSignIn(event);

    const insert = supabase.inserts.find((i) => i.table === 'auth_sign_in_events');
    expect(insert).toBeTruthy();
    expect(insert!.row).toMatchObject({
      tenant_id: TENANT,
      user_id: USER,
      event_kind: 'sign_in',
      session_id: 'sess-abc',
      ip_address: '1.2.3.4',
      user_agent: 'Mozilla/5.0',
      method: 'password',
      mfa_used: false,
      success: true,
    });

    const update = supabase.updates.find((u) => u.table === 'users');
    expect(update).toBeTruthy();
    expect(update!.values).toHaveProperty('last_login_at');
    expect(update!.eq).toEqual({ id: USER });
  });

  it('treats unique-constraint conflict as a no-op (idempotent)', async () => {
    const supabase = makeSupabase({ insertConflict: true });
    const svc = new AuthEventsService(supabase as never);

    await expect(
      svc.recordSignIn({
        type: 'sign_in',
        user_id: USER,
        session_id: 'sess-abc',
        ip_address: null,
        user_agent: null,
        method: 'password',
        provider: null,
        mfa_used: false,
        occurred_at: '2026-04-28T10:00:00Z',
      }),
    ).resolves.not.toThrow();
  });

  it('throws when user is unknown in public.users', async () => {
    const supabase = makeSupabase({ userRow: null });
    const svc = new AuthEventsService(supabase as never);

    await expect(
      svc.recordSignIn({
        type: 'sign_in',
        user_id: USER,
        session_id: 'sess-abc',
        ip_address: null,
        user_agent: null,
        method: 'password',
        provider: null,
        mfa_used: false,
        occurred_at: '2026-04-28T10:00:00Z',
      }),
    ).rejects.toThrow(/unknown user/i);
  });

  it('recordSignOut inserts but does NOT touch last_login_at', async () => {
    const supabase = makeSupabase();
    const svc = new AuthEventsService(supabase as never);

    await svc.recordSignOut({
      type: 'sign_out',
      user_id: USER,
      session_id: 'sess-abc',
      ip_address: null,
      user_agent: null,
      method: null,
      provider: null,
      mfa_used: false,
      occurred_at: '2026-04-28T11:00:00Z',
    });

    expect(supabase.inserts.some((i) => i.row.event_kind === 'sign_out')).toBe(true);
    expect(supabase.updates.some((u) => u.table === 'users')).toBe(false);
  });

  it('recordSignInFailed writes success=false and bypasses session_id dedupe', async () => {
    const supabase = makeSupabase();
    const svc = new AuthEventsService(supabase as never);

    await svc.recordSignInFailed({
      type: 'sign_in_failed',
      user_id: USER,
      session_id: null,
      ip_address: '5.6.7.8',
      user_agent: null,
      method: 'password',
      provider: null,
      mfa_used: false,
      occurred_at: '2026-04-28T12:00:00Z',
      failure_reason: 'invalid_password',
    });

    const row = supabase.inserts[0]!.row;
    expect(row).toMatchObject({
      event_kind: 'sign_in_failed',
      success: false,
      failure_reason: 'invalid_password',
      session_id: null,
    });
  });
});
```

- [ ] **Step 2: Run test, expect compile failure**

```bash
pnpm --filter @prequest/api test -- auth-events.service.spec
```

Expected: FAIL — `Cannot find module './auth-events.service'`.

- [ ] **Step 3: Write the minimal implementation**

Create `apps/api/src/modules/auth/auth-events.service.ts`:

```ts
import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

export type SupabaseAuthEventType = 'sign_in' | 'sign_out' | 'sign_in_failed';

export interface SupabaseAuthEvent {
  type: SupabaseAuthEventType;
  user_id: string;
  session_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  method: string | null;
  provider: string | null;
  mfa_used: boolean;
  occurred_at: string;
  failure_reason?: string;
}

@Injectable()
export class AuthEventsService {
  private readonly log = new Logger(AuthEventsService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async recordSignIn(event: SupabaseAuthEvent): Promise<void> {
    await this.insertEvent(event, 'sign_in', { success: true });
    await this.touchLastLogin(event.user_id, event.occurred_at);
  }

  async recordSignOut(event: SupabaseAuthEvent): Promise<void> {
    await this.insertEvent(event, 'sign_out', { success: true });
  }

  async recordSignInFailed(event: SupabaseAuthEvent): Promise<void> {
    await this.insertEvent(event, 'sign_in_failed', {
      success: false,
      failure_reason: event.failure_reason ?? null,
    });
  }

  private async insertEvent(
    event: SupabaseAuthEvent,
    kind: SupabaseAuthEventType,
    extra: { success: boolean; failure_reason?: string | null },
  ): Promise<void> {
    const tenantId = await this.resolveTenantId(event.user_id);

    const row = {
      tenant_id: tenantId,
      user_id: event.user_id,
      event_kind: kind,
      signed_in_at: event.occurred_at,
      session_id: event.session_id,
      ip_address: event.ip_address,
      user_agent: event.user_agent,
      method: event.method,
      provider: event.provider,
      mfa_used: event.mfa_used,
      success: extra.success,
      failure_reason: extra.failure_reason ?? null,
    };

    const { error } = await this.supabase.admin
      .from('auth_sign_in_events')
      .insert(row)
      .select()
      .maybeSingle();

    if (!error) return;

    if ((error as { code?: string }).code === '23505') {
      this.log.debug(`Duplicate ${kind} for session ${event.session_id} — ignored`);
      return;
    }
    throw error;
  }

  private async touchLastLogin(userId: string, occurredAt: string): Promise<void> {
    await this.supabase.admin
      .from('users')
      .update({ last_login_at: occurredAt })
      .eq('id', userId)
      .select()
      .maybeSingle();
  }

  private async resolveTenantId(userId: string): Promise<string> {
    const { data, error } = await this.supabase.admin
      .from('users')
      .select('tenant_id')
      .eq('id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new BadRequestException(`unknown user: ${userId}`);
    return (data as { tenant_id: string }).tenant_id;
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
pnpm --filter @prequest/api test -- auth-events.service.spec
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/auth/auth-events.service.ts apps/api/src/modules/auth/auth-events.service.spec.ts
git commit -m "feat(auth): add AuthEventsService for sign-in webhook events"
```

---

### Task 3: AuthController for the webhook

HMAC-verified, public, idempotent.

**Files:**
- Create: `apps/api/src/modules/auth/auth-events.controller.ts`
- Create: `apps/api/src/modules/auth/auth-events.controller.spec.ts`
- Modify: `apps/api/src/modules/auth/auth.module.ts`
- Modify: `apps/api/src/app.module.ts` (add `webhooks/auth` to TenantMiddleware exclude list)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/auth/auth-events.controller.spec.ts`:

```ts
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { AuthEventsController } from './auth-events.controller';
import type { AuthEventsService } from './auth-events.service';

const SECRET = 'test-hook-secret';

function makeService() {
  return {
    recordSignIn: jest.fn().mockResolvedValue(undefined),
    recordSignOut: jest.fn().mockResolvedValue(undefined),
    recordSignInFailed: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuthEventsService & {
    recordSignIn: jest.Mock;
    recordSignOut: jest.Mock;
    recordSignInFailed: jest.Mock;
  };
}

function makeConfig() {
  return {
    get: jest.fn((key: string) =>
      key === 'SUPABASE_AUTH_HOOK_SECRET' ? SECRET : undefined,
    ),
  } as never;
}

describe('AuthEventsController', () => {
  it('routes sign_in payload to recordSignIn', async () => {
    const service = makeService();
    const controller = new AuthEventsController(service, makeConfig());

    const body = {
      type: 'sign_in',
      user_id: 'u-1',
      session_id: 's-1',
      ip_address: '1.2.3.4',
      user_agent: 'UA',
      method: 'password',
      provider: null,
      mfa_used: false,
      occurred_at: '2026-04-28T00:00:00Z',
    };

    await controller.signInWebhook(`Bearer ${SECRET}`, body);

    expect(service.recordSignIn).toHaveBeenCalledWith(expect.objectContaining({ type: 'sign_in', user_id: 'u-1' }));
  });

  it('routes sign_out payload to recordSignOut', async () => {
    const service = makeService();
    const controller = new AuthEventsController(service, makeConfig());

    await controller.signInWebhook(`Bearer ${SECRET}`, {
      type: 'sign_out',
      user_id: 'u-1',
      session_id: 's-1',
      ip_address: null,
      user_agent: null,
      method: null,
      provider: null,
      mfa_used: false,
      occurred_at: '2026-04-28T00:00:00Z',
    });

    expect(service.recordSignOut).toHaveBeenCalled();
  });

  it('routes sign_in_failed payload to recordSignInFailed', async () => {
    const service = makeService();
    const controller = new AuthEventsController(service, makeConfig());

    await controller.signInWebhook(`Bearer ${SECRET}`, {
      type: 'sign_in_failed',
      user_id: 'u-1',
      session_id: null,
      ip_address: null,
      user_agent: null,
      method: 'password',
      provider: null,
      mfa_used: false,
      occurred_at: '2026-04-28T00:00:00Z',
      failure_reason: 'invalid_password',
    });

    expect(service.recordSignInFailed).toHaveBeenCalled();
  });

  it('returns 401 when authorization header is missing', async () => {
    const service = makeService();
    const controller = new AuthEventsController(service, makeConfig());

    await expect(controller.signInWebhook('', {})).rejects.toThrow(UnauthorizedException);
  });

  it('returns 401 when secret does not match', async () => {
    const service = makeService();
    const controller = new AuthEventsController(service, makeConfig());

    await expect(controller.signInWebhook('Bearer wrong', {})).rejects.toThrow(UnauthorizedException);
  });

  it('returns 400 when payload type is unknown', async () => {
    const service = makeService();
    const controller = new AuthEventsController(service, makeConfig());

    await expect(
      controller.signInWebhook(`Bearer ${SECRET}`, { type: 'totally_made_up', user_id: 'u-1' }),
    ).rejects.toThrow(BadRequestException);
  });
});
```

- [ ] **Step 2: Run test, expect compile failure**

```bash
pnpm --filter @prequest/api test -- auth-events.controller.spec
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the controller**

> **Note on payload shape.** The code below assumes the literal `{ type, user_id, session_id, ... }` shape. If your Supabase delivery is via Database Webhook on `auth.audit_log_entries` (see Task 4), `parsePayload` becomes a translator from the DB-webhook envelope (`{ type: 'INSERT', record: { payload: {...} } }`) to the same `SupabaseAuthEvent` shape — `AuthEventsService` stays identical. Adapt accordingly when wiring the actual hook.

Create `apps/api/src/modules/auth/auth-events.controller.ts`:

```ts
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from './public.decorator';
import { AuthEventsService, type SupabaseAuthEvent, type SupabaseAuthEventType } from './auth-events.service';

@Controller('webhooks/auth')
@Public()
export class AuthEventsController {
  constructor(
    private readonly events: AuthEventsService,
    private readonly config: ConfigService,
  ) {}

  @Post('sign-in')
  @HttpCode(204)
  async signInWebhook(
    @Headers('authorization') authorization: string,
    @Body() body: unknown,
  ): Promise<void> {
    this.verifySecret(authorization);
    const event = this.parsePayload(body);
    switch (event.type) {
      case 'sign_in':         await this.events.recordSignIn(event); return;
      case 'sign_out':        await this.events.recordSignOut(event); return;
      case 'sign_in_failed':  await this.events.recordSignInFailed(event); return;
    }
  }

  private verifySecret(authorization: string): void {
    const expected = this.config.get<string>('SUPABASE_AUTH_HOOK_SECRET');
    if (!expected) {
      throw new UnauthorizedException('webhook secret not configured');
    }
    const provided = (authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!provided || provided !== expected) {
      throw new UnauthorizedException();
    }
  }

  private parsePayload(body: unknown): SupabaseAuthEvent {
    if (!body || typeof body !== 'object') throw new BadRequestException('payload required');
    const b = body as Record<string, unknown>;
    const type = b.type as SupabaseAuthEventType;
    if (!['sign_in', 'sign_out', 'sign_in_failed'].includes(type)) {
      throw new BadRequestException(`unknown event type: ${String(b.type)}`);
    }
    if (typeof b.user_id !== 'string') throw new BadRequestException('user_id required');

    return {
      type,
      user_id: b.user_id,
      session_id: (b.session_id as string | null) ?? null,
      ip_address: (b.ip_address as string | null) ?? null,
      user_agent: (b.user_agent as string | null) ?? null,
      method: (b.method as string | null) ?? null,
      provider: (b.provider as string | null) ?? null,
      mfa_used: Boolean(b.mfa_used),
      occurred_at: (b.occurred_at as string) ?? new Date().toISOString(),
      failure_reason: (b.failure_reason as string | undefined) ?? undefined,
    };
  }
}
```

- [ ] **Step 4: Wire into auth.module.ts**

Replace the contents of `apps/api/src/modules/auth/auth.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthGuard } from './auth.guard';
import { AdminGuard } from './admin.guard';
import { AuthEventsService } from './auth-events.service';
import { AuthEventsController } from './auth-events.controller';
import { SupabaseModule } from '../../supabase/supabase.module';

@Module({
  imports: [ConfigModule, SupabaseModule],
  controllers: [AuthEventsController],
  providers: [AuthGuard, AdminGuard, AuthEventsService],
  exports: [AuthGuard, AdminGuard, AuthEventsService],
})
export class AuthModule {}
```

> **If `SupabaseModule` is already provided globally** (check `apps/api/src/supabase/supabase.module.ts` for `@Global`), you can drop `imports: [SupabaseModule]` — but `ConfigModule` is still needed.

- [ ] **Step 5: Add the path to TenantMiddleware exclude list**

Open `apps/api/src/app.module.ts`. Find the `configure` method (around line 100) and add `'api/webhooks/auth/sign-in'` to the `.exclude(...)` call:

```ts
configure(consumer: MiddlewareConsumer) {
  consumer
    .apply(TenantMiddleware)
    .exclude('api/health', 'api/webhooks/ingest', 'api/webhooks/outlook', 'api/webhooks/auth/sign-in')
    .forRoutes('*');
}
```

The webhook resolves tenant inside `AuthEventsService.resolveTenantId`, so the middleware must not reject it.

- [ ] **Step 6: Run controller tests, expect pass**

```bash
pnpm --filter @prequest/api test -- auth-events.controller.spec
```

Expected: 6 passing.

- [ ] **Step 7: Build the api to catch compile errors**

```bash
pnpm --filter @prequest/api build
```

Expected: clean build.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/auth/auth-events.controller.ts apps/api/src/modules/auth/auth-events.controller.spec.ts apps/api/src/modules/auth/auth.module.ts apps/api/src/app.module.ts
git commit -m "feat(auth): wire sign-in webhook controller"
```

---

### Task 4: Configure the Supabase delivery mechanism (manual + env)

This is a deploy-time configuration, not code. Document it inline so it isn't forgotten.

> **IMPORTANT — verify the delivery surface before configuring.** Supabase's "Auth Hooks" feature historically covers email/SMS sending and JWT customization, not generic runtime sign-in/sign-out events. Runtime auth events are typically delivered via **Database Webhooks on `auth.audit_log_entries`** (every login / logout writes a row there with an `action` column).
>
> Use `context7` to fetch current Supabase docs (`mcp__plugin_context7_context7__query-docs` with `library_id` resolved for "supabase auth hooks" and "supabase database webhooks") and verify which surface delivers `sign_in` / `sign_out` / `sign_in_failed` events today. Two paths:
>
> **Path A — Database Webhook on `auth.audit_log_entries`** (most likely correct):
> - Dashboard → Database → Webhooks → New webhook
> - Table: `auth.audit_log_entries`, Events: `Insert`
> - Type: HTTP Request → URL `https://<api-host>/api/webhooks/auth/sign-in`
> - HTTP Headers: `Authorization: Bearer <secret-from-step-1>`
> - Update `AuthEventsController.parsePayload` (Task 3) to handle the database-webhook envelope shape:
>   ```ts
>   // Database webhook payload:
>   // { type: 'INSERT', table: 'audit_log_entries', schema: 'auth', record: { id, payload, created_at, ip_address, ... } }
>   // The interesting bits live in record.payload (jsonb) — fields include action, actor_id, actor_username, traits.
>   ```
>   Map `record.payload.action`: `'login'` → `sign_in`, `'logout'` → `sign_out`, `'login_failed'` → `sign_in_failed` (verify exact strings against a real audit_log_entries row in your project).
>
> **Path B — Custom Auth Hook** (if Supabase has added a runtime sign-in hook by the time you implement):
> - Use the controller as drafted in Task 3 with the literal `{ type, user_id, session_id, ... }` payload.
>
> Either way, the controller secret check + idempotency guarantee in `AuthEventsService` are unchanged. Only `parsePayload` and the Supabase-side configuration differ.

- [ ] **Step 1: Generate the webhook secret**

```bash
openssl rand -hex 32
```

Save the output for the next two steps.

- [ ] **Step 2: Add the secret to local .env and Supabase**

In `.env` (and `.env.example` should also gain a placeholder line):

```
SUPABASE_AUTH_HOOK_SECRET=<paste-from-step-1>
```

In `.env.example`:

```
SUPABASE_AUTH_HOOK_SECRET=
```

- [ ] **Step 3: Configure the Supabase Auth Hook in the dashboard**

> **Manual step — agent should ask the user to do this and confirm.**
>
> Supabase Dashboard → project `iwbqnyrvycqgnatratrk` → Authentication → Hooks → Send → "Send Auth Event Hook"
> - URL: `https://<api-host>/api/webhooks/auth/sign-in` (use the production API host; for local dev, this hook can be left unconfigured — sign-in history simply won't populate locally)
> - Method: POST
> - Authorization Header: `Bearer <secret-from-step-1>`
> - Events: `Sign In`, `Sign Out`, `Sign In Failed` (subscribe to all three)
>
> Save and click "Send test event" to verify it returns 204.

- [ ] **Step 4: Smoke test in production-equivalent environment**

After deploy + hook configuration:

```bash
# log in via the dev app, then check the latest event landed:
PGPASSWORD='<db_password>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -c "select event_kind, signed_in_at, ip_address, user_id from public.auth_sign_in_events order by signed_in_at desc limit 5;"
```

Expected: at least one `sign_in` row from the recent test login.

- [ ] **Step 5: Commit env example**

```bash
git add .env.example
git commit -m "chore(env): add SUPABASE_AUTH_HOOK_SECRET placeholder"
```

> Do NOT commit `.env`. Verify it's in `.gitignore` first.

---

## Phase 2 — Backend read endpoints

### Task 5: GET /users/:id/sign-ins

**Files:**
- Modify: `apps/api/src/modules/user-management/user-management.service.ts`
- Modify: `apps/api/src/modules/user-management/user-management.controller.ts`
- Create: `apps/api/src/modules/user-management/user-management.service.spec.ts` (if it doesn't exist; otherwise extend)

- [ ] **Step 1: Write the failing test for listSignIns**

Create or extend `apps/api/src/modules/user-management/user-management.service.spec.ts`:

```ts
import { UserManagementService } from './user-management.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER   = '22222222-2222-2222-2222-222222222222';

function makeSupabase(rows: unknown[] = []) {
  const calls: { eqs: Array<[string, unknown]>; orderField?: string; limitVal?: number } = { eqs: [] };
  const builder: any = {
    select: () => builder,
    eq: (col: string, val: unknown) => { calls.eqs.push([col, val]); return builder; },
    order: (col: string) => { calls.orderField = col; return builder; },
    limit: (n: number) => { calls.limitVal = n; return Promise.resolve({ data: rows, error: null }); },
  };
  return {
    admin: { from: () => builder },
    calls,
  };
}

describe('UserManagementService.listSignIns', () => {
  beforeEach(() => {
    (TenantContext as any).run({ id: TENANT, slug: 't' }, () => {});
  });

  it('filters by tenant + user + event_kind=sign_in and respects limit', async () => {
    const supabase = makeSupabase([
      { id: 'e1', signed_in_at: '2026-04-28T10:00:00Z', ip_address: '1.2.3.4', user_agent: 'UA', country: null, city: null, method: 'password', provider: null, mfa_used: false, success: true, failure_reason: null },
    ]);

    await TenantContext.run({ id: TENANT, slug: 't' } as never, async () => {
      const svc = new UserManagementService(supabase as never);
      const rows = await svc.listSignIns(USER, 5);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 'e1', ip_address: '1.2.3.4' });
    });

    expect(supabase.calls.eqs).toEqual(expect.arrayContaining([
      ['tenant_id', TENANT],
      ['user_id', USER],
      ['event_kind', 'sign_in'],
    ]));
    expect(supabase.calls.limitVal).toBe(5);
  });
});
```

> If the existing `UserManagementService` constructor needs more dependencies (e.g. a permission service), add stubs to the test setup. Inspect `user-management.module.ts` first.

- [ ] **Step 2: Run test, expect FAIL (method missing)**

```bash
pnpm --filter @prequest/api test -- user-management.service.spec
```

Expected: FAIL — `listSignIns is not a function`.

- [ ] **Step 3: Add the service method**

Open `apps/api/src/modules/user-management/user-management.service.ts`. Add at the bottom of the class:

```ts
async listSignIns(userId: string, limit = 10) {
  const tenant = TenantContext.current();
  const { data, error } = await this.supabase.admin
    .from('auth_sign_in_events')
    .select('id, signed_in_at, ip_address, user_agent, country, city, method, provider, mfa_used, success, failure_reason')
    .eq('tenant_id', tenant.id)
    .eq('user_id', userId)
    .eq('event_kind', 'sign_in')
    .order('signed_in_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}
```

- [ ] **Step 4: Add the controller route**

Open `apps/api/src/modules/user-management/user-management.controller.ts`. Find the `@Get(':id/audit')` handler (around line 79). Add immediately after it:

```ts
@Get(':id/sign-ins')
async getSignIns(
  @Param('id') id: string,
  @Query('limit') limit?: string,
) {
  const n = limit ? Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100) : 10;
  return this.service.listSignIns(id, n);
}
```

You'll need to import `Query` from `@nestjs/common` if it isn't already imported in this file. Check the existing imports.

- [ ] **Step 5: Run tests + build, expect pass**

```bash
pnpm --filter @prequest/api test -- user-management.service.spec
pnpm --filter @prequest/api build
```

Expected: tests pass, build clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/user-management/
git commit -m "feat(users): GET /users/:id/sign-ins endpoint"
```

---

### Task 6: POST /users/:id/password-reset

Triggers Supabase Auth recovery email. Wraps `supabase.auth.admin.generateLink`.

**Files:**
- Modify: `apps/api/src/modules/user-management/user-management.service.ts`
- Modify: `apps/api/src/modules/user-management/user-management.controller.ts`
- Modify: `apps/api/src/modules/user-management/user-management.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Append to `user-management.service.spec.ts`:

```ts
describe('UserManagementService.sendPasswordReset', () => {
  it('looks up the user email and calls generateLink with type recovery', async () => {
    const generateLink = jest.fn(async () => ({ data: { properties: { action_link: 'https://example/recovery?...' } }, error: null }));
    const supabase = {
      admin: {
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { email: 'jane@example.com' }, error: null }),
              }),
            }),
          }),
        }),
        auth: { admin: { generateLink } },
      },
    };

    await TenantContext.run({ id: TENANT, slug: 't' } as never, async () => {
      const svc = new UserManagementService(supabase as never);
      await svc.sendPasswordReset(USER);
    });

    expect(generateLink).toHaveBeenCalledWith({ type: 'recovery', email: 'jane@example.com' });
  });

  it('throws when the user is not found', async () => {
    const supabase = {
      admin: {
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        }),
        auth: { admin: { generateLink: jest.fn() } },
      },
    };

    await TenantContext.run({ id: TENANT, slug: 't' } as never, async () => {
      const svc = new UserManagementService(supabase as never);
      await expect(svc.sendPasswordReset(USER)).rejects.toThrow(/not found/i);
    });
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
pnpm --filter @prequest/api test -- user-management.service.spec
```

Expected: FAIL — `sendPasswordReset is not a function`.

- [ ] **Step 3: Implement the service method**

Append to `UserManagementService`:

```ts
async sendPasswordReset(userId: string): Promise<void> {
  const tenant = TenantContext.current();

  const { data, error } = await this.supabase.admin
    .from('users')
    .select('email')
    .eq('id', userId)
    .eq('tenant_id', tenant.id)
    .maybeSingle();
  if (error) throw error;
  if (!data?.email) {
    throw new NotFoundException(`user ${userId} not found in tenant ${tenant.id}`);
  }

  const { error: linkError } = await this.supabase.admin.auth.admin.generateLink({
    type: 'recovery',
    email: data.email as string,
  });
  if (linkError) throw linkError;
}
```

> Add `NotFoundException` to the `@nestjs/common` import at the top of the file if it isn't already there.

- [ ] **Step 4: Add the controller route**

In `user-management.controller.ts`, immediately after the new `@Get(':id/sign-ins')`:

```ts
@Post(':id/password-reset')
@HttpCode(204)
async sendPasswordReset(@Param('id') id: string) {
  await this.service.sendPasswordReset(id);
}
```

> Add `HttpCode` to the `@nestjs/common` import.

- [ ] **Step 5: Run tests + build**

```bash
pnpm --filter @prequest/api test -- user-management.service.spec
pnpm --filter @prequest/api build
```

Expected: tests pass, build clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/user-management/
git commit -m "feat(users): POST /users/:id/password-reset"
```

---

### Task 7: GET /persons/:id/activity

Merged feed of recent tickets + reservations + audit events for a person.

**Files:**
- Create: `apps/api/src/modules/person/person-activity.service.ts`
- Create: `apps/api/src/modules/person/person-activity.service.spec.ts`
- Modify: `apps/api/src/modules/person/person.controller.ts`
- Modify: `apps/api/src/modules/person/person.module.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/person/person-activity.service.spec.ts`:

```ts
import { PersonActivityService } from './person-activity.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT = '11111111-1111-1111-1111-111111111111';
const PERSON = '33333333-3333-3333-3333-333333333333';

function makeSupabase(returns: { tickets?: unknown[]; bookings?: unknown[]; audits?: unknown[] }) {
  const from = (table: string) => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      or: () => builder,
      order: () => builder,
      limit: () => {
        if (table === 'tickets')        return Promise.resolve({ data: returns.tickets ?? [], error: null });
        if (table === 'reservations')   return Promise.resolve({ data: returns.bookings ?? [], error: null });
        if (table === 'audit_events')   return Promise.resolve({ data: returns.audits ?? [], error: null });
        return Promise.resolve({ data: [], error: null });
      },
    };
    return builder;
  };
  return { admin: { from } };
}

describe('PersonActivityService', () => {
  it('merges and orders by created_at desc, limited', async () => {
    const supabase = makeSupabase({
      tickets: [{ id: 't1', title: 'Broken light', status: 'open', created_at: '2026-04-28T08:00:00Z' }],
      bookings: [{ id: 'b1', space: { name: 'Conf A' }, starts_at: '2026-04-28T11:00:00Z', status: 'confirmed', created_at: '2026-04-28T09:00:00Z' }],
      audits: [{ id: 'a1', event_type: 'role_changed', details: {}, actor_user_id: null, actor: null, created_at: '2026-04-28T10:00:00Z' }],
    });

    await TenantContext.run({ id: TENANT, slug: 't' } as never, async () => {
      const svc = new PersonActivityService(supabase as never);
      const items = await svc.getRecentActivity(PERSON, 10);

      expect(items.map((i) => i.kind)).toEqual(['booking', 'audit', 'ticket']);
    });
  });

  it('respects the limit', async () => {
    const supabase = makeSupabase({
      tickets: Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, title: 'x', status: 'open', created_at: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z` })),
    });

    await TenantContext.run({ id: TENANT, slug: 't' } as never, async () => {
      const svc = new PersonActivityService(supabase as never);
      const items = await svc.getRecentActivity(PERSON, 5);
      expect(items).toHaveLength(5);
    });
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
pnpm --filter @prequest/api test -- person-activity.service.spec
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/modules/person/person-activity.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

export type ActivityItem =
  | { kind: 'ticket';  id: string; title: string; status: string; created_at: string }
  | { kind: 'booking'; id: string; space_name: string; starts_at: string; status: string; created_at: string }
  | { kind: 'audit';   id: string; event_type: string; details: unknown; actor_name: string | null; created_at: string };

@Injectable()
export class PersonActivityService {
  constructor(private readonly supabase: SupabaseService) {}

  async getRecentActivity(personId: string, limit = 20): Promise<ActivityItem[]> {
    const tenant = TenantContext.current();

    const [ticketsRes, bookingsRes, auditsRes] = await Promise.all([
      this.supabase.admin
        .from('tickets')
        .select('id, title, status, created_at')
        .eq('tenant_id', tenant.id)
        .eq('requester_person_id', personId)
        .order('created_at', { ascending: false })
        .limit(limit),
      this.supabase.admin
        .from('reservations')
        .select('id, status, starts_at, created_at, space:spaces(name)')
        .eq('tenant_id', tenant.id)
        .or(`requester_person_id.eq.${personId},host_person_id.eq.${personId}`)
        .order('created_at', { ascending: false })
        .limit(limit),
      this.supabase.admin
        .from('audit_events')
        .select('id, event_type, details, actor_user_id, created_at, actor:users!audit_events_actor_user_id_fkey(person:persons(first_name, last_name))')
        .eq('tenant_id', tenant.id)
        .eq('entity_type', 'persons')
        .eq('entity_id', personId)
        .order('created_at', { ascending: false })
        .limit(limit),
    ]);

    if (ticketsRes.error) throw ticketsRes.error;
    if (bookingsRes.error) throw bookingsRes.error;
    if (auditsRes.error) throw auditsRes.error;

    const items: ActivityItem[] = [
      ...(ticketsRes.data ?? []).map((t: any) => ({
        kind: 'ticket' as const,
        id: t.id, title: t.title, status: t.status, created_at: t.created_at,
      })),
      ...(bookingsRes.data ?? []).map((b: any) => ({
        kind: 'booking' as const,
        id: b.id,
        space_name: b.space?.name ?? '—',
        starts_at: b.starts_at,
        status: b.status,
        created_at: b.created_at,
      })),
      ...(auditsRes.data ?? []).map((a: any) => ({
        kind: 'audit' as const,
        id: a.id,
        event_type: a.event_type,
        details: a.details,
        actor_name: a.actor?.person
          ? `${a.actor.person.first_name} ${a.actor.person.last_name}`
          : null,
        created_at: a.created_at,
      })),
    ];

    items.sort((x, y) => y.created_at.localeCompare(x.created_at));
    return items.slice(0, limit);
  }
}
```

- [ ] **Step 4: Wire into the person module**

In `apps/api/src/modules/person/person.module.ts`, add `PersonActivityService` to providers + exports. Also import it.

- [ ] **Step 5: Add the controller route**

In `apps/api/src/modules/person/person.controller.ts`, after the `getEffectiveAuthorization` route, add:

```ts
@Get(':id/activity')
async getActivity(
  @Req() request: Request,
  @Param('id') id: string,
  @Query('limit') limit?: string,
) {
  await this.permissions.requirePermission(request, 'people.read');
  const n = limit ? Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100) : 20;
  return this.activity.getRecentActivity(id, n);
}
```

Inject `private readonly activity: PersonActivityService` in the controller constructor (add to the `constructor(...)` parameter list and import the service at the top).

- [ ] **Step 6: Run tests + build**

```bash
pnpm --filter @prequest/api test -- person-activity.service.spec
pnpm --filter @prequest/api build
```

Expected: pass + clean.

- [ ] **Step 7: Smoke test against running API**

```bash
pnpm dev:api &
sleep 5
curl -s -H "Authorization: Bearer <a-real-jwt>" http://localhost:3001/api/persons/<a-real-person-id>/activity?limit=5 | jq .
kill %1
```

Expected: JSON array of items, no error. Pick a person with at least one ticket or booking from the seed data so the response isn't empty.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/person/
git commit -m "feat(persons): GET /persons/:id/activity merged feed"
```

---

## Phase 3 — Frontend shared infrastructure

### Task 8: API hooks for new endpoints

**Files:**
- Modify: `apps/web/src/api/users/index.ts`
- Modify: `apps/web/src/api/persons/index.ts`

- [ ] **Step 1: Read the existing files**

```bash
sed -n '1,80p' apps/web/src/api/users/index.ts
sed -n '1,80p' apps/web/src/api/persons/index.ts
```

You need to see the existing key factory and `queryOptions` pattern so the additions match the conventions in `docs/react-query-guidelines.md`.

- [ ] **Step 2: Extend `apps/web/src/api/users/index.ts` — add sign-in keys + options**

Inside the existing `userKeys` factory (after `audit` if it exists), add:

```ts
signIns: (userId: string, limit = 10) =>
  [...userKeys.detail(userId), 'sign-ins', limit] as const,
```

Below the existing `userAuditOptions` (or near the bottom of the file), add:

```ts
export interface UserSignInRow {
  id: string;
  signed_in_at: string;
  ip_address: string | null;
  user_agent: string | null;
  country: string | null;
  city: string | null;
  method: string | null;
  provider: string | null;
  mfa_used: boolean;
  success: boolean;
  failure_reason: string | null;
}

export function userSignInsOptions(userId: string | undefined, limit = 10) {
  return queryOptions({
    queryKey: userKeys.signIns(userId ?? '', limit),
    queryFn: ({ signal }) =>
      apiFetch<UserSignInRow[]>(`/users/${userId}/sign-ins?limit=${limit}`, { signal }),
    enabled: Boolean(userId),
    staleTime: 30_000,
  });
}

export function useUserSignIns(userId: string | undefined, limit = 10) {
  return useQuery(userSignInsOptions(userId, limit));
}

export function useSendPasswordReset() {
  return useMutation<void, Error, { userId: string }>({
    mutationFn: ({ userId }) =>
      apiFetch<void>(`/users/${userId}/password-reset`, { method: 'POST' }),
  });
}

export function useUpdateUser(userId: string) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, Record<string, unknown>>({
    mutationFn: (patch) =>
      apiFetch(`/users/${userId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: userKeys.detail(userId) });
      qc.invalidateQueries({ queryKey: userKeys.lists() });
    },
  });
}
```

> Make sure `useMutation` and `useQueryClient` are imported from `@tanstack/react-query` at the top of the file.

- [ ] **Step 3: Extend `apps/web/src/api/persons/index.ts` — add activity options**

Inside `personKeys`, add:

```ts
activity: (personId: string, limit = 20) =>
  [...personKeys.detail(personId), 'activity', limit] as const,
```

Below the existing exports add:

```ts
export type PersonActivityItem =
  | { kind: 'ticket';  id: string; title: string; status: string; created_at: string }
  | { kind: 'booking'; id: string; space_name: string; starts_at: string; status: string; created_at: string }
  | { kind: 'audit';   id: string; event_type: string; details: unknown; actor_name: string | null; created_at: string };

export function personActivityOptions(personId: string | undefined, limit = 20) {
  return queryOptions({
    queryKey: personKeys.activity(personId ?? '', limit),
    queryFn: ({ signal }) =>
      apiFetch<PersonActivityItem[]>(`/persons/${personId}/activity?limit=${limit}`, { signal }),
    enabled: Boolean(personId),
    staleTime: 30_000,
  });
}

export function usePersonActivity(personId: string | undefined, limit = 20) {
  return useQuery(personActivityOptions(personId, limit));
}
```

- [ ] **Step 4: Type-check the web app**

```bash
pnpm --filter @prequest/web build
```

Expected: clean. Fix any imports or signatures.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/users/index.ts apps/web/src/api/persons/index.ts
git commit -m "feat(api): add hooks for sign-ins, password reset, person activity"
```

---

### Task 9: DsrActionsCard component

Reusable card with two actions: request data export, initiate erasure. Handles the no-linked-person case for users.

**Files:**
- Create: `apps/web/src/components/admin/dsr-actions-card.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Field, FieldGroup, FieldLabel,
} from '@/components/ui/field';
import { SettingsRow, SettingsRowValue } from '@/components/ui/settings-row';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toastSuccess, toastError } from '@/lib/toast';
import {
  useInitiateAccessRequest,
  useInitiateErasureRequest,
} from '@/api/gdpr';

interface Props {
  /** Person id whose data should be acted on. Null when subject is a user with no linked person. */
  personId: string | null;
  /** Display name used in confirm copy. */
  subjectName: string;
}

export function DsrActionsCard({ personId, subjectName }: Props) {
  const navigate = useNavigate();
  const [confirmExport, setConfirmExport] = useState(false);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [eraseReason, setEraseReason] = useState('');

  const accessReq = useInitiateAccessRequest();
  const erasureReq = useInitiateErasureRequest();

  if (!personId) {
    return (
      <SettingsRow
        label="Data subject requests"
        description="Data subject requests act on the underlying person record. Link a person to this user to enable export and erasure."
      >
        <SettingsRowValue>
          <span className="text-xs text-muted-foreground">Not available — no linked person</span>
        </SettingsRowValue>
      </SettingsRow>
    );
  }

  return (
    <>
      <SettingsRow
        label="Request data export"
        description={`Generates a downloadable archive of every record we hold for ${subjectName}. Fulfilled inline; available on the Privacy page.`}
      >
        <SettingsRowValue>
          <Button variant="outline" size="sm" onClick={() => setConfirmExport(true)} disabled={accessReq.isPending}>
            <Download className="size-4" />
            {accessReq.isPending ? 'Requesting…' : 'Request export'}
          </Button>
        </SettingsRowValue>
      </SettingsRow>

      <SettingsRow
        label="Initiate erasure"
        description="Anonymizes personal data subject to legal hold and retention windows. Irreversible after the 7-day restore window."
      >
        <SettingsRowValue>
          <Button variant="destructive" size="sm" onClick={() => setEraseOpen(true)}>
            <Trash2 className="size-4" />
            Initiate erasure
          </Button>
        </SettingsRowValue>
      </SettingsRow>

      <ConfirmDialog
        open={confirmExport}
        onOpenChange={setConfirmExport}
        title={`Request data export for ${subjectName}?`}
        description="An archive of all data we hold will be generated. You can find it on the Privacy page once ready."
        confirmLabel="Request export"
        onConfirm={async () => {
          try {
            await accessReq.mutateAsync({ personId });
            toastSuccess('Data export requested', {
              description: 'Track progress on the Privacy page.',
              action: { label: 'Open privacy', onClick: () => navigate('/admin/privacy') },
            });
          } catch (err) {
            toastError("Couldn't start export", { error: err });
          }
        }}
      />

      <Dialog open={eraseOpen} onOpenChange={(o) => { setEraseOpen(o); if (!o) setEraseReason(''); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Initiate erasure for {subjectName}</DialogTitle>
            <DialogDescription>
              Anonymizes personal data. Records on legal hold are skipped; everything else
              is replaced with anonymized values. A 7-day restore window applies.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="erase-reason">Reason</FieldLabel>
              <Textarea
                id="erase-reason"
                value={eraseReason}
                onChange={(e) => setEraseReason(e.target.value)}
                placeholder="e.g. Right to erasure request submitted by the data subject on 2026-04-28."
                rows={3}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEraseOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={!eraseReason.trim() || erasureReq.isPending}
              onClick={async () => {
                try {
                  await erasureReq.mutateAsync({ personId, reason: eraseReason.trim() });
                  toastSuccess('Erasure initiated', {
                    description: 'A 7-day restore window applies. Track on Privacy.',
                    action: { label: 'Open privacy', onClick: () => navigate('/admin/privacy') },
                  });
                  setEraseOpen(false);
                  setEraseReason('');
                } catch (err) {
                  toastError("Couldn't initiate erasure", { error: err });
                }
              }}
            >
              Initiate erasure
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
```

- [ ] **Step 2: Build to type-check**

```bash
pnpm --filter @prequest/web build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/admin/dsr-actions-card.tsx
git commit -m "feat(admin): DsrActionsCard for export + erasure"
```

---

### Task 10: PersonActivityFeed component

**Files:**
- Create: `apps/web/src/components/admin/person-activity-feed.tsx`

- [ ] **Step 1: Implement**

```tsx
import { Link } from 'react-router-dom';
import { Ticket, Calendar, Activity as ActivityIcon } from 'lucide-react';
import { usePersonActivity, type PersonActivityItem } from '@/api/persons';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';

export function PersonActivityFeed({ personId, limit = 20 }: { personId: string; limit?: number }) {
  const { data, isLoading, error } = usePersonActivity(personId, limit);

  if (isLoading) return <Skeleton className="h-48" />;
  if (error) {
    return (
      <p className="text-sm text-muted-foreground">
        Couldn't load activity. <button className="underline" onClick={() => window.location.reload()}>Retry</button>
      </p>
    );
  }
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No recent activity for this person.</p>;
  }

  return (
    <ul className="flex flex-col divide-y rounded-md border">
      {data.map((item) => (
        <li key={`${item.kind}-${item.id}`} className="px-3 py-2.5">
          <ActivityRow item={item} />
        </li>
      ))}
    </ul>
  );
}

function ActivityRow({ item }: { item: PersonActivityItem }) {
  if (item.kind === 'ticket') {
    return (
      <Link to={`/desk/tickets/${item.id}`} className="flex items-center gap-3 group">
        <Ticket className="size-4 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate group-hover:underline">{item.title}</div>
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <Badge variant="outline" className="text-[10px] capitalize">{item.status}</Badge>
            <time
              className="tabular-nums"
              dateTime={item.created_at}
              title={formatFullTimestamp(item.created_at)}
            >
              {formatRelativeTime(item.created_at)}
            </time>
          </div>
        </div>
      </Link>
    );
  }

  if (item.kind === 'booking') {
    return (
      <Link to={`/desk/bookings?b=${item.id}`} className="flex items-center gap-3 group">
        <Calendar className="size-4 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate group-hover:underline">{item.space_name}</div>
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <Badge variant="outline" className="text-[10px] capitalize">{item.status}</Badge>
            <time
              className="tabular-nums"
              dateTime={item.starts_at}
              title={formatFullTimestamp(item.starts_at)}
            >
              {formatRelativeTime(item.starts_at)}
            </time>
          </div>
        </div>
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <ActivityIcon className="size-4 text-muted-foreground shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm">
          {humanizeAuditEvent(item.event_type)}
          {item.actor_name && <span className="text-muted-foreground"> by {item.actor_name}</span>}
        </div>
        <div className="text-xs text-muted-foreground">
          <time
            className="tabular-nums"
            dateTime={item.created_at}
            title={formatFullTimestamp(item.created_at)}
          >
            {formatRelativeTime(item.created_at)}
          </time>
        </div>
      </div>
    </div>
  );
}

function humanizeAuditEvent(eventType: string): string {
  return eventType.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
```

- [ ] **Step 2: Build**

```bash
pnpm --filter @prequest/web build
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/admin/person-activity-feed.tsx
git commit -m "feat(admin): PersonActivityFeed component"
```

---

### Task 11: UserSignInHistory component

**Files:**
- Create: `apps/web/src/components/admin/user-sign-in-history.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useUserSignIns } from '@/api/users';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';

export function UserSignInHistory({ userId, limit = 10 }: { userId: string; limit?: number }) {
  const { data, isLoading, error } = useUserSignIns(userId, limit);

  if (isLoading) return <Skeleton className="h-48" />;
  if (error) {
    return <p className="text-sm text-muted-foreground">Couldn't load sign-in history.</p>;
  }
  if (!data || data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No sign-ins recorded yet for this account.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead className="w-[140px]">IP</TableHead>
          <TableHead>Device</TableHead>
          <TableHead className="w-[100px]">Method</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <time
                className="tabular-nums text-sm"
                dateTime={row.signed_in_at}
                title={formatFullTimestamp(row.signed_in_at)}
              >
                {formatRelativeTime(row.signed_in_at)}
              </time>
            </TableCell>
            <TableCell className="font-mono text-xs">{row.ip_address ?? '—'}</TableCell>
            <TableCell className="text-xs text-muted-foreground truncate max-w-[280px]">
              {row.user_agent ?? '—'}
            </TableCell>
            <TableCell className="text-xs capitalize">{row.method ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/components/admin/user-sign-in-history.tsx
git commit -m "feat(admin): UserSignInHistory component"
```

---

## Phase 4 — Person detail enhancements

### Task 12: Refactor person-detail.tsx

Adds avatar to header + Identity row, new "Organisation & access" group, Activity section, DSR actions in Danger zone. Also extracts `PersonDetailBody` so the persons.tsx inspector can reuse it (next phase).

**Files:**
- Modify: `apps/web/src/pages/admin/person-detail.tsx`

- [ ] **Step 1: Read the current file**

```bash
sed -n '1,50p' apps/web/src/pages/admin/person-detail.tsx
```

You're going to keep most of the existing Identity rows (first/last/email/phone/type/cost center/active) but rearrange and extend.

- [ ] **Step 2: Define the avatar upload helper**

Inside `person-detail.tsx`, near the top (above the component), add:

```ts
import { supabase } from '@/lib/supabase';

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ACCEPTED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

async function uploadAvatar(personId: string, tenantId: string, file: File): Promise<string> {
  if (file.size > MAX_AVATAR_BYTES) throw new Error('Avatar must be 2 MB or smaller');
  if (!ACCEPTED_AVATAR_TYPES.includes(file.type)) throw new Error('Avatar must be JPEG, PNG, or WebP');

  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg';
  const path = `${tenantId}/${personId}.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from('avatars')
    .upload(path, file, { upsert: true, cacheControl: '3600', contentType: file.type });
  if (uploadErr) throw uploadErr;

  const { data } = supabase.storage.from('avatars').getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;  // bust cache after upload
}
```

> If `apps/web/src/lib/supabase.ts` doesn't export the client this way, check the existing import pattern (likely `import { supabase } from '@/lib/supabase'` or similar). Match the existing convention.
>
> If the `avatars` bucket doesn't exist yet in the project, you'll need a small one-line migration to create it: `insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true) on conflict do nothing;` — but check first via the Supabase dashboard. If it does exist, skip.

- [ ] **Step 3: Extract PersonDetailBody**

Replace the existing `PersonDetailPage` body with two exported pieces. The body becomes a function that accepts `personId` and renders all sections:

```tsx
export function PersonDetailBody({ personId }: { personId: string }) {
  const { data: person, isLoading } = usePerson(personId);
  const { data: costCenters } = useCostCenters({ active: true });
  const update = useUpdatePerson(personId);
  const navigate = useNavigate();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [costCenter, setCostCenter] = useState('');
  const [type, setType] = useState<string>('employee');
  const [active, setActive] = useState(true);
  const [primaryOrgNodeId, setPrimaryOrgNodeId] = useState<string | null>(null);
  const [defaultLocationId, setDefaultLocationId] = useState<string | null>(null);
  const [managerId, setManagerId] = useState('');
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  // Hydrate from server response on first load + when the id changes.
  useEffect(() => {
    if (!person) return;
    setFirstName(person.first_name ?? '');
    setLastName(person.last_name ?? '');
    setEmail(person.email ?? '');
    setPhone(person.phone ?? '');
    setCostCenter(person.cost_center ?? '');
    setType((person.type as string) ?? 'employee');
    setActive(person.active ?? true);
    setDefaultLocationId(person.default_location_id ?? null);
    setManagerId(person.manager_person_id ?? '');
    // primary_org_node_id comes via the `primary_membership` relation.
    const memberships = (person as any).primary_membership as Array<{ org_node_id: string; is_primary: boolean }> | null | undefined;
    const primary = memberships?.find((m) => m.is_primary);
    setPrimaryOrgNodeId(primary?.org_node_id ?? null);
  }, [person?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Surface PATCH failures so silent saves don't hide errors.
  useEffect(() => {
    if (update.error) toastError("Couldn't save changes", { error: update.error });
  }, [update.error]);

  useDebouncedSave(firstName, (v) => {
    if (!person || v === person.first_name) return;
    update.mutate({ first_name: v });
  });
  useDebouncedSave(lastName, (v) => {
    if (!person || v === person.last_name) return;
    update.mutate({ last_name: v });
  });
  useDebouncedSave(email, (v) => {
    if (!person || v === (person.email ?? '')) return;
    update.mutate({ email: v || null });
  });
  useDebouncedSave(phone, (v) => {
    if (!person || v === (person.phone ?? '')) return;
    update.mutate({ phone: v || null });
  });

  if (isLoading) return <Skeleton className="h-96" />;
  if (!person) {
    return <p className="text-sm text-muted-foreground">This person doesn't exist or you don't have access.</p>;
  }

  return (
    <>
      <SettingsGroup title="Identity" description="Display name, contact details, and avatar.">
        {/* existing rows: First name, Last name, Email, Phone, Type, Cost center, Active */}
        {/* new row before First name: */}
        <SettingsRow label="Avatar" description="Shown across the app where this person appears.">
          <SettingsRowValue>
            <AvatarUploadRow person={person} tenantId={person.tenant_id} onUploaded={(url) => update.mutate({ avatar_url: url })} onRemoved={() => update.mutate({ avatar_url: null })} />
          </SettingsRowValue>
        </SettingsRow>
        {/* ...existing rows... */}
      </SettingsGroup>

      <SettingsGroup title="Organisation & access" description="Where this person sits in the org tree, their default work location, manager, and platform account.">
        <SettingsRow label="Primary organisation" description="Inherits the node's location grants in the portal.">
          <SettingsRowValue>
            <OrgNodeCombobox
              value={primaryOrgNodeId}
              onChange={(v) => { setPrimaryOrgNodeId(v); update.mutate({ primary_org_node_id: v }); }}
              placeholder="No organisation"
            />
          </SettingsRowValue>
        </SettingsRow>

        <SettingsRow label="Default work location" description="Sets the portal's default site/building for new requests.">
          <SettingsRowValue>
            <LocationCombobox
              value={defaultLocationId}
              onChange={(v) => { setDefaultLocationId(v); update.mutate({ default_location_id: v }); }}
              typesFilter={['site', 'building']}
              activeOnly
              placeholder="None"
            />
          </SettingsRowValue>
        </SettingsRow>

        <SettingsRow label="Manager">
          <SettingsRowValue>
            <PersonPicker
              value={managerId}
              onChange={(v) => { setManagerId(v); update.mutate({ manager_person_id: v || null }); }}
              excludeId={personId}
              placeholder="No manager"
            />
          </SettingsRowValue>
        </SettingsRow>

        <SettingsRow label="Linked user account" description="Whether this person can sign in to the platform.">
          <SettingsRowValue>
            <LinkedUserControl person={person} />
          </SettingsRowValue>
        </SettingsRow>
      </SettingsGroup>

      <SettingsSection
        title="Location grants"
        description="Every location this person can submit requests for — default + grants + org inheritance."
      >
        <PersonLocationGrantsPanel personId={personId} />
      </SettingsSection>

      <SettingsSection title="Activity" description="Recent tickets, bookings, and audit events for this person.">
        <PersonActivityFeed personId={personId} limit={20} />
      </SettingsSection>

      <SettingsGroup title="Danger zone">
        <SettingsRow
          label="Deactivate person"
          description="Hides this person from pickers and prevents new requests under their name."
        >
          <SettingsRowValue>
            <Button variant="destructive" size="sm" onClick={() => setConfirmDeactivate(true)} disabled={!active}>
              <Trash2 className="size-4" />
              Deactivate
            </Button>
          </SettingsRowValue>
        </SettingsRow>

        <DsrActionsCard
          personId={personId}
          subjectName={personFullName(person) || person.email || 'this person'}
        />
      </SettingsGroup>

      <ConfirmDialog
        open={confirmDeactivate}
        onOpenChange={setConfirmDeactivate}
        title={`Deactivate ${personFullName(person)}?`}
        description="They will be hidden from request submission and assignment. You can reactivate later."
        confirmLabel="Deactivate"
        destructive
        onConfirm={async () => {
          await update.mutateAsync({ active: false });
          setActive(false);
          setConfirmDeactivate(false);
          toastRemoved(personFullName(person), { verb: 'deactivated' });
          navigate('/admin/persons');
        }}
      />
    </>
  );
}
```

> Add the missing local state for `primaryOrgNodeId`, `defaultLocationId`, `managerId` and hydrate them from `person` in the existing `useEffect` block. Pattern matches the existing modal in `persons.tsx` lines 191-202.

- [ ] **Step 4: Implement AvatarUploadRow + LinkedUserControl**

Add inside `person-detail.tsx`:

```tsx
function AvatarUploadRow({
  person, tenantId, onUploaded, onRemoved,
}: {
  person: { id: string; first_name: string; last_name: string; email: string | null; avatar_url: string | null };
  tenantId: string;
  onUploaded: (url: string) => void;
  onRemoved: () => void;
}) {
  const [uploading, setUploading] = useState(false);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadAvatar(person.id, tenantId, file);
      onUploaded(url);
    } catch (err) {
      toastError("Couldn't upload avatar", { error: err });
    } finally {
      setUploading(false);
      e.target.value = '';  // allow re-uploading the same file
    }
  };

  return (
    <div className="flex items-center gap-3">
      <PersonAvatar person={person} size="lg" />
      <label className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'cursor-pointer')}>
        {uploading ? 'Uploading…' : person.avatar_url ? 'Replace' : 'Upload'}
        <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={handleFile} disabled={uploading} />
      </label>
      {person.avatar_url && (
        <Button variant="ghost" size="sm" onClick={onRemoved} disabled={uploading}>Remove</Button>
      )}
    </div>
  );
}

interface PersonLinkedUser { id: string; email: string; status: string; }

function getLinkedUser(person: { user?: PersonLinkedUser | PersonLinkedUser[] | null }): PersonLinkedUser | null {
  const u = person.user;
  if (!u) return null;
  return Array.isArray(u) ? (u[0] ?? null) : u;
}

function LinkedUserControl({ person }: { person: { id: string; first_name: string; last_name: string; email: string | null; user?: PersonLinkedUser | PersonLinkedUser[] | null } }) {
  const qc = useQueryClient();
  const linked = getLinkedUser(person);
  const [inviting, setInviting] = useState(false);

  if (linked) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant={linked.status === 'active' ? 'default' : 'secondary'} className="text-[10px] capitalize">
          {linked.status}
        </Badge>
        <Link
          to={`/admin/users/${linked.id}`}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
        >
          Open user
        </Link>
      </div>
    );
  }

  if (!person.email) {
    return <span className="text-xs text-muted-foreground">Add an email above to invite this person.</span>;
  }

  const handleInvite = async () => {
    setInviting(true);
    try {
      await apiFetch('/users', {
        method: 'POST',
        body: JSON.stringify({ person_id: person.id, email: person.email, status: 'active' }),
      });
      qc.invalidateQueries({ queryKey: personKeys.detail(person.id) });
      toastCreated('User account', {
        onView: () => { /* re-renders with the new linked user; the badge above will appear */ },
      });
    } catch (err) {
      toastError("Couldn't create account", { error: err, retry: handleInvite });
    } finally {
      setInviting(false);
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={handleInvite} disabled={inviting}>
      <UserPlus className="size-4" />
      {inviting ? 'Inviting…' : 'Invite as user'}
    </Button>
  );
}
```

Add the missing imports at the top of the file: `Link` from `react-router-dom`, `useQueryClient` from `@tanstack/react-query`, `personKeys` from `@/api/persons`, `apiFetch` from `@/lib/api`, `toastCreated`, `toastError` from `@/lib/toast`, `buttonVariants` from `@/components/ui/button`, `UserPlus` from `lucide-react`, `cn` from `@/lib/utils`.
```

> The exact `LinkedUserControl` is mostly lifted from `persons.tsx` lines 412-441 (the inline JSX in the table cell). Extract that into the component here so both surfaces use the same control.

- [ ] **Step 5: Update PersonDetailPage to use the new body**

Replace the existing `PersonDetailPage` return with a thin shell:

```tsx
export function PersonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: person, isLoading } = usePerson(id);
  if (!id) return null;

  const headline = !person ? (isLoading ? 'Loading…' : 'Not found') : (personFullName(person) || person.email || 'Unnamed person');

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/admin/persons"
        title={headline}
        description={person?.email ?? 'Person profile and access scope.'}
        actions={person ? (
          <div className="flex items-center gap-2">
            <PersonAvatar person={person} size="default" />
            <Badge variant={person.active ? 'default' : 'outline'} className="text-[10px] uppercase tracking-wider">
              {person.active ? 'Active' : 'Inactive'}
            </Badge>
          </div>
        ) : null}
      />
      <PersonDetailBody personId={id} />
    </SettingsPageShell>
  );
}
```

- [ ] **Step 6: Build to type-check**

```bash
pnpm --filter @prequest/web build
```

Fix any compile errors (missing imports, type mismatches).

- [ ] **Step 7: Smoke test**

```bash
pnpm dev
```

Open `/admin/persons/<a-person-id>` and verify:
- Avatar uploads, replaces, removes
- Default location, manager, primary org auto-save (watch the network tab for PATCH /persons/:id)
- Linked user row shows the right state
- Activity feed renders mixed items
- DSR card opens dialogs, completes successfully
- Deactivate still works

Stop the dev server when done.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/admin/person-detail.tsx
git commit -m "feat(persons): expand detail with avatar, org/location/manager, activity, DSR"
```

---

## Phase 5 — User detail enhancements

### Task 13: Refactor user-detail.tsx

Convert Identity to editable `SettingsGroup`, add Sign-in group, add Danger zone with suspend + DSR.

**Files:**
- Modify: `apps/web/src/pages/admin/user-detail.tsx`

- [ ] **Step 1: Read the existing file**

The current `UserDetailBody` returns four `SettingsSection` blocks (Identity, Roles, Effective permissions, Activity) with read-only fields.

- [ ] **Step 2: Replace UserDetailBody**

Rewrite `UserDetailBody`:

```tsx
export function UserDetailBody({ userId }: { userId: string }) {
  const userQuery = useQuery(userDetailOptions(userId));
  const effectiveQuery = useEffectivePermissions(userId);
  const auditQuery = useUserAudit(userId);
  const update = useUpdateUser(userId);
  const sendReset = useSendPasswordReset();

  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const user = userQuery.data;
  const effective = effectiveQuery.data;

  if (userQuery.isLoading) return <Skeleton className="h-96" />;
  if (!user) {
    return <p className="text-sm text-muted-foreground">This user doesn't exist or you don't have access.</p>;
  }

  const personId = user.person_id ?? user.person?.id ?? null;
  const subjectName = user.person ? `${user.person.first_name} ${user.person.last_name}` : user.email;

  return (
    <>
      <SettingsGroup title="Identity" description="Login email is fixed; everything else can be edited.">
        <SettingsRow label="Email" description="Authentication identifier; change via Supabase Auth.">
          <SettingsRowValue>
            <span className="text-sm text-muted-foreground">{user.email}</span>
          </SettingsRowValue>
        </SettingsRow>
        <UsernameRow user={user} onChange={(v) => update.mutate({ username: v || null })} />
        <SettingsRow label="Status">
          <SettingsRowValue>
            <Select value={user.status} onValueChange={(v) => update.mutate({ status: v })}>
              <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Linked person" description="The person record this account represents.">
          <SettingsRowValue>
            <PersonPicker
              value={personId ?? ''}
              onChange={(v) => update.mutate({ person_id: v || null })}
              placeholder="No linked person"
            />
          </SettingsRowValue>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Sign-in" description="Recent sign-ins and account recovery.">
        <SettingsRow label="Last sign-in">
          <SettingsRowValue>
            {(user as any).last_login_at ? (
              <time
                className="tabular-nums text-sm"
                dateTime={(user as any).last_login_at}
                title={formatFullTimestamp((user as any).last_login_at)}
              >
                {formatRelativeTime((user as any).last_login_at)}
              </time>
            ) : (
              <span className="text-sm text-muted-foreground">Never</span>
            )}
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Recent sign-ins" description="Last 10 successful sign-ins.">
          <div className="px-3 py-2 w-full">
            <UserSignInHistory userId={userId} limit={10} />
          </div>
        </SettingsRow>
        <SettingsRow label="Send password reset" description="Triggers Supabase Auth recovery email to the user's address.">
          <SettingsRowValue>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmReset(true)}
              disabled={sendReset.isPending}
            >
              {sendReset.isPending ? 'Sending…' : 'Send reset email'}
            </Button>
          </SettingsRowValue>
        </SettingsRow>
      </SettingsGroup>

      <SettingsSection title="Roles">
        <RolesList assignments={user.role_assignments ?? []} />
      </SettingsSection>

      <SettingsSection title="Effective permissions" density="tight">
        <EffectivePermissionsPanel
          loading={effectiveQuery.isLoading}
          modules={effective?.modules ?? []}
        />
      </SettingsSection>

      <SettingsSection title="Activity">
        <RoleAuditFeed
          events={auditQuery.data}
          loading={auditQuery.isLoading}
          hideTargetUser
          emptyLabel="No role changes for this user yet."
        />
      </SettingsSection>

      <SettingsGroup title="Danger zone">
        <SettingsRow
          label={user.status === 'suspended' ? 'Reactivate account' : 'Suspend account'}
          description="Suspended accounts cannot sign in. Existing sessions are not revoked."
        >
          <SettingsRowValue>
            <Button
              variant={user.status === 'suspended' ? 'outline' : 'destructive'}
              size="sm"
              onClick={() => setConfirmSuspend(true)}
            >
              {user.status === 'suspended' ? 'Reactivate' : 'Suspend'}
            </Button>
          </SettingsRowValue>
        </SettingsRow>
        <DsrActionsCard personId={personId} subjectName={subjectName} />
      </SettingsGroup>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={`Send password reset to ${user.email}?`}
        description="The user will receive a recovery link via email."
        confirmLabel="Send reset email"
        onConfirm={async () => {
          try {
            await sendReset.mutateAsync({ userId });
            toastSuccess('Reset email sent', { description: user.email });
          } catch (err) {
            toastError("Couldn't send reset email", { error: err, retry: () => sendReset.mutate({ userId }) });
          }
        }}
      />

      <ConfirmDialog
        open={confirmSuspend}
        onOpenChange={setConfirmSuspend}
        title={user.status === 'suspended' ? `Reactivate ${subjectName}?` : `Suspend ${subjectName}?`}
        description={user.status === 'suspended'
          ? 'They can sign in again immediately.'
          : 'They will be blocked from signing in. Existing sessions stay valid until they expire.'}
        confirmLabel={user.status === 'suspended' ? 'Reactivate' : 'Suspend'}
        destructive={user.status !== 'suspended'}
        onConfirm={async () => {
          await update.mutateAsync({ status: user.status === 'suspended' ? 'active' : 'suspended' });
        }}
      />
    </>
  );
}

function UsernameRow({ user, onChange }: { user: UserDetail; onChange: (v: string) => void }) {
  const [value, setValue] = useState(user.username ?? '');
  useEffect(() => { setValue(user.username ?? ''); }, [user.id]);  // eslint-disable-line react-hooks/exhaustive-deps
  useDebouncedSave(value, (v) => {
    if (v === (user.username ?? '')) return;
    onChange(v);
  });
  return (
    <SettingsRow label="Username" description="Optional handle. Doesn't affect login.">
      <SettingsRowValue>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-8 w-56"
          placeholder="None"
          aria-label="Username"
        />
      </SettingsRowValue>
    </SettingsRow>
  );
}
```

- [ ] **Step 3: Add the missing imports**

At the top of `user-detail.tsx`, add:

```ts
import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { SettingsGroup, SettingsRow, SettingsRowValue } from '@/components/ui/settings-row';
import { useUpdateUser, useSendPasswordReset } from '@/api/users';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import { PersonPicker } from '@/components/person-picker';
import { UserSignInHistory } from '@/components/admin/user-sign-in-history';
import { DsrActionsCard } from '@/components/admin/dsr-actions-card';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import { toastSuccess, toastError } from '@/lib/toast';
```

Trim any duplicates. Remove unused imports from the previous version (e.g. `Separator` if no longer referenced).

- [ ] **Step 4: Update the UserDetail interface to include last_login_at**

Find `export interface UserDetail` (around line 43) and add:

```ts
last_login_at?: string | null;
```

- [ ] **Step 5: Build**

```bash
pnpm --filter @prequest/web build
```

Fix any errors.

- [ ] **Step 6: Smoke test**

`pnpm dev`, open `/admin/users/<id>`, verify:
- Username debounced auto-save
- Status select auto-save
- Linked person picker
- Sign-in history (will be empty until webhook is configured + you sign in fresh)
- Last sign-in row reads "Never" until webhook runs
- Send reset email → confirm → success toast
- Suspend → confirm → status changes
- DSR rows when person is linked + the unavailable state when not

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/admin/user-detail.tsx
git commit -m "feat(users): editable identity, sign-in history, password reset, suspend, DSR"
```

---

## Phase 6 — Persons split-view

### Task 14: Refactor persons.tsx to TableInspectorLayout

**Files:**
- Modify: `apps/web/src/pages/admin/persons.tsx`

- [ ] **Step 1: Replace the page shell**

Replace the entire `PersonsPage` body. Mirror `users.tsx` structure exactly (header, toolbar, table, inspector).

```tsx
export function PersonsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('p');
  const [typeFilter, setTypeFilter] = useState('all');
  const [search, setSearch] = useState('');
  const { data: people, isPending: loading } = usePersons(typeFilter) as { data: Person[] | undefined; isPending: boolean };
  const refetch = () => qc.invalidateQueries({ queryKey: personKeys.all });

  const [createOpen, setCreateOpen] = useState(false);
  const [newFirstName, setNewFirstName] = useState('');
  const [newLastName, setNewLastName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newType, setNewType] = useState('employee');
  const [createError, setCreateError] = useState<string | null>(null);

  const filteredPeople = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return people ?? [];
    return (people ?? []).filter((p) => {
      const name = `${p.first_name} ${p.last_name}`.toLowerCase();
      return name.includes(q) || (p.email ?? '').toLowerCase().includes(q);
    });
  }, [people, search]);

  const selectPerson = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('p', id);
    else next.delete('p');
    setSearchParams(next, { replace: true });
  };

  const resetCreate = () => {
    setNewFirstName(''); setNewLastName(''); setNewEmail(''); setNewType('employee'); setCreateError(null);
  };

  const handleCreate = async () => {
    if (!newFirstName.trim() || !newLastName.trim()) return;
    try {
      setCreateError(null);
      const created = await apiFetch<{ id: string }>('/persons', {
        method: 'POST',
        body: JSON.stringify({
          first_name: newFirstName.trim(),
          last_name: newLastName.trim(),
          email: newEmail.trim() || undefined,
          type: newType,
        }),
      });
      resetCreate();
      setCreateOpen(false);
      refetch();
      toastCreated('Person', { onView: () => selectPerson(created.id) });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create person');
    }
  };

  const isEmpty = !loading && (people?.length ?? 0) === 0;
  const hasSelection = Boolean(selectedId);

  return (
    <>
      <TableInspectorLayout
        header={
          <div className="flex shrink-0 items-start justify-between gap-4 border-b px-6 py-4">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold">People</h1>
              <p className="text-xs text-muted-foreground max-w-2xl">
                Employees, contractors, and vendor contacts. Click a row to inspect; edit on the detail page.
              </p>
            </div>
            <Button className="gap-1.5 shrink-0" onClick={() => { resetCreate(); setCreateOpen(true); }}>
              <Plus className="size-4" /> Add person
            </Button>
          </div>
        }
        toolbar={
          <div className="flex shrink-0 items-center gap-3 border-b px-6 py-2.5">
            <Tabs value={typeFilter} onValueChange={setTypeFilter}>
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="employee">Employees</TabsTrigger>
                <TabsTrigger value="contractor">Contractors</TabsTrigger>
                <TabsTrigger value="vendor_contact">Vendors</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or email…"
                className="h-8 pl-8"
              />
            </div>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {filteredPeople.length} {filteredPeople.length === 1 ? 'person' : 'people'}
            </span>
          </div>
        }
        list={
          <PersonsTable
            people={filteredPeople}
            loading={loading}
            isEmpty={isEmpty}
            selectedId={selectedId}
            onSelect={selectPerson}
            onAdd={() => { resetCreate(); setCreateOpen(true); }}
            hasSelection={hasSelection}
          />
        }
        inspector={
          hasSelection && selectedId ? (
            <InspectorPanel
              onClose={() => selectPerson(null)}
              onExpand={() => navigate(`/admin/persons/${selectedId}`)}
            >
              <PersonInspectorContent personId={selectedId} />
            </InspectorPanel>
          ) : null
        }
      />

      <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) resetCreate(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add person</DialogTitle>
            <DialogDescription>Create a person record. Org, location, manager, and avatar are configured on the detail page.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="new-person-first">First name</FieldLabel>
                <Input id="new-person-first" value={newFirstName} onChange={(e) => setNewFirstName(e.target.value)} placeholder="Jane" />
              </Field>
              <Field>
                <FieldLabel htmlFor="new-person-last">Last name</FieldLabel>
                <Input id="new-person-last" value={newLastName} onChange={(e) => setNewLastName(e.target.value)} placeholder="Smith" />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="new-person-email">Email <span className="text-muted-foreground font-normal">(optional)</span></FieldLabel>
              <Input id="new-person-email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="jane@company.com" />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-person-type">Type</FieldLabel>
              <Select value={newType} onValueChange={(v) => setNewType(v ?? 'employee')}>
                <SelectTrigger id="new-person-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {personTypes.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {createError && <FieldError>{createError}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!newFirstName.trim() || !newLastName.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PersonsTable({
  people, loading, isEmpty, selectedId, onSelect, onAdd, hasSelection,
}: {
  people: Person[];
  loading: boolean;
  isEmpty: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  hasSelection: boolean;
}) {
  if (loading) return <div className="px-6 py-6 text-sm text-muted-foreground">Loading…</div>;
  if (isEmpty) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <UserCog className="size-10 text-muted-foreground" />
        <div className="text-sm font-medium">No people yet</div>
        <p className="max-w-sm text-sm text-muted-foreground">
          Add your first person to start routing requests and assigning ownership.
        </p>
        <Button className="gap-1.5" onClick={onAdd}>
          <Plus className="size-4" /> Add person
        </Button>
      </div>
    );
  }
  if (people.length === 0) {
    return <div className="px-6 py-10 text-center text-sm text-muted-foreground">No people match the current search.</div>;
  }
  return (
    <Table containerClassName="overflow-visible">
      <TableHeader className="bg-muted/30 sticky top-0 z-10 backdrop-blur-sm">
        <TableRow>
          <TableHead className="px-6">Name</TableHead>
          {!hasSelection && <TableHead className="w-[220px]">Email</TableHead>}
          <TableHead className="w-[120px]">Type</TableHead>
          {!hasSelection && <TableHead>Organisation</TableHead>}
          {!hasSelection && <TableHead className="w-[160px]">Platform access</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {people.map((person) => {
          const selected = selectedId === person.id;
          const orgNode = getPrimaryOrgNode(person);
          const linkedUser = getLinkedUser(person);
          return (
            <TableRow
              key={person.id}
              data-selected={selected ? 'true' : undefined}
              onClick={() => onSelect(person.id)}
              className={cn('cursor-pointer transition-colors', selected ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-muted/40')}
            >
              <TableCell className={cn('font-medium px-6', selected && 'border-l-2 border-l-primary pl-[22px]')}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <PersonAvatar person={person} size="sm" />
                  <div className="min-w-0">
                    <div className="truncate">{person.first_name} {person.last_name}</div>
                    {hasSelection && (
                      <div className="text-xs text-muted-foreground truncate mt-0.5">
                        {person.email ?? '—'}
                      </div>
                    )}
                  </div>
                </div>
              </TableCell>
              {!hasSelection && (
                <TableCell className="text-muted-foreground text-sm">{person.email ?? '—'}</TableCell>
              )}
              <TableCell>
                <Badge variant={typeColors[person.type] ?? 'outline'} className="capitalize text-xs">
                  {personTypes.find((t) => t.value === person.type)?.label ?? person.type}
                </Badge>
              </TableCell>
              {!hasSelection && (
                <TableCell className="text-muted-foreground text-sm">{orgNode?.name ?? '—'}</TableCell>
              )}
              {!hasSelection && (
                <TableCell>
                  {linkedUser ? (
                    <Badge variant={linkedUser.status === 'active' ? 'default' : 'secondary'} className="text-[10px] capitalize">
                      {linkedUser.status}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">No account</span>
                  )}
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function PersonInspectorContent({ personId }: { personId: string }) {
  const { data: person } = usePerson(personId);
  return (
    <div className="flex flex-col gap-8 px-6 pt-6 pb-10">
      {person && (
        <div className="flex items-start gap-3">
          <PersonAvatar person={person} size="lg" />
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-2xl font-semibold tracking-tight truncate">
                {personFullName(person) || person.email || 'Unnamed person'}
              </h2>
              <Badge variant={person.active ? 'default' : 'outline'} className="capitalize shrink-0 mt-1.5">
                {person.active ? 'Active' : 'Inactive'}
              </Badge>
            </div>
            {person.email && <p className="text-sm text-muted-foreground truncate">{person.email}</p>}
          </div>
        </div>
      )}
      <PersonDetailBody personId={personId} />
    </div>
  );
}
```

- [ ] **Step 2: Update imports at the top of persons.tsx**

Replace existing imports with the merged set:

```ts
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, UserCog, Search } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TableInspectorLayout, InspectorPanel } from '@/components/ui/table-inspector-layout';
import { PersonAvatar } from '@/components/person-avatar';
import { usePersons, usePerson, personKeys, personFullName } from '@/api/persons';
import { apiFetch } from '@/lib/api';
import { toastCreated } from '@/lib/toast';
import { PersonDetailBody } from './person-detail';
```

Drop everything no longer needed (the old `useCostCenters`, `Pencil`, `UserPlus`, `LocationCombobox`, `OrgNodeCombobox`, `ScrollArea`, `PersonPicker`, `FieldSeparator`, `Trash2`, `useUpdatePerson`, `useDebouncedSave`).

- [ ] **Step 3: Build**

```bash
pnpm --filter @prequest/web build
```

Fix any compile errors.

- [ ] **Step 4: Smoke test**

`pnpm dev`, open `/admin/persons`, verify:
- Click a row → inspector opens, URL has `?p=`
- Close inspector → URL drops `?p=`
- Expand button → navigates to `/admin/persons/:id`
- Tabs filter (All / Employees / Contractors / Vendors)
- Search filters live
- "Add person" dialog creates → opens the new row in the inspector
- Empty state on a fresh tenant
- Inspector body matches detail page (avatar, all groups, activity, DSR)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/admin/persons.tsx
git commit -m "feat(persons): split-view inspector layout, drop edit modal"
```

---

## Phase 7 — Cleanup

### Task 15: Remove dead code

**Files:**
- Modify: `apps/web/src/pages/admin/persons.tsx` (final cleanup)

- [ ] **Step 1: Search for orphans**

```bash
grep -rn "from '@/pages/admin/persons'" apps/web/src
grep -rn "openEdit\|setEditId" apps/web/src
```

Anything that imports the old modal helpers should be updated or — if dead — removed.

- [ ] **Step 2: Run final build + lint**

```bash
pnpm --filter @prequest/web build
pnpm --filter @prequest/web lint
pnpm --filter @prequest/api build
pnpm --filter @prequest/api test
```

Fix any warnings.

- [ ] **Step 3: Commit**

If there's anything to commit:

```bash
git add -p
git commit -m "chore: drop unused exports from persons.tsx"
```

---

## Self-review checklist

Before declaring this slice done, verify:

**Spec coverage:**
- [ ] Migration `00168_auth_sign_in_events.sql` exists, applied locally, pushed to remote
- [ ] Webhook endpoint receives + processes `sign_in`, `sign_out`, `sign_in_failed`
- [ ] `users.last_login_at` updates on real sign-in
- [ ] `GET /users/:id/sign-ins` returns rows
- [ ] `POST /users/:id/password-reset` triggers Supabase recovery email
- [ ] `GET /persons/:id/activity` returns merged feed
- [ ] Person detail surfaces avatar, default location, manager, primary org, linked user, activity, DSR
- [ ] User detail has editable username/status/linked person, sign-in group, suspend, DSR
- [ ] Persons page is split-view; edit modal removed; create dialog simplified
- [ ] No-linked-person fallback on user-detail DSR card
- [ ] Email is optional in person create dialog (not required)

**Risks left open (not in this slice):**
- Active sessions list / revoke
- "Sign out all devices" (ties to password change)
- New-device email alerts
- MFA enrollment
- API tokens
- Impersonate
- Frontend automated tests (no test runner configured)
