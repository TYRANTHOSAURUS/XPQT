-- 00079_drop_persons_division_department.sql
-- Source of truth for a person's department is now person_org_memberships.
-- Test data only — no backfill (per spec §3.5).

alter table public.persons drop column if exists division;
alter table public.persons drop column if exists department;
