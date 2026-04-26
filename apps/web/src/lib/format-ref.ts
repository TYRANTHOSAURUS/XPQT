/**
 * Module reference formatting.
 *
 * Every ticket, work order, and reservation in Prequest carries a
 * per-tenant, per-module monotonic counter (`module_number`) allocated by
 * a DB trigger on insert. These helpers compose the human-readable
 * reference strings (TKT-1234, WO-1234, RES-1234) shown in tables, detail
 * headers, URLs, email subjects, and command palette results.
 *
 * Single source of truth for module prefixes — when a new module ships,
 * add it here and every render path picks it up.
 */

export const MODULE_PREFIX = {
  case: 'TKT',
  work_order: 'WO',
  reservation: 'RES',
} as const;

export type ModuleKind = keyof typeof MODULE_PREFIX;
export type ModulePrefix = (typeof MODULE_PREFIX)[ModuleKind];

export function formatRef(kind: ModuleKind, n: number | null | undefined): string {
  if (n == null) return '—';
  return `${MODULE_PREFIX[kind]}-${n}`;
}

/** Convenience: format a ticket row whose kind comes from `ticket_kind`. */
export function formatTicketRef(
  ticketKind: 'case' | 'work_order' | null | undefined,
  n: number | null | undefined,
): string {
  if (n == null) return '—';
  const kind: ModuleKind = ticketKind === 'work_order' ? 'work_order' : 'case';
  return formatRef(kind, n);
}

/**
 * Parse `TKT-1234` / `WO-42` / `RES-7` into its prefix and number. Returns
 * `null` if the string doesn't match a known module prefix. Used by routers
 * and search to accept ref-form lookups alongside UUIDs.
 */
export function parseRef(input: string): { prefix: ModulePrefix; number: number } | null {
  const m = input.trim().toUpperCase().match(/^([A-Z]{2,4})-(\d+)$/);
  if (!m) return null;
  const prefix = m[1] as ModulePrefix;
  const isKnown = (Object.values(MODULE_PREFIX) as string[]).includes(prefix);
  if (!isKnown) return null;
  return { prefix, number: Number(m[2]) };
}
