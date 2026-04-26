// Implementation specs land in slice 2C/2D. The placeholders below mark
// the public-facing behaviour that the spec doc commits to.

describe('BundleService', () => {
  it.todo('creates a bundle on first-service-attach');
  it.todo('reuses the existing bundle when attaching another service to the same reservation');
  it.todo('cancel cascades to linked entities (reservation, orders, work-order tickets, asset reservations)');
  it.todo('respects fulfilled-line protection — cannot cancel a fulfilled order line');
  it.todo('emits bundle.created and bundle.cancelled audit events');
});
