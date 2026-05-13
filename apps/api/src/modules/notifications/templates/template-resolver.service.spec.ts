/**
 * TemplateResolverService — unit tests.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step C.
 *
 * Coverage:
 *   - Default rendering (no override row).
 *   - Subject override applied.
 *   - Empty-string override → falls back to default (architect I5).
 *   - Whitespace-only override → falls back to default.
 *   - Locale fallback to 'en' on unknown values (plan-review I6).
 *   - Override-load failure logs + renders defaults (graceful degradation).
 *   - Tenant filter applied on the override lookup (cross-tenant defense).
 *
 * `@react-email/render` is mocked. The real render uses an async dynamic
 * `await import("react-dom/server")` (see node_modules/@react-email/render/
 * dist/node/index.cjs:175) which jest's CJS VM can't resolve without
 * --experimental-vm-modules. Mocking it both unblocks unit tests AND
 * keeps them deterministic — the goal here is to verify resolver logic
 * (override merge, locale fallback, tenant filter), not render fidelity.
 * Render fidelity is exercised in the smoke probe in sub-step D + H.
 */

// Mock @react-email/render to avoid the async dynamic
// `await import("react-dom/server")` at the top of the real implementation —
// jest's CJS VM rejects that (`A dynamic import callback was invoked
// without --experimental-vm-modules`). The mock uses react-dom/server's
// synchronous renderToStaticMarkup so we still exercise real React
// rendering of the templates' HTML (the assertions below check actual
// strings like "Approval needed" / "Review request" / "reservering").
jest.mock('@react-email/render', () => {
  // require, not import — keeps the mock module CJS-compatible.

  const ReactDOMServer = require('react-dom/server');

  return {
    render: jest.fn(async (element: unknown, options?: { plainText?: boolean }) => {
      const html = ReactDOMServer.renderToStaticMarkup(element);
      if (!options?.plainText) return html;
      // Cheap HTML→text: strip tags. Good enough for unit tests checking
      // that key copy strings appear; the production render has proper
      // html-to-text + table layout, exercised in the smoke probe.
      return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }),
  };
});

import { TemplateResolverService } from './template-resolver.service';
import type { BookingApprovalRequiredPayload } from './types';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '99999999-9999-4999-8999-999999999999';

const PAYLOAD: BookingApprovalRequiredPayload = {
  bookingId: '22222222-2222-4222-8222-222222222222',
  chainId: '33333333-3333-4333-8333-333333333333',
  bookingTitle: 'Quarterly review',
  requesterName: 'Marleen Visser',
  spaceName: 'Boardroom 4',
  startAt: '2026-05-13T09:00:00Z',
  endAt: '2026-05-13T10:30:00Z',
  approvalCtaUrl: 'https://app.example.com/desk/approvals/abc',
};

interface OverrideRow {
  subject_override: string | null;
  cta_text_override: string | null;
  body_intro_override: string | null;
}

function makeHarness(opts: {
  override?: OverrideRow | null;
  selectError?: { message: string } | null;
} = {}) {
  const tenantFilters: Array<{ tenant_id?: string; event_kind?: string; locale?: string }> = [];

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table !== 'notification_template_overrides') {
          throw new Error(`unexpected table: ${table}`);
        }
        const filter: { tenant_id?: string; event_kind?: string; locale?: string } = {};
        tenantFilters.push(filter);
        const builder = {
          select: () => builder,
          eq: (col: string, val: string) => {
            (filter as Record<string, string>)[col] = val;
            return builder;
          },
          order: () => builder,
          limit: () => builder,
          maybeSingle: async () => {
            if (opts.selectError) return { data: null, error: opts.selectError };
            return { data: opts.override ?? null, error: null };
          },
        };
        return builder;
      }),
    },
  };

  const service = new TemplateResolverService(supabase as never);
  return { service, supabase, tenantFilters };
}

describe('TemplateResolverService.resolve', () => {
  it('renders default English template when no override is registered', async () => {
    const { service, tenantFilters } = makeHarness();

    const out = await service.resolve({
      tenantId: TENANT_ID,
      eventKind: 'booking.approval_required',
      locale: 'en',
      payload: PAYLOAD as unknown as Record<string, unknown>,
    });

    expect(out.subject).toBe('Marleen Visser requests approval for Boardroom 4');
    expect(out.html).toContain('Approval needed');
    expect(out.html).toContain('Marleen Visser');
    expect(out.html).toContain('Boardroom 4');
    expect(out.text).toContain('Marleen Visser');
    // Default CTA text is NOT surfaced as ctaText (only override-bearing
    // values are propagated; the default is baked into the HTML).
    expect(out.ctaText).toBeUndefined();

    // Cross-tenant defense: lookup filtered by all 3 keys.
    expect(tenantFilters[0]).toEqual({
      tenant_id: TENANT_ID,
      event_kind: 'booking.approval_required',
      locale: 'en',
    });
  });

  it('renders default Dutch template when no override is registered', async () => {
    const { service } = makeHarness();

    const out = await service.resolve({
      tenantId: TENANT_ID,
      eventKind: 'booking.approval_required',
      locale: 'nl',
      payload: PAYLOAD as unknown as Record<string, unknown>,
    });

    expect(out.subject).toBe('Marleen Visser vraagt goedkeuring voor Boardroom 4');
    expect(out.html).toContain('Goedkeuring vereist');
    expect(out.html).toContain('reservering');
    // NL voice quality bar — uses `reservering` family, not `boeking`.
    expect(out.html).not.toMatch(/boeking/i);
  });

  it('applies subject override when present', async () => {
    const { service } = makeHarness({
      override: {
        subject_override: 'Custom subject for {{ requesterName }}',
        cta_text_override: null,
        body_intro_override: null,
      },
    });

    const out = await service.resolve({
      tenantId: TENANT_ID,
      eventKind: 'booking.approval_required',
      locale: 'en',
      payload: PAYLOAD as unknown as Record<string, unknown>,
    });

    expect(out.subject).toBe('Custom subject for {{ requesterName }}');
  });

  it('applies cta + body intro overrides', async () => {
    const { service } = makeHarness({
      override: {
        subject_override: null,
        cta_text_override: 'Approve now',
        body_intro_override: 'A new approval request is waiting for you.',
      },
    });

    const out = await service.resolve({
      tenantId: TENANT_ID,
      eventKind: 'booking.approval_required',
      locale: 'en',
      payload: PAYLOAD as unknown as Record<string, unknown>,
    });

    expect(out.html).toContain('Approve now');
    expect(out.html).toContain('A new approval request is waiting for you.');
    expect(out.ctaText).toBe('Approve now');
  });

  it('treats empty-string overrides as null (architect I5)', async () => {
    const { service } = makeHarness({
      override: {
        subject_override: '',
        cta_text_override: '',
        body_intro_override: '',
      },
    });

    const out = await service.resolve({
      tenantId: TENANT_ID,
      eventKind: 'booking.approval_required',
      locale: 'en',
      payload: PAYLOAD as unknown as Record<string, unknown>,
    });

    // Default subject because empty-string was treated as null.
    expect(out.subject).toBe('Marleen Visser requests approval for Boardroom 4');
    // Default CTA, default intro.
    expect(out.html).toContain('Review request');
    expect(out.ctaText).toBeUndefined();
  });

  it('treats whitespace-only overrides as null', async () => {
    const { service } = makeHarness({
      override: {
        subject_override: '   ',
        cta_text_override: '\n\t ',
        body_intro_override: '   ',
      },
    });

    const out = await service.resolve({
      tenantId: TENANT_ID,
      eventKind: 'booking.approval_required',
      locale: 'en',
      payload: PAYLOAD as unknown as Record<string, unknown>,
    });

    expect(out.subject).toBe('Marleen Visser requests approval for Boardroom 4');
    expect(out.html).toContain('Review request');
  });

  it('trims overrides on the resolve side, not the admin UI', async () => {
    const { service } = makeHarness({
      override: {
        subject_override: '  Padded subject  ',
        cta_text_override: null,
        body_intro_override: null,
      },
    });

    const out = await service.resolve({
      tenantId: TENANT_ID,
      eventKind: 'booking.approval_required',
      locale: 'en',
      payload: PAYLOAD as unknown as Record<string, unknown>,
    });

    expect(out.subject).toBe('Padded subject');
  });

  it('falls back to en when locale is an unexpected value (plan-review I6)', async () => {
    const { service } = makeHarness();

    const out = await service.resolve({
      tenantId: TENANT_ID,
      eventKind: 'booking.approval_required',
      // Cast around the type — defensive runtime path for upstream bugs.
      locale: 'fr' as 'en',
      payload: PAYLOAD as unknown as Record<string, unknown>,
    });

    expect(out.subject).toBe('Marleen Visser requests approval for Boardroom 4');
  });

  it('renders defaults when override load fails (graceful degradation)', async () => {
    const { service } = makeHarness({
      selectError: { message: 'transient supabase blip' },
    });

    const out = await service.resolve({
      tenantId: TENANT_ID,
      eventKind: 'booking.approval_required',
      locale: 'en',
      payload: PAYLOAD as unknown as Record<string, unknown>,
    });

    expect(out.subject).toBe('Marleen Visser requests approval for Boardroom 4');
  });

  it('throws on unknown event kind (config bug, not retry)', async () => {
    const { service } = makeHarness();

    await expect(
      service.resolve({
        tenantId: TENANT_ID,
        eventKind: 'booking.totally_unknown',
        locale: 'en',
        payload: PAYLOAD as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(/template_resolver\.unknown_event_kind/);
  });

  it('uses the tenant_id passed in (cross-tenant defense)', async () => {
    const { service, tenantFilters } = makeHarness();

    await service.resolve({
      tenantId: OTHER_TENANT_ID,
      eventKind: 'booking.approval_required',
      locale: 'en',
      payload: PAYLOAD as unknown as Record<string, unknown>,
    });

    expect(tenantFilters[0].tenant_id).toBe(OTHER_TENANT_ID);
    expect(tenantFilters[0].tenant_id).not.toBe(TENANT_ID);
  });
});
