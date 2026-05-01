/**
 * KioskService DTOs.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §8
 *
 * Anonymous building-bound auth: KioskAuthGuard puts a `KioskContext` on
 * the request. KioskService methods take it as their first arg.
 */

export interface KioskContext {
  /** Resolved from kiosk_tokens.tenant_id. */
  tenantId: string;
  /** Resolved from kiosk_tokens.building_id. Lobby is bound to ONE building. */
  buildingId: string;
  /** kiosk_tokens.id — used for audit so we can answer "which kiosk did the check-in". */
  kioskTokenId: string;
}

/** Slim actor shape for any KioskService write that needs an audit anchor. */
export interface KioskActor {
  kind: 'kiosk';
  tenantId: string;
  buildingId: string;
  kioskTokenId: string;
}

/** Search-result row at the kiosk (privacy: NO host names). */
export interface KioskSearchResult {
  visitor_id: string;
  first_name: string;
  /** First letter of last_name only — `Visser` → `V.`. */
  last_initial: string | null;
  company: string | null;
}

/** QR check-in success payload. */
export interface KioskQrCheckinResult {
  visitor_id: string;
  /** First name of primary host — used for the "Welcome — your host is on the way" screen. */
  host_first_name: string | null;
  /** True if the building has a configured pass pool — drives the "see reception" copy. */
  has_reception_at_building: boolean;
}

export interface KioskNameCheckinResult {
  host_first_name: string | null;
  has_reception_at_building: boolean;
}

/** Walkup form at the kiosk (no invitation). */
export interface KioskWalkupDto {
  first_name: string;
  last_name?: string;
  email?: string;
  phone?: string;
  company?: string;
  visitor_type_id: string;
  primary_host_person_id: string;
}
