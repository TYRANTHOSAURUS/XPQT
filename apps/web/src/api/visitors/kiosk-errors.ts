/**
 * Backend → kiosk-friendly error mapping.
 *
 * Each kiosk surface (QR scan, name fallback, walk-up) had its own copy of
 * a `mapBackendError` function with overlapping rules. This module
 * consolidates them so the visitor-facing copy is consistent + easy to
 * iterate.
 *
 * The `kind` argument lets each surface tweak the fallback (e.g. the QR
 * surface offers "type your name", the name surface offers "see reception",
 * the walk-up offers "ask reception").
 */
import { ApiError } from '@/lib/api';

export type KioskErrorKind = 'qr' | 'name' | 'walkup';

export interface MappedKioskError {
  title: string;
  message: string;
}

/** Map a backend error into a visitor-friendly title + body. The `kind`
 *  controls which surface-specific cases are recognized AND the fallback
 *  copy when nothing matches. */
export function mapBackendError(
  err: unknown,
  kind: KioskErrorKind,
): MappedKioskError {
  if (err instanceof ApiError) {
    // Cross-surface case: the visit is anchored to a different building.
    if (err.status === 400 && /different building/i.test(err.message)) {
      return {
        title: 'This visit is for a different building',
        message: 'Please see reception — they can help redirect you.',
      };
    }

    if (kind === 'qr') {
      if (err.status === 401) {
        return {
          title: "We don't recognize that QR code",
          message: 'Please ask reception, or type your name to continue.',
        };
      }
      if (err.status === 403 && /already/i.test(err.message)) {
        return {
          title: 'This QR has already been used',
          message: 'Please see reception so they can help you check in.',
        };
      }
      if (err.status === 403 && /expired/i.test(err.message)) {
        return {
          title: 'This invitation has expired',
          message: 'Ask your host to send you a fresh invitation.',
        };
      }
    }

    if (kind === 'name') {
      if (err.status === 403 && /host first name/i.test(err.message)) {
        return {
          title: "That doesn't match",
          message:
            "The host's first name we have doesn't match. Please ask reception or try again.",
        };
      }
    }

    if (kind === 'walkup') {
      if (
        err.status === 400 &&
        /walk_up_disabled|approval_required/i.test(err.message)
      ) {
        return {
          title: 'Self check-in is not available for this type',
          message: 'Please see reception so they can help you check in.',
        };
      }
      if (err.status === 404 && /host/i.test(err.message)) {
        return {
          title: 'Host not found',
          message: 'Please double-check the host you picked, or see reception.',
        };
      }
    }
  }

  // Surface-aware fallbacks.
  if (kind === 'qr') {
    return {
      title: "Something didn't go through",
      message: 'Please see reception, or type your name to continue.',
    };
  }
  if (kind === 'walkup') {
    return {
      title: "Couldn't check you in",
      message: 'Please see reception so they can help.',
    };
  }
  // 'name'
  return {
    title: "Couldn't check you in",
    message: 'Please see reception so they can help.',
  };
}
