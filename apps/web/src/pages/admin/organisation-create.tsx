import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  SettingsPageShell,
  SettingsPageHeader,
  SettingsSection,
  SettingsFooterActions,
} from '@/components/ui/settings-page';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { OrgNodeCombobox } from '@/components/org-node-combobox';
import { apiFetch } from '@/lib/api';

export function OrganisationCreatePage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSubmitting(true);
    try {
      const created = await apiFetch<{ id: string }>('/org-nodes', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          code: code.trim() || null,
          description: description.trim() || null,
          parent_id: parentId,
        }),
      });
      toast.success('Organisation created');
      navigate(`/admin/organisations/${created.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create organisation');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        backTo="/admin/organisations"
        title="Create organisation"
        description="Add a new node to the requester-side hierarchy."
      />
      <SettingsSection
        title="Details"
        description="Identifying information for this organisation."
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="org-name">Name</FieldLabel>
            <Input
              id="org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Cairo Operations"
              autoFocus
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="org-code">Code</FieldLabel>
            <Input
              id="org-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. CAI-OPS"
            />
            <FieldDescription>Optional short identifier shown as a badge.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="org-description">Description</FieldLabel>
            <Textarea
              id="org-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this organisation do?"
              rows={3}
            />
          </Field>
        </FieldGroup>
      </SettingsSection>
      <SettingsSection
        title="Hierarchy"
        description="Place this organisation under a parent, or leave blank to make it a top-level node."
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="org-parent">Parent organisation</FieldLabel>
            <OrgNodeCombobox value={parentId} onChange={setParentId} />
          </Field>
        </FieldGroup>
      </SettingsSection>
      <SettingsFooterActions
        primary={{
          label: 'Create organisation',
          onClick: submit,
          loading: submitting,
        }}
        secondary={{ label: 'Cancel', href: '/admin/organisations' }}
      />
    </SettingsPageShell>
  );
}
