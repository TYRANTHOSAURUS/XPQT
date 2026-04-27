import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toastCreated, toastError, toastSuccess } from '@/lib/toast';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  SettingsPageShell,
  SettingsPageHeader,
  SettingsSection,
} from '@/components/ui/settings-page';
import { useCreateWebhook } from '@/api/webhooks';

export function WebhookCreatePage() {
  const navigate = useNavigate();
  const create = useCreateWebhook();
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const handleCreate = () => {
    create.mutate(
      { name: name.trim() },
      {
        onSuccess: (res) => {
          setApiKey(res.api_key);
          setCreatedId(res.webhook.id);
          toastCreated('Webhook', {
            description: 'Copy the API key below — it only appears once.',
          });
        },
        onError: (err) => toastError("Couldn't create webhook", { error: err, retry: handleCreate }),
      },
    );
  };

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        backTo="/admin/webhooks"
        title="New webhook"
        description="Create the webhook, then configure mapping, request type, and auth on the next screen."
      />

      {!apiKey ? (
        <SettingsSection title="Identity">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="wh-name">Name</FieldLabel>
              <Input
                id="wh-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Jira → Incident"
                autoFocus
              />
              <FieldDescription>
                Used in the audit log and stamped on every ticket's source channel.
              </FieldDescription>
            </Field>
          </FieldGroup>
          <div className="flex justify-end">
            <Button onClick={handleCreate} disabled={!name.trim() || create.isPending}>
              {create.isPending ? 'Creating…' : 'Create webhook'}
            </Button>
          </div>
        </SettingsSection>
      ) : (
        <SettingsSection
          title="Save your API key"
          description="This is the only time it will be shown. Copy it to the external system now."
        >
          <div className="rounded-md bg-muted px-3 py-3 font-mono text-xs break-all select-all">
            {apiKey}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(apiKey);
                toastSuccess('API key copied');
              }}
            >
              <Copy className="size-4" /> Copy
            </Button>
            <Button
              onClick={() => createdId && navigate(`/admin/webhooks/${createdId}`)}
            >
              Configure mapping
            </Button>
          </div>
        </SettingsSection>
      )}
    </SettingsPageShell>
  );
}
