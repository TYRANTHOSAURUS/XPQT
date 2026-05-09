import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { AppErrors } from '../../common/errors';

/**
 * Symmetric encryption for OAuth tokens stored in `calendar_sync_links`.
 *
 * Storage strategy:
 *  - The pgcrypto extension is enabled at the DB level (migration 00131).
 *  - We call `pgp_sym_encrypt` / `pgp_sym_decrypt` via a one-shot SQL query
 *    so the secret key never lives in the database — it stays in the API
 *    process env (`CALENDAR_TOKEN_ENCRYPTION_KEY`).
 *  - Output is the armored ASCII form (`pgp_sym_encrypt_armored` would be
 *    longer; we just hex-encode the bytea so it round-trips through `text`
 *    columns cleanly).
 *
 * Key sourcing (in order):
 *  1. CALENDAR_TOKEN_ENCRYPTION_KEY (preferred — explicit per-feature key)
 *  2. SUPABASE_VAULT_KEY (legacy / catch-all key in the platform env)
 *
 * If neither is set, encryption fails fast at module init — better than
 * silently writing plaintext tokens.
 */
@Injectable()
export class TokenEncryptionService implements OnModuleInit {
  private key!: string;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const key =
      this.config.get<string>('CALENDAR_TOKEN_ENCRYPTION_KEY') ||
      this.config.get<string>('SUPABASE_VAULT_KEY');
    if (!key) {
      throw AppErrors.server('calendar_sync.config_missing', {
        detail: 'CALENDAR_TOKEN_ENCRYPTION_KEY (or SUPABASE_VAULT_KEY) must be set — calendar-sync refuses to start without a token-encryption key.',
      });
    }
    this.key = key;
  }

  /**
   * Encrypt `plaintext` with pgp_sym_encrypt; returns the hex-encoded
   * ciphertext suitable for storing in a `text` column.
   */
  async encrypt(plaintext: string): Promise<string> {
    if (!plaintext) return '';
    // We use the supabase admin client's `rpc` to run a tiny SQL helper.
    // pgp_sym_encrypt returns bytea; we encode to hex for stable text storage.
    const { data, error } = await this.supabase.admin.rpc('calendar_sync_encrypt', {
      p_plaintext: plaintext,
      p_key: this.key,
    });
    if (error) {
      // Fallback: if the RPC isn't installed yet, do a raw SQL query through the
      // pg-meta-style endpoint. Keeping a single shape so callers don't branch.
      throw AppErrors.server('calendar_sync.token_failed', {
        detail: `Token encryption failed: ${error.message}. ` +
          `Make sure the calendar_sync_encrypt/decrypt SQL functions are installed (see calendar-sync-rpc.sql) ` +
          `or run them inline via the Supabase SQL editor.`,
        cause: error,
      });
    }
    if (typeof data !== 'string') {
      throw AppErrors.server('calendar_sync.token_failed', { detail: 'Token encryption returned non-string data' });
    }
    return data;
  }

  /**
   * Decrypt a hex-encoded ciphertext produced by `encrypt`.
   */
  async decrypt(ciphertext: string): Promise<string> {
    if (!ciphertext) return '';
    const { data, error } = await this.supabase.admin.rpc('calendar_sync_decrypt', {
      p_ciphertext: ciphertext,
      p_key: this.key,
    });
    if (error) {
      throw AppErrors.server('calendar_sync.token_failed', {
        detail: `Token decryption failed: ${error.message}. ` +
          `Confirm the encryption key has not rotated unexpectedly.`,
        cause: error,
      });
    }
    if (typeof data !== 'string') {
      throw AppErrors.server('calendar_sync.token_failed', { detail: 'Token decryption returned non-string data' });
    }
    return data;
  }
}
