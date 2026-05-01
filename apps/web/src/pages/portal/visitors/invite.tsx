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

export function PortalVisitorInvitePage() {
  const navigate = useNavigate();

  return (
    <SettingsPageShell width="default">
      <SettingsPageHeader
        backTo="/portal/visitors/expected"
        title="Invite a visitor"
        description="Pre-register a visitor so reception knows they're coming."
      />
      <VisitorInviteForm
        mode="standalone"
        onSuccess={() => {
          toastCreated('Visitor invitation', {
            onView: () => navigate('/portal/visitors/expected'),
          });
          navigate('/portal/visitors/expected');
        }}
        onCancel={() => navigate(-1)}
      />
    </SettingsPageShell>
  );
}
