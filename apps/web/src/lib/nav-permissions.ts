/**
 * Permission-aware filtering for the desk shell's grouped nav.
 *
 * Design rules (from
 * docs/superpowers/specs/2026-05-02-main-menu-redesign-design.md, §IA):
 *
 * - Hide a group entirely when zero items in it are visible.
 * - Keep the group label when ≥1 item is visible (single-item groups still
 *   show their label so the operator gets orientation).
 * - Group order is fixed regardless of which items are visible.
 *
 * Today the auth model exposes role TYPES (admin / agent / employee) rather
 * than granular per-resource permissions. The predicate signature here is
 * generic so we can swap in granular permission checks later without
 * touching every caller.
 */
export interface NavItem<T = unknown> {
  /** Stable identifier — used as React key and in tests. */
  id: string;
  /** The thing the predicate evaluates against. Caller-defined (e.g. a permission key, a role name, an arbitrary tag). */
  permission: T;
}

export interface NavGroup<T = unknown> {
  /** Stable identifier. */
  id: string;
  /** Group label. `null` renders as an unlabeled (separator-only) section. */
  label: string | null;
  items: NavItem<T>[];
}

/**
 * Filter a list of nav groups using a predicate. Groups whose items are all
 * filtered out are dropped entirely; surviving groups keep their label even
 * when only a single item remains.
 *
 * Pure function — no side effects. Order is preserved.
 */
export function filterNavGroups<T>(
  groups: NavGroup<T>[],
  canShow: (permission: T) => boolean,
): NavGroup<T>[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canShow(item.permission)),
    }))
    .filter((group) => group.items.length > 0);
}
