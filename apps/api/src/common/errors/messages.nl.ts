/**
 * Dutch (nl) error messages — Phase 7.B-3.
 *
 * Mirrors `messages.en.ts` exactly. Every key in the canonical English
 * registry has a Dutch translation here. Voice rules below match the EN
 * voice mandate (spec §3.4 / §6.5):
 *
 *   - Title voice for errors: "Kon <thing> niet <verb past participle>"
 *     (the Dutch equivalent of "Couldn't <verb> <thing>"). Neutral, human,
 *     no exclamation marks.
 *   - Detail is an optional one-line clarification.
 *   - NEVER include vendor names (Resend, Supabase, Stripe, Postgres,
 *     Microsoft Graph).
 *   - NEVER include SQL fragments or stack frames.
 *   - Use `je` (informal) consistently — XPQT tone is professional but
 *     informal, matching the EN tone.
 *   - For non-user-visible internal codes (outbox.*, setup_wo.*) we still
 *     register a generic ops-friendly message; the renderer falls back to
 *     `unknown.server_error` copy when the surface is user-facing.
 *
 * The renderer NEVER displays the server's `detail` verbatim — fail-closed
 * per decision #9. This map is the only path to user-visible copy for any
 * registered code in the Dutch locale.
 */

import type { KnownErrorCode } from '@prequest/shared';
import type { ErrorMessage } from './messages.en';

export const ERROR_MESSAGES_NL: Record<KnownErrorCode, ErrorMessage> = {
  // ─── auth / permission ──────────────────────────────────────────────────
  'auth.unauthorized': {
    title: 'Meld je opnieuw aan',
    detail: 'Je sessie heeft een nieuwe aanmelding nodig.',
  },
  'auth.expired': {
    title: 'Je sessie is verlopen',
    detail: 'Meld je opnieuw aan om verder te gaan waar je was.',
  },
  'auth.invalid': {
    title: 'Aanmelden mislukt',
    detail: 'Die gegevens werkten niet. Probeer het opnieuw.',
  },
  'permission.denied': {
    title: 'Je hebt geen toegang hiertoe',
    detail: 'Vraag een beheerder om toegang als je dat nodig hebt.',
  },
  'permission.missing_role': {
    title: 'Je hebt geen toegang hiertoe',
    detail: 'Je rol mist de rechten voor deze actie.',
  },

  // ─── generic legacy buckets ──────────────────────────────────────────────
  'generic.bad_request': {
    title: 'Kon dat niet voltooien',
    detail: 'Het verzoek is geweigerd.',
  },
  'generic.unauthorized': {
    title: 'Meld je opnieuw aan',
  },
  'generic.forbidden': {
    title: 'Je hebt geen toegang hiertoe',
  },
  'generic.not_found': {
    title: 'We kunnen dat niet vinden',
  },
  'generic.conflict': {
    title: 'Iets anders is gewijzigd',
    detail: 'Dit is door iemand anders bijgewerkt. Herlaad en probeer het opnieuw.',
  },

  // ─── validation ──────────────────────────────────────────────────────────
  'validation.failed': {
    title: 'Sommige velden hebben aandacht nodig',
  },

  // ─── rate limit / quota / request ────────────────────────────────────────
  'rate_limit.exceeded': {
    title: 'Te veel verzoeken',
    detail: 'Wacht even en probeer het opnieuw.',
  },
  'quota.exceeded': {
    title: 'Quotum overschreden',
    detail: 'Je hebt een gebruikslimiet in deze werkruimte bereikt.',
  },
  'request.too_large': {
    title: 'Dat verzoek is te groot',
    detail: 'Probeer een kleinere payload of minder items.',
  },
  'request.cancelled': {
    title: 'Verzoek geannuleerd',
  },

  // ─── network ─────────────────────────────────────────────────────────────
  'network.offline': {
    title: 'Je bent offline',
    detail: 'Wijzigingen worden gesynchroniseerd zodra je weer verbinding hebt.',
  },
  'network.timeout': {
    title: 'Kon de server niet bereiken',
    detail: 'Het verzoek verliep. Probeer het opnieuw.',
  },

  // ─── db (never leak SQL) ─────────────────────────────────────────────────
  'db.constraint': {
    title: 'Kon niet opslaan',
    detail: 'Een dataregel blokkeerde deze wijziging.',
  },
  'db.unique_violation': {
    title: 'Bestaat al',
    detail: 'Er bestaat al iets met dat kenmerk.',
  },
  'db.fk_violation': {
    title: 'Kon niet opslaan',
    detail: 'Dit verwijst naar iets dat niet meer bestaat.',
  },
  'db.deadlock': {
    title: 'Kon niet opslaan — probeer het opnieuw',
    detail: 'Twee wijzigingen botsten. Een nieuwe poging werkt meestal.',
  },

  // ─── third-party (no vendor names) ───────────────────────────────────────
  'email.dispatch_failed': {
    title: 'Kon de e-mail niet verzenden',
    detail: 'De e-maildienst weigerde het bericht. Probeer het later opnieuw.',
  },
  'realtime.unavailable': {
    title: 'Live updates zijn gepauzeerd',
    detail: 'Verbinding wordt op de achtergrond hersteld.',
  },

  // ─── render / unknown ────────────────────────────────────────────────────
  'render.failed': {
    title: 'Er ging iets mis op deze pagina',
    detail: 'Herlaad de pagina om te herstellen.',
  },
  'unknown.server_error': {
    title: 'Er ging iets mis aan onze kant',
    detail: 'Probeer het opnieuw. Blijft dit gebeuren, neem dan contact op met support en geef het trace-ID door.',
  },

  // ─── Phase 1 registered codes ────────────────────────────────────────────
  'work_order.plan_invalid': {
    title: 'Kon werkbon niet aanmaken',
    detail: 'Het plan heeft ontbrekende of ongeldige velden.',
  },
  'booking.slot_conflict': {
    title: 'Kon niet boeken — tijdconflict',
    detail: 'De gekozen ruimte is op dat tijdstip al geboekt.',
  },
  'booking_slot.not_found': {
    title: 'Kon dat boekingsslot niet vinden',
  },
  'booking_slot.url_mismatch': {
    title: 'Kon dat slot niet bijwerken',
    detail: 'Het slot in de URL komt niet overeen met de body.',
  },
  'booking.edit_forbidden': {
    title: 'Je kunt deze reservering niet wijzigen',
  },
  'booking.partial_failure': {
    // I3: reclassified to server-class per phase-7-error-codes.md line 101.
    title: 'Kon de reservering niet volledig opslaan',
    detail: 'Sommige onderdelen werden niet opgeslagen en terugdraaien lukte niet. Neem contact op met support en geef het trace-ID door.',
  },
  'booking.compensation_failed': {
    title: 'Kon de reservering niet volledig terugdraaien',
    detail: 'Een opruimstap mislukte. Neem contact op met support en geef het trace-ID door.',
  },
  'booking.slot_space_invalid': {
    title: 'Kon niet bijwerken — ongeldige ruimte',
    detail: 'Die ruimte is niet geldig voor dit slot.',
  },
  'booking.slot_update_failed': {
    title: 'Kon dat slot niet bijwerken',
  },
  'booking.invalid_attendee_count': {
    title: 'Kon niet bijwerken — aantal deelnemers ongeldig',
  },
  'booking.invalid_attendee_person_ids': {
    title: 'Kon niet bijwerken — ongeldige deelnemers',
  },
  'booking.invalid_window': {
    title: 'Kon niet bijwerken — ongeldig tijdvenster',
    detail: 'Controleer de start- en eindtijd.',
  },
  'reference.not_in_tenant': {
    title: 'Kon niet opslaan — verwezen item niet beschikbaar',
    detail: 'Een van de verwijzingen bestaat niet in deze werkruimte.',
  },
  'reference.lookup_failed': {
    title: 'Kon verwijzingen niet valideren',
    detail: 'Probeer het zo opnieuw.',
  },
  'reference.invalid_uuid': {
    title: 'Kon niet opslaan — ongeldige verwijzing',
    detail: 'Een verplicht kenmerk is onjuist opgemaakt.',
  },
  'reference.too_many': {
    title: 'Kon niet opslaan — te veel verwijzingen',
    detail: 'Verklein het aantal items en probeer het opnieuw.',
  },
  'workflow.update_ticket_field_not_allowed': {
    title: 'Kon niet bijwerken — veld niet toegestaan',
    detail: 'Dit veld kan niet door deze workflowstap worden gewijzigd.',
  },
  'outbox.idempotency_collision': {
    title: 'Dubbel event onderdrukt',
  },
  'outbox.tenant_id_required': {
    title: 'Kon niet emitten — werkruimte ontbreekt',
  },
  'outbox.idempotency_key_required': {
    title: 'Kon niet emitten — eventsleutel ontbreekt',
  },
  'setup_wo.requester_person_id_not_allowed': {
    title: 'Kon setup-werkbon niet aanmaken',
  },
  'setup_wo.fk_invalid': {
    title: 'Kon setup-werkbon niet aanmaken',
    detail: 'Een verwijzing is ongeldig.',
  },

  // ─── ticket / booking ────────────────────────────────────────────────────
  'ticket.not_found': {
    title: 'We kunnen dat ticket niet vinden',
  },
  'ticket.title_required': {
    title: 'Kon niet opslaan — titel verplicht',
  },
  'ticket.assignment_invalid': {
    title: 'Kon niet toewijzen — kies iemand anders',
    detail: 'Die persoon kan dit ticket niet aannemen.',
  },
  'ticket.routing_no_match': {
    title: 'Kon niet routeren — geen team gevonden',
  },
  'booking.conflict': {
    title: 'Kon niet boeken — conflict',
  },
  'booking.window_closed': {
    title: 'Het boekingsvenster is gesloten',
  },
  'booking.capacity_exceeded': {
    title: 'Capaciteit overschreden',
    detail: 'Kies een grotere ruimte of verwijder deelnemers.',
  },
  'booking.permission_denied': {
    title: 'Je kunt deze ruimte niet boeken',
  },
  'reservation.version_conflict': {
    title: 'Dit is door iemand anders gewijzigd',
    detail: 'Herlaad om de nieuwste versie te zien.',
  },
  'order.line_invalid': {
    title: 'Kon niet toevoegen — ongeldige regel',
  },
  'routing.no_match': {
    title: 'Kon niet routeren — geen match',
  },
  'routing.cycle_detected': {
    title: 'Routinglus gedetecteerd',
  },
  'sla.policy_invalid': {
    title: 'Kon SLA niet toepassen — beleid ongeldig',
  },
  'sla.threshold_invalid': {
    title: 'Kon niet opslaan — escalatiedrempel ongeldig',
    detail: 'Controleer de drempelwaarden en probeer het opnieuw.',
  },
  'sla.target_missing': {
    title: 'Kon SLA niet bijwerken — doel niet gevonden',
  },
  'sla.policy_not_found': {
    title: 'Kon SLA niet bijwerken',
    detail: 'SLA-beleid niet gevonden in deze tenant.',
  },
  'sla.policy_has_no_targets': {
    title: 'Kon SLA niet toewijzen',
    detail: 'Deze SLA-policy heeft geen response- of resolution-target ingesteld. Stel er minimaal één in voordat je deze toewijst.',
  },

  // ─── booking-bundles module (Phase 7.A.2.c.i) ────────────────────────────
  'bundle.forbidden': {
    title: 'Je hebt geen toegang tot deze reservering',
  },
  'bundle.not_found': {
    title: 'We kunnen die reservering niet vinden',
  },
  'bundle.no_services': {
    title: 'Kon niet opslaan — geen serviceregels opgegeven',
  },
  'bundle.line_not_in_bundle': {
    title: 'Kon niet annuleren — regel hoort niet bij een reservering',
  },
  'bundle.invalid_quantity': {
    title: 'Kon niet opslaan — aantal ongeldig',
  },
  'bundle.invalid_service_window': {
    title: 'Kon niet opslaan — servicevenster ongeldig',
    detail: 'Geef een geldige start- en eindtijd op.',
  },
  'bundle.invalid_requester_notes': {
    title: 'Kon niet opslaan — notities ongeldig',
    detail: 'Notities mogen maximaal 2000 tekens bevatten.',
  },
  'bundle.invalid_expected_updated_at': {
    title: 'Kon niet opslaan — versietoken ongeldig',
  },
  'bundle.lead_time_violation': {
    title: 'Kon niet toevoegen — onvoldoende doorlooptijd',
    detail: 'Verplaats de meeting later of verwijder deze service.',
  },
  'bundle.context_lookup_failed': {
    title: 'Er ging iets mis aan onze kant',
    detail: 'Probeer het opnieuw. Blijft dit gebeuren, neem dan contact op met support en geef het trace-ID door.',
  },
  'bundle.idempotency_key_required': {
    title: 'Kon niet opslaan — idempotentiesleutel ontbreekt',
  },
  'bundle.tenant_id_required': {
    title: 'Er ging iets mis aan onze kant',
    detail: 'Werkruimtecontext ontbreekt. Probeer het opnieuw.',
  },
  'booking.not_found': {
    title: 'We kunnen die reservering niet vinden',
  },
  'asset.not_found': {
    title: 'We kunnen dat asset niet vinden',
  },
  'catalog_item.not_found': {
    title: 'We kunnen dat catalogusitem niet vinden',
  },
  'plan.idempotency_key_required': {
    title: 'Er ging iets mis aan onze kant',
    detail: 'Idempotentiesleutel ontbreekt. Probeer het opnieuw.',
  },
  'plan.stable_index_required': {
    title: 'Er ging iets mis aan onze kant',
    detail: 'Stabiele index ontbreekt. Probeer het opnieuw.',
  },
  'plan.client_line_id_required': {
    title: 'Er ging iets mis aan onze kant',
    detail: 'Client-regel-ID ontbreekt. Probeer het opnieuw.',
  },
  service_rule_deny: {
    title: 'Kon niet boeken — een regel blokkeerde dit',
  },
  asset_conflict: {
    title: 'Kon niet boeken — asset al gereserveerd',
    detail: 'Een gevraagd asset is al gereserveerd voor dat tijdvak.',
  },
  line_not_found: {
    title: 'We kunnen die regel niet vinden',
  },
  line_state_changed: {
    title: 'Deze regel is door iemand anders gewijzigd',
    detail: 'Herlaad om de nieuwste status te zien.',
  },
  line_frozen: {
    title: 'Kon niet wijzigen — regel is al in uitvoering',
    detail: 'Annuleer en voeg opnieuw toe.',
  },
  line_already_fulfilled: {
    title: 'Kon niet annuleren — regel is al uitgevoerd',
    detail: 'Neem zo nodig contact op met het uitvoeringsteam.',
  },
  client_line_id_required: {
    title: 'Kon niet opslaan — client-regel-ID ontbreekt',
  },
  client_line_id_not_unique: {
    title: 'Kon niet opslaan — dubbele client-regel-ID',
  },

  // ─── reservations module (Phase 7.A.2.c.ii) ──────────────────────────────
  'booking.idempotency_payload_mismatch': {
    title: 'Kon niet opslaan — idempotentie-mismatch',
    detail: 'Een nieuwe poging stuurde een andere payload dan het oorspronkelijke verzoek.',
  },
  'booking.fk_invalid': {
    title: 'Kon niet opslaan — ongeldige verwijzing',
    detail: 'Een verwezen item ontbreekt of staat in een andere werkruimte.',
  },
  'booking.internal_ref_invalid': {
    title: 'Kon niet opslaan — interne verwijzing ongeldig',
  },
  'booking.snapshot_uuid_invalid': {
    title: 'Kon niet opslaan — snapshot-verwijzing ongeldig',
  },
  'booking.unexpected_error': {
    title: 'Kon de reservering niet opslaan',
    detail: 'Probeer het opnieuw. Blijft dit gebeuren, neem dan contact op met support en geef het trace-ID door.',
  },
  'booking.idempotency_key_required': {
    title: 'Kon niet opslaan — idempotentiesleutel ontbreekt',
  },
  'booking.completed_cannot_edit': {
    title: 'Kon niet wijzigen — reservering is afgerond',
  },
  'booking.not_editable': {
    title: 'Je kunt deze reservering niet wijzigen',
  },
  'booking.not_cancelled': {
    title: 'Kon niet herstellen — reservering is niet geannuleerd',
  },
  'booking.cancellation_grace_expired': {
    title: 'Kon niet herstellen — herstelvenster verlopen',
  },
  'booking.slot_taken': {
    title: 'Kon niet herstellen — slot is bezet',
  },
  'booking.not_a_recurring_occurrence': {
    title: 'Kon niet bijwerken — geen herhalingsmoment',
  },
  'booking.too_early_to_check_in': {
    title: 'Het is nog te vroeg om in te checken',
  },
  'booking.already_ended': {
    title: 'Deze reservering is al afgelopen',
  },
  'booking.already_checked_in': {
    title: 'Al ingecheckt',
  },
  'booking.not_confirmed': {
    title: 'Kon niet inchecken — reservering niet bevestigd',
  },
  'booking.check_in_failed': {
    title: 'Kon niet inchecken',
  },
  'booking.magic_link_invalid': {
    title: 'Die check-in-link is ongeldig',
  },
  'booking.magic_link_booking_mismatch': {
    title: 'Die check-in-link hoort bij een andere reservering',
  },
  'booking.magic_link_person_mismatch': {
    title: 'Die check-in-link is voor een andere persoon',
  },
  'booking.scheduler_window_requires_range': {
    title: 'Kon niet laden — datumbereik verplicht',
  },
  'booking.no_primary_slot': {
    title: 'Kon niet wijzigen — geen primair slot',
  },
  'booking.edit_failed': {
    title: 'Kon de wijzigingen niet opslaan',
  },
  'booking.list_failed': {
    title: 'Kon de reserveringen niet laden',
  },
  'booking.cancel_failed': {
    title: 'Kon de reservering niet annuleren',
  },
  'booking.skip_failed': {
    title: 'Kon dit moment niet overslaan',
  },
  'booking.restore_failed': {
    title: 'Kon de reservering niet herstellen',
  },
  'booking.scheduler_window_failed': {
    title: 'Kon het planningsvenster niet laden',
  },
  'booking.bundle_not_injected': {
    title: 'Er ging iets mis aan onze kant',
    detail: 'Bundle-service niet geconfigureerd. Neem contact op met support en geef het trace-ID door.',
  },
  'booking.recurrence_not_injected': {
    title: 'Er ging iets mis aan onze kant',
    detail: 'Herhalingsservice niet geconfigureerd. Neem contact op met support en geef het trace-ID door.',
  },
  'booking.recurrence_series_not_found': {
    title: 'Kon die herhalingsreeks niet vinden',
  },
  'booking.master_not_found': {
    title: 'Kon de hoofdreservering niet vinden',
  },
  'booking.recurrence_failed': {
    title: 'Kon de herhaling niet bijwerken',
  },
  'reservation.projection_no_parent': {
    title: 'Er ging iets mis aan onze kant',
    detail: 'Een reserveringsregel kwam terug zonder bovenliggend record. Neem contact op met support en geef het trace-ID door.',
  },
  'auth.missing_user': {
    title: 'Meld je opnieuw aan',
  },
  'magic_check_in.secret_missing': {
    title: 'Er ging iets mis aan onze kant',
    detail: 'Magic-check-in is niet correct geconfigureerd.',
  },
  // legacy snake_case codes (already asserted in specs)
  book_on_behalf_forbidden: {
    title: 'Je kunt niet namens een ander boeken',
  },
  multi_room_booking_failed: {
    title: 'Kon de ruimtes niet boeken',
  },
  multi_room_requires_two: {
    title: 'Kon niet boeken — minimaal twee ruimtes vereist',
  },
  multi_room_too_many: {
    title: 'Kon niet boeken — te veel ruimtes',
    detail: 'Boekingen met meerdere ruimtes zijn beperkt tot 10 plekken.',
  },
  multi_room_create_failed: {
    title: 'Kon de ruimtes niet boeken',
    detail: 'Probeer het opnieuw. Blijft dit gebeuren, neem dan contact op met support.',
  },
  multi_room_read_failed: {
    title: 'Kon de reservering niet laden',
    detail: 'Probeer het opnieuw. Blijft dit gebeuren, neem dan contact op met support.',
  },
  rule_deny: {
    title: 'Kon niet boeken — een regel blokkeerde dit',
  },
  reservation_not_visible: {
    title: 'Je hebt geen toegang tot deze reservering',
  },
  reservation_operator_required: {
    title: 'Voor dit overzicht heb je operatortoegang nodig',
  },
  booking_not_found: {
    title: 'We kunnen die reservering niet vinden',
  },
  booking_not_editable: {
    title: 'Je kunt deze reservering niet wijzigen',
  },
  booking_completed: {
    title: 'Die reservering is afgerond',
  },
  not_a_recurring_occurrence: {
    title: 'Kon niet bijwerken — geen herhalingsmoment',
  },
  booking_slot_taken: {
    title: 'Kon niet herstellen — slot is bezet',
  },
  booking_already_ended: {
    title: 'Deze reservering is al afgelopen',
  },
  booking_too_early_to_check_in: {
    title: 'Het is nog te vroeg om in te checken',
  },
  booking_already_checked_in: {
    title: 'Al ingecheckt',
  },
  booking_not_confirmed: {
    title: 'Kon niet inchecken — reservering niet bevestigd',
  },
  check_in_failed: {
    title: 'Kon niet inchecken',
  },
  magic_link_invalid: {
    title: 'Die check-in-link is ongeldig',
  },
  magic_link_booking_mismatch: {
    title: 'Die check-in-link hoort bij een andere reservering',
  },
  magic_link_person_mismatch: {
    title: 'Die check-in-link is voor een andere persoon',
  },
  cancellation_grace_expired: {
    title: 'Kon niet herstellen — herstelvenster verlopen',
  },
  booking_not_cancelled: {
    title: 'Kon niet herstellen — reservering is niet geannuleerd',
  },
  scheduler_window_requires_range: {
    title: 'Kon niet laden — datumbereik verplicht',
  },
  cancel_failed: {
    title: 'Kon de reservering niet annuleren',
    detail: 'Probeer het opnieuw. Blijft dit gebeuren, neem dan contact op met support.',
  },
  list_failed: {
    title: 'Kon de reserveringen niet laden',
    detail: 'Probeer het opnieuw. Blijft dit gebeuren, neem dan contact op met support.',
  },
  restore_failed: {
    title: 'Kon de reservering niet herstellen',
    detail: 'Probeer het opnieuw. Blijft dit gebeuren, neem dan contact op met support.',
  },
  skip_failed: {
    title: 'Kon dit moment niet overslaan',
    detail: 'Probeer het opnieuw. Blijft dit gebeuren, neem dan contact op met support.',
  },
  edit_failed: {
    title: 'Kon de wijzigingen niet opslaan',
    detail: 'Probeer het opnieuw. Blijft dit gebeuren, neem dan contact op met support.',
  },
  group_siblings_failed: {
    title: 'Kon de gerelateerde reserveringen niet laden',
  },
  list_for_operator_failed: {
    title: 'Kon de reserveringen niet laden',
  },
  list_for_operator_orders: {
    title: 'Kon gerelateerde orders niet laden',
    detail: 'Probeer het opnieuw. Blijft dit gebeuren, neem dan contact op met support.',
  },
  load_spaces_failed: {
    title: 'Kon de ruimtes niet laden',
    detail: 'Probeer het opnieuw. Blijft dit gebeuren, neem dan contact op met support.',
  },
  scheduler_window_failed: {
    title: 'Kon het planningsvenster niet laden',
  },
  reservation_not_editable: {
    title: 'Je kunt deze reservering niet wijzigen',
  },
  missing_user: {
    title: 'Meld je opnieuw aan',
  },

  // ─── approval module (Phase 7.A.2.d) ─────────────────────────────────────
  'approval.not_found': {
    title: 'We kunnen die goedkeuring niet vinden',
  },
  'approval.already_responded': {
    title: 'Deze goedkeuring is al beantwoord',
  },
  'approval.not_an_approver': {
    title: 'Je bent geen goedkeurder voor dit verzoek',
  },
  'approval.no_person_record': {
    title: 'Je hebt geen toegang hiertoe',
    detail: 'Er is geen persoonsrecord aan je account gekoppeld.',
  },
  'approval.cross_actor_pending': {
    title: 'Je hebt geen toegang hiertoe',
    detail: 'Je kunt alleen je eigen openstaande goedkeuringen zien.',
  },
  'approval.responding_user_required': {
    title: 'Kon niet goedkeuren — interne gebruikersverwijzing ontbreekt',
  },
  'approval.grant_failed': {
    title: 'Kon de goedkeuring niet verlenen',
    detail: 'Probeer het opnieuw. Blijft dit gebeuren, neem dan contact op met support en geef het trace-ID door.',
  },
  'approval.non_booking_approved': {
    title: 'Kon niet goedkeuren — verkeerd goedkeurpad voor dit doel',
  },
  'approval.cas_lost': {
    title: 'Goedkeuringsstatus is gewijzigd tijdens de poging',
    detail: 'Probeer het opnieuw.',
  },
  'approval.invalid_decision': {
    title: 'Kon niet goedkeuren — beslissing moet goedgekeurd of afgewezen zijn',
  },
  'vendor.unavailable': {
    title: 'Leverancier niet beschikbaar',
  },
  'vendor.not_in_scope': {
    title: 'Kon niet kiezen — leverancier niet toegestaan',
  },

  // ─── ticket module migration (Phase 7.A.2.a) ─────────────────────────────
  'ticket.bulk_cap_exceeded': {
    title: 'Kon niet bijwerken — selectie te groot',
    detail: 'Bulkupdates zijn beperkt tot 200 tickets per keer.',
  },
  'ticket.no_writable_in_selection': {
    title: 'Je kunt geen van die tickets bijwerken',
  },
  'ticket.case_sla_immutable': {
    title: 'Kon SLA niet wijzigen — bovenliggende SLA staat vast',
  },
  'ticket.cannot_reassign_to_same': {
    title: 'Kon niet opnieuw toewijzen — al daar toegewezen',
  },
  'ticket.tags_invalid': {
    title: 'Kon niet opslaan — tags ongeldig',
    detail: 'Tags moeten een lijst met tekstwaarden zijn.',
  },
  'ticket.watchers_invalid': {
    title: 'Kon niet opslaan — volgers ongeldig',
    detail: 'Volgers moeten een lijst met persoons-ID\'s zijn.',
  },
  'ticket.no_files_uploaded': {
    title: 'Kon niet uploaden — geen bestanden bijgevoegd',
  },
  'ticket.visibility_trace_forbidden': {
    title: 'Je hebt geen toegang hiertoe',
  },
  'ticket.write_forbidden': {
    title: 'Je kunt dit ticket niet wijzigen',
  },
  'ticket.read_forbidden': {
    title: 'Je hebt geen toegang tot dit ticket',
  },
  'ticket.plan_forbidden': {
    title: 'Je kunt dit ticket niet inplannen',
  },
  'ticket.bulk_update_invalid': {
    title: 'Kon bulkupdate niet uitvoeren — invoer ongeldig',
  },
  'ticket.reassignment_reason_required': {
    title: 'Kon niet opnieuw toewijzen — reden verplicht',
  },
  'ticket.children_open_cannot_close': {
    title: 'Kon niet sluiten — openstaande onderliggende werkbonnen',
    detail: 'Los de werkbonnen eerst op of sluit ze af.',
  },
  'ticket.priority_change_forbidden': {
    title: 'Je kunt de ticketprioriteit niet wijzigen',
  },
  'ticket.assign_forbidden': {
    title: 'Je kunt de tickettoewijzing niet wijzigen',
  },
  'ticket.cannot_reclassify_child': {
    title: 'Kon niet herclassificeren — herclassificeer in plaats daarvan het hoofdrecord',
  },
  'ticket.terminal_cannot_reclassify': {
    title: 'Kon niet herclassificeren — ticket is gesloten of opgelost',
  },

  // ─── reclassify ──────────────────────────────────────────────────────────
  'reclassify.target_not_found': {
    title: 'Kon niet herclassificeren — aanvraagtype niet gevonden',
  },
  'reclassify.target_inactive': {
    title: 'Kon niet herclassificeren — aanvraagtype is inactief',
  },
  'reclassify.target_same': {
    title: 'Kon niet herclassificeren — zelfde aanvraagtype',
  },
  'reclassify.reason_too_short': {
    title: 'Kon niet herclassificeren — reden te kort',
    detail: 'Geef minstens 3 tekens op.',
  },
  'reclassify.reason_too_long': {
    title: 'Kon niet herclassificeren — reden te lang',
    detail: 'Houd de reden onder 500 tekens.',
  },
  'reclassify.in_progress_collision': {
    title: 'Kon niet herclassificeren — andere wijziging bezig',
    detail: 'Probeer het opnieuw zodra die klaar is.',
  },
  'reclassify.in_progress_children_unacked': {
    title: 'Kon niet herclassificeren — bevestig openstaande werkbonnen',
    detail: 'Bevestig de openstaande onderliggende werkbonnen om door te gaan.',
  },
  'reclassify.terminal_state': {
    title: 'Kon niet herclassificeren — ticket is gesloten of opgelost',
  },
  'reclassify.work_order_target': {
    title: 'Kon niet herclassificeren — kies het hoofdticket',
  },
  'reclassify.actor_not_resolvable': {
    title: 'Kon niet herclassificeren — gebruiker niet in deze werkruimte',
  },

  // ─── dispatch ────────────────────────────────────────────────────────────
  'dispatch.title_required': {
    title: 'Kon niet uitsturen — titel verplicht',
  },
  'dispatch.from_work_order': {
    title: 'Kon niet uitsturen vanuit een werkbon',
    detail: 'Stuur in plaats daarvan uit vanuit het hoofddossier.',
  },
  'dispatch.parent_pending_approval': {
    title: 'Kon niet uitsturen — hoofdrecord wacht op goedkeuring',
  },
  'dispatch.assignment_required': {
    title: 'Kon niet uitsturen — toewijzing verplicht',
  },
  'dispatch.parent_terminal': {
    title: 'Kon niet uitsturen — hoofdrecord is gesloten of opgelost',
  },

  // ─── Phase 1 legacy snake_case (renamed in 7.A.2) ────────────────────────
  insert_failed: {
    title: 'Kon de reservering niet aanmaken',
    detail: 'Probeer het opnieuw. Blijft dit gebeuren, neem dan contact op met support.',
  },
  reservation_slot_conflict: {
    title: 'Kon niet boeken — tijdconflict',
    detail: 'De gekozen ruimte is op dat tijdstip al geboekt.',
  },
  override_reason_required: {
    title: 'Kon niet boeken — overschrijfreden verplicht',
  },
  multi_room_recurrence_unsupported: {
    title: 'Kon niet boeken — herhaling met meerdere ruimtes wordt niet ondersteund',
  },
  wrong_endpoint: {
    title: 'Kon niet bijwerken — verkeerd endpoint',
  },
  recurrence_unavailable: {
    title: 'Herhaling is hier niet beschikbaar',
  },
  edit_scope_failed: {
    title: 'Kon die wijziging niet toepassen',
  },
  not_recurring: {
    title: 'Deze reservering herhaalt zich niet',
  },
  reservation_write_forbidden: {
    title: 'Je kunt deze reservering niet wijzigen',
  },
  invalid_input: {
    title: 'Kon niet opslaan — invoer ongeldig',
  },
  space_not_found: {
    title: 'We kunnen die ruimte niet vinden',
  },
  space_inactive: {
    title: 'Die ruimte is inactief',
  },
  space_not_reservable: {
    title: 'Die ruimte is niet boekbaar',
  },
  permission_denied: {
    title: 'Je hebt geen toegang hiertoe',
  },

  // ─── space module migration (Phase 7.B-1.space) ──────────────────────────
  'space.not_found': {
    title: 'Kon die ruimte niet vinden',
  },
  'space.parent_not_found': {
    title: 'Kon de bovenliggende ruimte niet vinden',
  },
  'space.invalid_root_type': {
    title: 'Kon die ruimte niet bovenaan plaatsen',
    detail: 'Dat ruimtetype heeft een bovenliggende ruimte nodig.',
  },
  'space.invalid_parent_type': {
    title: 'Kon die ruimte niet onder die bovenliggende plaatsen',
    detail: 'Dat ruimtetype is niet toegestaan onder die bovenliggende.',
  },

  // ─── reporting module migration (Phase 7.B-1.reporting) ──────────────────
  'report.invalid_date_range': {
    title: 'Kon dat rapport niet uitvoeren',
    detail: 'De "van"-datum moet op of vóór de "tot"-datum liggen.',
  },
  'report.window_too_large': {
    title: 'Kon dat rapport niet uitvoeren',
    detail: 'Datumbereik is te lang. Probeer 365 dagen of minder.',
  },
  'report.rpc_failed': {
    title: 'Kon dat rapport niet uitvoeren',
  },
  'report.invalid_date': {
    title: 'Kon dat rapport niet uitvoeren',
    detail: 'Gebruik een datum in JJJJ-MM-DD-formaat.',
  },

  // ─── portal-announcements (Phase 7.B-1.portal-announcements) ─────────────
  'announcement.list_failed': {
    title: 'Kon de mededelingen niet laden',
  },
  'announcement.publish_failed': {
    title: 'Kon die mededeling niet publiceren',
  },
  'announcement.unpublish_failed': {
    title: 'Kon die mededeling niet depubliceren',
  },
  'announcement.invalid_payload': {
    title: 'Kon die mededeling niet publiceren',
    detail: 'Locatie, titel en tekst zijn verplicht.',
  },
  'announcement.insert_no_row': {
    title: 'Kon die mededeling niet opslaan',
  },

  // ─── person (Phase 7.B-1.person) ─────────────────────────────────────────
  'person.org_change_in_progress': {
    title: 'Kon de organisatie van die persoon niet wijzigen',
    detail: 'Een andere organisatiewijziging voor deze persoon is bezig. Herlaad en probeer het opnieuw.',
  },

  // ─── org-node (Phase 7.B-1.org-node) ─────────────────────────────────────
  'org_node.not_found': {
    title: 'Kon dat organisatieknooppunt niet vinden',
  },
  'org_node.name_required': {
    title: 'Kon dat organisatieknooppunt niet opslaan',
    detail: 'Naam is verplicht.',
  },
  'org_node.create_failed': {
    title: 'Kon dat organisatieknooppunt niet aanmaken',
  },
  'org_node.update_failed': {
    title: 'Kon dat organisatieknooppunt niet bijwerken',
  },
  'org_node.delete_failed': {
    title: 'Kon dat organisatieknooppunt niet verwijderen',
  },
  'org_node.has_children': {
    title: 'Kon niet verwijderen — heeft onderliggende knooppunten',
    detail: 'Verplaats of verwijder de onderliggende knooppunten voordat je dit verwijdert.',
  },
  'org_node.add_member_failed': {
    title: 'Kon dat lid niet toevoegen',
  },
  'org_node.add_grant_failed': {
    title: 'Kon die locatietoekenning niet toevoegen',
  },

  // ─── work-orders (Phase 7.B-1.work-orders) ───────────────────────────────
  'work_order.not_found': {
    title: 'Kon die werkbon niet vinden',
  },
  'work_order.body_required': {
    title: 'Kon die werkbon niet bijwerken',
    detail: 'Verzoekbody is verplicht.',
  },
  'work_order.empty_update': {
    title: 'Kon die werkbon niet bijwerken',
    detail: 'Minimaal één veld moet wijzigen.',
  },
  'work_order.field_invalid': {
    title: 'Kon die werkbon niet bijwerken',
    detail: 'Een van de velden heeft het verkeerde type.',
  },
  'work_order.title_empty': {
    title: 'Kon die werkbon niet bijwerken',
    detail: 'Titel mag niet leeg zijn.',
  },
  'work_order.priority_invalid': {
    title: 'Kon die werkbon niet bijwerken',
    detail: 'Prioriteit moet low, medium, high of critical zijn.',
  },
  'work_order.cost_invalid': {
    title: 'Kon die werkbon niet bijwerken',
    detail: 'Kosten moeten een eindig getal of leeg zijn.',
  },
  'work_order.tags_invalid': {
    title: 'Kon die werkbon niet bijwerken',
    detail: 'Tags moeten een lijst met tekstwaarden zijn.',
  },
  'work_order.watchers_invalid': {
    title: 'Kon die werkbon niet bijwerken',
    detail: 'Volgers moeten een lijst met persoons-ID\'s zijn.',
  },
  'work_order.duration_invalid': {
    title: 'Kon die werkbon niet bijwerken',
    detail: 'Geplande duur moet een positief geheel aantal minuten zijn.',
  },
  'work_order.planned_start_invalid': {
    title: 'Kon die werkbon niet bijwerken',
    detail: 'Geplande start moet een geldige tijdstempel zijn.',
  },
  'work_order.sla_unknown': {
    title: 'Kon die werkbon niet bijwerken',
    detail: 'Dat SLA-beleid hoort niet bij deze werkruimte.',
  },
  'work_order.assignee_uuid_invalid': {
    title: 'Kon die werkbon niet bijwerken',
    detail: 'Toewijzings-ID is geen geldige UUID.',
  },
  'work_order.no_longer_accessible': {
    title: 'Je hebt geen toegang tot deze werkbon',
  },
  'work_order.permission_sla_override': {
    title: 'Je kunt de SLA op deze werkbon niet wijzigen',
  },
  'work_order.permission_priority_change': {
    title: 'Je kunt de prioriteit op deze werkbon niet wijzigen',
  },
  'work_order.permission_assign': {
    title: 'Je kunt deze werkbon niet toewijzen',
  },
  'work_order.empty_status_update': {
    title: 'Kon die werkbon niet bijwerken',
    detail: 'Minimaal één van status, status_category of waiting_reason is verplicht.',
  },
  'work_order.empty_assignment_update': {
    title: 'Kon die werkbon niet bijwerken',
    detail: 'Minimaal één van assigned_team_id, assigned_user_id of assigned_vendor_id is verplicht.',
  },
  'work_order.empty_metadata_update': {
    title: 'Kon die werkbon niet bijwerken',
    detail: 'Minimaal één van title, description, cost, tags of watchers is verplicht.',
  },
  'work_order.reassign_reason_required': {
    title: 'Kon die werkbon niet opnieuw toewijzen',
    detail: 'Reden voor hertoewijzing is verplicht.',
  },
  'work_order.rerun_resolver_unsupported': {
    title: 'Kon die werkbon niet opnieuw toewijzen',
    detail: 'De auto-resolver wordt nog niet ondersteund voor werkbonnen. Geef een expliciete toewijzing op.',
  },

  // ─── user-management (Phase 7.B-1.user-management) ───────────────────────
  'user_management.invalid_permission_key': {
    title: 'Kon die rol niet opslaan',
    detail: 'Een van de rechtensleutels is ongeldig.',
  },

  // ─── service-catalog (Phase 7.B-1.service-catalog) ───────────────────────
  service_rule_not_found: {
    title: 'Kon die serviceregel niet vinden',
  },
  name_required: {
    title: 'Kon niet opslaan',
    detail: 'Naam is verplicht.',
  },
  invalid_predicate: {
    title: 'Kon die regel niet opslaan',
    detail: 'De regelpredicate is ongeldig.',
  },
  target_id_required: {
    title: 'Kon die regel niet opslaan',
    detail: 'Doel-ID is verplicht wanneer target_kind niet tenant is.',
  },
  target_kind_required: {
    title: 'Kon die regel niet opslaan',
    detail: 'Doelsoort is verplicht.',
  },
  effect_required: {
    title: 'Kon die regel niet opslaan',
    detail: 'Effect is verplicht.',
  },
  invalid_lead_time: {
    title: 'Kon die regel niet opslaan',
    detail: 'Doorlooptijd moet een niet-negatief geheel getal tot 1440 minuten zijn.',
  },
  template_required: {
    title: 'Kon die regel niet aanmaken',
    detail: 'Een sjabloonsleutel is verplicht.',
  },
  template_not_found: {
    title: 'Kon dat sjabloon niet vinden',
  },
  invalid_compiled_predicate: {
    title: 'Kon die regel niet aanmaken',
    detail: 'Het sjabloon resulteerde in een ongeldige predicate.',
  },
  param_required: {
    title: 'Kon die regel niet aanmaken',
    detail: 'Een verplichte sjabloonparameter ontbreekt.',
  },
  invalid_payload: {
    title: 'Kon dat verzoek niet verwerken',
    detail: 'Verzoekbody is verplicht.',
  },
  missing_delivery_space: {
    title: 'Kon services niet laden',
    detail: 'Een leverlocatie is verplicht.',
  },
  missing_service_type: {
    title: 'Kon services niet laden',
    detail: 'Een servicetype is verplicht.',
  },

  // ─── portal-appearance (Phase 7.B-1.portal-appearance) ───────────────────
  'portal_appearance.location_required': {
    title: 'Kon weergave niet bijwerken',
    detail: 'Locatie is verplicht.',
  },
  'portal_appearance.file_required': {
    title: 'Kon die afbeelding niet uploaden',
    detail: 'Een bestand is verplicht.',
  },
  'portal_appearance.unsupported_mime': {
    title: 'Kon die afbeelding niet uploaden',
    detail: 'Dit bestandstype wordt niet ondersteund.',
  },
  'portal_appearance.file_too_large': {
    title: 'Kon die afbeelding niet uploaden',
    detail: 'Dat bestand is te groot.',
  },
  'portal_appearance.list_failed': {
    title: 'Kon de portalweergave niet laden',
  },
  'portal_appearance.upsert_failed': {
    title: 'Kon de portalweergave niet opslaan',
  },
  'portal_appearance.upsert_no_row': {
    title: 'Kon de portalweergave niet opslaan',
  },
  'portal_appearance.upload_failed': {
    title: 'Kon die afbeelding niet uploaden',
  },
  'portal_appearance.delete_failed': {
    title: 'Kon de portalweergave niet verwijderen',
  },

  // ─── outbox (Phase 7.B-1.outbox) ─────────────────────────────────────────
  'outbox.duplicate_handler': {
    title: 'Kon de worker niet starten',
    detail: 'Een dubbele outbox-handler is geregistreerd.',
  },

  // ─── cost-centers (Phase 7.B-1.cost-centers) ─────────────────────────────
  cost_center_not_found: {
    title: 'Kon die kostenplaats niet vinden',
  },
  cost_center_code_taken: {
    title: 'Kon die kostenplaats niet opslaan',
    detail: 'Er bestaat al een kostenplaats met die code.',
  },
  code_required: {
    title: 'Kon niet opslaan',
    detail: 'Code is verplicht.',
  },
  code_too_long: {
    title: 'Kon niet opslaan',
    detail: 'Code mag maximaal 32 tekens bevatten.',
  },

  // ─── bundle-templates (Phase 7.B-1.bundle-templates) ─────────────────────
  bundle_template_not_found: {
    title: 'Kon dat bundle-sjabloon niet vinden',
  },
  invalid_services: {
    title: 'Kon dat sjabloon niet opslaan',
    detail: 'Services moeten een lijst zijn.',
  },
  invalid_service_line: {
    title: 'Kon dat sjabloon niet opslaan',
    detail: 'Elke serviceregel heeft een catalogusitem nodig.',
  },

  // ─── auth (Phase 7.B-1.auth) ─────────────────────────────────────────────
  'auth.missing_header': {
    title: 'Meld je opnieuw aan',
    detail: 'Authenticatie is verplicht.',
  },
  'auth.invalid_token': {
    title: 'Meld je opnieuw aan',
    detail: 'Je sessie is niet meer geldig.',
  },
  'auth.role_lookup_failed': {
    title: 'Kon toegang niet verifiëren',
  },
  'auth.user_not_in_tenant': {
    title: 'Je hebt hier geen toegang',
  },
  'auth.admin_required': {
    title: 'Je hebt geen toegang hiertoe',
    detail: 'Een beheerdersrol is vereist.',
  },

  // ─── webhook (Phase 7.B-1.webhook) ───────────────────────────────────────
  'webhook.not_found': {
    title: 'Kon die webhook niet vinden',
  },
  'webhook.tenant_resolution_failed': {
    title: 'Kon die webhook niet verwerken',
    detail: 'Werkruimte kon niet worden bepaald.',
  },
  'webhook.invalid_mapping': {
    title: 'Kon die webhook-mapping niet opslaan',
  },
  'webhook.missing_api_key': {
    title: 'Authenticatie vereist',
    detail: 'Bearer-API-sleutel ontbreekt.',
  },
  'webhook.invalid_api_key': {
    title: 'Authenticatie mislukt',
    detail: 'Ongeldige API-sleutel.',
  },
  'webhook.inactive': {
    title: 'Webhook niet beschikbaar',
    detail: 'Die webhook is inactief.',
  },
  'webhook.source_ip_unresolvable': {
    title: 'Webhook niet beschikbaar',
    detail: 'Bron-IP kon niet worden bepaald.',
  },
  'webhook.source_ip_not_permitted': {
    title: 'Webhook niet beschikbaar',
    detail: 'Bron-IP is niet toegestaan.',
  },

  // ─── tenant (Phase 7.B-1.tenant) ─────────────────────────────────────────
  'tenant.not_found': { title: 'Kon die werkruimte niet vinden' },
  'tenant.name_required': { title: 'Kon niet opslaan', detail: 'Naam is verplicht.' },
  'tenant.name_too_long': { title: 'Kon niet opslaan', detail: 'Naam is te lang.' },
  'tenant.invalid_theme_mode': {
    title: 'Kon niet opslaan',
    detail: 'Themamodus moet light, dark of system zijn.',
  },
  'tenant.invalid_color': { title: 'Kon niet opslaan', detail: 'Ongeldige kleurwaarde.' },
  'tenant.invalid_image_kind': {
    title: 'Kon die afbeelding niet uploaden',
    detail: 'Soort moet light, dark of favicon zijn.',
  },
  'tenant.file_required': { title: 'Kon die afbeelding niet uploaden', detail: 'Een bestand is verplicht.' },
  'tenant.invalid_svg': {
    title: 'Kon die afbeelding niet uploaden',
    detail: 'Bestand lijkt geen SVG te zijn.',
  },
  'tenant.update_failed': {
    title: 'Kon werkruimte niet bijwerken',
    detail: 'Probeer opnieuw. Blijft het mislukken, neem contact op met support.',
  },
  'tenant.upload_failed': { title: 'Kon die afbeelding niet uploaden' },

  // ─── workflow (Phase 7.B-1.workflow) ─────────────────────────────────────
  'workflow.not_found': { title: 'Kon die workflow niet vinden' },
  'workflow.invalid': {
    title: 'Kon die workflow niet opslaan',
    detail: 'De workflow-definitie is ongeldig.',
  },
  'workflow_instance.not_found': { title: 'Kon die workflow-uitvoering niet vinden' },

  // ─── service-routing (Phase 7.B-1.service-routing) ───────────────────────
  service_routing_not_found: { title: 'Kon die routingregel niet vinden' },
  service_routing_duplicate: {
    title: 'Kon die routingregel niet opslaan',
    detail: 'Voor die service bestaat al een routingregel.',
  },
  service_routing_immutable_key: {
    title: 'Kon die routingregel niet bijwerken',
    detail: 'De servicecategorie kan na aanmaken niet meer worden gewijzigd.',
  },
  invalid_foreign_key: {
    title: 'Kon niet opslaan',
    detail: 'Een verwezen item zit niet in deze werkruimte.',
  },
  invalid_service_category: {
    title: 'Kon die routingregel niet opslaan',
    detail: 'Ongeldige servicecategorie.',
  },
  setup_routing_failed: { title: 'Kon de setup-routing niet bepalen' },

  // ─── portal (Phase 7.B-1.portal) ─────────────────────────────────────────
  'portal.no_linked_person': {
    title: 'Geen profiel gevonden',
    detail: 'Je account is niet gekoppeld aan een persoonsrecord.',
  },
  'portal.no_user_in_tenant': {
    title: 'Geen gebruiker in deze werkruimte',
  },
  'portal.person_not_found': { title: 'Kon die persoon niet vinden' },
  'portal.user_not_found': { title: 'Kon die gebruiker niet vinden' },
  'portal.parent_space_not_found': { title: 'Kon die bovenliggende locatie niet vinden' },
  'portal.request_type_not_found': { title: 'Kon dat aanvraagtype niet vinden' },
  'portal.field_required': { title: 'Kon dat verzoek niet verwerken', detail: 'Een verplicht veld ontbreekt.' },
  'portal.unsupported_media_type': { title: 'Kon die afbeelding niet uploaden', detail: 'Bestandstype wordt niet ondersteund.' },
  'portal.avatar_too_large': { title: 'Kon die afbeelding niet uploaden', detail: 'Avatar is te groot.' },
  'portal.location_not_authorized': { title: 'Je hebt geen toegang tot deze locatie' },
  'portal.self_onboard_disabled': { title: 'Self-onboarding is uitgeschakeld' },
  'portal.self_onboard_forbidden_person_type': {
    title: 'Kon dat profiel niet aanmaken',
    detail: 'Dat persoonstype is niet toegestaan voor self-onboarding.',
  },
  'portal.default_already_set': {
    title: 'Kon standaard niet wijzigen',
    detail: 'Voor deze persoon is al een standaardlocatie ingesteld.',
  },
  'portal.grants_exist': {
    title: 'Kon standaarden niet wijzigen',
    detail: 'Er zijn andere locatietoekenningen voor deze persoon.',
  },
  'portal.requestable_failed': { title: 'Kon aanvraagtypes niet laden' },
  'portal.request_type_required': {
    title: 'Kon niet indienen',
    detail: 'Een aanvraagtype is verplicht.',
  },
  'portal.asset_not_found': { title: 'Kon dat asset niet vinden' },

  // ─── orders (Phase 7.B-1.orders) ─────────────────────────────────────────
  no_lines: { title: 'Kon niet indienen', detail: 'Minimaal één orderregel is verplicht.' },
  missing_location: {
    title: 'Kon niet indienen',
    detail: 'Leverlocatie is verplicht.',
  },
  missing_window: {
    title: 'Kon niet indienen',
    detail: 'Gewenst tijdvenster is verplicht.',
  },
  no_person: { title: 'Geen profiel gevonden', detail: 'Je account is niet gekoppeld aan een persoon.' },
  no_user: { title: 'Geen gebruikersrecord gevonden' },
  order_not_found: { title: 'Kon die order niet vinden' },
  master_order_not_found: { title: 'Kon die hoofdorder niet vinden' },
  line_not_editable: {
    title: 'Kon die orderregel niet bijwerken',
    detail: 'Deze regel kan niet meer worden gewijzigd.',
  },
  'orders.not_implemented': {
    title: 'Die functie is nog niet beschikbaar',
  },
  'orders.approval_routing_failed': {
    title: 'Kon de goedkeuringsroute niet bepalen',
  },

  // ─── daily-list (Phase 7.B-1.daily-list) ─────────────────────────────────
  'daily_list.pdf_renderer_unavailable': {
    title: 'Kon PDF niet genereren',
    detail: 'PDF-rendering is momenteel niet beschikbaar.',
  },
  'daily_list.line_not_found': { title: 'Kon die regel niet vinden' },
  'daily_list.invalid_payload': { title: 'Kon dat verzoek niet verwerken' },
  'daily_list.invalid_date': { title: 'Kon dat verzoek niet verwerken', detail: 'Ongeldig datumformaat.' },
  'daily_list.body_required': { title: 'Kon dat verzoek niet verwerken', detail: 'Verzoekbody is verplicht.' },
  'daily_list.field_required': { title: 'Kon dat verzoek niet verwerken', detail: 'Een verplicht veld ontbreekt.' },
  'daily_list.mailer_failed': { title: 'Kon die e-mail niet verzenden' },
  'daily_list.vendor_not_found': { title: 'Kon die leverancier niet vinden' },
  'daily_list.invalid_vendor': { title: 'Kon dat verzoek niet verwerken', detail: 'Leverancier is niet ingericht voor daglijsten.' },
  'daily_list.not_found': { title: 'Kon die daglijst niet vinden' },
  'daily_list.upload_failed': { title: 'Kon PDF niet uploaden' },
  'daily_list.signed_url_failed': { title: 'Kon ondertekende link niet genereren' },
  'daily_list.no_email': {
    title: 'Kon daglijst niet verzenden',
    detail: 'Leverancier heeft geen e-mailadres geconfigureerd.',
  },
  'daily_list.send_failed': {
    title: 'Kon daglijst niet verzenden',
    detail: 'Probeer opnieuw vanuit de daglijstpagina of neem contact op met support.',
  },
  'daily_list.pdf_missing': { title: 'Kon daglijst niet renderen', detail: 'PDF-opslagpad ontbreekt.' },

  // ─── config-engine (Phase 7.B-1.config-engine) ───────────────────────────
  'config_engine.invalid_expression': { title: 'Kon niet opslaan', detail: 'Ongeldige expressie.' },
  'config_engine.criteria_set_not_found': { title: 'Kon die criteriaset niet vinden' },
  'config_engine.entity_not_found': { title: 'Kon die config-entiteit niet vinden' },
  'config_engine.draft_not_found': { title: 'Kon geen concept vinden' },
  'config_engine.no_draft_to_publish': { title: 'Kon niet publiceren', detail: 'Geen concept om te publiceren.' },
  'config_engine.version_not_found': { title: 'Kon die versie niet vinden' },
  'config_engine.invalid_hierarchy': {
    title: 'Kon niet opslaan',
    detail: 'Ongeldige catalogushiërarchie.',
  },
  'config_engine.invalid_cover_source': {
    title: 'Kon niet opslaan',
    detail: 'cover_source moet image, icon of leeg zijn.',
  },
  'config_engine.file_required': { title: 'Kon die afbeelding niet uploaden', detail: 'Een bestand is verplicht.' },
  'config_engine.unsupported_mime': { title: 'Kon die afbeelding niet uploaden', detail: 'Bestandstype wordt niet ondersteund.' },
  'config_engine.file_too_large': { title: 'Kon die afbeelding niet uploaden', detail: 'Bestand is te groot.' },
  'config_engine.upload_failed': { title: 'Kon die afbeelding niet uploaden' },
  'config_engine.update_failed': { title: 'Kon niet bijwerken' },
  'config_engine.category_not_found': { title: 'Kon die categorie niet vinden' },
  'config_engine.invalid_request_type': { title: 'Kon dat aanvraagtype niet opslaan' },
  'config_engine.request_type_not_found': { title: 'Kon dat aanvraagtype niet vinden' },
  'config_engine.invalid_scope': {
    title: 'Kon niet opslaan',
    detail: 'Bereik is ongeldig.',
  },
  'config_engine.invalid_handler': {
    title: 'Kon niet opslaan',
    detail: 'Handler-configuratie is ongeldig.',
  },

  // ─── calendar-sync (Phase 7.B-1.calendar-sync) ───────────────────────────
  'calendar_sync.no_auth': { title: 'Meld je opnieuw aan' },
  'calendar_sync.invalid_state': { title: 'Kon aanmelden niet voltooien', detail: 'OAuth-state is onbekend of verlopen.' },
  'calendar_sync.state_user_mismatch': { title: 'Kon aanmelden niet voltooien', detail: 'OAuth-state hoort bij een andere gebruiker.' },
  'calendar_sync.no_link': { title: 'Geen agenda gekoppeld' },
  'calendar_sync.conflict_not_found': { title: 'Kon dat conflict niet vinden' },
  'calendar_sync.conflict_not_open': { title: 'Kon dat conflict niet bijwerken', detail: 'Conflict is niet meer open.' },
  'calendar_sync.link_not_found': { title: 'Kon die agendakoppeling niet vinden' },
  'calendar_sync.no_user_in_tenant': { title: 'Geen gebruiker in deze werkruimte' },
  'calendar_sync.token_failed': { title: 'Kon tokens niet verwerken' },
  'calendar_sync.graph_failed': { title: 'Kon de agendaservice niet bereiken' },
  'calendar_sync.config_missing': { title: 'Agendasynchronisatie is niet geconfigureerd' },

  // ─── room-booking-rules (Phase 7.B-1.room-booking-rules) ─────────────────
  'room_rule.template_param_required': { title: 'Kon sjabloon niet toepassen', detail: 'Een verplichte parameter ontbreekt.' },
  'room_rule.template_invalid': { title: 'Kon sjabloon niet toepassen' },
  'room_rule.invalid_predicate': { title: 'Kon niet opslaan', detail: 'Predicate is ongeldig.' },
  'room_rule.scenario_not_found': { title: 'Kon dat scenario niet vinden' },
  'room_rule.not_found': { title: 'Kon die regel niet vinden' },
  'room_rule.version_not_found': { title: 'Kon die versie niet vinden' },
  'room_rule.invalid_effect': { title: 'Kon niet opslaan', detail: 'Effect is ongeldig.' },
  'room_rule.name_required': { title: 'Kon niet opslaan', detail: 'Naam is verplicht.' },
  'room_rule.invalid_scope': { title: 'Kon niet opslaan', detail: 'Bereik is ongeldig.' },
  'room_rule.space_not_found': { title: 'Kon die ruimte niet vinden' },
  'room_rule.impact_failed': { title: 'Kon impact niet voorberekenen' },

  // ─── vendor-portal (Phase 7.B-1.vendor-portal) ───────────────────────────
  'vendor_portal.order_not_found': { title: 'Kon die order niet vinden' },
  'vendor_portal.invalid_email': { title: 'Kon niet opslaan', detail: 'Dat e-mailadres lijkt ongeldig.' },
  'vendor_portal.invalid_role': { title: 'Kon niet opslaan', detail: 'Rol moet fulfiller of manager zijn.' },
  'vendor_portal.invite_failed': { title: 'Kon die uitnodiging niet verzenden' },
  'vendor_portal.user_create_failed': { title: 'Kon die leveranciersgebruiker niet aanmaken' },
  'vendor_portal.user_not_found': { title: 'Kon die leveranciersgebruiker niet vinden' },
  'vendor_portal.user_deactivated': { title: 'Account gedeactiveerd' },
  'vendor_portal.user_locked': { title: 'Account tijdelijk vergrendeld' },
  'vendor_portal.magic_link_invalid': {
    title: 'Kon niet aanmelden',
    detail: 'Magic link is ongeldig, verlopen of al gebruikt.',
  },
  'vendor_portal.user_missing': { title: 'Kon niet aanmelden' },
  'vendor_portal.token_required': { title: 'Kon niet verwerken', detail: 'Token is verplicht.' },
  'vendor_portal.no_session': { title: 'Meld je opnieuw aan' },
  'vendor_portal.session_invalid': { title: 'Meld je opnieuw aan', detail: 'Sessie is ongeldig of verlopen.' },
  'vendor_portal.field_required': { title: 'Kon niet verwerken', detail: 'Een verplicht veld ontbreekt.' },
  'vendor_portal.invalid_status': { title: 'Kon status niet bijwerken' },
  'vendor_portal.invalid_transition': { title: 'Kon status niet bijwerken', detail: 'Die statusovergang is niet toegestaan.' },
  'vendor_portal.decline_reason_required': {
    title: 'Kon niet weigeren',
    detail: 'Een reden van minimaal 8 tekens is verplicht.',
  },

  // ─── privacy-compliance (Phase 7.B-1.privacy-compliance) ─────────────────
  'privacy.invalid_payload': { title: 'Kon dat verzoek niet verwerken' },
  'privacy.reason_required': { title: 'Kon niet verwerken', detail: 'Een reden is verplicht.' },
  'privacy.hold_create_failed': { title: 'Kon die juridische bewaring niet aanmaken' },
  'privacy.hold_not_found': { title: 'Kon die juridische bewaring niet vinden' },
  'privacy.retention_not_found': { title: 'Kon die bewaarinstellingen niet vinden' },
  'privacy.retention_invalid': { title: 'Kon bewaartermijn niet bijwerken' },
  'privacy.dsr_not_found': { title: 'Kon die DSR niet vinden' },
  'privacy.dsr_invalid_state': { title: 'Kon die DSR niet bijwerken' },
  'privacy.dsr_create_failed': { title: 'Kon die DSR niet aanmaken' },
  'privacy.bundle_upload_failed': {
    title: 'Kon bundel niet uploaden',
    detail: 'Probeer opnieuw. De export start opnieuw vanaf het begin.',
  },
  'privacy.signed_url_failed': {
    title: 'Kon ondertekende link niet genereren',
    detail: 'Probeer opnieuw. Blijft het mislukken, neem contact op met support.',
  },
  'privacy.subject_not_found': { title: 'Kon die betrokkene niet vinden' },
  'privacy.unknown_data_category': { title: 'Kon niet verwerken', detail: 'Onbekende datacategorie.' },

  // ─── routing (Phase 7.B-1.routing) ───────────────────────────────────────
  'routing.field_required': { title: 'Kon niet verwerken', detail: 'Een verplicht veld ontbreekt.' },
  'routing.body_required': { title: 'Kon niet verwerken', detail: 'Verzoekbody is verplicht.' },
  'routing.db_failed': { title: 'Kon dat verzoek niet verwerken' },
  'routing.not_found': { title: 'Kon dat record niet vinden' },
  'routing.invalid_definition': { title: 'Kon niet opslaan', detail: 'Ongeldige definitie.' },
  'routing.invalid_state': { title: 'Kon niet verwerken', detail: 'Ongeldige status voor deze actie.' },
  'routing.duplicate': { title: 'Kon niet opslaan', detail: 'Een duplicaat bestaat al.' },
  'routing.v2_not_implemented': { title: 'Die functie is nog niet beschikbaar' },

  // ─── common (Phase 7.B-1.common) ─────────────────────────────────────────
  'person.not_found': { title: 'Kon die persoon niet vinden' },
  'tenant.unknown': { title: 'Kon die werkruimte niet vinden' },
  'mail.config_missing': { title: 'Kon die e-mail niet verzenden', detail: 'E-mailprovider is niet geconfigureerd.' },
  'mail.dispatch_failed': { title: 'Kon die e-mail niet verzenden' },
  'mail.invalid_recipient': { title: 'Kon die e-mail niet verzenden', detail: 'Geadresseerde is ongeldig.' },
  'mail.webhook_unauthorized': { title: 'Webhook-authenticatie mislukt' },
  'mail.webhook_invalid': { title: 'Webhook-verzoek ongeldig' },
  'reference.field_invalid': { title: 'Kon niet opslaan', detail: 'Een verwezen veld is ongeldig.' },
  'reference.invalid_array_size': { title: 'Kon niet opslaan', detail: 'Lijst overschrijdt de toegestane grootte.' },
  'client_request_id.required': {
    title: 'Kon niet verwerken',
    detail: 'Voor deze actie is een client-request-ID verplicht.',
  },
  'client_request_id.invalid': {
    title: 'Kon niet verwerken',
    detail: 'Client-request-ID is ongeldig.',
  },

  // ─── visitors (Phase 7.B-1.visitors) ─────────────────────────────────────
  'visitor.not_found': { title: 'Kon die bezoeker niet vinden' },
  'visitor.invalid_payload': { title: 'Kon dat verzoek niet verwerken' },
  'visitor.invalid_state': { title: 'Kon die bezoeker niet bijwerken', detail: 'Die statusovergang is niet toegestaan.' },
  'visitor.forbidden': { title: 'Je hebt geen toegang hiertoe' },
  'visitor.unauthorized': { title: 'Meld je opnieuw aan' },
  'visitor.conflict': { title: 'Kon niet opslaan', detail: 'Conflict met bestaande gegevens.' },
  'visitor.field_required': { title: 'Kon niet verwerken', detail: 'Een verplicht veld ontbreekt.' },
  'visitor.invalid_uuid': { title: 'Kon niet verwerken', detail: 'Ongeldige UUID.' },
  'visitor.duplicate': { title: 'Kon niet opslaan', detail: 'Een duplicaat bestaat al.' },
  'visitor.host_not_found': { title: 'Kon die host niet vinden' },
  'visitor.kiosk_unauthorized': { title: 'Kiosk-authenticatie mislukt' },
  'visitor.pass_not_found': { title: 'Kon die pas niet vinden' },
  'visitor.pass_unavailable': { title: 'Pas niet beschikbaar' },
  'visitor.invitation_not_found': { title: 'Kon die uitnodiging niet vinden' },
  'visitor.reception_failed': { title: 'Kon niet verwerken bij de receptie' },
  'visitor.notification_failed': { title: 'Kon notificatie niet verzenden' },
  'visitor.invalid_token': { title: 'Uitnodigingslink is ongeldig', detail: 'Deze link is verlopen of niet meer geldig.' },
  'visitor.config_missing': { title: 'Kon niet verwerken', detail: 'Bezoekersservice is niet geconfigureerd.' },
  // Phase 7.B-1 review fixes (status-class drift)
  'visitor.host_required': { title: 'Je hebt geen toegang hiertoe', detail: 'Je bent geen host voor dit bezoek.' },
  'visitor.tenant_mismatch': { title: 'Kon die bezoeker niet vinden' },
  'visitor_type.not_found': { title: 'Kon dat bezoekerstype niet vinden' },
  'visitor_pass.not_found': { title: 'Kon die pas niet vinden' },
  'kiosk_token.not_found': { title: 'Kon die kiosk niet vinden' },
  'pool_anchor.not_found': { title: 'Kon die ankerruimte niet vinden' },
  'pool_anchor.invalid': { title: 'Kon niet verwerken', detail: 'Pool-anker moet een site of gebouw zijn.' },
  // B.2.A §3.1 transition_entity_status RPC
  'transition_entity_status.unknown_kind': { title: 'Kon niet bijwerken', detail: 'Onbekend entiteitstype.' },
  'transition_entity_status.not_found': { title: 'Ticket niet gevonden' },
  'transition_entity_status.has_open_children': { title: 'Kon niet sluiten', detail: 'Deze case heeft openstaande werkbonnen.' },
  'transition_entity_status.invalid_status': { title: 'Kon niet bijwerken', detail: 'Ongeldige status.' },
  'transition_entity_status.invalid_status_category': { title: 'Kon niet bijwerken', detail: 'Ongeldige statuscategorie.' },
  'command_operations.payload_mismatch': { title: 'Dubbel verzoek met andere payload.', detail: 'Je client gebruikte dezelfde X-Client-Request-Id header voor twee verschillende verzoeken. Genereer een nieuwe request-id en probeer opnieuw.' },
  'command_operations.unexpected_state': { title: 'Kon niet herhalen', detail: 'Onverwachte status van de vorige poging.' },
  'command_operations.client_request_id_required': { title: 'Kon niet bijwerken', detail: 'Verzoek ontbreekt de X-Client-Request-Id header.' },
  'work_order.parent_terminal': { title: 'Kon niet toevoegen aan gesloten case' },
  // B.2.A §3.2 set_entity_assignment RPC (00326)
  'set_entity_assignment.unknown_kind': { title: 'Kon niet bijwerken', detail: 'Onbekend entiteitstype.' },
  'set_entity_assignment.not_found': { title: 'Ticket niet gevonden' },
  'set_entity_assignment.resolver_rerun_not_supported_at_rpc': {
    title: 'Kon niet bijwerken',
    detail: 'Server kan routing niet opnieuw draaien — interne fout: een orchestratiestap is overgeslagen.',
  },
  // B.2.A §3.3 update_entity_sla RPC (00328)
  'update_entity_sla.unknown_kind': { title: 'Kon SLA niet bijwerken', detail: 'Onbekend entiteitstype.' },
  'update_entity_sla.not_found': { title: 'Ticket niet gevonden' },
  'update_entity_sla.timers_required': {
    title: 'Kon SLA niet bijwerken',
    detail: 'Timers verplicht.',
  },
  'update_entity_sla.sla_id_required': {
    title: 'Kon SLA niet bijwerken',
    detail: 'sla_id is verplicht.',
  },
  // B.2.A §3.0 update_entity_combined RPC (00331)
  'update_entity_combined.unknown_kind': { title: 'Kon niet bijwerken', detail: 'Onbekend entiteitstype.' },
  'update_entity_combined.not_found': { title: 'Ticket niet gevonden' },
  'update_entity_combined.invalid_patches': { title: 'Kon niet bijwerken', detail: 'De patch-payload moet een JSON-object zijn.' },
  'update_entity_combined.plan_not_supported_on_case': {
    title: 'Kon niet bijwerken',
    detail: 'Plandata kun je alleen op werkbonnen instellen.',
  },
  'update_entity_combined.invalid_priority': {
    title: 'Kon niet bijwerken',
    detail: 'Prioriteit moet low, medium, high of critical zijn.',
  },
  'update_entity_combined.invalid_metadata': {
    title: 'Kon niet bijwerken',
    detail: 'Titel mag niet leeg zijn.',
  },
  'update_entity_combined.invalid_cost': {
    title: 'Kon niet bijwerken',
    detail: 'Kosten moeten een niet-negatief getal zijn.',
  },
  'update_entity_combined.invalid_watcher': {
    title: 'Kon niet bijwerken',
    detail: 'Een of meer volgers horen niet bij deze tenant.',
  },
  'update_entity_combined.invalid_plan': {
    title: 'Kon niet bijwerken',
    detail: 'Plandata moeten een geldige ISO-tijdstempel zijn en duur moet een niet-negatief geheel getal zijn.',
  },

  // B.2.A §3.4 dispatch_child_work_order RPC (00338 / 00339)
  'dispatch_child_work_order.parent_not_found': { title: 'Case niet gevonden' },
  'dispatch_child_work_order.parent_not_dispatchable': {
    title: 'Kan geen werkorder uitdelen',
    detail: 'Deze case wacht op goedkeuring of is al afgesloten.',
  },
  'dispatch_child_work_order.invalid_payload': {
    title: 'Kan geen werkorder uitdelen',
    detail: 'De uitdeel-payload is onjuist.',
  },
  'dispatch_child_work_order.timers_required': {
    title: 'Kan geen werkorder uitdelen',
    detail: 'Er is een SLA gekozen zonder drempelwaardes. Probeer opnieuw.',
  },
  'dispatch_child_work_orders_batch.empty_tasks': {
    title: 'Kan geen werkorders uitdelen',
    detail: 'Er zijn geen taken opgegeven om uit te delen.',
  },
  'dispatch_child_work_orders_batch.invalid_payload': {
    title: 'Kan geen werkorders uitdelen',
    detail: 'De batch-payload is onjuist.',
  },
  // Tenant-FK validation helper (00317) — 422 codes.
  'validate_assignees_in_tenant.assigned_team_id_not_in_tenant': {
    title: 'Kan toewijzing niet bijwerken',
    detail: 'Het team hoort niet bij deze tenant.',
  },
  'validate_assignees_in_tenant.assigned_user_id_not_in_tenant': {
    title: 'Kan toewijzing niet bijwerken',
    detail: 'De gebruiker hoort niet bij deze tenant.',
  },
  'validate_assignees_in_tenant.assigned_vendor_id_not_in_tenant': {
    title: 'Kan toewijzing niet bijwerken',
    detail: 'De leverancier hoort niet bij deze tenant.',
  },
};

/**
 * Resolve a Dutch message for a code. Falls back to `unknown.server_error`
 * if the code isn't registered (decision #9 fail-closed). Decoupled from the
 * registry's `Set` so callers don't need to validate before lookup.
 */
export function resolveMessageNl(code: string): ErrorMessage {
  const known = ERROR_MESSAGES_NL[code as KnownErrorCode];
  if (known) return known;
  return ERROR_MESSAGES_NL['unknown.server_error'];
}
