import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { TenantService } from '../tenant/tenant.service';
import { WorkflowEngineService } from './workflow-engine.service';

export interface WebhookRow {
  id: string;
  tenant_id: string;
  workflow_id: string;
  name: string;
  token: string;
  active: boolean;
  ticket_defaults: Record<string, unknown>;
  field_mapping: Record<string, string>;
  last_received_at: string | null;
  last_error: string | null;
  created_at: string;
}

@Injectable()
export class WorkflowWebhookService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly tenantService: TenantService,
    private readonly engine: WorkflowEngineService,
  ) {}

  // ---------- Admin CRUD (tenant-scoped) ----------

  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('workflow_webhooks')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as WebhookRow[];
  }

  async create(dto: {
    name: string;
    workflow_id: string;
    ticket_defaults?: Record<string, unknown>;
    field_mapping?: Record<string, string>;
  }) {
    const tenant = TenantContext.current();
    const token = randomBytes(24).toString('hex');
    const { data, error } = await this.supabase.admin
      .from('workflow_webhooks')
      .insert({
        tenant_id: tenant.id,
        workflow_id: dto.workflow_id,
        name: dto.name,
        token,
        ticket_defaults: dto.ticket_defaults ?? {},
        field_mapping: dto.field_mapping ?? {},
      })
      .select()
      .single();
    if (error) throw error;
    return data as WebhookRow;
  }

  async update(id: string, dto: Partial<Pick<WebhookRow, 'name' | 'active' | 'ticket_defaults' | 'field_mapping' | 'workflow_id'>>) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('workflow_webhooks')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data as WebhookRow;
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

  async rotateToken(id: string) {
    const tenant = TenantContext.current();
    const token = randomBytes(24).toString('hex');
    const { data, error } = await this.supabase.admin
      .from('workflow_webhooks')
      .update({ token })
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data as WebhookRow;
  }

  // ---------- Public receive (no auth, no tenant middleware) ----------

  async receive(token: string, body: Record<string, unknown>) {
    // 1. Look up webhook by token (admin client — bypasses RLS)
    const { data: webhook, error } = await this.supabase.admin
      .from('workflow_webhooks')
      .select('*')
      .eq('token', token)
      .eq('active', true)
      .single();
    if (error || !webhook) throw new NotFoundException('Unknown or inactive webhook');

    const row = webhook as WebhookRow;

    // 2. Resolve tenant for this webhook
    const tenant = await this.tenantService.resolveById(row.tenant_id);
    if (!tenant) throw new NotFoundException('Tenant not found');

    // 3. Run the rest in tenant context so downstream services work
    return TenantContext.run(tenant, async () => {
      try {
        // Build ticket from mapping + defaults
        const mapped: Record<string, unknown> = { ...row.ticket_defaults };
        for (const [ticketField, jsonPath] of Object.entries(row.field_mapping ?? {})) {
          const value = this.evalJsonPath(body, jsonPath);
          if (value !== undefined) mapped[ticketField] = value;
        }

        // Create ticket
        const ticketPayload = {
          tenant_id: tenant.id,
          title: (mapped.title as string) ?? '(Webhook) Untitled',
          description: mapped.description ?? null,
          priority: mapped.priority ?? 'medium',
          interaction_mode: mapped.interaction_mode ?? 'internal',
          status: mapped.status ?? 'new',
          status_category: mapped.status_category ?? 'new',
          source_channel: 'webhook',
          requester_person_id: mapped.requester_person_id ?? null,
          location_id: mapped.location_id ?? null,
          assigned_team_id: mapped.assigned_team_id ?? null,
          metadata: { webhook_id: row.id, original_payload: body },
        };
        const { data: ticket, error: tErr } = await this.supabase.admin
          .from('tickets')
          .insert(ticketPayload)
          .select()
          .single();
        if (tErr) throw new BadRequestException(`Ticket creation failed: ${tErr.message}`);

        // Start workflow
        const instance = await this.engine.startForTicket(ticket.id, row.workflow_id);

        // Record success
        await this.supabase.admin
          .from('workflow_webhooks')
          .update({ last_received_at: new Date().toISOString(), last_error: null })
          .eq('id', row.id);

        return { ticket_id: ticket.id, workflow_instance_id: instance?.id ?? null };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Webhook processing failed';
        await this.supabase.admin
          .from('workflow_webhooks')
          .update({ last_received_at: new Date().toISOString(), last_error: message })
          .eq('id', row.id);
        throw err;
      }
    });
  }

  /**
   * Evaluate a JSONPath-like expression against `obj`.
   * Supports:
   *   $.foo.bar
   *   $.items[0].name
   *   foo.bar (no leading $)
   */
  private evalJsonPath(obj: unknown, path: string): unknown {
    if (!path) return undefined;
    const cleaned = path.replace(/^\$\.?/, '');
    if (!cleaned) return obj;
    // Split on dots, then handle [n] indices
    const tokens: Array<string | number> = [];
    for (const segment of cleaned.split('.')) {
      const m = segment.match(/^([^[\]]+)((?:\[\d+\])*)$/);
      if (!m) { tokens.push(segment); continue; }
      if (m[1]) tokens.push(m[1]);
      const idxMatches = m[2].match(/\[(\d+)\]/g);
      if (idxMatches) for (const idx of idxMatches) tokens.push(Number(idx.slice(1, -1)));
    }
    let cur: unknown = obj;
    for (const t of tokens) {
      if (cur == null) return undefined;
      if (typeof t === 'number') {
        if (!Array.isArray(cur)) return undefined;
        cur = cur[t];
      } else {
        if (typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[t];
      }
    }
    return cur;
  }
}
