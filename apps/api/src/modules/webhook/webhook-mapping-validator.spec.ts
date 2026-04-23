import { validateWebhookMapping } from './webhook-mapping-validator';
import type { WebhookRow } from './webhook-types';

function baseWebhook(over: Partial<WebhookRow> = {}): Pick<WebhookRow,
  'field_mapping' | 'ticket_defaults' | 'default_request_type_id' | 'request_type_rules'
  | 'default_requester_person_id' | 'requester_lookup'
> {
  return {
    field_mapping: {},
    ticket_defaults: {},
    default_request_type_id: null,
    request_type_rules: [],
    default_requester_person_id: null,
    requester_lookup: null,
    ...over,
  };
}

describe('validateWebhookMapping', () => {
  it('errors when no ticket_type_id source is configured', () => {
    const result = validateWebhookMapping(baseWebhook({ default_requester_person_id: 'p1' }), null);
    expect(result.ok).toBe(false);
    expect(result.problems.find(p => p.field === 'ticket_type_id')?.severity).toBe('error');
  });

  it('errors when no requester source is configured', () => {
    const result = validateWebhookMapping(baseWebhook({ default_request_type_id: 'rt1' }), null);
    expect(result.ok).toBe(false);
    expect(result.problems.find(p => p.field === 'requester_person_id')?.severity).toBe('error');
  });

  it('accepts a webhook with default_request_type_id + default_requester_person_id', () => {
    const result = validateWebhookMapping(baseWebhook({
      default_request_type_id: 'rt1',
      default_requester_person_id: 'p1',
    }), null);
    expect(result.ok).toBe(true);
  });

  it('accepts a webhook that supplies both via field_mapping', () => {
    const result = validateWebhookMapping(baseWebhook({
      field_mapping: { ticket_type_id: '$.rt', requester_person_id: '$.req' },
    }), null);
    expect(result.ok).toBe(true);
  });

  it('warns on asset-strategy request type without asset_id mapped', () => {
    const result = validateWebhookMapping(
      baseWebhook({ default_request_type_id: 'rt1', default_requester_person_id: 'p1' }),
      { id: 'rt1', fulfillment_strategy: 'asset' },
    );
    expect(result.ok).toBe(true);
    const warn = result.problems.find(p => p.field === 'asset_id');
    expect(warn?.severity).toBe('warning');
  });

  it('does not warn on asset-strategy when asset_id is in ticket_defaults', () => {
    const result = validateWebhookMapping(
      baseWebhook({
        default_request_type_id: 'rt1',
        default_requester_person_id: 'p1',
        ticket_defaults: { asset_id: 'a-1' },
      }),
      { id: 'rt1', fulfillment_strategy: 'asset' },
    );
    expect(result.problems.find(p => p.field === 'asset_id')).toBeUndefined();
  });

  it('warns on location-strategy without location_id or asset_id', () => {
    const result = validateWebhookMapping(
      baseWebhook({ default_request_type_id: 'rt1', default_requester_person_id: 'p1' }),
      { id: 'rt1', fulfillment_strategy: 'location' },
    );
    const warn = result.problems.find(p => p.field === 'location_id');
    expect(warn?.severity).toBe('warning');
  });

  it('does not warn on location-strategy when asset_id is mapped', () => {
    const result = validateWebhookMapping(
      baseWebhook({
        default_request_type_id: 'rt1',
        default_requester_person_id: 'p1',
        field_mapping: { asset_id: '$.asset' },
      }),
      { id: 'rt1', fulfillment_strategy: 'location' },
    );
    expect(result.problems.find(p => p.field === 'location_id')).toBeUndefined();
  });

  it('emits info (not warning) on auto-strategy missing both scope fields', () => {
    const result = validateWebhookMapping(
      baseWebhook({ default_request_type_id: 'rt1', default_requester_person_id: 'p1' }),
      { id: 'rt1', fulfillment_strategy: 'auto' },
    );
    const problem = result.problems.find(p => p.severity === 'info');
    expect(problem).toBeDefined();
    expect(result.ok).toBe(true);
  });

  it('is silent for fixed-strategy with just defaults', () => {
    const result = validateWebhookMapping(
      baseWebhook({ default_request_type_id: 'rt1', default_requester_person_id: 'p1' }),
      { id: 'rt1', fulfillment_strategy: 'fixed' },
    );
    expect(result.problems).toHaveLength(0);
  });
});
