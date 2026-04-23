import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { evalJsonPath } from './json-path';
import type { CreateTicketDto } from '../ticket/ticket.service';
import type { RequestTypeRule, RequestTypeRuleCondition, WebhookRow } from './webhook-types';

export interface MappingResult {
  dto: CreateTicketDto & { external_system?: string; external_id?: string };
  externalSystem: string | null;
  externalId: string | null;
}

@Injectable()
export class WebhookMappingService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Translate a raw webhook payload into a CreateTicketDto using the
   * webhook's mapping config. Throws 400 if the payload can't satisfy the
   * universal requirements (ticket_type_id + requester_person_id).
   */
  async map(
    webhook: WebhookRow,
    payload: Record<string, unknown>,
    headers: { externalSystem: string | null; externalId: string | null },
  ): Promise<MappingResult> {
    const mapped = this.applyFieldMapping(webhook, payload);

    const ticketTypeId = await this.resolveRequestType(webhook, payload, mapped);
    if (!ticketTypeId) {
      throw new BadRequestException(
        'Webhook payload does not resolve to a ticket_type_id. Add a default_request_type_id, request_type_rules entry, or map ticket_type_id in field_mapping.',
      );
    }

    const requesterPersonId = await this.resolveRequester(webhook, payload, mapped);
    if (!requesterPersonId) {
      throw new BadRequestException(
        'Webhook payload does not resolve to a requester_person_id. Add a default_requester_person_id, requester_lookup, or map requester_person_id in field_mapping.',
      );
    }

    const externalSystem = headers.externalSystem ?? (mapped.external_system as string | null) ?? null;
    const externalId = headers.externalId ?? (mapped.external_id as string | null) ?? null;

    const dto: CreateTicketDto & { external_system?: string; external_id?: string } = {
      ticket_type_id: ticketTypeId,
      title: (mapped.title as string | undefined) ?? `(Webhook) ${externalId ?? webhook.name}`,
      description: mapped.description as string | undefined,
      priority: (mapped.priority as string | undefined) ?? 'medium',
      impact: mapped.impact as string | undefined,
      urgency: mapped.urgency as string | undefined,
      requester_person_id: requesterPersonId,
      requested_for_person_id: mapped.requested_for_person_id as string | undefined,
      location_id: mapped.location_id as string | undefined,
      asset_id: mapped.asset_id as string | undefined,
      interaction_mode: (mapped.interaction_mode as string | undefined) ?? 'internal',
      source_channel: `webhook:${webhook.name}`,
      form_data: mapped.form_data as Record<string, unknown> | undefined,
    };

    if (externalSystem) dto.external_system = externalSystem;
    if (externalId) dto.external_id = externalId;

    return { dto, externalSystem, externalId };
  }

  private applyFieldMapping(webhook: WebhookRow, payload: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...(webhook.ticket_defaults ?? {}) };
    for (const [ticketField, jsonPath] of Object.entries(webhook.field_mapping ?? {})) {
      const value = evalJsonPath(payload, jsonPath);
      if (value !== undefined) out[ticketField] = value;
    }
    return out;
  }

  private async resolveRequestType(
    webhook: WebhookRow,
    payload: Record<string, unknown>,
    mapped: Record<string, unknown>,
  ): Promise<string | null> {
    if (mapped.ticket_type_id && typeof mapped.ticket_type_id === 'string') {
      return mapped.ticket_type_id;
    }
    for (const rule of webhook.request_type_rules ?? []) {
      if (this.ruleMatches(rule, payload)) return rule.request_type_id;
    }
    return webhook.default_request_type_id;
  }

  private ruleMatches(rule: RequestTypeRule, payload: Record<string, unknown>): boolean {
    return rule.when.every(cond => this.conditionMatches(cond, payload));
  }

  private conditionMatches(cond: RequestTypeRuleCondition, payload: Record<string, unknown>): boolean {
    const value = evalJsonPath(payload, cond.path);
    switch (cond.operator) {
      case 'exists':
        return value !== undefined && value !== null;
      case 'equals':
        return value === cond.value;
      case 'in':
        return Array.isArray(cond.value) && cond.value.includes(value as never);
      default:
        return false;
    }
  }

  private async resolveRequester(
    webhook: WebhookRow,
    payload: Record<string, unknown>,
    mapped: Record<string, unknown>,
  ): Promise<string | null> {
    if (mapped.requester_person_id && typeof mapped.requester_person_id === 'string') {
      return mapped.requester_person_id;
    }

    if (webhook.requester_lookup?.strategy === 'exact_email') {
      const email = evalJsonPath(payload, webhook.requester_lookup.path);
      if (typeof email === 'string' && email.length > 0) {
        const { data } = await this.supabase.admin
          .from('persons')
          .select('id')
          .eq('tenant_id', webhook.tenant_id)
          .eq('email', email)
          .maybeSingle();
        if (data?.id) return data.id as string;
      }
    }

    return webhook.default_requester_person_id;
  }
}
