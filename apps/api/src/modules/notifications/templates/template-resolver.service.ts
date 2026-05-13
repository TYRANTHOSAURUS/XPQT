import { Injectable, Logger } from '@nestjs/common';
import { render } from '@react-email/render';
import * as React from 'react';
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
 * Registry of `(eventKind, locale)` → template module. Keep this static
 * — adding a new event kind or a new locale is a deliberate code change.
 */
const REGISTRY: Record<string, Record<'en' | 'nl', TemplateModule<unknown> | undefined>> = {
  'booking.approval_required': {
    en: bookingApprovalRequiredEn as TemplateModule<unknown>,
    nl: bookingApprovalRequiredNl as TemplateModule<unknown>,
  },
};

export interface ResolveArgs {
  tenantId: string;
  /** e.g. 'booking.approval_required' — must match a REGISTRY key. */
  eventKind: string;
  /** Pre-validated locale; unknown values default to 'en' defensively. */
  locale: 'en' | 'nl';
  /** Typed payload — caller's responsibility to match the kind. */
  payload: Record<string, unknown>;
}

@Injectable()
export class TemplateResolverService {
  private readonly log = new Logger(TemplateResolverService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async resolve(args: ResolveArgs): Promise<RenderedTemplate> {
    const locale = args.locale === 'en' || args.locale === 'nl' ? args.locale : 'en';

    const localeMap = REGISTRY[args.eventKind];
    if (!localeMap) {
      throw new Error(`template_resolver.unknown_event_kind: ${args.eventKind}`);
    }
    const template = localeMap[locale] ?? localeMap.en;
    if (!template) {
      throw new Error(
        `template_resolver.no_template: kind=${args.eventKind} locale=${locale}`,
      );
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

    return {
      subject,
      html,
      text,
      ctaText: overrides.ctaText ?? undefined,
      // ctaUrl belongs in payload; the template handles linking. We surface
      // ctaText because Teams adapters and inbox previews need the button
      // copy independent of the rendered HTML.
    };
  }

  private async loadOverrides(
    tenantId: string,
    eventKind: string,
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

/**
 * Type-narrowing helper for callers that want compile-time payload safety.
 * Today only one event kind ships; future kinds add to the union.
 */
export type NotificationEventPayloads = {
  'booking.approval_required': BookingApprovalRequiredPayload;
};
