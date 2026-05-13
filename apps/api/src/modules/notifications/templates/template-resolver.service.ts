import { Injectable, Logger } from '@nestjs/common';
import { render } from '@react-email/render';
import * as React from 'react';
import { AppErrors } from '../../../common/errors';
import { SupabaseService } from '../../../common/supabase/supabase.service';
import bookingApprovalRequiredEn from './booking-approval-required.en';
import bookingApprovalRequiredNl from './booking-approval-required.nl';
import type {
  BookingApprovalRequiredPayload,
  RenderedTemplate,
  TemplateModule,
  TemplateOverrides,
} from './types';

/**
 * TemplateResolverService — load default template + apply tenant overrides
 * → render to HTML/text + return the resolved subject + CTA copy.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step C.
 *
 * ── Override semantics (architect I5) ───────────────────────────────────
 *
 * Each override field is treated as:
 *   - null   → use default (no override registered).
 *   - ""     → use default (treat empty as "no override" — admin UI lets
 *              users blank a field to revert without deleting the row).
 *   - "..."  → use the trimmed string as-is.
 *
 * The trim happens HERE (single source of truth), not in the admin UI,
 * because direct DB inserts (cron jobs, future automation) shouldn't be
 * able to bypass the normalisation.
 *
 * ── Locale fallback (plan-review I6) ────────────────────────────────────
 *
 * Caller passes a `locale` already typed as 'en' | 'nl'. If somehow an
 * unexpected value reaches us (defensive), we fall back to 'en'. Throwing
 * here would dead-letter a notification on a metadata bug — not worth it.
 *
 * ── Cross-tenant defense ────────────────────────────────────────────────
 *
 * Override lookup filters by tenant_id. supabase.admin bypasses RLS, so
 * this filter is the boundary. Pattern matches branding.service.ts.
 */

/**
 * Type-narrowing map: each event kind → its strongly-typed payload.
 * Adding a new kind here is a one-liner; the type-system then propagates
 * the new kind across `ResolveArgs` and into REGISTRY (self-review I8 —
 * the previous `Record<string, ...>` shape lost compile-time payload
 * checking; a typo in a payload field name silently rendered `undefined`).
 */
export type NotificationEventPayloads = {
  'booking.approval_required': BookingApprovalRequiredPayload;
};

/**
 * Registry of `(eventKind, locale)` → template module. Keep this static
 * — adding a new event kind or a new locale is a deliberate code change.
 *
 * Self-review I8: each entry is typed via `NotificationEventPayloads[K]`
 * so that the template module's payload contract matches its declared
 * kind. The previous `TemplateModule<unknown>` cast hid mismatches
 * (kind ↔ payload).
 */
const REGISTRY: {
  [K in keyof NotificationEventPayloads]: Record<
    'en' | 'nl',
    TemplateModule<NotificationEventPayloads[K]> | undefined
  >;
} = {
  'booking.approval_required': {
    en: bookingApprovalRequiredEn,
    nl: bookingApprovalRequiredNl,
  },
};

export type NotificationEventKind = keyof NotificationEventPayloads;

export interface ResolveArgs<K extends NotificationEventKind = NotificationEventKind> {
  tenantId: string;
  /** Must match a key in `NotificationEventPayloads`. */
  eventKind: K;
  /** Pre-validated locale; unknown values default to 'en' defensively. */
  locale: 'en' | 'nl';
  /** Typed payload — `NotificationEventPayloads[K]`. Compile catches typos. */
  payload: NotificationEventPayloads[K];
}

/**
 * Default CTA copy per (eventKind, locale). Surfaced via
 * `RenderedTemplate.ctaText` so Teams adapters + inbox previews + future
 * channels can read the button copy independent of the rendered HTML
 * (self-review I2 — previously `ctaText` was undefined when no override
 * was registered, which broke any caller that relied on the field).
 *
 * Keep these in sync with the literal strings inside the template
 * components (`booking-approval-required.en.tsx:75` / `.nl.tsx:69`). The
 * test suite asserts this — drift fails CI.
 */
const DEFAULT_CTA_TEXT: {
  [K in NotificationEventKind]: Record<'en' | 'nl', string>;
} = {
  'booking.approval_required': {
    en: 'Review request',
    nl: 'Verzoek bekijken',
  },
};

@Injectable()
export class TemplateResolverService {
  private readonly log = new Logger(TemplateResolverService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async resolve<K extends NotificationEventKind>(
    args: ResolveArgs<K>,
  ): Promise<RenderedTemplate> {
    const locale = args.locale === 'en' || args.locale === 'nl' ? args.locale : 'en';

    const localeMap = REGISTRY[args.eventKind];
    if (!localeMap) {
      // Programming / config error: handler passed an eventKind that has
      // no template module registered. 500 + dead-letter is the right
      // shape — retrying won't help, ops needs to ship the missing
      // module. Self-review C1 (was raw `new Error()`).
      throw AppErrors.server('notification.unknown_event_kind', {
        detail: `eventKind=${String(args.eventKind)}`,
      });
    }
    const template = localeMap[locale] ?? localeMap.en;
    if (!template) {
      // Same shape as unknown_event_kind: the locale was missing AND the
      // 'en' fallback was missing. Signals an incomplete template module.
      // Self-review C1 (was raw `new Error()`).
      throw AppErrors.server('notification.template_resolution_failed', {
        detail: `kind=${String(args.eventKind)} locale=${locale}`,
      });
    }

    // ── 1. Load tenant overrides — best-effort, never throws upstream. ──
    //
    // If the table read fails (RLS surprise, transient supabase blip),
    // we render with default copy + log a warn. Better to send the
    // canonical email than to dead-letter the notification because the
    // admin tweaked the subject line.
    const overrides = await this.loadOverrides(args.tenantId, args.eventKind, locale);

    // ── 2. Render. ───────────────────────────────────────────────────────
    const subject = template.renderSubject(args.payload, overrides);
    const element = React.createElement(template.Component, {
      payload: args.payload,
      overrides,
    });

    const [html, text] = await Promise.all([
      render(element),
      render(element, { plainText: true }),
    ]);

    // ── 3. Resolve effective CTA text. ──────────────────────────────────
    //
    // Self-review I2: surface the template's DEFAULT cta even when no
    // override is registered, so Teams adapters + inbox previews + future
    // channels see a non-undefined value. Override wins; default fills
    // in otherwise. ctaUrl still belongs in payload — the template
    // component owns linking.
    const effectiveCta =
      overrides.ctaText ?? DEFAULT_CTA_TEXT[args.eventKind][locale];

    return {
      subject,
      html,
      text,
      ctaText: effectiveCta,
    };
  }

  private async loadOverrides(
    tenantId: string,
    eventKind: NotificationEventKind,
    locale: 'en' | 'nl',
  ): Promise<TemplateOverrides> {
    try {
      const { data, error } = await this.supabase.admin
        .from('notification_template_overrides')
        .select('subject_override, cta_text_override, body_intro_override')
        .eq('tenant_id', tenantId)
        .eq('event_kind', eventKind)
        .eq('locale', locale)
        // Plan v2 §Sub-step C — "if multiple, take the most recent". The
        // schema already enforces a unique (tenant, event_kind, locale)
        // constraint (00392:47) so this ordering is defensive against
        // schema drift, not the expected case.
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        this.log.warn(
          `template_resolver.override_load_failed: tenant=${tenantId} kind=${eventKind} locale=${locale} ${error.message}`,
        );
        return {};
      }
      if (!data) return {};

      return {
        subject: normalize(data.subject_override),
        ctaText: normalize(data.cta_text_override),
        bodyIntro: normalize(data.body_intro_override),
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.log.warn(
        `template_resolver.override_load_threw: tenant=${tenantId} kind=${eventKind} locale=${locale} ${detail}`,
      );
      return {};
    }
  }
}

/** Trim + collapse empty strings to null per architect I5. */
function normalize(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
