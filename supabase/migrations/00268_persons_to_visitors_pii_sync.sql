-- 00268_persons_to_visitors_pii_sync.sql
-- Visitor management v1 — keep visitors.{first_name,last_name,email,phone}
-- in sync with persons.{first_name,last_name,email,phone} after writes.
--
-- Post-shipping review C5:
--   00264 added denorm PII columns to visitors with the comment
--     "Maintained by app writes — kept in sync for fast search + email
--      rendering without join."
--   But there was no enforcement. App writes happen on invite + walk-up
--   only. When the canonical persons row is later updated (rename,
--   email correction, anonymization), the visitors-side denorm goes stale.
--   Worst case: PersonsAdapter.anonymize() blanks persons.first_name to
--   "Former employee" + persons.email to NULL, but visitors keeps the
--   original first_name and email forever — GDPR erasure escapes through
--   the denorm.
--
-- Fix:
--   AFTER UPDATE trigger on persons that fans the four PII fields
--   (first_name, last_name, email, phone) out to all visitors with that
--   person_id when any of them changes. Idempotent: only updates rows
--   that actually differ. Tenant-scoped: every visitor row carries its
--   own tenant_id and the trigger filters on it.
--
-- A one-shot UPDATE backfills any current divergence (e.g. a person
-- whose name was edited via /admin/users between 00264 shipping and now).
--
-- company is NOT synced — visitors.company is the visitor's organisation,
-- not the persons row's employer. No persons-side source of truth exists
-- for it. App writes still own that field.
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §3, §4.1.
-- Reviewer: post-shipping codex review (C5).

-- ---------------------------------------------------------------------------
-- 1. Trigger function. Runs AFTER UPDATE OF first_name | last_name | email | phone
--    on persons. Updates the matching visitors rows in the same tenant.
--    No-op if none of the four columns changed (the trigger only fires for
--    those columns thanks to the WHEN clause below).
-- ---------------------------------------------------------------------------
create or replace function public.sync_persons_pii_to_visitors()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Cheap-skip: if every PII field is unchanged, nothing to do.
  if new.first_name is not distinct from old.first_name
     and new.last_name is not distinct from old.last_name
     and new.email     is not distinct from old.email
     and new.phone     is not distinct from old.phone then
    return new;
  end if;

  update public.visitors v
     set first_name = new.first_name,
         last_name  = new.last_name,
         email      = new.email,
         phone      = new.phone
   where v.tenant_id  = new.tenant_id
     and v.person_id  = new.id
     and (v.first_name is distinct from new.first_name
       or v.last_name  is distinct from new.last_name
       or v.email      is distinct from new.email
       or v.phone      is distinct from new.phone);

  return new;
end;
$$;

comment on function public.sync_persons_pii_to_visitors() is
  'Visitor management v1 (00268): keep visitors.{first_name,last_name,email,phone} '
  'in sync with the canonical persons row. Fires AFTER UPDATE OF the four PII '
  'columns. Critical for GDPR erasure: when PersonsAdapter blanks persons.first_name '
  'to "Former employee", every linked visitors row is anonymized in the same '
  'transaction. company is NOT synced (no persons-side source).';

drop trigger if exists trg_sync_persons_pii_to_visitors on public.persons;
create trigger trg_sync_persons_pii_to_visitors
  after update of first_name, last_name, email, phone on public.persons
  for each row
  execute function public.sync_persons_pii_to_visitors();

-- ---------------------------------------------------------------------------
-- 2. One-shot backfill: re-sync any visitor row whose denorm has drifted
--    from the canonical persons row. Idempotent — only writes rows that
--    actually differ.
-- ---------------------------------------------------------------------------
update public.visitors v
   set first_name = p.first_name,
       last_name  = p.last_name,
       email      = p.email,
       phone      = p.phone
  from public.persons p
 where p.id = v.person_id
   and p.tenant_id = v.tenant_id
   and (v.first_name is distinct from p.first_name
     or v.last_name  is distinct from p.last_name
     or v.email      is distinct from p.email
     or v.phone      is distinct from p.phone);

notify pgrst, 'reload schema';
