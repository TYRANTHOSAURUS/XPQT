/**
 * /kiosk/setup — first-time provisioning landing.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §8.1
 * Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md task 8.1
 *
 * Flow:
 *   1. Admin generates a kiosk token in `/admin/visitors/passes` (slice 9).
 *   2. Admin sends the kiosk device to a URL like
 *      `/kiosk/setup?token=…&building=…&building_name=…&tenant=…&tenant_name=…`.
 *      (Slice 9 owns the URL builder; this page is forward-compatible with
 *      whatever query keys the backend ends up emitting — extras are
 *      ignored, missing values fall back to "Unknown".)
 *   3. This page calls `probeKioskToken` (a tiny `GET /kiosk/visitor-types`)
 *      to confirm the token is accepted by the backend and stores the
 *      session in localStorage.
 *   4. On success: navigates to `/kiosk` (idle screen).
 *
 * Manual reset: a "Reset kiosk" button clears the local session so an
 * admin can re-provision without diving into the browser's storage UI.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toastSuccess } from '@/lib/toast';
import { clearKioskSession, readKioskSession, writeKioskSession } from '@/lib/kiosk-auth';
import { probeKioskToken } from '@/api/visitors/kiosk';

type Status = 'idle' | 'verifying' | 'error' | 'ok';

export function KioskSetupPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Manual entry fields (used when the admin pastes the token by hand from
  // the kiosk's settings menu rather than scanning a setup URL).
  const [manualToken, setManualToken] = useState('');
  const [manualBuildingName, setManualBuildingName] = useState('');

  const tokenFromUrl = params.get('token');
  const buildingId = params.get('building') ?? params.get('building_id');
  const buildingName = params.get('building_name') ?? null;
  const tenantId = params.get('tenant') ?? params.get('tenant_id');
  const tenantName = params.get('tenant_name') ?? null;
  const primaryColor = params.get('primary_color');
  const logoLight = params.get('logo_light_url');
  const logoDark = params.get('logo_dark_url');
  const showProvisioningMessage = params.get('msg') === 'needs-provisioning';

  // Auto-bind if we landed with a full setup URL.
  useEffect(() => {
    if (!tokenFromUrl || !buildingId || !tenantId) return;
    void verifyAndStore({
      token: tokenFromUrl,
      tenantId,
      buildingId,
      buildingName: buildingName ?? 'this building',
      tenantName: tenantName ?? null,
      primaryColor: primaryColor ?? null,
      logoLight: logoLight ?? null,
      logoDark: logoDark ?? null,
    });
    // run only once on first load with a setup URL
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verifyAndStore(args: {
    token: string;
    tenantId: string | null;
    buildingId: string | null;
    buildingName: string;
    tenantName: string | null;
    primaryColor: string | null;
    logoLight: string | null;
    logoDark: string | null;
  }) {
    setStatus('verifying');
    setErrorMsg(null);
    const ok = await probeKioskToken(args.token);
    if (!ok) {
      setStatus('error');
      setErrorMsg(
        'The provided kiosk token was rejected. Ask your admin to generate a fresh one.',
      );
      return;
    }
    writeKioskSession({
      token: args.token,
      tenantId: args.tenantId,
      buildingId: args.buildingId,
      buildingName: args.buildingName,
      branding: {
        tenant_name: args.tenantName,
        primary_color: args.primaryColor,
        logo_light_url: args.logoLight,
        logo_dark_url: args.logoDark,
      },
      provisionedAt: new Date().toISOString(),
    });
    setStatus('ok');
    setTimeout(() => navigate('/kiosk', { replace: true }), 600);
  }

  function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = manualToken.trim();
    if (!trimmed) return;
    // Manual paste-only flow — no setup URL means we don't yet know the
    // tenantId / buildingId. Backend resolves both from the token; we
    // store null rather than the literal string 'unknown' so any code
    // that branches on the value handles "unknown" honestly.
    void verifyAndStore({
      token: trimmed,
      tenantId: null,
      buildingId: null,
      buildingName: manualBuildingName.trim() || 'this building',
      tenantName: null,
      primaryColor: null,
      logoLight: null,
      logoDark: null,
    });
  }

  function handleReset() {
    clearKioskSession();
    setStatus('idle');
    // Reset is a successful admin action, not an error — surface it as
    // a confirmation rather than an error toast.
    toastSuccess('Kiosk reset', { description: 'Local session cleared.' });
  }

  const existing = readKioskSession();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 p-8">
      <div className="flex w-full max-w-2xl flex-col gap-8">
        <header className="flex flex-col gap-2 text-center">
          <h1 className="text-4xl font-semibold tracking-tight">Kiosk setup</h1>
          <p className="text-lg text-muted-foreground">
            Bind this device to a building so the lobby check-in can take
            visitors.
          </p>
        </header>

        {showProvisioningMessage && !existing ? (
          <div className="rounded-lg border bg-muted/50 px-4 py-3 text-base">
            This device hasn't been set up yet. Open the URL your admin sent
            you, or paste the kiosk token below.
          </div>
        ) : null}

        {status === 'verifying' ? (
          <div className="rounded-lg border bg-muted/30 px-4 py-3 text-base">
            Verifying kiosk token…
          </div>
        ) : null}

        {status === 'ok' ? (
          <div className="rounded-lg border border-green-500/40 bg-green-500/10 px-4 py-3 text-base">
            Kiosk verified. Redirecting to the welcome screen…
          </div>
        ) : null}

        {status === 'error' && errorMsg ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-base text-destructive">
            {errorMsg}
          </div>
        ) : null}

        {!tokenFromUrl ? (
          <form onSubmit={handleManualSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="kiosk-token">Kiosk token</FieldLabel>
                <Input
                  id="kiosk-token"
                  value={manualToken}
                  onChange={(e) => setManualToken(e.target.value)}
                  placeholder="Paste the token your admin generated"
                  autoComplete="off"
                  spellCheck={false}
                  className="text-lg"
                />
                <FieldDescription>
                  Generated in admin → Visitors → Passes → Provision kiosk.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="kiosk-building-name">
                  Building label (optional)
                </FieldLabel>
                <Input
                  id="kiosk-building-name"
                  value={manualBuildingName}
                  onChange={(e) => setManualBuildingName(e.target.value)}
                  placeholder="HQ Amsterdam"
                  autoComplete="off"
                  className="text-lg"
                />
                <FieldDescription>
                  Shown on the welcome screen. Defaults to "this building" when
                  blank.
                </FieldDescription>
              </Field>
              <Button
                type="submit"
                size="lg"
                className="h-14 text-lg"
                disabled={!manualToken.trim() || status === 'verifying'}
              >
                Verify and continue
              </Button>
            </FieldGroup>
          </form>
        ) : null}

        {existing ? (
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">
              Currently provisioned for{' '}
              <span className="font-medium text-foreground">
                {existing.buildingName}
              </span>
              {existing.branding?.tenant_name ? (
                <>
                  {' '}
                  ({existing.branding.tenant_name})
                </>
              ) : null}
              .
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="lg"
                className="h-12 text-base"
                onClick={() => navigate('/kiosk', { replace: true })}
              >
                Continue to kiosk
              </Button>
              <Button
                variant="ghost"
                size="lg"
                className="h-12 text-base"
                onClick={handleReset}
              >
                Reset kiosk
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
