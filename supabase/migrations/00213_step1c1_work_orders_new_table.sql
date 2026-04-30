-- Step 1c.1 of docs/data-model-step1c-plan.md: create work_orders_new as a
-- real table mirroring the work_order subset of tickets.
--
-- This is the first DDL of the step 1c migration. It is purely additive:
-- creates a new table, no existing object is modified. Subsequent phases
-- will:
--   1c.2 — backfill from tickets
--   1c.3 — install forward shadow trigger (tickets → work_orders_new)
--   1c.3.5 — install reverse shadow trigger (work_orders_new → tickets)
--   1c.3.6 — atomic rename: existing public.work_orders view → legacy alias,
--            this table → public.work_orders
--   1c.4 — flip writers
--
-- Naming: `_new` suffix during the bridge so the existing public.work_orders
-- view continues working untouched. At phase 1c.10c the suffix is dropped.
--
-- Schema mirrors the union of all current tickets columns relevant to the
-- work_order subset, plus a `legacy_ticket_id` reverse pointer used only
-- during the bridge (dropped at 1c.10c).

create table public.work_orders_new (
  -- Reuse the source ticket UUID. Phase 1c.2 backfill copies tickets.id
  -- into here verbatim, which preserves any external FK that points at
  -- the work-order's UUID. Cheap migration vs cleaner ID semantics —
  -- per docs/data-model-step1c-plan.md "Open Q1 RESOLVED."
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  ticket_type_id uuid references public.request_types(id),

  -- Polymorphic parent. During the bridge the discriminator is the
  -- bridge enum: 'case' | 'booking_bundle'. Step 4+ extends to line-level
  -- parents.
  parent_kind text check (parent_kind in ('case','booking_bundle')),
  parent_case_id uuid references public.tickets(id),  -- bridge name; renamed at step 6
  booking_bundle_id uuid references public.booking_bundles(id) on delete set null,
  -- Mutual exclusion: at most one parent link, mirroring 00208's
  -- work_order_single_parent on tickets.
  constraint work_orders_new_single_parent
    check (parent_case_id is null or booking_bundle_id is null),
  -- parent_kind must agree with which FK is set (or both null = orphan WO).
  constraint work_orders_new_kind_matches_fk
    check (
      (parent_kind is null     and parent_case_id is null and booking_bundle_id is null)
      or (parent_kind = 'case'           and parent_case_id is not null and booking_bundle_id is null)
      or (parent_kind = 'booking_bundle' and parent_case_id is null     and booking_bundle_id is not null)
    ),

  -- Header
  title text not null,
  description text,
  status text not null default 'new',
  status_category text not null default 'new'
    check (status_category in ('new','assigned','in_progress','waiting','resolved','closed')),
  waiting_reason text check (waiting_reason in ('requester','vendor','approval','scheduled_work','other')),
  interaction_mode text not null default 'internal' check (interaction_mode in ('internal','external')),
  priority text not null default 'medium',
  impact text,
  urgency text,

  -- Requester / actor (booking-origin WOs intentionally have no requester
  -- to avoid leaking via portal — see ticket.service.ts:1499)
  requester_person_id uuid references public.persons(id),
  requested_for_person_id uuid references public.persons(id),

  -- Scope
  location_id uuid references public.spaces(id),
  asset_id uuid references public.assets(id),

  -- Assignment
  assigned_team_id uuid references public.teams(id),
  assigned_user_id uuid references public.users(id),
  assigned_vendor_id uuid,  -- FK to vendors(id), enforced via cross-tenant defensive JOIN at read-time

  -- Process
  workflow_id uuid references public.workflow_definitions(id),
  sla_id uuid references public.sla_policies(id),

  -- Bookkeeping
  source_channel text default 'portal',
  tags text[] default '{}',
  watchers uuid[] default '{}',
  cost numeric(12,2),
  satisfaction_rating smallint check (satisfaction_rating between 1 and 5),
  satisfaction_comment text,
  form_data jsonb,

  -- Computed SLA fields (mirror tickets.sla_*)
  sla_response_due_at timestamptz,
  sla_resolution_due_at timestamptz,
  sla_response_breached_at timestamptz,
  sla_resolution_breached_at timestamptz,
  sla_at_risk boolean not null default false,
  sla_paused boolean not null default false,
  sla_paused_at timestamptz,
  sla_total_paused_minutes integer not null default 0,

  -- Reference number (mirror tickets.module_number — WO prefix)
  module_number bigint,

  -- External-system pointer (inbound webhook integration)
  external_system text,
  external_id text,

  -- Order line link (slice 2 booking-origin WO ↔ order line)
  linked_order_line_item_id uuid,

  -- Planned schedule (00206)
  planned_start_at timestamptz,
  planned_duration_minutes integer,

  -- Reclassify trail (mirror tickets.reclassified_*)
  reclassified_at timestamptz,
  reclassified_from_id uuid,
  reclassified_reason text,
  reclassified_by uuid references public.users(id),

  -- Close trail
  close_reason text,
  closed_by uuid references public.users(id),

  -- Timestamps
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  closed_at timestamptz,

  -- Bridge: reverse pointer back to the source tickets row. Dropped at
  -- phase 1c.10c. UNIQUE so dual-write is idempotent.
  legacy_ticket_id uuid unique references public.tickets(id) on delete set null
);

comment on table public.work_orders_new is
  'Step 1c.1 (00213) of docs/data-model-step1c-plan.md. Real table that will replace public.work_orders view at phase 1c.3.6 (atomic rename). Backfill in 1c.2; dual-write trigger in 1c.3. Direct API access revoked; service-role only.';

comment on column public.work_orders_new.parent_kind is
  'Discriminator. Bridge values: case | booking_bundle. End-state at step 4+ extends to line-level parents.';

comment on column public.work_orders_new.legacy_ticket_id is
  'Reverse pointer to source tickets row. Used only during the dual-write bridge (1c.3 through 1c.10b). Dropped at 1c.10c.';

-- ── RLS + grants ──────────────────────────────────────────────
alter table public.work_orders_new enable row level security;

create policy "tenant_isolation" on public.work_orders_new
  using (tenant_id = public.current_tenant_id());

revoke all on public.work_orders_new from anon, authenticated, public;
grant select, insert, update, delete on public.work_orders_new to service_role;
revoke truncate, references, trigger on public.work_orders_new from service_role;

-- ── Indexes (mirror tickets hot-paths for the work_order subset) ──
create index idx_won_queue_primary
  on public.work_orders_new (tenant_id, status_category, assigned_team_id, priority);
create index idx_won_queue_location
  on public.work_orders_new (tenant_id, assigned_team_id, location_id, status_category);
create index idx_won_queue_sla
  on public.work_orders_new (tenant_id, sla_at_risk, sla_resolution_due_at)
  where status_category not in ('resolved','closed');
create index idx_won_assigned_user
  on public.work_orders_new (assigned_user_id) where assigned_user_id is not null;
create index idx_won_assigned_user_tenant
  on public.work_orders_new (tenant_id, assigned_user_id);
create index idx_won_assigned_vendor
  on public.work_orders_new (assigned_vendor_id) where assigned_vendor_id is not null;
create index idx_won_parent_case
  on public.work_orders_new (parent_case_id) where parent_case_id is not null;
create index idx_won_bundle
  on public.work_orders_new (booking_bundle_id) where booking_bundle_id is not null;
create index idx_won_oli
  on public.work_orders_new (linked_order_line_item_id) where linked_order_line_item_id is not null;
create index idx_won_legacy_ticket
  on public.work_orders_new (legacy_ticket_id) where legacy_ticket_id is not null;
create index idx_won_tenant_created
  on public.work_orders_new (tenant_id, created_at desc);

create trigger set_work_orders_new_updated_at
  before update on public.work_orders_new
  for each row execute function public.set_updated_at();

notify pgrst, 'reload schema';
