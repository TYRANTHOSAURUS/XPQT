/**
 * Visitor invitation payload — visitor-first invite (`/portal/visitors/invite`)
 * and the booking-first composer line both deserialize into this shape.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §6.1
 *
 * Pattern note: the API repo uses zod for request validation in modules where
 * the schema is non-trivial; lightweight DTOs (like this one) declare TS
 * interfaces and keep validation in the service. Slice 2d's controller wraps
 * incoming JSON with a zod schema before handing it to InvitationService.
 */
export interface CreateInvitationDto {
  /** Visitor PII — written to the persons row. */
  first_name: string;
  last_name?: string;
  email?: string;
  phone?: string;
  company?: string;

  /**
   * Tenant-configured visitor type. Drives:
   *   - requires_approval flag (creates pending_approval visitor + Approval row)
   *   - allow_walk_up flag (used by reception/kiosk paths, not invite path)
   *   - default_expected_until_offset_minutes (when expected_until omitted)
   */
  visitor_type_id: string;

  /** Expected arrival window. expected_at required; expected_until defaults from visitor_type. */
  expected_at: string;       // ISO 8601
  expected_until?: string;   // ISO 8601

  /**
   * Building scope check (spec §6.3): inviter's location grants must cover
   * this building. Otherwise InvitationService.create throws Forbidden.
   */
  building_id: string;
  meeting_room_id?: string;

  /**
   * Booking-first invite — set when this visitor is attached to a booking
   * (ties cancellation cascade, slice 4). Post-canonicalisation
   * (2026-05-02): `booking_id` is the canonical name; `booking_bundle_id`
   * is the legacy alias accepted transitionally for callers that haven't
   * migrated. The service prefers `booking_id` when both are present.
   * Visitors no longer carry a `reservation_id` (column dropped 00278:38).
   */
  booking_id?: string;
  /** @deprecated use `booking_id` */
  booking_bundle_id?: string;

  /**
   * Co-hosts in addition to the inviter (who is always the primary host).
   * One visitor_hosts row per id; primary host is appended automatically.
   */
  co_host_person_ids?: string[];

  notes_for_visitor?: string;
  notes_for_reception?: string;
}
