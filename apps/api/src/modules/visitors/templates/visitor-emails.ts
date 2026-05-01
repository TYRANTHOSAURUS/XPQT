/**
 * Visitor email templates — English, branded.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §6, §10.2, §11.3
 *
 * The platform uses plain string-interpolated subject + textBody + optional
 * htmlBody — no Handlebars / MJML / react-email anywhere in the codebase. We
 * mirror the pattern from `apps/api/src/modules/daily-list/templates/strings.ts`:
 * one pure function per template, returns `{ subject, textBody, htmlBody }`.
 *
 * **English-only by user direction (spec §3 #14).** Strings are still
 * keyed (`visitor.invitation.expected.subject`, etc.) so a future i18n
 * pass is mechanical — when locales arrive, swap the constant lookup
 * with a per-locale bundle, like daily-list/templates/strings.ts does.
 *
 * Templates are pure functions of the rendered context — the worker
 * (visitor-email.worker.ts) is responsible for loading the visitor,
 * branding, building, host, and visitor type rows and assembling the
 * context object.
 *
 * Cross-tenant: pure render functions, no DB access, no tenant context
 * lookups. Caller is responsible for tenant scoping when assembling the
 * context object.
 */

export interface VisitorEmailContext {
  /** Tenant branding for the email envelope. */
  tenant: {
    name: string;
    /** Logo URL for the email header (light variant, falls back to none). */
    logo_url: string | null;
    /** Hex primary color for the CTA button + accents. Defaults to slate-900. */
    primary_color: string;
  };
  /** Visitor identity — first_name only public-facing, last_name optional. */
  visitor: {
    first_name: string;
    last_name: string | null;
    email: string | null;
  };
  /** Primary host — first name only per privacy convention. */
  host: {
    first_name: string;
  };
  /** Building visit details. */
  building: {
    name: string;
    address: string | null;
    /** Optional reception phone — null when not configured. */
    reception_phone: string | null;
  };
  /** Optional meeting room (top-level visit). */
  meeting_room: {
    name: string;
  } | null;
  /** Visit timing — both timestamps are ISO-8601 in UTC. */
  expected_at: string;
  expected_until: string | null;
  /** Visitor-type metadata. */
  visitor_type: {
    display_name: string;
    /** Per-type "what to bring" or requirements list. v1 reads from
     *  the boolean flags on visitor_types (requires_id_scan / requires_nda
     *  / requires_photo) — v2 might add a free-form field. */
    requires_id_scan: boolean;
    requires_nda: boolean;
    requires_photo: boolean;
  };
  /** Cancel link — the worker injects the host URL + plaintext token. */
  cancel_url: string | null;
  /** Free-form notes for the visitor (set on invite). */
  notes_for_visitor: string | null;
  /** Move-only context — populated for `visitor.invitation.moved`. */
  move?: {
    old_expected_at: string;
    new_expected_at: string;
  };
  /** Room-change context — populated for `visitor.invitation.room_changed`. */
  room_change?: {
    old_room_name: string | null;
    new_room_name: string | null;
  };
}

export interface RenderedEmail {
  subject: string;
  textBody: string;
  htmlBody: string;
}

/* ─── helpers ──────────────────────────────────────────────────────────── */

/**
 * Format an ISO timestamp in a stable, locale-neutral English form for
 * email bodies. Visitor-facing dates need a single canonical shape so the
 * snapshot tests don't drift across CI runners. The platform emits in
 * UTC; reception is welcome to translate during follow-up review.
 */
export function formatVisitDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Example: "Friday, May 1, 2026 at 09:00 UTC"
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const day = days[d.getUTCDay()];
  const month = months[d.getUTCMonth()];
  const date = d.getUTCDate();
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day}, ${month} ${date}, ${year} at ${hh}:${mm} UTC`;
}

function visitorFullName(visitor: VisitorEmailContext['visitor']): string {
  return [visitor.first_name, visitor.last_name].filter(Boolean).join(' ');
}

function whatToBringLines(type: VisitorEmailContext['visitor_type']): string[] {
  const items: string[] = [];
  if (type.requires_id_scan) items.push('A government-issued photo ID');
  if (type.requires_nda) items.push('Be ready to sign an NDA at reception');
  if (type.requires_photo) items.push('You will be photographed for your visitor pass');
  return items;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * HTML envelope shared by all visitor emails. Inline styles only —
 * Outlook + Gmail clients strip <style> tags inconsistently. The
 * branded primary color is used for the CTA button + the divider.
 */
function envelope(opts: {
  tenant: VisitorEmailContext['tenant'];
  preheader: string;
  bodyHtml: string;
}): string {
  const logo = opts.tenant.logo_url
    ? `<img src="${escapeHtml(opts.tenant.logo_url)}" alt="${escapeHtml(opts.tenant.name)}" style="max-height:48px;max-width:200px;display:block;" />`
    : `<div style="font-size:18px;font-weight:600;color:#0f172a;">${escapeHtml(opts.tenant.name)}</div>`;
  const color = opts.tenant.primary_color || '#0f172a';
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>
  <body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
    <span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(opts.preheader)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;">
            <tr><td style="padding:24px;border-bottom:1px solid #e2e8f0;">${logo}</td></tr>
            <tr><td style="padding:24px;line-height:1.5;">${opts.bodyHtml}</td></tr>
            <tr><td style="padding:16px 24px;border-top:3px solid ${escapeHtml(color)};color:#64748b;font-size:12px;">Sent via Prequest</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function ctaButtonHtml(url: string, label: string, color: string): string {
  return `<p><a href="${escapeHtml(url)}" style="display:inline-block;background:${escapeHtml(color)};color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">${escapeHtml(label)}</a></p>`;
}

/* ─── templates ────────────────────────────────────────────────────────── */

/**
 * `visitor.invitation.expected` — primary invite + day-of details.
 *
 * Trigger: InvitationService.create when status='expected' (no approval),
 * or VisitorService.onApprovalDecided when an approval grants.
 */
export function renderInvitationExpected(ctx: VisitorEmailContext): RenderedEmail {
  const fullName = visitorFullName(ctx.visitor);
  const date = formatVisitDate(ctx.expected_at);
  const subject = `You're invited to visit ${ctx.building.name} on ${date}`;

  const lines: string[] = [];
  lines.push(`Hi ${ctx.visitor.first_name},`);
  lines.push('');
  lines.push(`You're invited to visit ${ctx.building.name} on ${date}.`);
  lines.push('');
  lines.push(`Host: ${ctx.host.first_name}`);
  if (ctx.meeting_room) lines.push(`Meeting room: ${ctx.meeting_room.name}`);
  if (ctx.building.address) lines.push(`Address: ${ctx.building.address}`);
  if (ctx.building.reception_phone) lines.push(`Reception: ${ctx.building.reception_phone}`);

  const bring = whatToBringLines(ctx.visitor_type);
  if (bring.length > 0) {
    lines.push('');
    lines.push('What to bring:');
    for (const item of bring) lines.push(`  - ${item}`);
  }

  if (ctx.notes_for_visitor) {
    lines.push('');
    lines.push('Note from your host:');
    lines.push(ctx.notes_for_visitor);
  }

  if (ctx.cancel_url) {
    lines.push('');
    lines.push(`Can't make it? Cancel here: ${ctx.cancel_url}`);
    lines.push(`(Or simply reply to this email and ${ctx.host.first_name} will be notified.)`);
  }

  lines.push('');
  lines.push(`See you on ${date.split(' at ')[0]}.`);

  const textBody = lines.join('\n');

  const bringHtml = bring.length > 0
    ? `<p><strong>What to bring</strong></p><ul style="margin:8px 0 16px 20px;padding:0;">${bring
        .map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
    : '';
  const notesHtml = ctx.notes_for_visitor
    ? `<p><strong>Note from your host</strong></p><p style="background:#f1f5f9;padding:12px;border-radius:6px;">${escapeHtml(ctx.notes_for_visitor)}</p>`
    : '';
  const cancelHtml = ctx.cancel_url
    ? `<p style="margin-top:24px;color:#475569;">Can't make it?</p>${ctaButtonHtml(ctx.cancel_url, 'Cancel my visit', ctx.tenant.primary_color || '#0f172a')}<p style="color:#64748b;font-size:12px;">Or reply to this email and ${escapeHtml(ctx.host.first_name)} will be notified.</p>`
    : '';
  const bodyHtml = `
    <p>Hi ${escapeHtml(ctx.visitor.first_name)},</p>
    <p>You're invited to visit <strong>${escapeHtml(ctx.building.name)}</strong> on <strong>${escapeHtml(date)}</strong>.</p>
    <p><strong>Host:</strong> ${escapeHtml(ctx.host.first_name)}<br/>
    ${ctx.meeting_room ? `<strong>Meeting room:</strong> ${escapeHtml(ctx.meeting_room.name)}<br/>` : ''}
    ${ctx.building.address ? `<strong>Address:</strong> ${escapeHtml(ctx.building.address)}<br/>` : ''}
    ${ctx.building.reception_phone ? `<strong>Reception:</strong> ${escapeHtml(ctx.building.reception_phone)}` : ''}</p>
    ${bringHtml}
    ${notesHtml}
    ${cancelHtml}
  `.trim();

  const htmlBody = envelope({
    tenant: ctx.tenant,
    preheader: `${ctx.host.first_name} invited you to ${ctx.building.name}`,
    bodyHtml,
  });

  void fullName; // reserved for analytics tags
  return { subject, textBody, htmlBody };
}

/**
 * `visitor.invitation.day_before_reminder` — reminder fired by the
 * day-before cron (visitor-reminder.worker.ts).
 */
export function renderDayBeforeReminder(ctx: VisitorEmailContext): RenderedEmail {
  const date = formatVisitDate(ctx.expected_at);
  const dayPart = date.split(' at ')[0];
  const subject = `Reminder: Your visit to ${ctx.building.name} is ${dayPart === undefined ? 'tomorrow' : dayPart}`;

  const lines: string[] = [];
  lines.push(`Hi ${ctx.visitor.first_name},`);
  lines.push('');
  lines.push(`A friendly reminder that your visit to ${ctx.building.name} is on ${date}.`);
  lines.push('');
  lines.push(`Host: ${ctx.host.first_name}`);
  if (ctx.meeting_room) lines.push(`Meeting room: ${ctx.meeting_room.name}`);
  if (ctx.building.address) lines.push(`Address: ${ctx.building.address}`);
  if (ctx.building.reception_phone) lines.push(`Reception: ${ctx.building.reception_phone}`);

  const bring = whatToBringLines(ctx.visitor_type);
  if (bring.length > 0) {
    lines.push('');
    lines.push('What to bring:');
    for (const item of bring) lines.push(`  - ${item}`);
  }

  if (ctx.cancel_url) {
    lines.push('');
    lines.push(`Can't make it? Cancel here: ${ctx.cancel_url}`);
  }

  lines.push('');
  lines.push('See you soon.');

  const textBody = lines.join('\n');
  const bringHtml = bring.length > 0
    ? `<p><strong>What to bring</strong></p><ul style="margin:8px 0 16px 20px;padding:0;">${bring
        .map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
    : '';
  const cancelHtml = ctx.cancel_url
    ? `<p style="margin-top:24px;">${ctaButtonHtml(ctx.cancel_url, 'Cancel my visit', ctx.tenant.primary_color || '#0f172a')}</p>`
    : '';
  const bodyHtml = `
    <p>Hi ${escapeHtml(ctx.visitor.first_name)},</p>
    <p>A friendly reminder that your visit to <strong>${escapeHtml(ctx.building.name)}</strong> is on <strong>${escapeHtml(date)}</strong>.</p>
    <p><strong>Host:</strong> ${escapeHtml(ctx.host.first_name)}<br/>
    ${ctx.meeting_room ? `<strong>Meeting room:</strong> ${escapeHtml(ctx.meeting_room.name)}<br/>` : ''}
    ${ctx.building.address ? `<strong>Address:</strong> ${escapeHtml(ctx.building.address)}<br/>` : ''}
    ${ctx.building.reception_phone ? `<strong>Reception:</strong> ${escapeHtml(ctx.building.reception_phone)}` : ''}</p>
    ${bringHtml}
    ${cancelHtml}
  `.trim();
  const htmlBody = envelope({
    tenant: ctx.tenant,
    preheader: `Visit reminder · ${ctx.building.name}`,
    bodyHtml,
  });
  return { subject, textBody, htmlBody };
}

/**
 * `visitor.invitation.cancelled` — visitor self-cancel, host cancel, or
 * cascade cancel from a bundle change.
 */
export function renderCancellation(ctx: VisitorEmailContext): RenderedEmail {
  const date = formatVisitDate(ctx.expected_at);
  const subject = `Your visit to ${ctx.building.name} has been cancelled`;
  const lines = [
    `Hi ${ctx.visitor.first_name},`,
    '',
    `Your visit to ${ctx.building.name} on ${date} has been cancelled.`,
    '',
    `If this was unexpected, please reach out to ${ctx.host.first_name}.`,
  ];
  if (ctx.building.reception_phone) {
    lines.push(`Reception: ${ctx.building.reception_phone}`);
  }
  const textBody = lines.join('\n');
  const bodyHtml = `
    <p>Hi ${escapeHtml(ctx.visitor.first_name)},</p>
    <p>Your visit to <strong>${escapeHtml(ctx.building.name)}</strong> on ${escapeHtml(date)} has been cancelled.</p>
    <p>If this was unexpected, please reach out to ${escapeHtml(ctx.host.first_name)}.</p>
    ${ctx.building.reception_phone ? `<p>Reception: ${escapeHtml(ctx.building.reception_phone)}</p>` : ''}
  `.trim();
  const htmlBody = envelope({
    tenant: ctx.tenant,
    preheader: `Visit cancelled · ${ctx.building.name}`,
    bodyHtml,
  });
  return { subject, textBody, htmlBody };
}

/**
 * `visitor.invitation.moved` — the bundle's start time changed; visitor
 * is still in `expected` so we update them.
 */
export function renderMoved(ctx: VisitorEmailContext): RenderedEmail {
  const oldDate = formatVisitDate(ctx.move?.old_expected_at ?? ctx.expected_at);
  const newDate = formatVisitDate(ctx.move?.new_expected_at ?? ctx.expected_at);
  const subject = `Your visit to ${ctx.building.name} has moved`;

  const lines = [
    `Hi ${ctx.visitor.first_name},`,
    '',
    `Your visit to ${ctx.building.name} has been rescheduled.`,
    '',
    `Was: ${oldDate}`,
    `Now: ${newDate}`,
    '',
    `Host: ${ctx.host.first_name}`,
  ];
  if (ctx.meeting_room) lines.push(`Meeting room: ${ctx.meeting_room.name}`);
  if (ctx.cancel_url) {
    lines.push('');
    lines.push(`Can't make the new time? Cancel here: ${ctx.cancel_url}`);
  }
  const textBody = lines.join('\n');
  const cancelHtml = ctx.cancel_url
    ? `<p>${ctaButtonHtml(ctx.cancel_url, "Can't make it? Cancel my visit", ctx.tenant.primary_color || '#0f172a')}</p>`
    : '';
  const bodyHtml = `
    <p>Hi ${escapeHtml(ctx.visitor.first_name)},</p>
    <p>Your visit to <strong>${escapeHtml(ctx.building.name)}</strong> has been rescheduled.</p>
    <p><strong>Was:</strong> ${escapeHtml(oldDate)}<br/>
    <strong>Now:</strong> ${escapeHtml(newDate)}</p>
    <p><strong>Host:</strong> ${escapeHtml(ctx.host.first_name)}${ctx.meeting_room ? `<br/><strong>Meeting room:</strong> ${escapeHtml(ctx.meeting_room.name)}` : ''}</p>
    ${cancelHtml}
  `.trim();
  const htmlBody = envelope({
    tenant: ctx.tenant,
    preheader: `Visit rescheduled · ${ctx.building.name}`,
    bodyHtml,
  });
  return { subject, textBody, htmlBody };
}

/**
 * `visitor.invitation.room_changed` — the bundle's room changed; visitor
 * is still in `expected` so we update them.
 */
export function renderRoomChanged(ctx: VisitorEmailContext): RenderedEmail {
  const date = formatVisitDate(ctx.expected_at);
  const oldRoom = ctx.room_change?.old_room_name ?? '(unspecified)';
  const newRoom = ctx.room_change?.new_room_name ?? '(unspecified)';
  const subject = `Your meeting room at ${ctx.building.name} has changed`;
  const lines = [
    `Hi ${ctx.visitor.first_name},`,
    '',
    `Your meeting room for the visit to ${ctx.building.name} on ${date} has changed.`,
    '',
    `Was: ${oldRoom}`,
    `Now: ${newRoom}`,
    '',
    `Host: ${ctx.host.first_name}`,
  ];
  if (ctx.cancel_url) {
    lines.push('');
    lines.push(`Can't make it? Cancel here: ${ctx.cancel_url}`);
  }
  const textBody = lines.join('\n');
  const cancelHtml = ctx.cancel_url
    ? `<p>${ctaButtonHtml(ctx.cancel_url, "Can't make it? Cancel my visit", ctx.tenant.primary_color || '#0f172a')}</p>`
    : '';
  const bodyHtml = `
    <p>Hi ${escapeHtml(ctx.visitor.first_name)},</p>
    <p>Your meeting room for the visit to <strong>${escapeHtml(ctx.building.name)}</strong> on ${escapeHtml(date)} has changed.</p>
    <p><strong>Was:</strong> ${escapeHtml(oldRoom)}<br/>
    <strong>Now:</strong> ${escapeHtml(newRoom)}</p>
    <p><strong>Host:</strong> ${escapeHtml(ctx.host.first_name)}</p>
    ${cancelHtml}
  `.trim();
  const htmlBody = envelope({
    tenant: ctx.tenant,
    preheader: `Room change · ${ctx.building.name}`,
    bodyHtml,
  });
  return { subject, textBody, htmlBody };
}

/**
 * `visitor.invitation.declined` — sent to the **host** (not the visitor)
 * when an approval gatekeeper denies the invite.
 *
 * Spec §11.3: "host receives 'your invitation was declined' notification.
 * Visitor receives nothing."
 */
export function renderDeclinedToHost(ctx: VisitorEmailContext): RenderedEmail {
  const fullName = visitorFullName(ctx.visitor) || 'your visitor';
  const date = formatVisitDate(ctx.expected_at);
  const subject = `Your visitor invitation for ${fullName} was declined`;
  const lines = [
    `Hi ${ctx.host.first_name},`,
    '',
    `Your invitation for ${fullName} to visit ${ctx.building.name} on ${date} was declined by the approval team.`,
    '',
    `If you believe this was a mistake, contact your facilities lead or security team.`,
    '',
    `${fullName} has not been notified.`,
  ];
  const textBody = lines.join('\n');
  const bodyHtml = `
    <p>Hi ${escapeHtml(ctx.host.first_name)},</p>
    <p>Your invitation for <strong>${escapeHtml(fullName)}</strong> to visit <strong>${escapeHtml(ctx.building.name)}</strong> on ${escapeHtml(date)} was declined by the approval team.</p>
    <p>If you believe this was a mistake, contact your facilities lead or security team.</p>
    <p style="color:#64748b;">${escapeHtml(fullName)} has not been notified.</p>
  `.trim();
  const htmlBody = envelope({
    tenant: ctx.tenant,
    preheader: `Invitation declined`,
    bodyHtml,
  });
  return { subject, textBody, htmlBody };
}

/* ─── dispatch table ───────────────────────────────────────────────────── */

export type VisitorEmailKind =
  | 'visitor.invitation.expected'
  | 'visitor.invitation.day_before_reminder'
  | 'visitor.invitation.cancelled'
  | 'visitor.invitation.moved'
  | 'visitor.invitation.room_changed'
  | 'visitor.invitation.declined';

export const VISITOR_EMAIL_TEMPLATES: Record<
  VisitorEmailKind,
  (ctx: VisitorEmailContext) => RenderedEmail
> = {
  'visitor.invitation.expected': renderInvitationExpected,
  'visitor.invitation.day_before_reminder': renderDayBeforeReminder,
  'visitor.invitation.cancelled': renderCancellation,
  'visitor.invitation.moved': renderMoved,
  'visitor.invitation.room_changed': renderRoomChanged,
  'visitor.invitation.declined': renderDeclinedToHost,
};
