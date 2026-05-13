# Slice C — PM (Preventive-Maintenance) Generator — Plan v2 (codex-revised)

**Date:** 2026-05-13
**Branch:** main
**Predecessor:** planning-board cleanup workstream (handoff doc at `ai/handoff-planning-board-cleanup.md` — shipped 2026-05-12)
**Spec reference:** `docs/superpowers/specs/2026-04-30-plandate-planning-board-pm-design.md` §"Slice C — Preventive Maintenance" (lines 171–239)

v1 → v2 changelog (codex plan-review 2026-05-13):
- **Direction errors fixed**: idempotency key now includes `asset_id` (fan-out was broken); WO create goes through a new PM-specific atomic RPC (`create_ticket_with_automation` inserts into `tickets`, not `work_orders` — codex caught the conflation); completion hook moved into SQL trigger (no `completed_at` column exists — uses `resolved_at` from `transition_entity_status` instead); smoke probe expanded for fan-out + replay + advance + completion + real-DB idempotency.
- **Hardening applied**: composite-FK tenant ownership on `asset_id` / `asset_type_id`; bounded-batch cron iteration mirroring `workflow-wait-sweeper`; granular CRUD permissions over `maintenance.admin`.

---

## 1. Goal + scope

**Deliverable (v1):** a preventive-maintenance work-order generator that auto-creates recurring maintenance WOs from templated plans.

**In scope for v1:**
- Schema: `maintenance_plans` table + `origin` + `maintenance_plan_id` columns on `work_orders`.
- Drop the orphaned legacy `maintenance_schedules` table (migration 00016) cleanly — only 1 ref in 00100 seed cleanup, no service code touches it.
- Recurrence engine: simple `{interval, unit, anchor_date}` math. NO RRULE library.
- Generator job (nightly cron via the project's existing scheduled-handler pattern).
- Service layer + admin endpoints for plan CRUD.
- Admin UI v1: `/admin/maintenance/plans` index + detail page using the settings-page template.
- Tests: recurrence math, idempotency, end-to-end generator smoke probe.

**Out of scope for v1 (deferred to v1.5+):**
- Full RRULE support (EXDATE/RDATE, weekly-on-specific-days, monthly-by-day-of-week).
- Compliance dimension: signed checklists, certificates, audit signoff.
- Plan-side assignee override (routing remains the only assignment source).
- Multi-tenant cron orchestration tuning (use per-tenant iteration inside one cron).
- Calendar adjustments for business hours / public holidays (planned start stays as scheduled).
- Corrective-WO linkage UI (the FK `maintenance_plan_id` is added but the corrective-child workflow ships in v1.5).
- **Workflow on PM-WOs.** `WorkflowStartHandler` reads `tickets.workflow_id` only — it doesn't fire for `work_orders`. v3 RPC (00398) deliberately leaves `work_orders.workflow_id` NULL on PM spawns so admins see honest state ("no workflow configured for PM today") instead of silent no-ops. Phase 2 universal-workflow (memory `project_universal_workflow_phase1_complete`) will land polymorphic workflow handlers; the RPC is revisited then.
- **Permanent per-asset failure quarantine.** Codex remediation moved per-asset failure to BLOCK plan advance — but a permanent failure (asset deleted under the plan, persistent FK error) now blocks the plan forever. v1.5 will add a max-retries quarantine mechanism. Admin notices via cron logs + missing WO.

**Codex remediation journal — v3 RPC (migration 00398, 2026-05-13):**
- Dropped `workflow_id` inheritance on PM-WO inserts.
- Set `sla_timers.recompute_pending = true` for forward-compat with the future polymorphic SLA recompute handler.
- Registered `pm_generator` + `manual` strategy values in `docs/assignments-routing-fulfillment.md`.
- `PMGeneratorService.generateForPlan` now blocks `next_run_at` advance on any per-asset failure (null returns from ON CONFLICT are not failures).
- `/admin/maintenance/plans` create dialog migrated to `PickerCommandList` (search/scroll for the asset/asset-type/request-type pickers).

---

## 2. Decisions on the 5 open spec questions

The spec leaves 5 design calls open (lines 232–239). Defaults below; ask codex to pressure-test.

| # | Question | Default | Why |
|---|---|---|---|
| 1 | Recurrence model | `{interval: int, unit: 'day'\|'week'\|'month'\|'year', anchor_date: date}` | Covers 95% of facilities PM (monthly HVAC, quarterly inspection, annual fire test). Hand-rolled math is 1-2h; RRULE is multi-day library integration. Ship simple; add RRULE in v2 if customers ask. |
| 2 | Assignee defaults | Routing-only — no plan-side override | The routing engine is the single source of truth (memory `project_routing_stack`). If a plan needs a specific team, set a routing rule. Don't fork the assignment decision. |
| 3 | Multi-asset plans | Mutex: nullable `asset_id` XOR nullable `asset_type_id`; CHECK constraint enforces exactly one. Per-type fan-out generates 1 WO per asset of that type. | Simple covers both common cases (HVAC filter on Building A vs all HVAC fleet). Avoids the M:N complexity of `maintenance_plan_assets`. |
| 4 | Plan authoring UI | Ship in v1 — `/admin/maintenance/plans` admin index + detail page with settings-page template | Without UI, the feature is unusable. Standard settings-page shape, low marginal cost. |
| 5 | 00016 cleanup | Drop `maintenance_schedules` cleanly in a fresh migration; no preservation | Orphaned legacy (1 ref in seed cleanup, no service code). Per `.claude/CLAUDE.md` "no legacy preservation" + `feedback_best_in_class_not_legacy`. |

Plus 3 more I'm pre-deciding:

| # | Question | Default |
|---|---|---|
| 6 | Completion → plan update | When generated WO transitions to `status='completed'`, set `plan.last_completed_at = wo.completed_at` and `plan.next_run_at = recurrence_advance(wo.completed_at, recurrence)`. Don't backfill missed cycles. |
| 7 | Idempotency | Unique partial index on `(maintenance_plan_id, planned_start_at)` where `status NOT IN ('completed','cancelled')`. Generator does INSERT … ON CONFLICT DO NOTHING. Re-runs are safe. |
| 8 | Lead time | Per-plan `lead_days int default 7`. Generator selects plans where `next_run_at <= now() + (lead_days * '1 day'::interval)`. |

---

## 3. Data model — concrete SQL (v2)

```sql
-- new
create table public.maintenance_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- identity + admin
  name text not null,
  description text,
  active boolean not null default true,

  -- target (mutex: exactly one of asset_id / asset_type_id)
  -- COMPOSITE FK enforces tenant ownership (FK alone is not tenant-safe).
  -- Requires public.assets and public.asset_types to expose (tenant_id, id)
  -- as a UNIQUE constraint — verify in migration; add if absent.
  asset_id uuid,
  asset_type_id uuid,
  constraint maintenance_plans_target_mutex check (
    (asset_id is not null and asset_type_id is null) or
    (asset_id is null and asset_type_id is not null)
  ),
  constraint maintenance_plans_asset_tenant_fk
    foreign key (tenant_id, asset_id)
    references public.assets (tenant_id, id) on delete cascade,
  constraint maintenance_plans_asset_type_tenant_fk
    foreign key (tenant_id, asset_type_id)
    references public.asset_types (tenant_id, id) on delete cascade,

  -- request routing
  request_type_id uuid not null,
  location_id uuid,
  constraint maintenance_plans_request_type_tenant_fk
    foreign key (tenant_id, request_type_id)
    references public.request_types (tenant_id, id),
  constraint maintenance_plans_location_tenant_fk
    foreign key (tenant_id, location_id)
    references public.spaces (tenant_id, id),

  -- WO template
  title_template text not null,
  description_template text,
  priority text not null default 'normal' check (priority in ('low','normal','high','critical')),
  planned_duration_minutes int default 60 check (planned_duration_minutes > 0),

  -- recurrence
  recurrence_interval int not null check (recurrence_interval > 0),
  recurrence_unit text not null check (recurrence_unit in ('day','week','month','year')),
  anchor_date date not null,
  lead_days int not null default 7 check (lead_days >= 0),

  -- state
  next_run_at timestamptz not null,
  last_completed_at timestamptz,
  last_generated_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.users(id),
  updated_by uuid references public.users(id)
);

create index idx_maintenance_plans_tenant on public.maintenance_plans (tenant_id);
create index idx_maintenance_plans_due on public.maintenance_plans (next_run_at) where active = true;
create index idx_maintenance_plans_asset on public.maintenance_plans (asset_id) where asset_id is not null;
create index idx_maintenance_plans_asset_type on public.maintenance_plans (asset_type_id) where asset_type_id is not null;

-- RLS — tenant_id isolation only (mirrors request_types / routing_rules)
alter table public.maintenance_plans enable row level security;

-- extension on work_orders
alter table public.work_orders
  add column origin text not null default 'reactive'
    check (origin in ('reactive','preventive','corrective')),
  add column maintenance_plan_id uuid,
  add column source_asset_id uuid;  -- v2: persists fan-out provenance so the
                                    -- idempotency index can include asset_id

-- Composite tenant FKs (no orphan + tenant-safe)
alter table public.work_orders
  add constraint work_orders_pm_plan_tenant_fk
    foreign key (tenant_id, maintenance_plan_id)
    references public.maintenance_plans (tenant_id, id),
  add constraint work_orders_pm_asset_tenant_fk
    foreign key (tenant_id, source_asset_id)
    references public.assets (tenant_id, id);

create index idx_work_orders_pm_plan on public.work_orders (maintenance_plan_id)
  where maintenance_plan_id is not null;

-- v2 IDEMPOTENCY GUARD — codex fix.
-- Old key (plan_id, planned_start_at) silently dropped fan-out WOs because
-- an asset-type plan generates N WOs at the same planned_start_at — only one
-- could insert. New key includes source_asset_id; the partial predicate is
-- gone (replay safety should survive terminal status).
create unique index uq_work_orders_pm_occurrence
  on public.work_orders (tenant_id, maintenance_plan_id, source_asset_id, planned_start_at)
  where maintenance_plan_id is not null;

-- drop legacy in its own migration
drop table public.maintenance_schedules cascade;
```

**Composite-FK precondition.** The `(tenant_id, id)` references require unique
constraints on `public.assets`, `public.asset_types`, `public.request_types`,
and `public.spaces`. Verify on a per-table basis in the migration; if any
table is missing the unique constraint, add it first. Pattern is already in
use elsewhere in the codebase — grep for `unique (tenant_id, id)` to confirm.

Three migrations:
1. `00386_maintenance_plans_schema.sql` — composite-FK preconditions (if needed) + table + indexes + RLS.
2. `00387_work_orders_pm_columns.sql` — `origin` + `maintenance_plan_id` + `source_asset_id` + composite FKs + idempotency index.
3. `00388_drop_legacy_maintenance_schedules.sql` — drop the orphan + new no-op seed-cleanup migration if 00100 needs replacing.

---

## 4. Generator algorithm (v2 — codex-revised)

**Critical change: WO creation goes through a new PM-specific atomic RPC.**

`create_ticket_with_automation` writes to `public.tickets` — NOT `work_orders`. We need a sibling RPC that writes to `work_orders` atomically with the plan advance + audit emit. Reading `00351` end-to-end to mirror its shape (routing decision capture, audit emit, command_op insert, tenant validation).

**New RPC: `create_pm_work_order(p_plan_id uuid, p_actor_user_id uuid, p_asset_id uuid, p_run_at timestamptz)` (migration 00389)**

Body:
```
1. SELECT FOR UPDATE the plan row (locks against concurrent generator runs).
2. Verify plan.active = true; if not, return null (skip silently).
3. Resolve asset details (location, name) from the asset_id.
4. INSERT INTO work_orders (tenant_id, requester_person_id=null, asset_id, location_id,
     ticket_type_id, title (rendered template), priority, planned_start_at, planned_duration_minutes,
     origin='preventive', maintenance_plan_id, source_asset_id, created_by=p_actor_user_id, ...)
   ON CONFLICT (tenant_id, maintenance_plan_id, source_asset_id, planned_start_at) DO NOTHING
   RETURNING id INTO v_wo_id.
5. If v_wo_id IS NULL (conflict): return null. The generator's already done this occurrence.
6. INSERT routing_decisions row (call resolver inline OR null-it-out + leave for first
   operator open — match how create_ticket_with_automation does it; verify).
7. INSERT ticket_activities row with metadata = jsonb_build_object('source', 'generator',
     'event', 'plan_spawned', 'plan_id', p_plan_id).
8. UPDATE maintenance_plans SET last_generated_at = now()
     WHERE id = p_plan_id.
9. RETURN v_wo_id.
```

Notes:
- `SELECT FOR UPDATE` on the plan serializes parallel generator runs on the same plan (cross-tenant cron is single-process, but defense-in-depth).
- The `ON CONFLICT DO NOTHING` makes the operation idempotent at the row level — re-running the generator does not double-emit.
- Routing decision capture: read `00351` carefully. May choose to leave it null in v1 (operators triage on the planning board) OR call the resolver inline for assignment auto-set. Default: null + leave for routing-engine retry. Confirm during build.

**Cron iteration** (mirrors `workflow-wait-sweeper.cron.ts` — verify the actual file path):

```ts
@Cron('0 3 * * *')
async run() {
  const tenants = await this.listActiveTenants();
  for (const tenantId of tenants) {
    try {
      await this.generateForTenant(tenantId, new Date());
    } catch (err) {
      this.logger.error(`PM generator failed for tenant ${tenantId}`, err);
      // Continue to next tenant; per-tenant failure doesn't block siblings.
    }
  }
}

async generateForTenant(tenantId, runAt) {
  const BATCH = 100;
  while (true) {
    const plans = await this.selectDuePlans(tenantId, runAt, BATCH);
    if (plans.length === 0) break;
    for (const plan of plans) {
      const targets = await this.resolveTargets(plan);
      for (const assetId of targets) {
        try {
          await this.callCreatePmWorkOrderRpc(plan.id, SYSTEM_ACTOR_ID, assetId, plan.next_run_at);
        } catch (err) {
          this.logger.error(`PM occurrence failed for plan ${plan.id} asset ${assetId}`, err);
          // per-row catch — don't propagate
        }
      }
      // Advance plan.next_run_at OUTSIDE the per-asset loop (one advance per occurrence)
      await this.advancePlan(plan.id, plan.next_run_at, plan.recurrence_interval, plan.recurrence_unit);
    }
    if (plans.length < BATCH) break;
  }
}
```

Bounded batch + per-row + per-tenant catch — failure on one plan doesn't block siblings; failure on one tenant doesn't block the cron.

`advance_recurrence(next_run_at, interval, unit)`:
- Postgres-native: `next_run_at + (interval * '1 day'::interval)` etc. Month/year math respects month-end via Postgres `interval` semantics.

**Completion hook** (v2 — codex-revised, moved to SQL trigger):

There is no `work_orders.completed_at` column. The codebase uses `transition_entity_status` (00325) which synthesizes `resolved_at` / `closed_at` based on status_category. Trigger fires inside that flow.

New migration `00390_pm_completion_trigger.sql`:

```sql
create or replace function tg_pm_plan_last_completed_at() returns trigger
language plpgsql as $$
begin
  -- Only fire when a WO transitions INTO 'resolved' (the primary signal of
  -- maintenance done) AND it has a maintenance_plan_id.
  if new.maintenance_plan_id is not null
     and new.resolved_at is not null
     and (old.resolved_at is null or old.resolved_at <> new.resolved_at)
  then
    update public.maintenance_plans
       set last_completed_at = new.resolved_at,
           updated_at = now()
     where id = new.maintenance_plan_id
       and tenant_id = new.tenant_id;  -- defense-in-depth
  end if;
  return new;
end;
$$;

create trigger tg_pm_plan_last_completed_at
  after update of resolved_at on public.work_orders
  for each row
  execute function tg_pm_plan_last_completed_at();
```

Uses `resolved_at` (not the nonexistent `completed_at`). Deadlock risk: the trigger updates `maintenance_plans` after the WO row update — the generator updates `maintenance_plans` BEFORE the WO insert. Lock ordering is: plans-then-WOs in the generator (via the RPC's `SELECT FOR UPDATE`); WOs-then-plans in the trigger. Two writers could theoretically deadlock. Mitigation: the generator's lock-then-write is fast (one row); deadlock probability is low. Acceptable for v1; revisit if monitoring shows it.

---

## 5. Service + controller surface

**MaintenancePlanService** (`apps/api/src/modules/maintenance/maintenance-plan.service.ts`):
- `create(dto, ctx)` — validates target mutex, computes initial `next_run_at` from `anchor_date`, inserts.
- `update(id, dto, ctx)` — partial update; if recurrence changed, recompute `next_run_at` from `anchor_date`.
- `delete(id, ctx)` — soft delete (set `active = false`); hard delete only if no work orders reference it.
- `list(filters, ctx)` — pagination, filter by `asset_id` / `request_type_id` / `active`.
- `findById(id, ctx)` — detail view.

**PMGeneratorService** (`apps/api/src/modules/maintenance/pm-generator.service.ts`):
- `generateForTenant(tenantId, runAt)` — the algorithm above.
- `generateForAllTenants(runAt)` — cron entry point.

**PMGeneratorCron** (`apps/api/src/modules/maintenance/pm-generator.cron.ts`):
- `@Cron('0 3 * * *')` annotation; calls `generateForAllTenants(new Date())`.

**MaintenancePlanController** (`apps/api/src/modules/maintenance/maintenance-plan.controller.ts`):
- `POST /admin/maintenance/plans` — create.
- `GET /admin/maintenance/plans` — list.
- `GET /admin/maintenance/plans/:id` — detail.
- `PATCH /admin/maintenance/plans/:id` — update.
- `DELETE /admin/maintenance/plans/:id` — soft delete.
- All gated by granular CRUD permissions (codex-revised — `<resource>.<action>` grammar): `maintenance_plans.read`, `maintenance_plans.create`, `maintenance_plans.update`, `maintenance_plans.delete`. Register all four in `packages/shared/src/permissions.ts` + grant by default to admin / agent-admin role per `project_permission_catalog_enforcement_shipped`. NOT `maintenance.admin` (codex flagged that as inconsistent with the resource.action grammar; rooms.admin / vendors.admin are themselves legacy outliers per the LEGACY list).

**WO completion hook:**
- In the existing WO update path (`work-order.service.ts`), when status transitions to `completed` and `maintenance_plan_id IS NOT NULL`, update the plan's `last_completed_at`. Keep it simple — direct UPDATE inside the same transaction as the WO completion.

---

## 6. Admin UI v1

**Routes:**
- `/admin/maintenance` — overview page (counts of active plans, plans due today, recent generation history).
- `/admin/maintenance/plans` — index page (table of plans).
- `/admin/maintenance/plans/new` — create flow (dialog or page; default to page given complexity).
- `/admin/maintenance/plans/:id` — detail page.

**Shape (per `CLAUDE.md` settings-page template):**
- Index: `SettingsPageShell width="xwide"`, `SettingsPageHeader` with "New plan" CTA, `Table` with columns: name, target (asset name or type name), request type, recurrence (formatted as "Every 1 month"), next due, active toggle. Row click → detail.
- Detail: `SettingsPageShell width="xwide" backTo="/admin/maintenance/plans"`. Groups:
  1. **Identity** — name, description, active toggle (auto-save via `useDebouncedSave`).
  2. **Target** — asset picker XOR asset-type picker (mutex enforced in UI). Clickable row → dialog.
  3. **Schedule** — recurrence interval + unit + anchor date + lead days. Inline controls.
  4. **WO template** — title template, description template, priority, planned duration. Title/desc are textareas with `{{asset.name}}` token preview.
  5. **Routing** — request type picker, optional location override.
  6. **Operations** — list of recent generated WOs (max 10, with links), next due, last completed at.
  7. **Danger zone** — delete (soft if WOs exist, hard if none).

All forms use the `Field`/`FieldGroup` primitives per `CLAUDE.md` form composition rules. Toasts via `apps/web/src/lib/toast.ts`. AppError on the backend.

---

## 7. Migration sequence (v2)

1. `00386_maintenance_plans_schema.sql` — composite-FK preconditions (verify + add `unique (tenant_id, id)` on assets / asset_types / request_types / spaces if missing) + create `maintenance_plans` table + indexes + RLS.
2. `00387_work_orders_pm_columns.sql` — add `origin` + `maintenance_plan_id` + `source_asset_id` + composite tenant FKs + the v2 idempotency index (tenant + plan + asset + planned_start_at).
3. `00388_drop_legacy_maintenance_schedules.sql` — `drop table if exists public.maintenance_schedules cascade`. The seed-reset query in 00100 references this table; since 00100 is already applied, write a fresh follow-on migration that no-ops (the cascade has already cleaned up rows). Verify by grepping for any other live reference before pushing.
4. `00389_create_pm_work_order_rpc.sql` — the new PM-specific atomic RPC. Mirrors `00351_create_ticket_with_automation_v3.sql` shape but writes to `work_orders` + handles fan-out idempotency via `ON CONFLICT DO NOTHING`.
5. `00390_pm_completion_trigger.sql` — `tg_pm_plan_last_completed_at` AFTER UPDATE OF `resolved_at` on `work_orders`. Updates `maintenance_plans.last_completed_at` inline.

Each pushed via psql per `.claude/CLAUDE.md` fallback. `NOTIFY pgrst, 'reload schema';` after each.

---

## 8. Tests + smoke gate (v2 — codex-revised, expanded for direction errors)

**Unit:**
- `recurrence.spec.ts` — `advance_recurrence` math: day/week/month/year, month-end semantics, year leap-day.
- `maintenance-plan.service.spec.ts` — target mutex validation, next_run_at compute on create + update, soft-delete-vs-hard-delete branch, composite-FK validation (cross-tenant asset_id rejected).
- `pm-generator.service.spec.ts` — per-asset fan-out for asset_type plans, idempotency under double-run, system-actor stamping, audit `metadata.source='generator'`.

**Smoke probe (extend `apps/api/scripts/smoke-work-orders.mjs`) — five scenarios:**

1. **Single-asset spawn.** Seed: plan with asset_id, next_run_at = today, lead=7. Run generator. Assert: 1 WO appears with `origin='preventive'`, `maintenance_plan_id=plan.id`, `source_asset_id=asset.id`, `planned_start_at=plan.next_run_at`, audit `metadata.source='generator'`.

2. **Asset-type fan-out.** Seed: plan with asset_type_id, 3 assets of that type. Run generator. Assert: 3 WOs created, all with distinct `source_asset_id`, same planned_start_at. **This proves the v2 idempotency index correctly allows fan-out (the v1 index would have collapsed to 1 WO).**

3. **Plan advance.** After (2) runs, assert: `plan.next_run_at` advanced to `prev_next_run_at + recurrence_interval unit`, `last_generated_at = run_at`.

4. **Replay idempotency.** Run generator AGAIN at the same `run_at`. Assert: same 3 WOs (no duplicates). The next_run_at advanced after (2) means (3) selects nothing OR `ON CONFLICT DO NOTHING` fires — either is correct. **Direction-error guard: codex's vacuous-test concern (P0-3 timestamp bug pattern).**

5. **Completion hook.** Resolve one of the WOs (mint `resolved_at` via the actual transition_entity_status RPC). Assert: `plan.last_completed_at = wo.resolved_at`. **Confirms trigger fires inside transition_entity_status's transaction.**

6. **Replay after terminal.** Resolve another WO in (2)'s output. Run generator at `run_at + recurrence_unit` (next cycle). Assert: 3 fresh WOs at the NEW planned_start_at (the resolved WO doesn't block the new occurrence because the idempotency key includes planned_start_at).

7. **Cross-tenant isolation.** Insert a plan in tenant A. Run generator for tenant B. Assert: no WOs created in tenant B. Assert: composite FK rejects an asset_id pointing at tenant A from tenant B's plan.

Cleanup in `try/finally` so failed runs don't leave orphan WOs/plans.

**FE tests:**
- `maintenance-plans.test.tsx` — index page renders list, row click navigates.
- `maintenance-plan-detail.test.tsx` — auto-save works, target mutex enforced in UI (selecting asset clears asset_type and vice-versa), recurrence preview accurate.

---

## 9. Working pattern + stop conditions

Same pattern as the cleanup workstream:

1. **Chunk by phase:** schema → service → generator → controller → admin UI → tests.
2. **Gate after each chunk:** api tsc + tests + smoke; web tsc + tests.
3. **Commit per chunk** with HEREDOC explaining WHY.
4. **Full-review after backend complete.** Address findings.
5. **Codex review after FE complete.** Address findings.
6. **Stop when:** generator runs cleanly against the live DB + admin UI lets you create/edit a plan + smoke probe green.

**Defer if found during build:**
- Anything that would double the slice size (e.g., full RRULE migration mid-flight) → flag in commit body, leave for v1.5.
- Visual polish that isn't broken UX (e.g., colored badges per recurrence cadence) → backlog.

---

## 10. Codex pressure-test points

Codex: please review this plan BEFORE I write code. Specifically:

1. **Schema decisions:** is the `asset_id XOR asset_type_id` mutex the right shape, or should it be a join table (`maintenance_plan_assets`) from the start? What edge cases break the mutex?
2. **Recurrence:** is `{interval, unit, anchor_date}` enough for v1? What facilities-PM patterns does it MISS that would force a v1.5 emergency? (e.g., "every 1st Monday of the month" / "twice a year on specific dates")
3. **Idempotency index:** the partial unique index on `(maintenance_plan_id, planned_start_at) where status not in ('completed','cancelled')` — is the predicate stable enough? Status transitions in Postgres can fire the unique check at weird times.
4. **Generator iteration model:** single nightly cron iterating all tenants vs per-tenant cron. Cross-tenant blast radius if one tenant's plans throw?
5. **Routing-only assignment:** any case where a plan REQUIRES a specific assignee (e.g., certified-only HVAC tech for compliance) and routing can't express that? Or do existing routing rules cover all cases?
6. **WO completion hook:** updating `last_completed_at` inside the WO completion transaction — any deadlock risk against the generator's plan-update writes?
7. **Drop 00016 cleanly:** any references I missed (grep found 2)? Any risk to existing tenant seed data?
8. **Cron registration:** does the project already have a cron framework, or do I need to add one? (Memory says `WorkflowWaitSweeperCron` exists — verify the registration shape.)
9. **Admin permission:** new permission key `maintenance.admin` — any drift with the existing permission catalog?
10. **Test coverage:** what would I miss? Specifically — does the smoke probe genuinely exercise the generator's idempotency, or is there a vacuous-test risk like the P0-3 timestamp bug?

End with a verdict: "plan looks solid — proceed" / "plan needs adjustment in X / Y / Z — re-spec before coding" / specific changes.

---

That's the plan. Codex review next, then code.
