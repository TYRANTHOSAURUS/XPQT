/**
 * /visit/cancel/:token — public visitor cancel landing.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §6.4
 * Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md slice 10
 *
 * The visitor receives an email invite from their host with a link of the
 * form `https://<tenant>.prequest.app/visit/cancel/:token`. They click it,
 * land here, and decide whether to cancel.
 *
 * Auth model:
 *   - This route lives OUTSIDE the auth-guarded portal/desk/admin shells.
 *     The token IS the auth — the backend validates it via SECURITY DEFINER
 *     functions that bypass RLS but enforce single-use + tenant isolation.
 *   - We never call any session-aware endpoint from this page. apiFetch()
 *     omits Authorization when there's no Supabase session, which is the
 *     anonymous case.
 *
 * Four states:
 *   1. **Loading peek** — fetching visit details (`GET /visitors/cancel/:token/preview`).
 *      No commitment, no token consumption.
 *   2. **Initial / interstitial** — shows the visit details and asks the
 *      visitor to confirm. Two large buttons: confirm (destructive variant)
 *      and "keep my visit" (navigates to a generic landing).
 *   3. **Cancelling** — `POST /visitors/cancel/:token` in flight; brief
 *      spinner; the page is locked while we wait. The token is consumed
 *      by this call.
 *   4. **Success / Error** — terminal states. Success links to a generic
 *      "you can close this tab" message; error maps the 410 code to
 *      visitor-friendly copy and surfaces a reception phone if available.
 *
 * Single-use enforcement:
 *   - The peek endpoint is read-only, so refreshing the interstitial does
 *     NOT consume the token.
 *   - The cancel POST consumes the token. If the visitor refreshes the
 *     page after a successful cancel, the peek call returns the visitor
 *     with status='cancelled', and we render the "already cancelled" copy
 *     directly from that — no new mutation fires. (Re-issuing the cancel
 *     would 410 anyway because the token is now consumed; this is just
 *     nicer UX.)
 *
 * i18n:
 *   - All visible strings are routed through the local `t()` shim below.
 *     The project doesn't yet have a runtime i18n library; this shim is a
 *     drop-in for future migration to react-i18next without touching JSX.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { AlertTriangle, CalendarX2, CheckCircle2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api';
import { formatFullTimestamp } from '@/lib/format';
import { useBranding } from '@/hooks/use-branding';
import {
  type CancelPreview,
  useCancelInvitationViaToken,
  useCancelPreview,
} from '@/api/visitors';

// ─── Strings (i18n-shaped) ────────────────────────────────────────────────
//
// Centralised so the JSX reads against keys, not literals. Adding a real
// i18n library later is a one-line swap to `useTranslation()` here.

const STRINGS = {
  pageTitle: 'Cancel your visit',
  loadingPreview: 'Loading your visit details…',
  interstitialHeading: 'Cancel your visit',
  interstitialBodyWithBuilding: (date: string, building: string) =>
    `You're cancelling your visit on ${date} at ${building}.`,
  interstitialBodyDateOnly: (date: string) =>
    `You're cancelling your visit on ${date}.`,
  interstitialBodyBuildingOnly: (building: string) =>
    `You're cancelling your visit at ${building}.`,
  interstitialBodyGeneric: "You're cancelling your upcoming visit.",
  hostLine: (host: string) =>
    `${host} will be notified that you're not coming.`,
  confirmButton: 'Yes, cancel my visit',
  keepButton: 'Keep my visit',
  cancellingHeading: 'Cancelling your visit…',
  successHeading: 'Your visit has been cancelled',
  successBody: (host: string) =>
    `We've notified ${host}. They'll be in touch if they need anything else.`,
  successBodyNoHost:
    "We've notified your host. They'll be in touch if they need anything else.",
  alreadyCancelledHeading: 'Already cancelled',
  alreadyCancelledBody:
    'This visit has already been cancelled. No further action needed.',
  closeTabHint: 'You can close this tab.',
  errorInvalid: {
    heading: 'This link doesn’t look valid',
    body: 'Sorry, this link doesn’t seem valid. Please contact the person who invited you.',
  },
  errorAlreadyUsed: {
    heading: 'Already cancelled',
    body: 'This visit has already been cancelled. No further action needed.',
  },
  errorExpired: {
    heading: 'This invitation link has expired',
    body: 'Please contact your host to re-invite or to confirm whether your visit is still happening.',
  },
  errorTooLate: {
    heading: 'This visit can no longer be cancelled',
    body: "Looks like you've already arrived or the visit window has passed. If this is wrong, contact your host.",
  },
  errorGeneric: {
    heading: 'Something went wrong',
    body: 'We couldn’t cancel your visit just now. Please try again, or contact your host.',
  },
  retry: 'Try again',
  poweredBy: 'Powered by Prequest',
  visitDetailsLabel: 'Visit details',
  whenLabel: 'When',
  whereLabel: 'Where',
  hostLabel: 'Host',
} as const;

/**
 * `t()` shim. Type-narrows the key, runs string templates with their args,
 * and returns the resolved string. Replace with `useTranslation()` later.
 */
type StringKeys = keyof typeof STRINGS;
function t<K extends StringKeys>(
  key: K,
  ...args: (typeof STRINGS)[K] extends (...args: infer P) => string ? P : []
): string {
  const v = STRINGS[key];
  if (typeof v === 'function') {
    return (v as (...a: unknown[]) => string)(...args);
  }
  if (typeof v === 'string') return v;
  // Nested error blocks aren't called via t() — kept structured for the
  // mapErrorCode helper below.
  return key as unknown as string;
}

// ─── Page ─────────────────────────────────────────────────────────────────

type Phase = 'interstitial' | 'cancelling' | 'cancelled' | 'kept';

export function VisitCancelPage() {
  const params = useParams<{ token: string }>();
  const token = params.token ?? '';
  const navigate = useNavigate();
  const { branding } = useBranding();
  const [phase, setPhase] = useState<Phase>('interstitial');

  const previewQuery = useCancelPreview(token);
  const cancelMutation = useCancelInvitationViaToken();

  // Set the document title for clarity in the browser tab — the tenant
  // name is already pulled in by the BrandingProvider.
  useEffect(() => {
    const prev = document.title;
    document.title = branding.name
      ? `${t('pageTitle')} – ${branding.name}`
      : t('pageTitle');
    return () => {
      document.title = prev;
    };
  }, [branding.name]);

  // ── Loading the peek ────────────────────────────────────────────────
  if (previewQuery.isPending && !previewQuery.data) {
    return (
      <PublicShell>
        <div className="flex flex-col items-center justify-center gap-4 py-12">
          <Spinner className="size-6" />
          <p className="text-sm text-muted-foreground">{t('loadingPreview')}</p>
        </div>
      </PublicShell>
    );
  }

  // ── Peek error → terminal error state ──────────────────────────────
  if (previewQuery.isError) {
    const code = mapErrorCode(previewQuery.error);
    const copy = errorCopy(code);
    return (
      <PublicShell>
        <ErrorPanel heading={copy.heading} body={copy.body} variant={code === 'token_already_used' ? 'info' : 'error'} />
      </PublicShell>
    );
  }

  const preview = previewQuery.data;
  if (!preview) {
    // Defence-in-depth — shouldn't hit this branch (isPending|isError covered above).
    return (
      <PublicShell>
        <ErrorPanel
          heading={STRINGS.errorGeneric.heading}
          body={STRINGS.errorGeneric.body}
          variant="error"
        />
      </PublicShell>
    );
  }

  // ── Visit already in a terminal status (cancelled / no_show / etc.) ─
  // Rendered without firing the cancel mutation. The peek doesn't consume
  // the token, so a refresh-after-cancel lands here cleanly.
  if (preview.visitor_status === 'cancelled' || phase === 'cancelled') {
    return (
      <PublicShell>
        <SuccessPanel
          host={preview.host_first_name}
          alreadyCancelled={preview.visitor_status === 'cancelled' && phase !== 'cancelled'}
        />
      </PublicShell>
    );
  }

  if (
    preview.visitor_status === 'arrived' ||
    preview.visitor_status === 'in_meeting' ||
    preview.visitor_status === 'checked_out' ||
    preview.visitor_status === 'no_show'
  ) {
    // The visitor already arrived or the visit window passed; cancellation
    // isn't meaningful. Same shape as the "too late" backend error.
    const copy = errorCopy('transition_not_allowed');
    return (
      <PublicShell>
        <ErrorPanel heading={copy.heading} body={copy.body} variant="info" />
      </PublicShell>
    );
  }

  // ── User picked "keep my visit" ─────────────────────────────────────
  if (phase === 'kept') {
    return (
      <PublicShell>
        <KeptPanel host={preview.host_first_name} />
      </PublicShell>
    );
  }

  // ── Cancelling spinner ──────────────────────────────────────────────
  if (phase === 'cancelling' || cancelMutation.isPending) {
    return (
      <PublicShell>
        <div className="flex flex-col items-center justify-center gap-4 py-12">
          <Spinner className="size-6" />
          <p className="text-sm text-muted-foreground">{t('cancellingHeading')}</p>
        </div>
      </PublicShell>
    );
  }

  // ── Cancel error (POST failed) ─────────────────────────────────────
  if (cancelMutation.isError) {
    const code = mapErrorCode(cancelMutation.error);
    const copy = errorCopy(code);
    return (
      <PublicShell>
        <ErrorPanel
          heading={copy.heading}
          body={copy.body}
          variant={code === 'token_already_used' ? 'info' : 'error'}
          retry={
            code === 'invalid_token' || code === 'token_expired' || code === 'token_already_used'
              ? undefined
              : () => {
                  cancelMutation.reset();
                }
          }
        />
      </PublicShell>
    );
  }

  // ── Default: interstitial confirmation ─────────────────────────────
  return (
    <PublicShell>
      <Interstitial
        preview={preview}
        onConfirm={() => {
          setPhase('cancelling');
          cancelMutation.mutate(
            { token, visitorIdHint: preview.visitor_id },
            {
              onSuccess: () => setPhase('cancelled'),
              onError: () => setPhase('interstitial'),
            },
          );
        }}
        onKeep={() => {
          // Per the spec note: window.close() is browser-blocked unless we
          // own the opener (clicking from an email opens a fresh tab with
          // no opener). Navigate to a benign in-app message instead.
          setPhase('kept');
          // Best-effort attempt — most browsers reject this; the kept
          // panel below is the visible fallback.
          try {
            navigate('.', { replace: true });
          } catch {
            /* noop */
          }
        }}
      />
    </PublicShell>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

function Interstitial({
  preview,
  onConfirm,
  onKeep,
}: {
  preview: CancelPreview;
  onConfirm: () => void;
  onKeep: () => void;
}) {
  const dateLabel = preview.expected_at
    ? formatFullTimestamp(preview.expected_at)
    : null;

  // Body line varies based on which fields we have. Building name comes
  // back denormalized as "the office" if no building was set.
  const bodyText = useMemo(() => {
    const hasBuilding = preview.building_name && preview.building_name !== 'the office';
    if (dateLabel && hasBuilding) {
      return STRINGS.interstitialBodyWithBuilding(dateLabel, preview.building_name);
    }
    if (dateLabel) return STRINGS.interstitialBodyDateOnly(dateLabel);
    if (hasBuilding) return STRINGS.interstitialBodyBuildingOnly(preview.building_name);
    return STRINGS.interstitialBodyGeneric;
  }, [dateLabel, preview.building_name]);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col items-center gap-3 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-amber-50 text-amber-600 ring-1 ring-amber-200/70 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-400/30">
          <CalendarX2 className="size-6" aria-hidden="true" />
        </span>
        <h1 className="text-balance text-3xl font-semibold tracking-tight">
          {t('interstitialHeading')}
        </h1>
        <p className="max-w-md text-balance text-muted-foreground">{bodyText}</p>
      </header>

      <section
        aria-labelledby="visit-details-heading"
        className="rounded-xl border border-border/60 bg-muted/30 p-5 ring-1 ring-black/5"
      >
        <h2
          id="visit-details-heading"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          {t('visitDetailsLabel')}
        </h2>
        <dl className="mt-3 grid gap-3 text-sm">
          {preview.expected_at && (
            <div className="grid grid-cols-[auto_1fr] gap-x-3">
              <dt className="font-medium text-muted-foreground">{t('whenLabel')}</dt>
              <dd className="tabular-nums">{formatFullTimestamp(preview.expected_at)}</dd>
            </div>
          )}
          {preview.building_name && preview.building_name !== 'the office' && (
            <div className="grid grid-cols-[auto_1fr] gap-x-3">
              <dt className="font-medium text-muted-foreground">{t('whereLabel')}</dt>
              <dd>{preview.building_name}</dd>
            </div>
          )}
          {preview.host_first_name && preview.host_first_name !== 'your host' && (
            <div className="grid grid-cols-[auto_1fr] gap-x-3">
              <dt className="font-medium text-muted-foreground">{t('hostLabel')}</dt>
              <dd>{preview.host_first_name}</dd>
            </div>
          )}
        </dl>
      </section>

      <p className="text-center text-sm text-muted-foreground">
        {t('hostLine', preview.host_first_name)}
      </p>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-center">
        <Button
          size="lg"
          variant="destructive"
          className="h-12 px-6 text-base sm:flex-1 sm:max-w-xs"
          onClick={onConfirm}
        >
          {t('confirmButton')}
        </Button>
        <Button
          size="lg"
          variant="outline"
          className="h-12 px-6 text-base sm:flex-1 sm:max-w-xs"
          onClick={onKeep}
        >
          {t('keepButton')}
        </Button>
      </div>
    </div>
  );
}

function SuccessPanel({
  host,
  alreadyCancelled,
}: {
  host: string;
  alreadyCancelled: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200/70 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-400/30">
        <CheckCircle2 className="size-7" aria-hidden="true" />
      </span>
      <h1 className="text-balance text-3xl font-semibold tracking-tight">
        {alreadyCancelled ? t('alreadyCancelledHeading') : t('successHeading')}
      </h1>
      <p className="max-w-md text-balance text-muted-foreground">
        {alreadyCancelled
          ? t('alreadyCancelledBody')
          : host && host !== 'your host'
            ? t('successBody', host)
            : STRINGS.successBodyNoHost}
      </p>
      <p className="text-sm text-muted-foreground">{t('closeTabHint')}</p>
    </div>
  );
}

function KeptPanel({ host }: { host: string }) {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-blue-50 text-blue-600 ring-1 ring-blue-200/70 dark:bg-blue-500/10 dark:text-blue-400 dark:ring-blue-400/30">
        <CheckCircle2 className="size-7" aria-hidden="true" />
      </span>
      <h1 className="text-balance text-3xl font-semibold tracking-tight">
        Your visit is still on
      </h1>
      <p className="max-w-md text-balance text-muted-foreground">
        Nothing changed.{' '}
        {host && host !== 'your host'
          ? `${host} will be expecting you as planned.`
          : 'Your host will be expecting you as planned.'}
      </p>
      <p className="text-sm text-muted-foreground">{t('closeTabHint')}</p>
    </div>
  );
}

function ErrorPanel({
  heading,
  body,
  variant,
  retry,
}: {
  heading: string;
  body: string;
  variant: 'error' | 'info';
  retry?: () => void;
}) {
  const Icon = variant === 'info' ? CheckCircle2 : ShieldAlert;
  const tone =
    variant === 'info'
      ? 'bg-blue-50 text-blue-600 ring-blue-200/70 dark:bg-blue-500/10 dark:text-blue-400 dark:ring-blue-400/30'
      : 'bg-rose-50 text-rose-600 ring-rose-200/70 dark:bg-rose-500/10 dark:text-rose-400 dark:ring-rose-400/30';
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <span className={`flex size-14 items-center justify-center rounded-full ring-1 ${tone}`}>
        <Icon className="size-7" aria-hidden="true" />
      </span>
      <h1 className="text-balance text-3xl font-semibold tracking-tight">{heading}</h1>
      <p className="max-w-md text-balance text-muted-foreground">{body}</p>
      {retry && (
        <Button onClick={retry} variant="outline">
          {t('retry')}
        </Button>
      )}
    </div>
  );
}

// ─── Shell ────────────────────────────────────────────────────────────────

function PublicShell({ children }: { children: React.ReactNode }) {
  const { branding } = useBranding();
  // Apply tenant primary color as a CSS variable so destructive button etc.
  // could pick it up if we wanted brand-tinted accents later. Today we
  // just keep the global theme intact — tenants don't expect their brand
  // color on the cancel CTA (it's destructive; brand-color destructives
  // confuse the affordance).
  return (
    <div className="fixed inset-0 flex flex-col bg-background text-foreground antialiased">
      <header className="border-b border-border/60 px-6 py-4">
        <div className="mx-auto flex max-w-md items-center justify-center gap-3">
          {branding.logo_light_url ? (
            <img
              src={branding.logo_light_url}
              alt={branding.name || 'Tenant logo'}
              className="h-7 w-auto object-contain"
            />
          ) : (
            <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <AlertTriangle className="size-4" aria-hidden="true" />
            </span>
          )}
          {branding.name && (
            <span className="text-sm font-medium text-muted-foreground">
              {branding.name}
            </span>
          )}
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-10">
        <div className="w-full max-w-md">{children}</div>
      </main>
      <footer className="border-t border-border/60 px-6 py-4">
        <div className="mx-auto flex max-w-md items-center justify-center text-xs text-muted-foreground">
          <Link
            to="/"
            className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded"
          >
            {t('poweredBy')}
          </Link>
        </div>
      </footer>
    </div>
  );
}

// ─── Error code mapping ───────────────────────────────────────────────────

type CancelErrorCode =
  | 'invalid_token'
  | 'token_already_used'
  | 'token_expired'
  | 'transition_not_allowed'
  | 'unknown';

function mapErrorCode(err: unknown): CancelErrorCode {
  if (!(err instanceof ApiError)) return 'unknown';
  // Backend sends `{ code: '...' }` inside the response body for 410 + the
  // 'transition_not_allowed' GoneException. ApiError.body holds it.
  const body = err.body as { code?: string } | null | undefined;
  const code = body?.code;
  switch (code) {
    case 'invalid_token':
    case 'token_already_used':
    case 'token_expired':
    case 'transition_not_allowed':
      return code;
    default:
      return 'unknown';
  }
}

function errorCopy(code: CancelErrorCode): { heading: string; body: string } {
  switch (code) {
    case 'invalid_token':
      return STRINGS.errorInvalid;
    case 'token_already_used':
      return STRINGS.errorAlreadyUsed;
    case 'token_expired':
      return STRINGS.errorExpired;
    case 'transition_not_allowed':
      return STRINGS.errorTooLate;
    default:
      return STRINGS.errorGeneric;
  }
}
