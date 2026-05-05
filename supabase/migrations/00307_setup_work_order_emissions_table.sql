-- B.0.A.6 — setup_work_order_emissions table (handler-side dedup).
--
-- Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §2.5
-- (NEW in v6; v7 fixed FK target; v8-I4 ON DELETE SET NULL with tombstone
-- semantics).
--
-- Handler-side durable dedup so re-handling the same setup_work_order
-- .create_required outbox event is a no-op. Primary key (tenant_id, oli_id)
-- — at most one setup WO is emitted per OLI for the lifetime of the row.
--
-- This table does NOT exist on remote yet; v6 specced it but no migration
-- shipped. Created here from scratch with the v8.1 contract.
--
-- v7-I3: FK is to public.work_orders(id), NOT public.tickets(id). The
-- rewrite collapsed tickets into work_orders for booking-origin work
-- (00288); TicketService.createBookingOriginWorkOrder writes to
-- public.work_orders directly (ticket.service.ts:1903). v6's tickets(id)
-- FK would have raised 23503 on the first INSERT.
--
-- v8-I4: FK is `ON DELETE SET NULL`, NOT `ON DELETE CASCADE`. Rationale:
-- the dedup row's "this OLI was already handled" signal MUST survive an
-- admin WO deletion. v7 used CASCADE, which meant a WO admin-cleanup
-- cascaded the dedup row away, allowing a replayed event to recreate the
-- WO — exactly the failure mode the dedup table was designed to prevent.
-- v8 contract: a row with `work_order_id IS NULL` is a TOMBSTONE meaning
-- "this OLI's setup-WO was created and later deleted by admin". The
-- handler treats tombstones as already_handled (idempotent no-op). To
-- explicitly reset setup-WO creation for an OLI, admins DELETE the
-- dedup row (see spec §2.5 admin runbook).

create table if not exists public.setup_work_order_emissions (
  tenant_id        uuid        not null references public.tenants(id) on delete cascade,
  oli_id           uuid        not null,
  -- v7-I3: was tickets(id) in v6. v8-I4: ON DELETE SET NULL preserves the
  -- dedup signal as a TOMBSTONE when an admin deletes the WO. Nullable to
  -- support tombstones.
  work_order_id    uuid        references public.work_orders(id) on delete set null,
  outbox_event_id  uuid        not null,                -- audit pointer; fk soft to outbox.events
  created_at       timestamptz not null default now(),
  primary key (tenant_id, oli_id)
);

create index if not exists setup_work_order_emissions_wo
  on public.setup_work_order_emissions (work_order_id);

alter table public.setup_work_order_emissions enable row level security;

drop policy if exists tenant_isolation on public.setup_work_order_emissions;
create policy tenant_isolation on public.setup_work_order_emissions
  using (tenant_id = public.current_tenant_id());

revoke all on table public.setup_work_order_emissions from public;
grant select, insert, update, delete on table public.setup_work_order_emissions to service_role;

comment on table public.setup_work_order_emissions is
  'Handler-side dedup for setup_work_order.create_required outbox events (§2.5 / §7.8 of the outbox spec). Primary key (tenant_id, oli_id) — at most one setup WO is emitted per OLI for the lifetime of the row. v7: rows are inserted by create_setup_work_order_from_event RPC in the SAME tx as the work_orders insert (atomic). v8: FK to work_orders is ON DELETE SET NULL (was CASCADE in v7) so the dedup signal survives admin WO cleanup. Survives WO close/cancel/delete and event replay; admins reset by DELETE-ing the dedup row.';
comment on column public.setup_work_order_emissions.work_order_id is
  'NULL = tombstone (WO was created and later deleted by admin). The handler treats tombstones as already_handled. To re-allow setup-WO creation for an OLI, admins DELETE the dedup row.';
