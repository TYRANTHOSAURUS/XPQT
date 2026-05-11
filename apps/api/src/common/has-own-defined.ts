/**
 * hasOwnDefined — DTO key-presence helper used by every §3.0
 * orchestrator caller (TicketService.update + WorkOrderService.update).
 *
 * Returns true iff `dto` has the property `key` AS ITS OWN (no
 * prototype-chain fall-through) AND the value is not `undefined`.
 *
 * Why both checks:
 *   • `hasOwnProperty` alone treats `{ title: undefined }` as a present
 *     key — that pollutes the orchestrator's payload with a metadata
 *     branch containing an empty inner DTO, causing an extra DB round-
 *     trip on a no-op (Slice 3.1 full-review #2 / 2026-04-30).
 *   • `!== undefined` alone treats keys inherited from a prototype as
 *     present — that's never what the caller meant.
 *
 * The helper is the canonical shape — case-side `buildPatchesPayloadForCase`
 * and WO-side `buildPatchesPayloadForWorkOrder` both use it so their
 * presence semantics agree by construction (plan-review F-IMP-2 /
 * 2026-05-11).
 */
export function hasOwnDefined<T extends object>(
  dto: T,
  key: PropertyKey,
): boolean {
  return (
    Object.prototype.hasOwnProperty.call(dto, key) &&
    (dto as Record<PropertyKey, unknown>)[key] !== undefined
  );
}
