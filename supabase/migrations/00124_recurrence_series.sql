-- 00124_recurrence_series.sql
-- Recurrence series metadata. Each occurrence is a separate `reservations` row,
-- linked via reservations.recurrence_series_id (already exists from 00014).

create table if not exists public.recurrence_series (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  recurrence_rule jsonb not null,                    -- {frequency, interval, by_day[], by_month_day, count, until}
  series_start_at timestamptz not null,
  series_end_at timestamptz,                         -- null = open-ended (capped by max_occurrences)
  max_occurrences int not null default 365,
  holiday_calendar_id uuid references public.business_hours_calendars(id),
  materialized_through timestamptz not null,         -- rolling window cap
  parent_reservation_id uuid references public.reservations(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.recurrence_series enable row level security;
drop policy if exists "tenant_isolation" on public.recurrence_series;
create policy "tenant_isolation" on public.recurrence_series
  using (tenant_id = public.current_tenant_id());

create index if not exists idx_recurrence_series_materialized
  on public.recurrence_series (tenant_id, materialized_through);

create trigger set_recurrence_series_updated_at before update on public.recurrence_series
  for each row execute function public.set_updated_at();

-- Add FK from reservations.recurrence_series_id (column exists from 00014)
alter table public.reservations
  drop constraint if exists reservations_recurrence_series_fk;
alter table public.reservations
  add constraint reservations_recurrence_series_fk
  foreign key (recurrence_series_id) references public.recurrence_series(id);

notify pgrst, 'reload schema';
