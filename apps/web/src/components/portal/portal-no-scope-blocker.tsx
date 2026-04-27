import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Building2, Mail, MapPin } from 'lucide-react';
import { toastError, toastSuccess } from '@/lib/toast';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { apiFetch } from '@/lib/api';
import { usePortal } from '@/providers/portal-provider';

interface OnboardableSpace {
  id: string;
  name: string;
  type: string;
}

/**
 * Renders when /portal/me.can_submit = false — person has no default location
 * and no grants.
 *
 * Two branches:
 *  - `can_self_onboard=true` (tenant flagged + person type='employee' +
 *    zero scope): show a curated picker backed by /portal/me/onboard-locations.
 *    The picker only offers sites/buildings that actually have active request
 *    types with eligible descendants — no dead ends.
 *  - otherwise: "contact your workplace admin" fallback.
 *
 * See docs/portal-scope-slice.md §9 edge cases.
 */
export function PortalNoScopeBlocker() {
  const { data, claimDefaultLocation } = usePortal();
  const canSelfOnboard = data?.can_self_onboard ?? false;

  const [options, setOptions] = useState<OnboardableSpace[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchOptions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await apiFetch<OnboardableSpace[]>('/portal/me/onboard-locations');
      setOptions(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load locations');
      setOptions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canSelfOnboard) void fetchOptions();
  }, [canSelfOnboard, fetchOptions]);

  const onClaim = async () => {
    if (!spaceId) return;
    setSubmitting(true);
    try {
      await claimDefaultLocation(spaceId);
      toastSuccess('Work location set');
    } catch (e) {
      toastError("Couldn't set your work location", { error: e, retry: onClaim });
    } finally {
      setSubmitting(false);
    }
  };

  // Self-onboard path, but tenant has zero onboardable locations → fall back
  // to the admin-required message. Hitting this means the tenant flagged
  // self-onboard but hasn't configured any request types yet.
  const zeroOptions = canSelfOnboard && options !== null && options.length === 0 && !loading;

  if (canSelfOnboard && !zeroOptions) {
    return (
      <div className="max-w-xl mx-auto py-10">
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-start gap-3">
              <MapPin className="h-5 w-5 mt-0.5 text-primary" />
              <div>
                <h2 className="font-semibold">Where's your work location?</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Pick the site or building you primarily work at. The portal will show
                  services and route requests based on this. Only locations with
                  available services are listed.
                </p>
              </div>
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Couldn't load locations</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {loading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Spinner className="size-4" /> Loading locations…
              </div>
            )}

            {!loading && options && options.length > 0 && (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="onboard-space">Work location</FieldLabel>
                  <Select value={spaceId ?? ''} onValueChange={(v) => setSpaceId(v || null)}>
                    <SelectTrigger id="onboard-space">
                      <SelectValue placeholder="Select a location…" />
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((opt) => (
                        <SelectItem key={opt.id} value={opt.id}>
                          <span className="inline-flex items-center gap-2">
                            <Building2 className="h-3.5 w-3.5" />
                            <span>{opt.name}</span>
                            <Badge variant="outline" className="text-[10px] capitalize">
                              {opt.type}
                            </Badge>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    {options.length === 1
                      ? 'One location is configured for this tenant.'
                      : `${options.length} locations configured for this tenant.`}
                  </FieldDescription>
                </Field>
              </FieldGroup>
            )}

            <div className="flex justify-end">
              <Button
                onClick={() => void onClaim()}
                disabled={submitting || !spaceId || loading}
              >
                {submitting ? 'Saving…' : 'Save and continue'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Fallback: either self-onboard is off for this tenant/person, or the
  // tenant has self-onboard on but no request types configured anywhere.
  return (
    <div className="max-w-xl mx-auto py-10">
      <Card>
        <CardContent className="pt-6">
          <Alert variant="default" className="border-amber-500/40 bg-amber-500/5">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Your work location isn't set yet</AlertTitle>
            <AlertDescription className="space-y-3">
              <p className="text-sm">
                {zeroOptions
                  ? `The portal is available, but no services have been configured yet.`
                  : `You can't submit requests yet because no default work location has been assigned to your account, and you haven't been granted access to any specific locations.`}
              </p>
              <p className="text-sm text-muted-foreground inline-flex items-center gap-1">
                <Mail className="h-3.5 w-3.5" />
                Contact your workplace admin to get set up.
              </p>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}
