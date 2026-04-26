// Implementation specs land in slice 2B. The placeholders below mark the
// resolver's behavioural contract used by the booking-confirm dialog.

describe('ServiceRuleResolverService', () => {
  it.todo('resolves rules for catalog_item target_kind');
  it.todo('resolves rules for menu target_kind');
  it.todo('resolves rules for catalog_category target_kind');
  it.todo('resolves rules for tenant target_kind (the catch-all)');
  it.todo('specificity sort: catalog_item > menu > catalog_category > tenant');
  it.todo('returns no-match for booking.* paths when reservation is absent');
  it.todo('honors the predicate engine path resolver for nested attribute lookups');
});
