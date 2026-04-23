import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../common/supabase/supabase.service';

export interface WebhookEventRow {
  id: string;
  tenant_id: string;
  webhook_id: string;
  received_at: string;
  external_system: string | null;
  external_id: string | null;
  status: 'accepted' | 'deduplicated' | 'rejected' | 'error';
  ticket_id: string | null;
  workflow_instance_id: string | null;
  http_status: number;
  error_message: string | null;
  payload: Record<string, unknown>;
  headers: Record<string, unknown> | null;
}

export interface LogInput {
  tenantId: string;
  webhookId: string;
  externalSystem: string | null;
  externalId: string | null;
  status: WebhookEventRow['status'];
  ticketId?: string | null;
  workflowInstanceId?: string | null;
  httpStatus: number;
  errorMessage?: string | null;
  payload: Record<string, unknown>;
  headers?: Record<string, unknown> | null;
}

@Injectable()
export class WebhookEventService {
  private readonly logger = new Logger(WebhookEventService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async log(input: LogInput): Promise<string | null> {
    const { data, error } = await this.supabase.admin
      .from('webhook_events')
      .insert({
        tenant_id: input.tenantId,
        webhook_id: input.webhookId,
        external_system: input.externalSystem,
        external_id: input.externalId,
        status: input.status,
        ticket_id: input.ticketId ?? null,
        workflow_instance_id: input.workflowInstanceId ?? null,
        http_status: input.httpStatus,
        error_message: input.errorMessage ?? null,
        payload: input.payload,
        headers: input.headers ?? null,
      })
      .select('id')
      .single();

    if (error) {
      this.logger.error(`webhook_event log failed: ${error.message}`);
      return null;
    }
    return data.id as string;
  }

  async list(
    webhookId: string,
    tenantId: string,
    filters: { status?: WebhookEventRow['status']; external_id?: string; limit?: number } = {},
  ): Promise<WebhookEventRow[]> {
    let q = this.supabase.admin
      .from('webhook_events')
      .select('*')
      .eq('webhook_id', webhookId)
      .eq('tenant_id', tenantId)
      .order('received_at', { ascending: false })
      .limit(filters.limit ?? 100);
    if (filters.status) q = q.eq('status', filters.status);
    if (filters.external_id) q = q.eq('external_id', filters.external_id);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as WebhookEventRow[];
  }

  /**
   * Daily retention — 30-day hard delete. Long-term provenance of a
   * successful ingest lives on the ticket via tickets.metadata.original_payload.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async pruneExpired() {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { error, count } = await this.supabase.admin
      .from('webhook_events')
      .delete({ count: 'exact' })
      .lt('received_at', cutoff);
    if (error) {
      this.logger.error(`webhook_events prune failed: ${error.message}`);
      return;
    }
    if (count) this.logger.log(`webhook_events pruned ${count} rows older than ${cutoff}`);
  }
}
