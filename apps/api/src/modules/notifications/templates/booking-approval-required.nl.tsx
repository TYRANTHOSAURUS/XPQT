import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import * as React from 'react';
import type {
  BookingApprovalRequiredPayload,
  TemplateModule,
  TemplateOverrides,
} from './types';

/**
 * Dutch-language default template for `booking.approval_required`.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step C + Quality bar "NL voice" rule —
 * use the `reservering` family (NOT `boeking`). Mirror of the EN template;
 * styles are shared visually.
 *
 * Override fields (TemplateOverrides):
 *   - subject — replaces "${requesterName} vraagt goedkeuring voor ..."
 *   - ctaText — replaces "Verzoek bekijken"
 *   - bodyIntro — replaces the standard intro paragraph
 */

function renderSubject(
  payload: BookingApprovalRequiredPayload,
  overrides: TemplateOverrides,
): string {
  if (overrides.subject) return overrides.subject;
  return `${payload.requesterName} vraagt goedkeuring voor ${payload.spaceName}`;
}

function formatDateRange(startAt: string, endAt: string): string {
  // Format as "ma 13 mei, 09:00 – 10:30 (UTC)" — explicit UTC marker, same
  // reasoning as the EN template.
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${startAt} – ${endAt}`;
  }
  const dateOpts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  };
  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    hour12: false,
  };
  return `${start.toLocaleDateString('nl-NL', dateOpts)}, ${start.toLocaleTimeString('nl-NL', timeOpts)} – ${end.toLocaleTimeString('nl-NL', timeOpts)} (UTC)`;
}

const Component: React.FC<{
  payload: BookingApprovalRequiredPayload;
  overrides: TemplateOverrides;
}> = ({ payload, overrides }) => {
  const intro = overrides.bodyIntro
    ?? `${payload.requesterName} heeft een reservering aangevraagd waarvoor jouw goedkeuring nodig is.`;
  const cta = overrides.ctaText ?? 'Verzoek bekijken';
  const previewText = `${payload.requesterName} vraagt goedkeuring voor ${payload.spaceName}`;

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Heading style={headingStyle}>Goedkeuring vereist</Heading>

          <Text style={paragraphStyle}>{intro}</Text>

          <Section style={detailsStyle}>
            <Text style={labelStyle}>Reservering</Text>
            <Text style={valueStyle}>{payload.bookingTitle || payload.spaceName}</Text>

            <Text style={labelStyle}>Ruimte</Text>
            <Text style={valueStyle}>{payload.spaceName}</Text>

            <Text style={labelStyle}>Wanneer</Text>
            <Text style={valueStyle}>{formatDateRange(payload.startAt, payload.endAt)}</Text>

            <Text style={labelStyle}>Aangevraagd door</Text>
            <Text style={valueStyle}>{payload.requesterName}</Text>
          </Section>

          <Section style={ctaSectionStyle}>
            <Button href={payload.approvalCtaUrl} style={buttonStyle}>
              {cta}
            </Button>
          </Section>

          <Text style={footerStyle}>
            Je ontvangt deze e-mail omdat je goedkeurder bent voor deze reservering.
          </Text>
        </Container>
      </Body>
    </Html>
  );
};

const bodyStyle: React.CSSProperties = {
  backgroundColor: '#f6f7f9',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  margin: 0,
  padding: '24px 0',
};

const containerStyle: React.CSSProperties = {
  backgroundColor: '#ffffff',
  borderRadius: 8,
  margin: '0 auto',
  maxWidth: 560,
  padding: '32px',
};

const headingStyle: React.CSSProperties = {
  color: '#0f172a',
  fontSize: 20,
  fontWeight: 600,
  lineHeight: '28px',
  margin: '0 0 16px 0',
};

const paragraphStyle: React.CSSProperties = {
  color: '#1e293b',
  fontSize: 14,
  lineHeight: '22px',
  margin: '0 0 24px 0',
};

const detailsStyle: React.CSSProperties = {
  borderRadius: 6,
  backgroundColor: '#f8fafc',
  padding: '16px 20px',
  marginBottom: 24,
};

const labelStyle: React.CSSProperties = {
  color: '#64748b',
  fontSize: 12,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  margin: '12px 0 4px 0',
};

const valueStyle: React.CSSProperties = {
  color: '#0f172a',
  fontSize: 14,
  margin: '0',
};

const ctaSectionStyle: React.CSSProperties = {
  marginTop: 8,
  marginBottom: 24,
};

const buttonStyle: React.CSSProperties = {
  backgroundColor: '#0f172a',
  borderRadius: 6,
  color: '#ffffff',
  display: 'inline-block',
  fontSize: 14,
  fontWeight: 500,
  padding: '10px 20px',
  textDecoration: 'none',
};

const footerStyle: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: 12,
  lineHeight: '18px',
  margin: 0,
};

const templateModule: TemplateModule<BookingApprovalRequiredPayload> = {
  renderSubject,
  Component,
};

export default templateModule;
