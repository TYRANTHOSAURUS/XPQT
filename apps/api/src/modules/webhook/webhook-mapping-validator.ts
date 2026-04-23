import type { FulfillmentStrategy, ValidationProblem, ValidationResult, WebhookRow } from './webhook-types';

export interface RequestTypeContext {
  id: string;
  fulfillment_strategy: FulfillmentStrategy | null;
}

/**
 * Inspect a webhook config against its mapped request type's strategy and
 * surface missing-required-for-routing fields before an event arrives.
 *
 * - `error` blocks save: the webhook cannot produce a valid ticket at all.
 * - `warning` means routing will degrade to the request-type default
 *   because the branch for this strategy can't run.
 * - `info` is a heads-up.
 */
export function validateWebhookMapping(
  webhook: Pick<WebhookRow,
    | 'field_mapping'
    | 'ticket_defaults'
    | 'default_request_type_id'
    | 'request_type_rules'
    | 'default_requester_person_id'
    | 'requester_lookup'
  >,
  requestType: RequestTypeContext | null,
): ValidationResult {
  const problems: ValidationProblem[] = [];
  const provided = new Set([
    ...Object.keys(webhook.field_mapping ?? {}),
    ...Object.keys(webhook.ticket_defaults ?? {}),
  ]);

  const hasRequestType =
    !!webhook.default_request_type_id ||
    (webhook.request_type_rules?.length ?? 0) > 0 ||
    provided.has('ticket_type_id');

  if (!hasRequestType) {
    problems.push({
      severity: 'error',
      field: 'ticket_type_id',
      message: 'Webhook does not supply a request type — every inbound event will 422.',
    });
  }

  const hasRequester =
    !!webhook.default_requester_person_id ||
    !!webhook.requester_lookup ||
    provided.has('requester_person_id');

  if (!hasRequester) {
    problems.push({
      severity: 'error',
      field: 'requester_person_id',
      message: 'Webhook does not supply a requester — every inbound event will 422.',
    });
  }

  if (!requestType) return { ok: problems.every(p => p.severity !== 'error'), problems };

  switch (requestType.fulfillment_strategy) {
    case 'asset':
      if (!provided.has('asset_id')) {
        problems.push({
          severity: 'warning',
          field: 'asset_id',
          message: 'Request type is asset-strategy; without asset_id, routing falls to request-type default.',
        });
      }
      break;
    case 'location':
      if (!provided.has('location_id') && !provided.has('asset_id')) {
        problems.push({
          severity: 'warning',
          field: 'location_id',
          message: 'Request type is location-strategy; without location_id (or an asset), routing falls to request-type default.',
        });
      }
      break;
    case 'auto':
      if (!provided.has('asset_id') && !provided.has('location_id')) {
        problems.push({
          severity: 'info',
          message: 'Request type is auto-strategy; neither asset nor location mapped — only request-type default will assign.',
        });
      }
      break;
    case 'fixed':
    case null:
    case undefined:
      break;
  }

  return { ok: problems.every(p => p.severity !== 'error'), problems };
}
