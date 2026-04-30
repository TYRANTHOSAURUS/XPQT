-- Step 0 of data-model-redesign-2026-04-30.md: polymorphic activities sidecar.
--
-- Why: ticket_activities is ticket-only. When step 1 extracts work_orders into
-- their own table, the audit timeline fragments unless activities is already a
-- polymorphic sidecar that addresses the parent by (entity_kind, entity_id).
--
-- This migration is purely additive:
--   1. Creates `public.activities` with the same column shape as ticket_activities
--      plus polymorphic addressing (entity_kind, entity_id) and source-of-truth
--      metadata for backfill idempotency.
--   2. Backfills every existing ticket_activities row as entity_kind='ticket'.
--   3. Installs a trigger that shadows every NEW ticket_activities insert into
--      activities. Existing service code does not need to change yet.
--
-- Future steps will:
--   - Step 1: drop the shadow trigger when work_orders has its own table and
--     services write to activities directly with entity_kind in {'case','work_order'}.
--   - Beyond: add booking / order / reservation activity sources.
--
-- Visibility: matches ticket_activities (tenant_isolation only). The API layer
-- gates reads via per-entity visibility services. We do NOT push entity-aware
-- visibility into RLS at this stage — branchy SQL would tank performance and we
-- don't yet have all sibling visibility functions in shape.

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  entity_kind text not null check (
    entity_kind in (
      'ticket',         -- legacy umbrella; split into case / work_order in step 1
      'case',
      'work_order',
      'booking',
      'reservation',
      'order',
      'service_order'
    )
  ),
  entity_id uuid not null,
  activity_type text not null check (
    activity_type in ('internal_note', 'external_comment', 'system_event')
  ),
  author_person_id uuid references public.persons(id),
  visibility text not null check (visibility in ('internal', 'external', 'system')),
  content text,
  attachments jsonb not null default '[]'::jsonb,
  metadata jsonb,
  -- Provenance for migration: which legacy table+row this activity originated from.
  -- Used for backfill idempotency and to identify shadow records during the dual-
  -- write window. After step 1 stable, new writes go straight into activities and
  -- source_* will be null on those rows.
  source_table text,
  source_id uuid,
  created_at timestamptz not null default now()
);

comment on table public.activities is
  'Polymorphic timeline. Replaces ticket_activities as the single source of truth across cases, work_orders, bookings, reservations, and service orders. Step 0 of docs/data-model-redesign-2026-04-30.md.';

comment on column public.activities.entity_kind is
  'Discriminator for polymorphic FK. ''ticket'' is a transitional value covering both case and work_order rows until step 1 lands.';

comment on column public.activities.source_table is
  'Migration provenance only. NULL once writes go directly to this table.';

alter table public.activities enable row level security;

create policy "tenant_isolation" on public.activities
  using (tenant_id = public.current_tenant_id());

-- Per-kind partial indexes for fast (entity_id, created_at) lookups. We pay
-- some write overhead for fast reads in the inevitable timeline UIs.
create index idx_activities_ticket on public.activities (entity_id, created_at desc)
  where entity_kind = 'ticket';
create index idx_activities_case on public.activities (entity_id, created_at desc)
  where entity_kind = 'case';
create index idx_activities_work_order on public.activities (entity_id, created_at desc)
  where entity_kind = 'work_order';
create index idx_activities_booking on public.activities (entity_id, created_at desc)
  where entity_kind = 'booking';
create index idx_activities_reservation on public.activities (entity_id, created_at desc)
  where entity_kind = 'reservation';
create index idx_activities_order on public.activities (entity_id, created_at desc)
  where entity_kind = 'order';
create index idx_activities_service_order on public.activities (entity_id, created_at desc)
  where entity_kind = 'service_order';

create index idx_activities_tenant_created on public.activities (tenant_id, created_at desc);

-- Idempotency for backfill + shadow writes. A single (source_table, source_id)
-- pair maps to at most one activity row.
create unique index uq_activities_source
  on public.activities (source_table, source_id)
  where source_id is not null;

-- Backfill: every existing ticket_activities row becomes an activity row with
-- entity_kind='ticket'. Idempotent because of uq_activities_source.
insert into public.activities (
  tenant_id,
  entity_kind,
  entity_id,
  activity_type,
  author_person_id,
  visibility,
  content,
  attachments,
  metadata,
  source_table,
  source_id,
  created_at
)
select
  ta.tenant_id,
  'ticket',
  ta.ticket_id,
  ta.activity_type,
  ta.author_person_id,
  ta.visibility,
  ta.content,
  coalesce(ta.attachments, '[]'::jsonb),
  ta.metadata,
  'ticket_activities',
  ta.id,
  ta.created_at
from public.ticket_activities ta
on conflict (source_table, source_id) where source_id is not null do nothing;

-- Shadow trigger: keep activities in sync with ticket_activities going forward.
-- Removed in step 1 once services write to activities directly.
create or replace function public.shadow_ticket_activity_to_activities()
returns trigger
language plpgsql
as $$
begin
  insert into public.activities (
    tenant_id,
    entity_kind,
    entity_id,
    activity_type,
    author_person_id,
    visibility,
    content,
    attachments,
    metadata,
    source_table,
    source_id,
    created_at
  ) values (
    new.tenant_id,
    'ticket',
    new.ticket_id,
    new.activity_type,
    new.author_person_id,
    new.visibility,
    new.content,
    coalesce(new.attachments, '[]'::jsonb),
    new.metadata,
    'ticket_activities',
    new.id,
    new.created_at
  )
  on conflict (source_table, source_id) where source_id is not null do nothing;
  return new;
end;
$$;

create trigger trg_ticket_activities_shadow
after insert on public.ticket_activities
for each row execute function public.shadow_ticket_activity_to_activities();

comment on function public.shadow_ticket_activity_to_activities() is
  'Step 0 dual-write shim. Drop in step 1 when ticket.service.ts and sla.service.ts write to activities directly.';

notify pgrst, 'reload schema';
