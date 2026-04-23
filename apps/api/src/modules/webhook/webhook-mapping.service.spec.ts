import { BadRequestException } from '@nestjs/common';
import { WebhookMappingService } from './webhook-mapping.service';
import type { WebhookRow } from './webhook-types';

interface PersonChain {
  _email: string | null;
  select(): PersonChain;
  eq(field: string, value: string): PersonChain;
  maybeSingle(): Promise<{ data: { id: string } | null; error: null }>;
}

function makeSupabaseStub(personLookup: Record<string, string | null> = {}) {
  return {
    admin: {
      from: jest.fn((table: string) => {
        if (table !== 'persons') throw new Error(`unexpected table ${table}`);
        const chain: PersonChain = {
          _email: null,
          select() { return chain; },
          eq(field: string, value: string) {
            if (field === 'email') chain._email = value;
            return chain;
          },
          maybeSingle: jest.fn(async () => {
            const id: string | null = chain._email != null ? personLookup[chain._email] ?? null : null;
            return { data: id ? { id } : null, error: null };
          }),
        };
        return chain;
      }),
    },
  };
}

function baseWebhook(over: Partial<WebhookRow> = {}): WebhookRow {
  return {
    id: 'wh1',
    tenant_id: 't1',
    workflow_id: null,
    name: 'Jira-Bridge',
    api_key_hash: 'deadbeef',
    active: true,
    ticket_defaults: {},
    field_mapping: {},
    default_request_type_id: null,
    request_type_rules: [],
    default_requester_person_id: null,
    requester_lookup: null,
    allowed_cidrs: [],
    rate_limit_per_minute: 60,
    last_used_at: null,
    created_at: '2026-04-23T00:00:00Z',
    ...over,
  };
}

describe('WebhookMappingService', () => {
  function make(personLookup: Record<string, string | null> = {}) {
    const supabase = makeSupabaseStub(personLookup);
    return new WebhookMappingService(supabase as never);
  }

  it('rejects payloads with no resolvable request type', async () => {
    const svc = make();
    const webhook = baseWebhook({ default_requester_person_id: 'p1' });
    await expect(svc.map(webhook, {}, { externalSystem: null, externalId: null }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects payloads with no resolvable requester', async () => {
    const svc = make();
    const webhook = baseWebhook({ default_request_type_id: 'rt1' });
    await expect(svc.map(webhook, {}, { externalSystem: null, externalId: null }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('picks ticket_type_id from a matching request_type_rule', async () => {
    const svc = make();
    const webhook = baseWebhook({
      default_request_type_id: 'rt-default',
      default_requester_person_id: 'p1',
      request_type_rules: [
        { when: [{ path: '$.severity', operator: 'equals', value: 'P1' }], request_type_id: 'rt-p1' },
        { when: [{ path: '$.severity', operator: 'in', value: ['P2', 'P3'] }], request_type_id: 'rt-low' },
      ],
    });
    const { dto } = await svc.map(webhook, { severity: 'P2' }, { externalSystem: null, externalId: null });
    expect(dto.ticket_type_id).toBe('rt-low');
  });

  it('falls back to default_request_type_id when no rule matches', async () => {
    const svc = make();
    const webhook = baseWebhook({
      default_request_type_id: 'rt-default',
      default_requester_person_id: 'p1',
      request_type_rules: [
        { when: [{ path: '$.missing', operator: 'exists' }], request_type_id: 'rt-other' },
      ],
    });
    const { dto } = await svc.map(webhook, {}, { externalSystem: null, externalId: null });
    expect(dto.ticket_type_id).toBe('rt-default');
  });

  it('resolves requester via email lookup when configured', async () => {
    const svc = make({ 'alice@example.com': 'person-alice' });
    const webhook = baseWebhook({
      default_request_type_id: 'rt1',
      requester_lookup: { path: '$.reporter.email', strategy: 'exact_email' },
    });
    const { dto } = await svc.map(
      webhook,
      { reporter: { email: 'alice@example.com' } },
      { externalSystem: null, externalId: null },
    );
    expect(dto.requester_person_id).toBe('person-alice');
  });

  it('falls back to default_requester_person_id when email lookup misses', async () => {
    const svc = make({});
    const webhook = baseWebhook({
      default_request_type_id: 'rt1',
      default_requester_person_id: 'integrations-bot',
      requester_lookup: { path: '$.reporter.email', strategy: 'exact_email' },
    });
    const { dto } = await svc.map(
      webhook,
      { reporter: { email: 'unknown@example.com' } },
      { externalSystem: null, externalId: null },
    );
    expect(dto.requester_person_id).toBe('integrations-bot');
  });

  it('surfaces external_system + external_id from headers on the dto', async () => {
    const svc = make();
    const webhook = baseWebhook({
      default_request_type_id: 'rt1',
      default_requester_person_id: 'p1',
    });
    const { dto, externalSystem, externalId } = await svc.map(
      webhook,
      {},
      { externalSystem: 'jira', externalId: 'PROJ-42' },
    );
    expect(externalSystem).toBe('jira');
    expect(externalId).toBe('PROJ-42');
    expect(dto.external_system).toBe('jira');
    expect(dto.external_id).toBe('PROJ-42');
  });

  it('stamps source_channel with the webhook name', async () => {
    const svc = make();
    const webhook = baseWebhook({
      name: 'Jira-Bridge',
      default_request_type_id: 'rt1',
      default_requester_person_id: 'p1',
    });
    const { dto } = await svc.map(webhook, {}, { externalSystem: null, externalId: null });
    expect(dto.source_channel).toBe('webhook:Jira-Bridge');
  });
});
