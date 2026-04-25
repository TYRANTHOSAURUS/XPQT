import { TokenEncryptionService } from '../token-encryption.service';

/**
 * Round-trip test using a stubbed Supabase admin client. We don't need real
 * pgcrypto here — the service's contract is "RPC call wraps a string and
 * returns a string." The stub asserts the contract holds.
 */
describe('TokenEncryptionService', () => {
  let stored: string | undefined;

  const supabaseStub = {
    admin: {
      rpc: jest.fn(async (fn: string, args: { p_plaintext?: string; p_ciphertext?: string; p_key: string }) => {
        if (fn === 'calendar_sync_encrypt') {
          // simulate hex-encoded ciphertext: base64 of "key|plaintext"
          stored = Buffer.from(`${args.p_key}|${args.p_plaintext}`, 'utf8').toString('hex');
          return { data: stored, error: null };
        }
        if (fn === 'calendar_sync_decrypt') {
          if (!args.p_ciphertext) return { data: '', error: null };
          const decoded = Buffer.from(args.p_ciphertext, 'hex').toString('utf8');
          const [k, ...rest] = decoded.split('|');
          if (k !== args.p_key) return { data: null, error: { message: 'wrong key' } };
          return { data: rest.join('|'), error: null };
        }
        return { data: null, error: { message: `unknown rpc ${fn}` } };
      }),
    },
  } as never;

  const configStub = {
    get: (k: string) => (k === 'CALENDAR_TOKEN_ENCRYPTION_KEY' ? 'super-secret' : undefined),
  } as never;

  it('round-trips a plaintext token', async () => {
    const svc = new TokenEncryptionService(supabaseStub, configStub);
    svc.onModuleInit();
    const encrypted = await svc.encrypt('refresh-token-xyz');
    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toContain('refresh-token-xyz');
    const decrypted = await svc.decrypt(encrypted);
    expect(decrypted).toBe('refresh-token-xyz');
  });

  it('returns empty string for empty input on encrypt + decrypt', async () => {
    const svc = new TokenEncryptionService(supabaseStub, configStub);
    svc.onModuleInit();
    expect(await svc.encrypt('')).toBe('');
    expect(await svc.decrypt('')).toBe('');
  });

  it('throws if neither CALENDAR_TOKEN_ENCRYPTION_KEY nor SUPABASE_VAULT_KEY is set', () => {
    const svc = new TokenEncryptionService(supabaseStub, { get: () => undefined } as never);
    expect(() => svc.onModuleInit()).toThrow(/CALENDAR_TOKEN_ENCRYPTION_KEY/);
  });
});
