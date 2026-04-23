import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { TenantService } from '../tenant/tenant.service';
import { TicketService } from '../ticket/ticket.service';
import { WorkflowEngineService } from '../workflow/workflow-engine.service';
import { WebhookAuthService } from './webhook-auth.service';
import { WebhookEventService } from './webhook-event.service';
import { WebhookMappingService } from './webhook-mapping.service';
import type { WebhookRow } from './webhook-types';

export interface IngestRequestMeta {
  authorization: string | undefined;
  sourceIp: string | undefined;
  externalSystem: string | null;
  externalId: string | null;
  rawHeaders: Record<string, unknown>;
}

export interface IngestResponse {
  ticket_id: string;
  workflow_instance_id: string | null;
  external_id: string | null;
  deduplicated: boolean;
}

@Injectable()
export class WebhookIngestService {
  private readonly logger = new Logger(WebhookIngestService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly tenantService: TenantService,
    private readonly auth: WebhookAuthService,
    private readonly mapping: WebhookMappingService,
    private readonly events: WebhookEventService,
    @Inject(forwardRef(() => TicketService)) private readonly tickets: TicketService,
    @Inject(forwardRef(() => WorkflowEngineService)) private readonly workflow: WorkflowEngineService,
  ) {}

  async ingest(payload: Record<string, unknown>, meta: IngestRequestMeta): Promise<IngestResponse> {
    const webhook = await this.auth.verify(meta.authorization, meta.sourceIp);
    const tenant = await this.tenantService.resolveById(webhook.tenant_id);
    if (!tenant) {
      await this.events.log({
        tenantId: webhook.tenant_id,
        webhookId: webhook.id,
        externalSystem: meta.externalSystem,
        externalId: meta.externalId,
        status: 'error',
        httpStatus: 500,
        errorMessage: 'Tenant resolution failed',
        payload,
        headers: meta.rawHeaders,
      });
      throw new Error('Tenant resolution failed');
    }

    return TenantContext.run(tenant, async () => {
      const dedupHit = await this.checkIdempotency(webhook, meta.externalSystem, meta.externalId);
      if (dedupHit) {
        await this.events.log({
          tenantId: webhook.tenant_id,
          webhookId: webhook.id,
          externalSystem: meta.externalSystem,
          externalId: meta.externalId,
          status: 'deduplicated',
          ticketId: dedupHit,
          httpStatus: 200,
          payload,
          headers: meta.rawHeaders,
        });
        return { ticket_id: dedupHit, workflow_instance_id: null, external_id: meta.externalId, deduplicated: true };
      }

      try {
        const { dto } = await this.mapping.map(webhook, payload, {
          externalSystem: meta.externalSystem,
          externalId: meta.externalId,
        });

        const webhookHasWorkflowOverride = !!webhook.workflow_id;
        const ticket = await this.tickets.create(dto, { skipWorkflow: webhookHasWorkflowOverride });

        let workflowInstanceId: string | null = null;
        if (webhookHasWorkflowOverride && webhook.workflow_id) {
          const instance = await this.workflow.startForTicket(ticket.id as string, webhook.workflow_id);
          workflowInstanceId = instance?.id ?? null;
        }

        await this.markUsed(webhook.id);
        await this.events.log({
          tenantId: webhook.tenant_id,
          webhookId: webhook.id,
          externalSystem: meta.externalSystem,
          externalId: meta.externalId,
          status: 'accepted',
          ticketId: ticket.id as string,
          workflowInstanceId,
          httpStatus: 200,
          payload,
          headers: meta.rawHeaders,
        });

        return {
          ticket_id: ticket.id as string,
          workflow_instance_id: workflowInstanceId,
          external_id: meta.externalId,
          deduplicated: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Webhook processing failed';
        const httpStatus = (err as { status?: number })?.status ?? 500;

        // Race on the unique index — another concurrent request won the insert.
        if (httpStatus === 500 && /idx_tickets_external_ref/.test(message)) {
          const prior = await this.checkIdempotency(webhook, meta.externalSystem, meta.externalId);
          if (prior) {
            await this.events.log({
              tenantId: webhook.tenant_id,
              webhookId: webhook.id,
              externalSystem: meta.externalSystem,
              externalId: meta.externalId,
              status: 'deduplicated',
              ticketId: prior,
              httpStatus: 200,
              payload,
              headers: meta.rawHeaders,
            });
            return { ticket_id: prior, workflow_instance_id: null, external_id: meta.externalId, deduplicated: true };
          }
        }

        await this.events.log({
          tenantId: webhook.tenant_id,
          webhookId: webhook.id,
          externalSystem: meta.externalSystem,
          externalId: meta.externalId,
          status: httpStatus >= 500 ? 'error' : 'rejected',
          httpStatus,
          errorMessage: message,
          payload,
          headers: meta.rawHeaders,
        });
        throw err;
      }
    });
  }

  private async checkIdempotency(
    webhook: WebhookRow,
    externalSystem: string | null,
    externalId: string | null,
  ): Promise<string | null> {
    if (!externalSystem || !externalId) return null;
    const { data } = await this.supabase.admin
      .from('tickets')
      .select('id')
      .eq('tenant_id', webhook.tenant_id)
      .eq('external_system', externalSystem)
      .eq('external_id', externalId)
      .maybeSingle();
    return data?.id ?? null;
  }

  private async markUsed(webhookId: string) {
    const { error } = await this.supabase.admin
      .from('workflow_webhooks')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', webhookId);
    if (error) this.logger.warn(`webhook last_used_at update failed: ${error.message}`);
  }
}
