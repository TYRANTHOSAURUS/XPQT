import { Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * Routing Studio Visibility tab (Artifact C placeholder).
 *
 * Visibility is deliberately not a standalone engine — see Contract 5 in
 * the improvement plan. It runs through `TicketVisibilityService` and the
 * SQL predicate `public.ticket_visibility_ids`, grounded in role
 * assignments (`user_role_assignments.domain_scope` + `.location_scope`)
 * plus routing-owned inheritance flags.
 *
 * This tab exists so the Studio's information architecture matches the
 * target IA (Routing Map · Case Ownership · Child Dispatch · Visibility ·
 * Explain · Advanced Overrides · Audit). A real editor replaces this
 * placeholder once routing-owned visibility flags
 * (VisibilityHints.parent_owner_sees_children, vendor_children_visibility,
 * cross_location_overlays) have user-editable surfaces.
 */
export function VisibilityTab() {
  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <Info className="size-4" />
        <AlertTitle>Visibility is role-based today</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>
            Who sees which tickets is determined by user role assignments — specifically the
            domain and location scopes on each role. There's nothing to configure here yet.
          </p>
          <p>
            Routing-owned visibility flags (whether the parent case owner sees spawned children,
            whether vendors see only their own work orders, cross-location overlay roles) are
            declared in the policy schema but not user-editable from the Studio yet. A real
            editor lands here when those flags need per-tenant tuning.
          </p>
        </AlertDescription>
      </Alert>

      <section className="rounded-md border bg-muted/30 p-4 text-sm">
        <h3 className="mb-2 font-medium">Where visibility comes from today</h3>
        <ul className="ml-4 list-disc space-y-1 text-muted-foreground">
          <li>
            <strong className="text-foreground">Participants:</strong> requester, assignee,
            watcher, vendor — always see their own tickets
          </li>
          <li>
            <strong className="text-foreground">Operators:</strong> team members see team
            tickets; role assignments widen visibility by domain + location scope
          </li>
          <li>
            <strong className="text-foreground">Overrides:</strong>{' '}
            <code className="rounded bg-muted px-1">tickets.read_all</code> /{' '}
            <code className="rounded bg-muted px-1">tickets.write_all</code> permissions on a
            role
          </li>
        </ul>
        <p className="mt-3 text-muted-foreground">
          Reference:{' '}
          <a
            className="underline"
            href="https://github.com/anthropics/claude-code"
            onClick={(e) => e.preventDefault()}
          >
            docs/visibility.md
          </a>{' '}
          in the repo.
        </p>
      </section>
    </div>
  );
}
