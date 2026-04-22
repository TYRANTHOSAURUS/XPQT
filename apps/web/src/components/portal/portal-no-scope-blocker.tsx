import { useState } from 'react';
import { AlertCircle, Mail, MapPin } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { LocationCombobox } from '@/components/location-combobox';
import { usePortal } from '@/providers/portal-provider';

/**
 * Renders when /portal/me.can_submit = false — person has no default location
 * and no grants.
 *
 * Two branches:
 *  - `can_self_onboard=true` (tenant opted in AND person is an employee): show
 *    a picker so the user can claim their initial work location themselves.
 *    POST /portal/me/claim-default-location enforces a one-shot write.
 *  - otherwise: "contact your workplace admin" fallback.
 *
 * See docs/portal-scope-slice.md §9 edge cases.
 */
export function PortalNoScopeBlocker() {
  const { data, claimDefaultLocation } = usePortal();
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canSelfOnboard = data?.can_self_onboard ?? false;

  const onClaim = async () => {
    if (!spaceId) {
      toast.error('Pick your work location first');
      return;
    }
    setSubmitting(true);
    try {
      await claimDefaultLocation(spaceId);
      toast.success('Work location set');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to set work location');
    } finally {
      setSubmitting(false);
    }
  };

  if (canSelfOnboard) {
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
                  services and route requests based on this. You can change it later by
                  asking your workplace admin.
                </p>
              </div>
            </div>
            <FieldGroup>
              <Field>
                <FieldLabel>Work location</FieldLabel>
                <LocationCombobox
                  value={spaceId}
                  onChange={setSpaceId}
                  typesFilter={['site', 'building']}
                  placeholder="Select a site or building…"
                  activeOnly
                />
              </Field>
            </FieldGroup>
            <div className="flex justify-end">
              <Button onClick={() => void onClaim()} disabled={submitting || !spaceId}>
                {submitting ? 'Saving…' : 'Save and continue'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto py-10">
      <Card>
        <CardContent className="pt-6">
          <Alert variant="default" className="border-amber-500/40 bg-amber-500/5">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Your work location isn't set yet</AlertTitle>
            <AlertDescription className="space-y-3">
              <p className="text-sm">
                You can't submit requests yet because no default work location has been
                assigned to your account, and you haven't been granted access to any
                specific locations.
              </p>
              <p className="text-sm text-muted-foreground inline-flex items-center gap-1">
                <Mail className="h-3.5 w-3.5" />
                Contact your workplace admin to set your work location.
              </p>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}
