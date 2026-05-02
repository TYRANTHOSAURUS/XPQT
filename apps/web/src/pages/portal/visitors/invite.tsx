/**
 * /portal/visitors/invite — visitor-first standalone invite page.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §6.1
 *
 * Hosts who don't yet have a booking can invite a visitor straight from
 * here. Submission flows through `useCreateInvitation()` which invalidates
 * the host's expected list — navigating to /portal/visitors/expected after
 * success will hit a hot cache.
 */
import { useNavigate } from 'react-router-dom';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import { VisitorInviteForm } from '@/components/portal/visitor-invite-form';
import { toastCreated } from '@/lib/toast';
import { usePortal } from '@/providers/portal-provider';

export function PortalVisitorInvitePage() {
  const navigate = useNavigate();
  const { data } = usePortal();
  // Seed the building from the host's default location so the form
  // shows their normal site as the building without making them pick.
  // Falls back to undefined → the form picks the first authorized
  // building.
  const defaultBuildingId = data?.default_location?.id;

  return (
    <SettingsPageShell width="default">
      <SettingsPageHeader
        backTo="/portal/visitors/expected"
        title="Invite a visitor"
        description="Pre-register a visitor so reception knows they're coming."
      />
      <VisitorInviteForm
        mode="standalone"
        defaults={{ building_id: defaultBuildingId }}
        onSuccess={(visitorId) => {
          toastCreated('visitor invitation', {
            // The desk surface is the new canonical detail view; portal
            // hosts can also stay on /portal/visitors/expected to find
            // the visitor in their own list.
            onView: () => navigate(`/desk/visitors?id=${visitorId}`),
          });
          navigate('/portal/visitors/expected');
        }}
        onCancel={() => navigate(-1)}
      />
    </SettingsPageShell>
  );
}
