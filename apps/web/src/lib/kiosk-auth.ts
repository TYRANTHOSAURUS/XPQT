/**
 * Kiosk auth + provisioning storage.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §8.1
 * Backend: apps/api/src/modules/visitors/kiosk-auth.guard.ts
 *
 * The kiosk is an anonymous, building-bound device. Admin provisions it via
 * `/admin/visitors/passes` (slice 9) → backend returns a long-lived Bearer
 * token (90-day rotation) bound to a specific tenant_id + building_id.
 *
 * The kiosk stores the token + a small projection of provisioning metadata
 * (tenantId, buildingId, building name, branding hint) in localStorage so it
 * can render the welcome screen and call `/api/kiosk/*` without ever
 * touching the user-JWT auth flow.
 *
 * Why localStorage and not a cookie:
 *   - The kiosk's only state is the token. There's no user, no session id, no
 *     refresh, nothing the server needs to read on a different page load.
 *   - Cookie would serialise on every request including the static asset
 *     hits — pointless overhead.
 *   - LocalStorage is per-origin and per-device which IS the kiosk model.
 *
 * Caveats:
 *   - If the device cache is wiped, the kiosk needs re-provisioning. Admin
 *     can rotate / re-provision from `/admin/visitors/passes`.
 *   - The token is sensitive (anyone holding it can fake check-ins for that
 *     building). The mitigation is the 90-day rotation + admin's ability to
 *     revoke. We do NOT log it; we only ever read it from storage and shove
 *     it into the Authorization header.
 */

const STORAGE_KEY = 'pq.kiosk.session';

/** Branding hint for the kiosk. Optional; the kiosk renders sensible
 *  defaults when not set. The shape matches the public branding endpoint
 *  the admin has access to today; the kiosk receives a compact projection
 *  at provisioning time so we don't depend on a separate anonymous
 *  branding endpoint. */
export interface KioskBranding {
  tenant_name?: string | null;
  primary_color?: string | null;
  logo_light_url?: string | null;
  logo_dark_url?: string | null;
}

export interface KioskSession {
  /** Bearer token for `/api/kiosk/*`. Kept private — never log or render. */
  token: string;
  /** Resolved at provisioning. Recorded so the welcome screen can show
   *  "Welcome to <Building Name>" without an extra fetch. Both can be
   *  null when the admin pasted only the token without a setup URL —
   *  in that case the backend resolves the binding from the token. */
  tenantId: string | null;
  buildingId: string | null;
  buildingName: string;
  /** ISO. Kiosk shows a "needs re-provisioning soon" banner inside 7 days. */
  expiresAt?: string | null;
  branding?: KioskBranding | null;
  /** Set on first save; surfaced in the admin "kiosk last seen" view if we
   *  ever wire it. Today it's local-only. */
  provisionedAt: string;
}

export function readKioskSession(): KioskSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as KioskSession;
    if (!parsed.token) return null;
    // tenantId / buildingId can legitimately be null when the admin pastes
    // a bare token without a setup URL; the backend resolves the binding
    // from the token in that case.
    return parsed;
  } catch {
    return null;
  }
}

export function writeKioskSession(session: KioskSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* ignore quota — kiosk has nothing else to write */
  }
}

export function clearKioskSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Convenience accessor for `Authorization: Bearer …` building. */
export function readKioskToken(): string | null {
  const session = readKioskSession();
  return session?.token ?? null;
}
