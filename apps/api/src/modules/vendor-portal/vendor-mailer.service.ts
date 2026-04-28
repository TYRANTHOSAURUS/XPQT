import { Injectable, Logger } from '@nestjs/common';

/**
 * Outbound delivery surface for vendor-portal magic links + invitations.
 *
 * Sprint 1 ships the abstraction with a logging-only implementation —
 * the Sprint 2 controller never sees plaintext tokens, but a tenant
 * admin running locally can grab the link from server logs while
 * actual email delivery is wired in Sprint 4.
 *
 * Production implementation (Sprint 4) plugs into the same interface and
 * dispatches via Postmark / Resend EU. Test code can swap a no-op stub.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md §4.
 */
export interface VendorMailer {
  sendMagicLink(input: SendMagicLinkInput): Promise<MagicLinkSendResult>;
}

export interface SendMagicLinkInput {
  tenantId: string;
  vendorId: string;
  vendorUserId: string;
  email: string;
  displayName: string | null;
  rawToken: string;
  expiresAt: string;
  /** 'invited' on first issuance, 'resent' on re-issue. */
  reason: 'invited' | 'resent';
  /** Tenant-customised invitation message — surfaces in Sprint 4 templated email. */
  invitationMessage?: string | null;
}

export interface MagicLinkSendResult {
  /** Provider-side message id. Sprint 1 logging mailer returns a synthetic id. */
  messageId: string;
  /** When the mailer accepted the message (not when the user opens it). */
  acceptedAt: string;
}

/**
 * Sprint 1 dev-mode mailer. Logs the link at info level and stores it
 * NOWHERE (specifically: not the response of invite/issueMagicLink, not
 * the API request log, not a debug table). The link must reach the
 * intended human via the server log channel only.
 */
@Injectable()
export class LoggingVendorMailer implements VendorMailer {
  private readonly log = new Logger(LoggingVendorMailer.name);
  private readonly portalBaseUrl =
    process.env.VENDOR_PORTAL_BASE_URL ?? 'http://localhost:5173';

  async sendMagicLink(input: SendMagicLinkInput): Promise<MagicLinkSendResult> {
    const link = `${this.portalBaseUrl}/vendor/login?token=${encodeURIComponent(input.rawToken)}`;
    // Single structured log line; ops can filter on event="vendor_magic_link".
    // The link itself is the high-entropy bearer token — anyone with read
    // access to the log can act as the vendor user. Treat log retention
    // accordingly per docs/operations/breach-notification.md.
    this.log.warn(
      `event=vendor_magic_link reason=${input.reason} ` +
      `tenant=${input.tenantId} vendor=${input.vendorId} ` +
      `vendor_user=${input.vendorUserId} email=${input.email} ` +
      `expires=${input.expiresAt} link=${link}`,
    );
    return {
      messageId: `dev:${input.vendorUserId}:${Date.now()}`,
      acceptedAt: new Date().toISOString(),
    };
  }
}

/** DI token for swapping the implementation in Sprint 4 / tests. */
export const VENDOR_MAILER = Symbol('VENDOR_MAILER');
