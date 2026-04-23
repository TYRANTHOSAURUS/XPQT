import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { WebhookMappingService } from './webhook-mapping.service';
import { validateWebhookMapping } from './webhook-mapping-validator';
import type { RequestTypeContext } from './webhook-mapping-validator';
import type {
  RequestTypeRule,
  RequesterLookup,
  ValidationResult,
  WebhookRow,
} from './webhook-types';
import type { WebhookEventRow } from './webhook-event.service';
import { WebhookEventService } from './webhook-event.service';

export interface WebhookUpsertDto {
  name: string;
  workflow_id?: string | null;
  active?: boolean;
  ticket_defaults?: Record<string, unknown>;
  field_mapping?: Record<string, string>;
  default_request_type_id?: string | null;
  request_type_rules?: RequestTypeRule[];
  default_requester_person_id?: string | null;
  requester_lookup?: RequesterLookup | null;
  allowed_cidrs?: string[];
  rate_limit_per_minute?: number;
}

export interface WebhookCreateResponse {
  webhook: Omit<WebhookRow, 'api_key_hash'>;
  api_key: string;
  validation: ValidationResult;
}

export interface WebhookUpdateResponse {
  webhook: Omit<WebhookRow, 'api_key_hash'>;
  validation: ValidationResult;
}

@Injectable()
export class WebhookAdminService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly mapping: WebhookMappingService,
    private readonly events: WebhookEventService,
  ) {}

  async list(): Promise<Omit<WebhookRow, 'api_key_hash'>[]> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('workflow_webhooks')
      .select('id, tenant_id, workflow_id, name, active, ticket_defaults, field_mapping, default_request_type_id, request_type_rules, default_requester_person_id, requester_lookup, allowed_cidrs, rate_limit_per_minute, last_used_at, created_at')
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as Omit<WebhookRow, 'api_key_hash'>[];
  }

  async create(dto: WebhookUpsertDto): Promise<WebhookCreateResponse> {
    const tenant = TenantContext.current();
    const { apiKey, apiKeyHash } = this.generateApiKey();

    const { data, error } = await this.supabase.admin
      .from('workflow_webhooks')
      .insert({
        tenant_id: tenant.id,
        name: dto.name,
        workflow_id: dto.workflow_id ?? null,
        active: dto.active ?? false,
        ticket_defaults: dto.ticket_defaults ?? {},
        field_mapping: dto.field_mapping ?? {},
        default_request_type_id: dto.default_request_type_id ?? null,
        request_type_rules: dto.request_type_rules ?? [],
        default_requester_person_id: dto.default_requester_person_id ?? null,
        requester_lookup: dto.requester_lookup ?? null,
        allowed_cidrs: dto.allowed_cidrs ?? [],
        rate_limit_per_minute: dto.rate_limit_per_minute ?? 60,
        api_key_hash: apiKeyHash,
      })
      .select('id, tenant_id, workflow_id, name, active, ticket_defaults, field_mapping, default_request_type_id, request_type_rules, default_requester_person_id, requester_lookup, allowed_cidrs, rate_limit_per_minute, last_used_at, created_at')
      .single();

    if (error) throw error;
    const webhook = data as Omit<WebhookRow, 'api_key_hash'>;
    const validation = await this.validateAgainstRequestType(webhook.default_request_type_id ?? null, webhook);
    return { webhook, api_key: apiKey, validation };
  }

  async update(id: string, dto: Partial<WebhookUpsertDto>): Promise<WebhookUpdateResponse> {
    const tenant = TenantContext.current();

    const { data, error } = await this.supabase.admin
      .from('workflow_webhooks')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select('id, tenant_id, workflow_id, name, active, ticket_defaults, field_mapping, default_request_type_id, request_type_rules, default_requester_person_id, requester_lookup, allowed_cidrs, rate_limit_per_minute, last_used_at, created_at')
      .single();
    if (error) throw error;
    const webhook = data as Omit<WebhookRow, 'api_key_hash'>;
    const validation = await this.validateAgainstRequestType(webhook.default_request_type_id ?? null, webhook);
    return { webhook, validation };
  }

  async remove(id: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('workflow_webhooks')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
  }

  async rotateApiKey(id: string): Promise<{ api_key: string }> {
    const tenant = TenantContext.current();
    const { apiKey, apiKeyHash } = this.generateApiKey();
    const { error } = await this.supabase.admin
      .from('workflow_webhooks')
      .update({ api_key_hash: apiKeyHash })
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return { api_key: apiKey };
  }

  async listEvents(
    id: string,
    filters: { status?: WebhookEventRow['status']; external_id?: string; limit?: number },
  ): Promise<WebhookEventRow[]> {
    const tenant = TenantContext.current();
    return this.events.list(id, tenant.id, filters);
  }

  /**
   * Run a sample payload through mapping without creating a ticket. Returns
   * the resulting CreateTicketDto or the mapping error. Routing preview is
   * the caller's concern (hit /routing/studio/simulate with the returned DTO).
   */
  async testPayload(id: string, payload: Record<string, unknown>) {
    const tenant = TenantContext.current();
    const row = await this.getRow(id, tenant.id);
    try {
      const result = await this.mapping.map(row as unknown as WebhookRow, payload, {
        externalSystem: null,
        externalId: null,
      });
      return { ok: true, dto: result.dto };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Mapping failed';
      return { ok: false, error: message };
    }
  }

  private async getRow(id: string, tenantId: string): Promise<Omit<WebhookRow, 'api_key_hash'>> {
    const { data, error } = await this.supabase.admin
      .from('workflow_webhooks')
      .select('id, tenant_id, workflow_id, name, active, ticket_defaults, field_mapping, default_request_type_id, request_type_rules, default_requester_person_id, requester_lookup, allowed_cidrs, rate_limit_per_minute, last_used_at, created_at')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Webhook not found');
    return data as Omit<WebhookRow, 'api_key_hash'>;
  }

  private generateApiKey(): { apiKey: string; apiKeyHash: string } {
    const apiKey = `pqt_live_${randomBytes(32).toString('hex')}`;
    const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
    return { apiKey, apiKeyHash };
  }

  private async validateAgainstRequestType(
    requestTypeId: string | null,
    merged: Partial<WebhookRow>,
  ): Promise<ValidationResult> {
    let requestType: RequestTypeContext | null = null;
    if (requestTypeId) {
      const { data } = await this.supabase.admin
        .from('request_types')
        .select('id, fulfillment_strategy')
        .eq('id', requestTypeId)
        .maybeSingle();
      if (data) requestType = data as RequestTypeContext;
    }

    return validateWebhookMapping(
      {
        field_mapping: merged.field_mapping ?? {},
        ticket_defaults: merged.ticket_defaults ?? {},
        default_request_type_id: merged.default_request_type_id ?? null,
        request_type_rules: merged.request_type_rules ?? [],
        default_requester_person_id: merged.default_requester_person_id ?? null,
        requester_lookup: merged.requester_lookup ?? null,
      },
      requestType,
    );
  }
}
