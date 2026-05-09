/**
 * Locale selector for error messages — Phase 7.B-3.
 *
 * Picks the active locale (`en` | `nl`) and dispatches `resolveMessage` to
 * the matching catalog. v1 default: `en`. The user's choice is read from
 * `localStorage.getItem('locale')` (last-write-wins) with a fallback to the
 * `<html lang>` attribute or `navigator.language`. Future tenant-level
 * preferences slot in here.
 *
 * Voice + coverage rules live with the per-locale catalogs
 * (`messages.en.ts`, `messages.nl.ts`); this module is glue.
 *
 * Spec: docs/superpowers/specs/2026-05-02-error-handling-system-design.md §6.5
 */

import {
  ERROR_MESSAGES_EN,
  resolveMessage as resolveEn,
  type ErrorMessage,
  type Surface,
} from './messages.en';
import { ERROR_MESSAGES_NL, resolveMessageNl as resolveNl } from './messages.nl';

export type Locale = 'en' | 'nl';

const LOCALE_STORAGE_KEY = 'locale';

/**
 * Resolve the active locale from (in order):
 *   1. `localStorage.getItem('locale')` — explicit user choice.
 *   2. `<html lang>` attribute — set by the host shell when known.
 *   3. `navigator.language` — browser default.
 *   4. Fallback: `'en'`.
 *
 * Always returns a registered locale; unknown values fall back to `'en'`.
 */
export function pickLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === 'nl') return 'nl';
    if (stored === 'en') return 'en';
  } catch {
    // Private mode / blocked storage — fall through to lang detection.
  }
  const lang = (
    (typeof document !== 'undefined' && document.documentElement.lang) ||
    (typeof navigator !== 'undefined' && navigator.language) ||
    'en'
  )
    .slice(0, 2)
    .toLowerCase();
  return lang === 'nl' ? 'nl' : 'en';
}

/**
 * Resolve a localized error message. Defaults the `locale` arg to the
 * current pickLocale() so callers don't need to thread it through, but
 * accepting an override keeps tests deterministic.
 *
 * Falls back to `unknown.server_error` in the picked locale for
 * unregistered codes (fail-closed per spec §3.4 / decision #9).
 */
export function resolveMessage(
  code: string,
  surfaceOrLocale?: Surface | Locale,
  locale?: Locale,
): { title: string; detail?: string } {
  // Two call shapes are supported:
  //   resolveMessage('booking.slot_conflict')
  //   resolveMessage('booking.slot_conflict', 'toast')
  //   resolveMessage('booking.slot_conflict', 'toast', 'nl')
  //   resolveMessage('booking.slot_conflict', 'nl')        ← convenience
  let surface: Surface | undefined;
  let activeLocale: Locale;
  if (surfaceOrLocale === 'en' || surfaceOrLocale === 'nl') {
    surface = undefined;
    activeLocale = surfaceOrLocale;
  } else {
    surface = surfaceOrLocale;
    activeLocale = locale ?? pickLocale();
  }
  return activeLocale === 'nl' ? resolveNl(code, surface) : resolveEn(code, surface);
}

export {
  ERROR_MESSAGES_EN,
  ERROR_MESSAGES_NL,
  type ErrorMessage,
  type Surface,
};
