import { AlertCircle, Mail } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Renders when /portal/me.can_submit = false — person has no default location
 * and no grants. The portal is not usable until an admin assigns at least one.
 * Matches docs/portal-scope-slice.md §9 edge cases.
 */
export function PortalNoScopeBlocker() {
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
