/**
 * Portal submit types. Not exported from @prequest/shared because the trace is
 * portal-local UX diagnostic, not part of any routing contract.
 * See docs/service-catalog-live.md §6 and docs/portal-scope-slice.md §2.
 */

export interface PortalSubmitDto {
  /**
   * Required. The request type being submitted. There is no longer a paired
   * service_item concept — submit and catalog both operate on request_type_id
   * directly (see docs/service-catalog-live.md).
   */
  request_type_id: string;
  location_id?: string | null;   // user-picked; never prefilled from asset
  asset_id?: string | null;
  requested_for_person_id?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  impact?: string;
  urgency?: string;
  title: string;
  description?: string;
  form_data?: Record<string, unknown>;
}

/**
 * Subset returned by the routing simulator when the admin simulates "as a
 * person". Kept as a separate type so the simulator result stays slim even
 * though the same RPC (request_type_requestable_trace) returns more fields.
 */
export interface PortalAvailabilityTrace {
  authorized: boolean;
  has_any_scope: boolean;
  effective_location_id: string | null;
  matched_root_id: string | null;
  matched_root_source: 'default' | 'grant' | null;
  grant_id: string | null;
  visible: boolean;
  location_required: boolean;
  granularity: string | null;
  granularity_ok: boolean;
  overall_valid: boolean;
  failure_reason: string | null;
}

/**
 * Full trace returned by public.request_type_requestable_trace(). Used by the
 * portal submit path and the routing-studio simulator. Always complete —
 * every field is present in every response.
 */
export interface RequestTypeTrace extends PortalAvailabilityTrace {
  request_type_id: string;
  matched_coverage_rule_id: string | null;
  matched_form_variant_id: string | null;
  criteria: {
    visible_allow_required: boolean;
    visible_allow_ok: boolean;
    visible_deny_ok: boolean;
    request_allow_required: boolean;
    request_allow_ok: boolean;
    request_deny_ok: boolean;
  };
  on_behalf_ok: boolean;
  asset_type_filter_ok: boolean;
}
