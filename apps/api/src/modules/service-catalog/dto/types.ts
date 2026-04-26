// Internal types for ServiceCatalog. Filled in slice 2B.
export type ServiceRuleEffect = 'deny' | 'require_approval' | 'allow_override' | 'warn' | 'allow';
export type ServiceRuleTargetKind = 'catalog_item' | 'menu' | 'catalog_category' | 'tenant';
