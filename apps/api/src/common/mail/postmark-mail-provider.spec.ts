import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PostmarkMailProvider } from './postmark-mail-provider';

const ORIG_ENV = { ...process.env };

describe('PostmarkMailProvider — send', () => {
  beforeEach(() => {
    process.env.POSTMARK_SERVER_TOKEN = 'test-token';
    process.env.POSTMARK_DEFAULT_FROM_EMAIL = 'noreply@example.com';
    process.env.POSTMARK_DEFAULT_FROM_NAME = 'Prequest';
    process.env.POSTMARK_WEBHOOK_SECRET = 'shhh';
    /* Stub global fetch so we don't dial Postmark during tests. */
    global.fetch = jest.fn(async () =>
      new Response(
        JSON.stringify({
          MessageID: 'pm-msg-123',
          SubmittedAt: '2026-04-30T12:00:00Z',
          To: 'orders@vendor.example',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
  });
  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  it('builds a valid Postmark request body with attachment + idempotency', async () => {
    const provider = new PostmarkMailProvider();
    const result = await provider.send({
      tenantId: 'tenant-1',
      from: 'noreply@example.com',
      fromName: 'Prequest',
      to: 'orders@vendor.example',
      toName: 'Acme Catering',
      subject: 'Daglijst 2026-05-01',
      textBody: 'Plain text body',
      idempotencyKey: 'daily-list:abc:v1',
      messageStream: 'transactional',
      tags: { entity_type: 'vendor_daily_list', daily_list_id: 'abc' },
      attachments: [
        { filename: 'list.pdf', contentType: 'application/pdf', contents: Buffer.from('%PDF-1.4 ...') },
      ],
    });
    expect(result.messageId).toBe('pm-msg-123');
    expect(result.acceptedAt).toBe('2026-04-30T12:00:00Z');

    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[0]).toBe('https://api.postmarkapp.com/email');
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Postmark-Server-Token']).toBe('test-token');
    expect((init.headers as Record<string, string>)['X-PM-Idempotency-Key']).toBe('daily-list:abc:v1');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.From).toMatch(/Prequest.*<noreply@example.com>/);
    expect(body.To).toMatch(/Acme Catering.*<orders@vendor.example>/);
    expect(body.Subject).toBe('Daglijst 2026-05-01');
    expect(body.MessageStream).toBe('outbound');         // default transactional stream env
    expect(Array.isArray(body.Attachments)).toBe(true);
    const att = (body.Attachments as Array<Record<string, unknown>>)[0];
    expect(att.Name).toBe('list.pdf');
    expect(att.ContentType).toBe('application/pdf');
    /* Buffer is base64-encoded for Postmark. */
    expect(typeof att.Content).toBe('string');
    expect(Buffer.from(att.Content as string, 'base64').toString('utf8'))
      .toMatch(/^%PDF-1\.4/);
  });

  it('escapes CR/LF + quotes in display name to prevent header injection', async () => {
    const provider = new PostmarkMailProvider();
    await provider.send({
      tenantId: 'tenant-1',
      from: 'noreply@example.com',
      fromName: 'Acme\r\n"BCC: attacker@evil.com"',
      to: 'orders@vendor.example',
      subject: 's',
      textBody: 't',
    });
    const body = JSON.parse(((global.fetch as jest.Mock).mock.calls[0][1] as RequestInit).body as string);
    /* No bare \r or \n in the From header. */
    expect(body.From).not.toMatch(/[\r\n]/);
    expect(body.From).not.toContain('"BCC:');
  });

  it('throws BadRequest when POSTMARK_SERVER_TOKEN is missing', async () => {
    delete process.env.POSTMARK_SERVER_TOKEN;
    const provider = new PostmarkMailProvider();
    await expect(provider.send({
      tenantId: 't', from: 'a@b', to: 'c@d', subject: 's', textBody: 't',
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('surfaces Postmark errors with code + message', async () => {
    global.fetch = jest.fn(async () =>
      new Response(
        JSON.stringify({ ErrorCode: 422, Message: 'You cannot send to that domain.' }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
    const provider = new PostmarkMailProvider();
    await expect(provider.send({
      tenantId: 't', from: 'a@b', to: 'c@d', subject: 's', textBody: 't',
    })).rejects.toThrow(/Postmark 422.*code=422.*cannot send/);
  });
});

describe('PostmarkMailProvider — verifyWebhook', () => {
  beforeEach(() => {
    process.env.POSTMARK_WEBHOOK_SECRET = 'shhh';
  });
  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  function signedHeaders(rawBody: string, secret = 'shhh'): Record<string, string> {
    const sig = createHmac('sha256', secret).update(rawBody).digest('base64');
    return { 'x-postmark-signature': sig };
  }

  it('translates Delivery to a normalised delivered event', () => {
    const provider = new PostmarkMailProvider();
    const raw = JSON.stringify({
      RecordType: 'Delivery',
      MessageID:  'pm-msg-123',
      Recipient:  'orders@vendor.example',
      DeliveredAt: '2026-04-30T12:05:00Z',
    });
    const events = provider.verifyWebhook({ rawBody: raw, headers: signedHeaders(raw) });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('delivered');
    expect(events[0].providerMessageId).toBe('pm-msg-123');
    expect(events[0].at).toBe('2026-04-30T12:05:00Z');
  });

  it('translates Bounce with bounce-type mapping', () => {
    const provider = new PostmarkMailProvider();
    const raw = JSON.stringify({
      RecordType: 'Bounce',
      MessageID:  'pm-msg-456',
      Recipient:  'bad@example.com',
      Type:       'HardBounce',
      Description: 'mailbox does not exist',
      BouncedAt: '2026-04-30T12:05:00Z',
    });
    const events = provider.verifyWebhook({ rawBody: raw, headers: signedHeaders(raw) });
    expect(events[0].type).toBe('bounced');
    if (events[0].type === 'bounced') {
      expect(events[0].bounceType).toBe('hard');
      expect(events[0].reason).toBe('mailbox does not exist');
    }
  });

  it('translates SpamComplaint to complained', () => {
    const provider = new PostmarkMailProvider();
    const raw = JSON.stringify({
      RecordType: 'SpamComplaint',
      MessageID:  'pm-msg-789',
      Recipient:  'spammer@example.com',
      ReceivedAt: '2026-04-30T12:05:00Z',
    });
    const events = provider.verifyWebhook({ rawBody: raw, headers: signedHeaders(raw) });
    expect(events[0].type).toBe('complained');
  });

  it('drops engagement events (Open / Click) — return empty array', () => {
    const provider = new PostmarkMailProvider();
    const raw = JSON.stringify({ RecordType: 'Open', MessageID: 'm', Recipient: 'r' });
    expect(provider.verifyWebhook({ rawBody: raw, headers: signedHeaders(raw) })).toEqual([]);
  });

  it('handles batch event arrays', () => {
    const provider = new PostmarkMailProvider();
    const raw = JSON.stringify([
      { RecordType: 'Delivery', MessageID: 'm1', Recipient: 'a@b', DeliveredAt: '2026-04-30T12:00:00Z' },
      { RecordType: 'Bounce',   MessageID: 'm2', Recipient: 'c@d', Type: 'SoftBounce', Description: 'temp', BouncedAt: '2026-04-30T12:00:00Z' },
    ]);
    const events = provider.verifyWebhook({ rawBody: raw, headers: signedHeaders(raw) });
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('delivered');
    expect(events[1].type).toBe('bounced');
    if (events[1].type === 'bounced') expect(events[1].bounceType).toBe('soft');
  });

  it('rejects mismatched signature with 401', () => {
    const provider = new PostmarkMailProvider();
    const raw = JSON.stringify({ RecordType: 'Delivery', MessageID: 'm', Recipient: 'r' });
    const tamperedHeaders = signedHeaders(raw, 'wrong-secret');
    expect(() => provider.verifyWebhook({ rawBody: raw, headers: tamperedHeaders })).toThrow(UnauthorizedException);
  });

  it('rejects missing signature header with 401', () => {
    const provider = new PostmarkMailProvider();
    const raw = JSON.stringify({ RecordType: 'Delivery', MessageID: 'm' });
    expect(() => provider.verifyWebhook({ rawBody: raw, headers: {} })).toThrow(UnauthorizedException);
  });

  it('rejects when POSTMARK_WEBHOOK_SECRET is unset', () => {
    delete process.env.POSTMARK_WEBHOOK_SECRET;
    const provider = new PostmarkMailProvider();
    const raw = JSON.stringify({ RecordType: 'Delivery', MessageID: 'm' });
    expect(() => provider.verifyWebhook({ rawBody: raw, headers: signedHeaders(raw) })).toThrow(UnauthorizedException);
  });

  it('rejects malformed JSON body', () => {
    const provider = new PostmarkMailProvider();
    const raw = 'not-json';
    expect(() => provider.verifyWebhook({ rawBody: raw, headers: signedHeaders(raw) })).toThrow(BadRequestException);
  });
});
