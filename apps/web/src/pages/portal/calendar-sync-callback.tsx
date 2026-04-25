import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { useFinishConnect } from '@/api/calendar-sync';

/**
 * /portal/calendar-sync/callback
 *
 * Microsoft redirects here after the user grants consent. We pull `code` and
 * `state` from the query string, exchange them for tokens via the backend,
 * then bounce the user back to /portal/me/calendar-sync.
 *
 * Failure modes shown inline (with a one-click "Try again" → connect page)
 * because OAuth errors are unfortunately common (consent declined, network
 * blip, redirect URI mismatch on the app registration, etc.).
 */
export function PortalCalendarSyncCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const finish = useFinishConnect();

  const [error, setError] = useState<string | null>(null);
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const code = params.get('code');
    const state = params.get('state');
    const oauthError = params.get('error');
    const oauthErrorDesc = params.get('error_description');

    if (oauthError) {
      setError(oauthErrorDesc ?? oauthError);
      return;
    }
    if (!code || !state) {
      setError('Missing code or state in the callback URL.');
      return;
    }

    void finish
      .mutateAsync({ code, state })
      .then(() => {
        toast.success('Outlook calendar connected');
        navigate('/portal/me/calendar-sync', { replace: true });
      })
      .catch((err: Error) => {
        setError(err.message ?? 'Could not finish connecting Outlook.');
      });
    // We intentionally only run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto w-full max-w-[480px] px-6 py-16">
      <div className="flex flex-col items-center gap-4 rounded-lg border bg-card p-8 text-center">
        {error ? (
          <>
            <div className="rounded-full bg-destructive/10 p-3">
              <AlertCircle className="size-6 text-destructive" />
            </div>
            <div className="flex flex-col gap-1">
              <h1 className="text-lg font-semibold">Could not connect</h1>
              <p className="text-sm text-muted-foreground max-w-sm">{error}</p>
            </div>
            <Button onClick={() => navigate('/portal/me/calendar-sync')}>Try again</Button>
          </>
        ) : (
          <>
            <Spinner className="size-6 text-muted-foreground" />
            <div className="flex flex-col gap-1">
              <h1 className="text-lg font-semibold inline-flex items-center gap-2">
                <CheckCircle2 className="size-5 text-emerald-500" />
                Almost there
              </h1>
              <p className="text-sm text-muted-foreground">
                Finishing the connection with Microsoft Graph…
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
