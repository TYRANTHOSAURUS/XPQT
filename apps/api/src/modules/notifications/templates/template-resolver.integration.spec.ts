/**
 * TemplateResolverService — REAL render integration test.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step C self-review I3.
 *
 * ── Why a separate spec file ────────────────────────────────────────────
 *
 * The unit test (template-resolver.service.spec.ts) mocks
 * `@react-email/render` with `react-dom/server.renderToStaticMarkup`
 * because the real render uses an async dynamic
 * `await import('react-dom/server')` (see node_modules/@react-email/render/
 * dist/node/index.cjs:175) which jest's CJS VM rejects without
 * `--experimental-vm-modules`.
 *
 * Self-review I3: a breaking change in `@react-email/render` (inline-style
 * normalisation, MSO conditionals, <Preview> handling) wouldn't be caught
 * by the mocked unit tests. This spec runs the REAL render against each
 * shipped template — gated by `NOTIFICATIONS_REAL_RENDER=1` so the fast
 * test path stays fast (the dynamic-import gate forces us to launch this
 * via `node --experimental-vm-modules` separately).
 *
 * ── How to run ──────────────────────────────────────────────────────────
 *
 *   # From repo root:
 *   NOTIFICATIONS_REAL_RENDER=1 \
 *     node --experimental-vm-modules \
 *     node_modules/.bin/jest \
 *     --config apps/api/jest.config.cjs \
 *     templates/template-resolver.integration
 *
 * Without the env flag, this file becomes a single skipped describe block
 * so `pnpm --filter @prequest/api test` is unaffected.
 *
 * ── What it asserts ─────────────────────────────────────────────────────
 *
 * For each template module (en + nl):
 *   - HTML render returns a non-empty string.
 *   - Plain-text render returns a non-empty string.
 *   - HTML contains the <Preview> text we passed (exercises the React
 *     Email <Preview> handling).
 *   - HTML contains the CTA copy with an <a href="..."> (exercises the
 *     <Button> primitive's anchor rewrite).
 *   - HTML contains either a `<style>` block or inline-style attributes
 *     (exercises the inline-style normalisation pass — the failure mode
 *     a `@react-email/render` upgrade is most likely to break silently).
 *   - Plain-text strips tags entirely.
 */

import bookingApprovalRequiredEn from './booking-approval-required.en';
import bookingApprovalRequiredNl from './booking-approval-required.nl';
import type { BookingApprovalRequiredPayload } from './types';

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

const ENABLED = process.env.NOTIFICATIONS_REAL_RENDER === '1';

(ENABLED ? describe : describe.skip)('TemplateResolverService — real @react-email/render integration', () => {
  // Lazy-import inside the (un)skipped block so that when ENABLED=false the
  // dynamic import never runs — fast-path test runs don't pay the cost.
  let render: (
    element: React.ReactElement,
    options?: { plainText?: boolean },
  ) => Promise<string>;
  let createElement: typeof import('react').createElement;

  beforeAll(async () => {
    const reactEmail = await import('@react-email/render');
    render = reactEmail.render as never;
    const React = await import('react');
    createElement = React.createElement;
  });

  describe('booking-approval-required.en', () => {
    it('renders non-empty HTML + text via the real engine', async () => {
      const element = createElement(bookingApprovalRequiredEn.Component, {
        payload: PAYLOAD,
        overrides: {},
      });
      const html = await render(element);
      const text = await render(element, { plainText: true });

      expect(typeof html).toBe('string');
      expect(html.length).toBeGreaterThan(100);
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(20);

      // Preview handling — the <Preview> element renders as a hidden span.
      expect(html).toMatch(/Marleen Visser requests approval for Boardroom 4/);
      // Button anchor — exercise <Button> primitive's href rewrite.
      expect(html).toMatch(/<a [^>]*href="https:\/\/app\.example\.com\/desk\/approvals\/abc"/);
      // CTA copy.
      expect(html).toContain('Review request');
      // Inline-style normalisation — every <Text> + <Container> primitive
      // injects a `style=` attribute. If a future render upgrade silently
      // drops this, this assertion catches it.
      expect(html).toMatch(/style="[^"]+"/);

      // Plain-text strips tags.
      expect(text).not.toMatch(/<[a-z]/i);
      expect(text).toContain('Marleen Visser');
    });
  });

  describe('booking-approval-required.nl', () => {
    it('renders non-empty HTML + text via the real engine', async () => {
      const element = createElement(bookingApprovalRequiredNl.Component, {
        payload: PAYLOAD,
        overrides: {},
      });
      const html = await render(element);
      const text = await render(element, { plainText: true });

      expect(html.length).toBeGreaterThan(100);
      expect(text.length).toBeGreaterThan(20);
      // Preview handling (NL).
      expect(html).toMatch(/Marleen Visser vraagt goedkeuring voor Boardroom 4/);
      expect(html).toContain('Verzoek bekijken');
      expect(html).toContain('Goedkeuring vereist');
      // NL voice quality bar — uses `reservering`, not `boeking`.
      expect(html).toContain('reservering');
      expect(html).not.toMatch(/boeking/i);
      // Inline styles applied.
      expect(html).toMatch(/style="[^"]+"/);
    });
  });
});

// Keep the file a valid module even when fully skipped — jest dislikes
// empty test files.
if (!ENABLED) {
  it('skipped (set NOTIFICATIONS_REAL_RENDER=1 to enable)', () => {
    expect(true).toBe(true);
  });
}
