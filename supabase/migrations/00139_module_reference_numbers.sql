-- 00139_module_reference_numbers.sql
-- Per-tenant, per-module human-readable reference numbers (TKT-1234, WO-1234, RES-1234).
--
-- Why
--   UUIDs are unspeakable. Tickets, work orders, and reservations all need
--   stable, short, scannable IDs for use in URLs, email subjects, Slack
--   messages, vendor portals, and audit logs. The number lives alongside the
--   UUID — UUID stays the primary key; module_number is the rendered
--   reference. Modules are platform-defined identity dimensions (TKT for
--   cases, WO for work orders, RES for reservations); request_type stays a
--   separate metadata layer because it can change via reclassification.
--
-- Counter scope
--   Per (tenant_id, module). Cases (TKT), work orders (WO), and reservations
--   (RES) each start at #1 per tenant and grow independently.
--
-- Allocation strategy
--   BEFORE INSERT trigger calls allocate_module_number() when module_number
--   is NULL. Every insert path (TicketService, BookingFlowService,
--   RecurrenceService, calendar-sync intercept, webhook ingest, future
--   importers) gets numbering for free without app code changes.
--
-- Concurrency / gaps
--   allocate_module_number() uses INSERT ... ON CONFLICT for first-time
--   allocation and UPDATE ... RETURNING for subsequent. The per-row lock on
--   tenant_sequences is held only for the bump, so contention is minimal.
--   Aborted transactions consume a number (same behaviour as Linear/Jira) —
--   we deliberately accept gaps in exchange for trivial concurrent semantics.

-- ── 1. Tenant sequence table ─────────────────────────────────────
create table if not exists public.tenant_sequences (
  tenant_id   uuid   not null references public.tenants(id) on delete cascade,
  module      text   not null check (module ~ '^[A-Z]{2,4}$'),
  next_number bigint not null default 1 check (next_number > 0),
  primary key (tenant_id, module)
);

comment on table public.tenant_sequences is
  'Per-(tenant, module) monotonic counter for human-readable entity refs (TKT-1234, WO-1234, RES-1234). Allocated atomically by allocate_module_number().';

-- RLS on but no policy: only security-definer functions touch this table.
-- End users never read or write counters directly. Deny-all for everyone
-- else is the correct posture.
alter table public.tenant_sequences enable row level security;

-- ── 2. Allocator function ─────────────────────────────────────────
create or replace function public.allocate_module_number(
  p_tenant_id uuid,
  p_module    text
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n bigint;
begin
  -- First-time allocation for this (tenant, module): insert with
  -- next_number = 2 and return 1. Concurrent inserters race; the loser
  -- falls through to the UPDATE below.
  insert into public.tenant_sequences (tenant_id, module, next_number)
  values (p_tenant_id, p_module, 2)
  on conflict (tenant_id, module) do nothing
  returning 1 into v_n;

  if v_n is not null then
    return v_n;
  end if;

  -- Existing row: bump and return the previous value. UPDATE ... RETURNING
  -- is atomic at the row level.
  update public.tenant_sequences
     set next_number = next_number + 1
   where tenant_id = p_tenant_id and module = p_module
   returning next_number - 1 into v_n;

  return v_n;
end;
$$;

comment on function public.allocate_module_number(uuid, text) is
  'Atomically allocates the next reference number for a (tenant, module) pair. Called by BEFORE INSERT triggers on tickets and reservations.';

grant execute on function public.allocate_module_number(uuid, text)
  to authenticated, service_role;

-- ── 3. tickets.module_number ─────────────────────────────────────
alter table public.tickets
  add column if not exists module_number bigint;

-- Backfill cases and work orders independently, in created_at order.
-- TKT and WO each start at #1 per tenant.
update public.tickets t
   set module_number = numbered.n
  from (
    select id,
           row_number() over (
             partition by tenant_id, ticket_kind
             order by created_at, id
           ) as n
      from public.tickets
  ) numbered
 where t.id = numbered.id
   and t.module_number is null;

-- Seed tenant_sequences past the backfilled max for both kinds.
-- greatest() guards against re-running where a counter has already advanced.
insert into public.tenant_sequences (tenant_id, module, next_number)
select tenant_id,
       case ticket_kind when 'case' then 'TKT' else 'WO' end as module,
       max(module_number) + 1 as next_number
  from public.tickets
 group by tenant_id, ticket_kind
on conflict (tenant_id, module) do update
  set next_number = greatest(public.tenant_sequences.next_number, excluded.next_number);

alter table public.tickets
  alter column module_number set not null;

create unique index if not exists tickets_tenant_kind_module_number_uniq
  on public.tickets (tenant_id, ticket_kind, module_number);

create or replace function public.tickets_assign_module_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.module_number is null then
    new.module_number := public.allocate_module_number(
      new.tenant_id,
      case new.ticket_kind when 'case' then 'TKT' else 'WO' end
    );
  end if;
  return new;
end;
$$;

drop trigger if exists tickets_assign_module_number_trg on public.tickets;
create trigger tickets_assign_module_number_trg
  before insert on public.tickets
  for each row execute function public.tickets_assign_module_number();

-- ── 4. reservations.module_number ────────────────────────────────
alter table public.reservations
  add column if not exists module_number bigint;

update public.reservations r
   set module_number = numbered.n
  from (
    select id,
           row_number() over (
             partition by tenant_id
             order by created_at, id
           ) as n
      from public.reservations
  ) numbered
 where r.id = numbered.id
   and r.module_number is null;

insert into public.tenant_sequences (tenant_id, module, next_number)
select tenant_id, 'RES', max(module_number) + 1
  from public.reservations
 group by tenant_id
on conflict (tenant_id, module) do update
  set next_number = greatest(public.tenant_sequences.next_number, excluded.next_number);

alter table public.reservations
  alter column module_number set not null;

create unique index if not exists reservations_tenant_module_number_uniq
  on public.reservations (tenant_id, module_number);

create or replace function public.reservations_assign_module_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.module_number is null then
    new.module_number := public.allocate_module_number(new.tenant_id, 'RES');
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_assign_module_number_trg on public.reservations;
create trigger reservations_assign_module_number_trg
  before insert on public.reservations
  for each row execute function public.reservations_assign_module_number();

-- ── 5. Reload PostgREST schema cache ─────────────────────────────
notify pgrst, 'reload schema';
