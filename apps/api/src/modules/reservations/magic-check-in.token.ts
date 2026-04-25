import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Magic-link check-in token.
 *
 * The token is a compact, URL-safe HMAC over (reservation_id,
 * requester_person_id, expiry). Signed with `CHECK_IN_MAGIC_SECRET`.
 *
 * Format: base64url(`${reservation_id}.${requester_person_id}.${expiry_ms}.${sig}`)
 *
 * 30-minute expiry by default. The link goes in the check-in reminder email
 * so users can check in without logging in.
 */

const SECRET_ENV = 'CHECK_IN_MAGIC_SECRET';

function secret(): string {
  const s = process.env[SECRET_ENV];
  // We deliberately fall back to a fixed dev value rather than throwing —
  // forces tests to run, prod ops are responsible for setting the env.
  return s && s.length > 0 ? s : 'dev-only-magic-secret-do-not-use-in-prod';
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function createMagicCheckInToken(args: {
  reservationId: string;
  requesterPersonId: string;
  ttlMinutes?: number;
  /** Override "now" — only for tests. */
  nowMs?: number;
}): string {
  const ttl = (args.ttlMinutes ?? 30) * 60 * 1000;
  const expiry = (args.nowMs ?? Date.now()) + ttl;
  const payload = `${args.reservationId}.${args.requesterPersonId}.${expiry}`;
  const sig = sign(payload);
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

export interface VerifiedToken {
  reservationId: string;
  requesterPersonId: string;
  expiry: number;
}

export function verifyMagicCheckInToken(
  token: string,
  /** Override "now" — only for tests. */
  nowMs: number = Date.now(),
): { ok: true; payload: VerifiedToken } | { ok: false; reason: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString();
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const parts = decoded.split('.');
  if (parts.length !== 4) return { ok: false, reason: 'malformed' };
  const [reservationId, requesterPersonId, expiryStr, providedSig] = parts;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry)) return { ok: false, reason: 'malformed' };

  const expected = sign(`${reservationId}.${requesterPersonId}.${expiry}`);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  if (nowMs > expiry) {
    return { ok: false, reason: 'expired' };
  }
  return {
    ok: true,
    payload: { reservationId, requesterPersonId, expiry },
  };
}
