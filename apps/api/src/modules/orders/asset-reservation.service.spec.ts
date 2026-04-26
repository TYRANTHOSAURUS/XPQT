// Implementation specs land in slice 2C. The placeholders below mark
// the conflict-guard contract surfaced by GiST exclusion in 00142.

describe('AssetReservationService', () => {
  it.todo('creates an asset_reservations row tied to an order line item');
  it.todo('rejects overlapping windows on the same asset (23P01 exclusion violation)');
  it.todo('lets cancelled reservations not block new ones (status="confirmed" only is in the GiST predicate)');
  it.todo('on conflict, returns alternative assets in the 409 response');
  it.todo('per-occurrence asset conflict marks one occurrence recurrence_skipped without blocking siblings');
});
