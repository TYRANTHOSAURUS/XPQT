-- 00250_visit_invitation_tokens.sql
-- Visitor Management v1 — invitation tokens (cancel link + future QR).
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.6
--
-- Tokens are looked up by hash (sha256), never by plaintext. The plaintext
-- is delivered to the visitor in the invite email and discarded by the
-- server after issuance. Validation goes through the SECURITY DEFINER
-- function in 00256 — anonymous callers (cancel-link clicks from email)
-- never SELECT this table directly.

create table public.visit_invitation_tokens (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid not null references public.visitors(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  token_hash text not null unique,                                  -- sha256(token); raw token never stored
  purpose    text not null check (purpose in ('cancel','qr')),
  expires_at timestamptz not null,
  used_at    timestamptz,                                            -- single-use enforcement
  created_at timestamptz not null default now()
);

-- Composite FK with tenant alignment (B1).
alter table public.visit_invitation_tokens
  add constraint vit_visitor_fk
    foreign key (tenant_id, visitor_id) references public.visitors(tenant_id, id);

alter table public.visit_invitation_tokens enable row level security;

-- service_role only — anonymous lookups MUST go through validate_invitation_token().
drop policy if exists tenant_isolation on public.visit_invitation_tokens;
create policy "visit_invitation_tokens_select" on public.visit_invitation_tokens
  for select using (tenant_id = public.current_tenant_id());
create policy "visit_invitation_tokens_insert" on public.visit_invitation_tokens
  for insert with check (tenant_id = public.current_tenant_id());
create policy "visit_invitation_tokens_update" on public.visit_invitation_tokens
  for update
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

revoke all on public.visit_invitation_tokens from public, anon, authenticated;
grant select, insert, update on public.visit_invitation_tokens to service_role;

create index idx_vit_token on public.visit_invitation_tokens (token_hash);
create index idx_vit_expiry on public.visit_invitation_tokens (expires_at) where used_at is null;
create index idx_vit_visitor on public.visit_invitation_tokens (tenant_id, visitor_id);

comment on table public.visit_invitation_tokens is
  'Single-use tokens for visitor cancel links + future QR check-in. Validation runs through validate_invitation_token() (SECURITY DEFINER); never queried directly by anon. See visitor-management-v1-design.md §4.6.';

notify pgrst, 'reload schema';
