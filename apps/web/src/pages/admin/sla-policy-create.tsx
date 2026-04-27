import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toastCreated, toastError } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  SettingsPageHeader,
  SettingsPageShell,
  SettingsSection,
} from '@/components/ui/settings-page';
import { useCreateSlaPolicy } from '@/api/sla-policies';

export function SlaPolicyCreatePage() {
  const navigate = useNavigate();
  const create = useCreateSlaPolicy();
  const [name, setName] = useState('');
  const [responseHours, setResponseHours] = useState('');
  const [resolutionHours, setResolutionHours] = useState('');

  const handleCreate = () => {
    const body = {
      name: name.trim(),
      response_time_minutes: responseHours ? Math.round(parseFloat(responseHours) * 60) : null,
      resolution_time_minutes: resolutionHours ? Math.round(parseFloat(resolutionHours) * 60) : null,
      pause_on_waiting_reasons: ['requester', 'vendor', 'scheduled_work'],
      escalation_thresholds: [],
    };
    create.mutate(body, {
      onSuccess: (policy) => {
        toastCreated('SLA policy', { onView: () => navigate(`/admin/sla-policies/${policy.id}`) });
        navigate(`/admin/sla-policies/${policy.id}`);
      },
      onError: (err) => toastError("Couldn't create SLA policy", { error: err, retry: handleCreate }),
    });
  };

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        backTo="/admin/sla-policies"
        title="New SLA policy"
        description="Set the targets now. Calendar, pause conditions, and escalations are configured on the next screen."
      />

      <SettingsSection title="Identity & targets">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="sla-name">Name</FieldLabel>
            <Input
              id="sla-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Standard, High Priority, Critical…"
              autoFocus
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="sla-response">Response target (hours)</FieldLabel>
              <Input
                id="sla-response"
                type="number"
                step="0.5"
                value={responseHours}
                onChange={(e) => setResponseHours(e.target.value)}
                placeholder="e.g. 4"
              />
              <FieldDescription>How quickly an agent must acknowledge.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="sla-resolution">Resolution target (hours)</FieldLabel>
              <Input
                id="sla-resolution"
                type="number"
                step="0.5"
                value={resolutionHours}
                onChange={(e) => setResolutionHours(e.target.value)}
                placeholder="e.g. 24"
              />
              <FieldDescription>How quickly the ticket must be resolved.</FieldDescription>
            </Field>
          </div>
        </FieldGroup>
        <div className="flex justify-end">
          <Button onClick={handleCreate} disabled={!name.trim() || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create policy'}
          </Button>
        </div>
      </SettingsSection>
    </SettingsPageShell>
  );
}
