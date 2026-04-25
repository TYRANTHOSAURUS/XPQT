-- 00131_pgcrypto.sql
-- Enable pgcrypto for symmetric encryption of OAuth tokens stored in
-- public.calendar_sync_links (calendar sync foundation, Phase H).
--
-- The TokenEncryptionService in apps/api/src/modules/calendar-sync/ uses
-- pgp_sym_encrypt/pgp_sym_decrypt via the two SQL functions below. The key
-- is supplied per-call from the API process env (CALENDAR_TOKEN_ENCRYPTION_KEY
-- or SUPABASE_VAULT_KEY) so it never lives in the database.
create extension if not exists pgcrypto;

-- Encrypt plaintext to a hex-encoded text blob suitable for storing in a
-- `text` column. SECURITY DEFINER + locked search_path so callers without
-- pgcrypto privileges still work; we trust the API to never pass the key
-- to untrusted code.
create or replace function public.calendar_sync_encrypt(p_plaintext text, p_key text)
returns text
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select encode(extensions.pgp_sym_encrypt(p_plaintext, p_key), 'hex');
$$;

create or replace function public.calendar_sync_decrypt(p_ciphertext text, p_key text)
returns text
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select extensions.pgp_sym_decrypt(decode(p_ciphertext, 'hex'), p_key);
$$;

revoke all on function public.calendar_sync_encrypt(text, text) from public;
revoke all on function public.calendar_sync_decrypt(text, text) from public;
grant execute on function public.calendar_sync_encrypt(text, text) to service_role;
grant execute on function public.calendar_sync_decrypt(text, text) to service_role;

notify pgrst, 'reload schema';
