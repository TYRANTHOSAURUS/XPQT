import {
  Box,
  Briefcase,
  Building2,
  CalendarDays,
  Car,
  Coffee,
  FileText,
  HelpCircle,
  Home,
  Key,
  Laptop,
  Lightbulb,
  MapPin,
  Monitor,
  Package,
  Printer,
  ShieldCheck,
  ShoppingCart,
  Truck,
  UserPlus,
  Users,
  Utensils,
  Wifi,
  Wrench,
} from 'lucide-react';
import type { ComponentType } from 'react';

/**
 * Curated icon allowlist for portal-side dynamic icon-by-name lookup.
 *
 * Catalog categories and request types persist their icon as a string
 * name (`Monitor`, `Wrench`, …). Resolving the name via a `Record` lookup
 * lets bundlers tree-shake the rest of `lucide-react` (~1500 icons).
 *
 * Keep this list aligned with the admin icon picker in
 * `apps/web/src/pages/admin/catalog-hierarchy.tsx` plus a few safe
 * additions used elsewhere in the portal. Unknown names fall back to
 * `HelpCircle` so a stale DB icon never crashes a render.
 */
export const PORTAL_ICONS = {
  Box,
  Briefcase,
  Building2,
  CalendarDays,
  Car,
  Coffee,
  FileText,
  HelpCircle,
  Home,
  Key,
  Laptop,
  Lightbulb,
  MapPin,
  Monitor,
  Package,
  Printer,
  ShieldCheck,
  ShoppingCart,
  Truck,
  UserPlus,
  Users,
  Utensils,
  Wifi,
  Wrench,
} as const satisfies Record<string, ComponentType<{ className?: string }>>;

export type PortalIconName = keyof typeof PORTAL_ICONS;

/**
 * Resolve a string icon name to a component, with a guaranteed fallback.
 * Pass `undefined`/`null` for "no icon configured" — same fallback.
 */
export function resolvePortalIcon(
  name: string | null | undefined,
): ComponentType<{ className?: string }> {
  if (!name) return HelpCircle;
  return (PORTAL_ICONS as Record<string, ComponentType<{ className?: string }>>)[name] ?? HelpCircle;
}
