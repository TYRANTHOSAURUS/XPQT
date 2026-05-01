/**
 * Visitor email template render tests.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §6
 *
 * Strategy: render each template against a fixed context and snapshot
 * the output. The snapshot tests guard against accidental string changes
 * (e.g. drift in the cancel-link copy) — a change to a template should
 * be a deliberate, reviewed update, not a silent diff in someone else's
 * unrelated PR.
 *
 * Plain assertions cover the load-bearing properties (cancel link is
 * present, host first-name only, no last-name leak, branding present).
 */

import {
  formatVisitDate,
  renderCancellation,
  renderDayBeforeReminder,
  renderDeclinedToHost,
  renderInvitationExpected,
  renderMoved,
  renderRoomChanged,
  VISITOR_EMAIL_TEMPLATES,
  type VisitorEmailContext,
} from './visitor-emails';

const FIXED_CTX: VisitorEmailContext = {
  tenant: {
    name: 'Acme Corp',
    logo_url: 'https://cdn.acme.test/logo.png',
    primary_color: '#0ea5e9',
  },
  visitor: {
    first_name: 'Marleen',
    last_name: 'Visser',
    email: 'marleen@example.com',
  },
  host: {
    first_name: 'Jan',
  },
  building: {
    name: 'HQ Amsterdam',
    address: 'Herengracht 100, Amsterdam',
    reception_phone: '+31 20 555 0100',
  },
  meeting_room: { name: 'Amber 3' },
  expected_at: '2026-05-01T09:00:00Z',
  expected_until: '2026-05-01T11:00:00Z',
  visitor_type: {
    display_name: 'Guest',
    requires_id_scan: true,
    requires_nda: false,
    requires_photo: false,
  },
  cancel_url: 'https://acme.prequest.app/visit/cancel/abcdef',
  notes_for_visitor: 'Bring laptop. Coffee is on us.',
};

describe('visitor email templates', () => {
  describe('formatVisitDate', () => {
    it('formats a UTC ISO timestamp in stable English form', () => {
      expect(formatVisitDate('2026-05-01T09:00:00Z')).toBe(
        'Friday, May 1, 2026 at 09:00 UTC',
      );
    });
    it('returns the input on invalid date', () => {
      expect(formatVisitDate('not-a-date')).toBe('not-a-date');
    });
  });

  describe('renderInvitationExpected', () => {
    it('renders subject with building + date', () => {
      const r = renderInvitationExpected(FIXED_CTX);
      expect(r.subject).toBe(
        "You're invited to visit HQ Amsterdam on Friday, May 1, 2026 at 09:00 UTC",
      );
    });
    it('uses host first name only — never last name', () => {
      const ctx: VisitorEmailContext = {
        ...FIXED_CTX,
        host: { first_name: 'Jan' },
      };
      const r = renderInvitationExpected(ctx);
      expect(r.textBody).toContain('Host: Jan');
      // Make sure we don't accidentally interpolate any last-name.
      expect(r.textBody).not.toContain('Bakker');
    });
    it('includes cancel link in both text + html', () => {
      const r = renderInvitationExpected(FIXED_CTX);
      expect(r.textBody).toContain('https://acme.prequest.app/visit/cancel/abcdef');
      expect(r.htmlBody).toContain('https://acme.prequest.app/visit/cancel/abcdef');
    });
    it('omits cancel link when none supplied', () => {
      const r = renderInvitationExpected({ ...FIXED_CTX, cancel_url: null });
      expect(r.textBody).not.toContain('Cancel');
      expect(r.htmlBody).not.toContain('Cancel');
    });
    it('renders "What to bring" only when type has requirements', () => {
      const withReq = renderInvitationExpected(FIXED_CTX);
      expect(withReq.textBody).toContain('What to bring');
      expect(withReq.textBody).toContain('government-issued photo ID');

      const noReq = renderInvitationExpected({
        ...FIXED_CTX,
        visitor_type: {
          display_name: 'Guest',
          requires_id_scan: false,
          requires_nda: false,
          requires_photo: false,
        },
      });
      expect(noReq.textBody).not.toContain('What to bring');
    });
    it('renders tenant logo URL when present', () => {
      const r = renderInvitationExpected(FIXED_CTX);
      expect(r.htmlBody).toContain('https://cdn.acme.test/logo.png');
    });
    it('falls back to tenant name when logo is null', () => {
      const r = renderInvitationExpected({
        ...FIXED_CTX,
        tenant: { ...FIXED_CTX.tenant, logo_url: null },
      });
      expect(r.htmlBody).not.toContain('<img ');
      expect(r.htmlBody).toContain('Acme Corp');
    });
    it('escapes HTML in user-supplied notes', () => {
      const r = renderInvitationExpected({
        ...FIXED_CTX,
        notes_for_visitor: '<script>alert(1)</script>',
      });
      expect(r.htmlBody).not.toContain('<script>');
      expect(r.htmlBody).toContain('&lt;script&gt;');
    });
    it('snapshot — full text body', () => {
      const r = renderInvitationExpected(FIXED_CTX);
      expect(r.textBody).toMatchInlineSnapshot(`
"Hi Marleen,

You're invited to visit HQ Amsterdam on Friday, May 1, 2026 at 09:00 UTC.

Host: Jan
Meeting room: Amber 3
Address: Herengracht 100, Amsterdam
Reception: +31 20 555 0100

What to bring:
  - A government-issued photo ID

Note from your host:
Bring laptop. Coffee is on us.

Can't make it? Cancel here: https://acme.prequest.app/visit/cancel/abcdef
(Or simply reply to this email and Jan will be notified.)

See you on Friday, May 1, 2026."
`);
    });
  });

  describe('renderDayBeforeReminder', () => {
    it('subject includes "Reminder" + building', () => {
      const r = renderDayBeforeReminder(FIXED_CTX);
      expect(r.subject).toContain('Reminder');
      expect(r.subject).toContain('HQ Amsterdam');
    });
    it('contains the cancel link when present', () => {
      const r = renderDayBeforeReminder(FIXED_CTX);
      expect(r.textBody).toContain('Cancel here:');
    });
    it('snapshot — text body', () => {
      const r = renderDayBeforeReminder(FIXED_CTX);
      expect(r.textBody).toMatchInlineSnapshot(`
"Hi Marleen,

A friendly reminder that your visit to HQ Amsterdam is on Friday, May 1, 2026 at 09:00 UTC.

Host: Jan
Meeting room: Amber 3
Address: Herengracht 100, Amsterdam
Reception: +31 20 555 0100

What to bring:
  - A government-issued photo ID

Can't make it? Cancel here: https://acme.prequest.app/visit/cancel/abcdef

See you soon."
`);
    });
  });

  describe('renderCancellation', () => {
    it('subject mentions cancellation', () => {
      const r = renderCancellation(FIXED_CTX);
      expect(r.subject).toContain('cancelled');
    });
    it('does not include a cancel CTA (already cancelled)', () => {
      const r = renderCancellation(FIXED_CTX);
      expect(r.textBody).not.toContain('Cancel here:');
    });
    it('snapshot — text body', () => {
      const r = renderCancellation(FIXED_CTX);
      expect(r.textBody).toMatchInlineSnapshot(`
"Hi Marleen,

Your visit to HQ Amsterdam on Friday, May 1, 2026 at 09:00 UTC has been cancelled.

If this was unexpected, please reach out to Jan.
Reception: +31 20 555 0100"
`);
    });
  });

  describe('renderMoved', () => {
    it('shows old + new times', () => {
      const r = renderMoved({
        ...FIXED_CTX,
        move: {
          old_expected_at: '2026-05-01T09:00:00Z',
          new_expected_at: '2026-05-01T14:00:00Z',
        },
      });
      expect(r.textBody).toContain('Was:');
      expect(r.textBody).toContain('Now:');
      expect(r.textBody).toContain('14:00 UTC');
    });
  });

  describe('renderRoomChanged', () => {
    it('shows old + new room names', () => {
      const r = renderRoomChanged({
        ...FIXED_CTX,
        room_change: { old_room_name: 'Amber 3', new_room_name: 'Onyx 1' },
      });
      expect(r.textBody).toContain('Was: Amber 3');
      expect(r.textBody).toContain('Now: Onyx 1');
    });
    it('falls back gracefully when room names missing', () => {
      const r = renderRoomChanged({
        ...FIXED_CTX,
        room_change: { old_room_name: null, new_room_name: null },
      });
      expect(r.textBody).toContain('(unspecified)');
    });
  });

  describe('renderDeclinedToHost', () => {
    it('addresses the host, not the visitor', () => {
      const r = renderDeclinedToHost(FIXED_CTX);
      // Greets the host, not the visitor
      expect(r.textBody.startsWith('Hi Jan,')).toBe(true);
      // Mentions the visitor by full name
      expect(r.textBody).toContain('Marleen Visser');
    });
    it('reminds host that visitor is not notified', () => {
      const r = renderDeclinedToHost(FIXED_CTX);
      expect(r.textBody).toMatch(/has not been notified/i);
    });
  });

  describe('VISITOR_EMAIL_TEMPLATES dispatch table', () => {
    it('exposes one renderer per kind', () => {
      const keys = Object.keys(VISITOR_EMAIL_TEMPLATES).sort();
      expect(keys).toEqual([
        'visitor.invitation.cancelled',
        'visitor.invitation.day_before_reminder',
        'visitor.invitation.declined',
        'visitor.invitation.expected',
        'visitor.invitation.moved',
        'visitor.invitation.room_changed',
      ]);
    });

    it('each renderer returns subject + textBody + htmlBody', () => {
      for (const [kind, render] of Object.entries(VISITOR_EMAIL_TEMPLATES)) {
        const r = render({
          ...FIXED_CTX,
          move: kind === 'visitor.invitation.moved' ? {
            old_expected_at: FIXED_CTX.expected_at,
            new_expected_at: '2026-05-01T14:00:00Z',
          } : undefined,
          room_change: kind === 'visitor.invitation.room_changed' ? {
            old_room_name: 'Amber',
            new_room_name: 'Onyx',
          } : undefined,
        });
        expect(r.subject).toBeTruthy();
        expect(r.textBody).toBeTruthy();
        expect(r.htmlBody).toBeTruthy();
        expect(r.htmlBody).toContain('<!doctype html>');
      }
    });
  });
});
