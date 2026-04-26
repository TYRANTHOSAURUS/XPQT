-- 00146_approvals_scope_breakdown.sql
-- Per spec §4.4: approvals carry the scope of every entity they cover.
-- DB-enforced dedup: one pending row per (target, approver).
--
-- Why partial unique on status='pending' only: an approver who already
-- approved one bundle and gets pulled into a different bundle later should
-- get a fresh pending row; the previous 'approved'/'rejected' rows must not
-- block the new insert.

alter table public.approvals
  add column if not exists scope_breakdown jsonb not null default '{}'::jsonb;

-- Concurrent inserts surface as 23505; the bundle transaction's
-- SELECT-merge-UPDATE retry path handles them.
create unique index if not exists uq_approvals_pending_dedup
  on public.approvals (target_entity_id, approver_person_id)
  where status = 'pending';

notify pgrst, 'reload schema';
