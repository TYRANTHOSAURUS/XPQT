-- 00264_visitor_search_trigram_indexes.sql
-- Visitor management v1 — search performance + denorm columns.
--
-- Slice 2 review Fix #3 (performance):
--   Reception search (reception.service.ts) and kiosk search
--   (kiosk.service.ts) both use pg_trgm.similarity() on
--   visitors.{first_name,last_name,company} and persons.{first_name,
--   last_name} (host name through primary_host_person_id). For 100s of
--   today's visitors per building this is fine on a seqscan, but for
--   10,000+ visitors (large multi-building tenant) the seqscan becomes
--   the bottleneck. GIN trigram indexes turn `similarity(col, q) > t`
--   into an index-served lookup.
--
-- BONUS — schema correctness:
--   Slice 2 service code (invitation.service.ts:116-120,
--   kiosk.service.ts:538-542, reception.service.ts:73-75) WRITES and
--   READS visitors.first_name / last_name / email / phone / company.
--   Migration 00252 added several v1 columns but NOT these — search
--   queries against the live DB would hit "column does not exist".
--   We add them here as nullable text columns (PII canonical on
--   persons; visitors carries denorm copies for fast list/search and
--   to keep email-cancel templates working without joining persons on
--   every render). Existing rows backfill from persons via a one-shot
--   UPDATE; new rows write both via app code (invitation.service +
--   kiosk.service already do this).
--
-- Persons trigram indexes already exist (00136_global_search.sql line
-- 40-44). Do NOT duplicate — host-name search reuses those.

-- ---------------------------------------------------------------------------
-- 1. Denorm columns on visitors (slice 2 schema gap discovered during
--    review — service code already writes them, the table just didn't
--    have them yet).
-- ---------------------------------------------------------------------------
alter table public.visitors
  add column if not exists first_name text,
  add column if not exists last_name  text,
  add column if not exists email      text,
  add column if not exists phone      text,
  add column if not exists company    text;

-- One-shot backfill from persons (canonical source). New rows write
-- both denorm + persons via app code; legacy rows get filled here.
-- Idempotent: only updates rows where the denorm column is still null.
update public.visitors v
   set first_name = p.first_name,
       last_name  = p.last_name,
       email      = p.email,
       phone      = p.phone
  from public.persons p
 where p.id = v.person_id
   and p.tenant_id = v.tenant_id
   and (v.first_name is null
     or v.last_name  is null
     or v.email      is null
     or v.phone      is null);

comment on column public.visitors.first_name is
  'Denormalized from persons.first_name (canonical). Maintained by app writes — kept in sync for fast search + email rendering without join.';
comment on column public.visitors.last_name is
  'Denormalized from persons.last_name. See first_name.';
comment on column public.visitors.email is
  'Denormalized from persons.email. Used as the email-cancel link target and as the fuzzy-search column.';
comment on column public.visitors.phone is
  'Denormalized from persons.phone. Optional; kiosk walk-up may set it without persons-side write.';
comment on column public.visitors.company is
  'Visitor''s organisation. Not on persons (employees use a different org-membership chain). Captured at invite/walk-up time.';

-- ---------------------------------------------------------------------------
-- 2. pg_trgm GIN indexes for fuzzy search.
--    pg_trgm extension was created in 00136; safe to assume present.
-- ---------------------------------------------------------------------------
create extension if not exists pg_trgm;

create index if not exists idx_visitors_first_name_trgm
  on public.visitors using gin (first_name gin_trgm_ops);

create index if not exists idx_visitors_last_name_trgm
  on public.visitors using gin (last_name gin_trgm_ops);

create index if not exists idx_visitors_company_trgm
  on public.visitors using gin (company gin_trgm_ops);

-- Persons first_name / last_name trigram indexes already exist as
-- idx_persons_first_name_trgm / idx_persons_last_name_trgm in
-- 00136_global_search.sql — do NOT recreate.

notify pgrst, 'reload schema';
