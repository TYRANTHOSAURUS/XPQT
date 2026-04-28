import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { ResendMailProvider } from './resend-mail-provider';

const ORIG_ENV = { ...process.env };

/* whsec_ tokens: prefix + base64-encoded raw HMAC key. The provider
   expects to base64-decode after stripping `whsec_`. The tests sign
   payloads with the SAME decoded key. */
const TEST_KEY_RAW = Buffer.from('test-svix-secret-key', 'utf8');
const TEST_KEY_WHSEC = `whsec_${TEST_KEY_RAW.toString('base64')}`;

describe('ResendMailProvider — send', () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.RESEND_DEFAULT_FROM_EMAIL = 'noreply@example.com';
    process.env.RESEND_DEFAULT_FROM_NAME = 'Prequest';
    process.env.RESEND_WEBHOOK_SECRET = TEST_KEY_WHSEC;
    /* Stub global fetch so we don't dial Resend during tests. */
    global.fetch = jest.fn(async () =>
      new Response(
        JSON.stringify({ id: 'resend-msg-123' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
  });
  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  it('builds a Resend request body with attachment + idempotency + tags', async () => {
    const provider = new ResendMailProvider();
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
    expect(result.messageId).toBe('resend-msg-123');

    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[0]).toBe('https://api.resend.com/emails');
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-resend-key');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('daily-list:abc:v1');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.from).toMatch(/Prequest <noreply@example.com>/);
    expect(body.to).toEqual(['Acme Catering <orders@vendor.example>']);
    expect(body.subject).toBe('Daglijst 2026-05-01');
    /* Tags are an array of {name, value}. */
    expect(body.tags).toEqual([
      { name: 'entity_type', value: 'vendor_daily_list' },
      { name: 'daily_list_id', value: 'abc' },
    ]);
    /* Attachments base64-encoded with content_type. */
    expect(Array.isArray(body.attachments)).toBe(true);
    const att = (body.attachments as Array<Record<string, unknown>>)[0];
    expect(att.filename).toBe('list.pdf');
    expect(att.content_type).toBe('application/pdf');
    expect(Buffer.from(att.content as string, 'base64').toString('utf8')).toMatch(/^%PDF-1\.4/);
  });

  it('escapes CR/LF + quotes in display name to prevent header injection', async () => {
    const provider = new ResendMailProvider();
    await provider.send({
      tenantId: 'tenant-1',
      from: 'noreply@example.com',
      fromName: 'Acme\r\n"BCC: attacker@evil.com"',
      to: 'orders@vendor.example',
      subject: 's',
      textBody: 't',
    });
    const body = JSON.parse(((global.fetch as jest.Mock).mock.calls[0][1] as RequestInit).body as string);
    expect(body.from).not.toMatch(/[\r\n]/);
    expect(body.from).not.toContain('"BCC:');
  });

  it('rejects recipients that contain comma or CR/LF (multi-recipient injection)', async () => {
    const provider = new ResendMailProvider();
    await expect(provider.send({
      tenantId: 'tenant-1',
      from: 'noreply@example.com',
      to: 'a@b.com,c@d.com',
      subject: 's',
      textBody: 't',
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws BadRequest when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    const provider = new ResendMailProvider();
    await expect(provider.send({
      tenantId: 't', from: 'a@b', to: 'c@d', subject: 's', textBody: 't',
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('surfaces Resend errors with name + message', async () => {
    global.fetch = jest.fn(async () =>
      new Response(
        JSON.stringify({ name: 'validation_error', message: 'invalid_to_address' }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
    const provider = new ResendMailProvider();
    await expect(provider.send({
      tenantId: 't', from: 'a@b', to: 'c@d', subject: 's', textBody: 't',
    })).rejects.toThrow(/Resend 422.*validation_error.*invalid_to_address/);
  });
});

describe('ResendMailProvider — verifyWebhook (Svix-signed)', () => {
  beforeEach(() => {
    process.env.RESEND_WEBHOOK_SECRET = TEST_KEY_WHSEC;
  });
  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  function svixHeaders(rawBody: string, ts?: number, key?: Buffer): Record<string, string> {
    const id  = 'msg_test_xyz';
    const tsv = String(ts ?? Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', key ?? TEST_KEY_RAW)
      .update(`${id}.${tsv}.${rawBody}`)
      .digest('base64');
    return {
      'svix-id':        id,
      'svix-timestamp': tsv,
      'svix-signature': `v1,${sig}`,
    };
  }

  it('translates email.delivered to a normalised delivered event', () => {
    const provider = new ResendMailProvider();
    const raw = JSON.stringify({
      type: 'email.delivered',
      data: {
        email_id: 'resend-msg-123',
        to: ['orders@vendor.example'],
        created_at: '2026-04-30T12:05:00Z',
      },
    });
    const events = provider.verifyWebhook({ rawBody: raw, headers: svixHeaders(raw) });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('delivered');
    expect(events[0].providerMessageId).toBe('resend-msg-123');
  });

  it('translates email.bounced with subtype mapping', () => {
    const provider = new ResendMailProvider();
    const raw = JSON.stringify({
      type: 'email.bounced',
      data: {
        email_id: 'resend-msg-456',
        to: ['bad@example.com'],
        bounce: { subType: 'general', message: 'mailbox does not exist' },
        created_at: '2026-04-30T12:05:00Z',
      },
    });
    const events = provider.verifyWebhook({ rawBody: raw, headers: svixHeaders(raw) });
    expect(events[0].type).toBe('bounced');
    if (events[0].type === 'bounced') {
      expect(events[0].bounceType).toBe('hard');
      expect(events[0].reason).toBe('mailbox does not exist');
    }
  });

  it('translates email.complained to complained', () => {
    const provider = new ResendMailProvider();
    const raw = JSON.stringify({
      type: 'email.complained',
      data: { email_id: 'resend-msg-789', to: ['spammer@example.com'], created_at: '2026-04-30T12:05:00Z' },
    });
    const events = provider.verifyWebhook({ rawBody: raw, headers: svixHeaders(raw) });
    expect(events[0].type).toBe('complained');
  });

  it('drops engagement events (sent / opened / clicked)', () => {
    const provider = new ResendMailProvider();
    for (const t of ['email.sent', 'email.opened', 'email.clicked']) {
      const raw = JSON.stringify({ type: t, data: { email_id: 'm', to: ['r'] } });
      expect(provider.verifyWebhook({ rawBody: raw, headers: svixHeaders(raw) })).toEqual([]);
    }
  });

  it('rejects mismatched signature with 401', () => {
    const provider = new ResendMailProvider();
    const raw = JSON.stringify({ type: 'email.delivered', data: { email_id: 'm', to: ['r'] } });
    /* Sign with a DIFFERENT key — verification must fail. */
    const tamperedHeaders = svixHeaders(raw, undefined, Buffer.from('wrong-key', 'utf8'));
    expect(() => provider.verifyWebhook({ rawBody: raw, headers: tamperedHeaders }))
      .toThrow(UnauthorizedException);
  });

  it('rejects missing svix headers with 401', () => {
    const provider = new ResendMailProvider();
    const raw = JSON.stringify({ type: 'email.delivered', data: { email_id: 'm' } });
    expect(() => provider.verifyWebhook({ rawBody: raw, headers: {} }))
      .toThrow(UnauthorizedException);
  });

  it('rejects when RESEND_WEBHOOK_SECRET is unset', () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const provider = new ResendMailProvider();
    const raw = JSON.stringify({ type: 'email.delivered', data: { email_id: 'm' } });
    expect(() => provider.verifyWebhook({ rawBody: raw, headers: svixHeaders(raw) }))
      .toThrow(UnauthorizedException);
  });

  it('rejects timestamp older than 5 minute tolerance', () => {
    const provider = new ResendMailProvider();
    const raw = JSON.stringify({ type: 'email.delivered', data: { email_id: 'm' } });
    const oldTs = Math.floor(Date.now() / 1000) - 600;            // 10 minutes ago
    expect(() => provider.verifyWebhook({ rawBody: raw, headers: svixHeaders(raw, oldTs) }))
      .toThrow(/out of tolerance/);
  });

  it('rejects malformed JSON body', () => {
    const provider = new ResendMailProvider();
    const raw = 'not-json';
    expect(() => provider.verifyWebhook({ rawBody: raw, headers: svixHeaders(raw) }))
      .toThrow(BadRequestException);
  });
});
