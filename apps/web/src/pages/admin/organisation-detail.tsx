import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  SettingsPageShell,
  SettingsPageHeader,
  SettingsSection,
} from '@/components/ui/settings-page';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { OrgNodeCombobox } from '@/components/org-node-combobox';
import { OrgNodeMembersPanel } from '@/components/admin/org-node-members-panel';
import { OrgNodeGrantsPanel } from '@/components/admin/org-node-grants-panel';
import { OrgNodeTeamsPanel } from '@/components/admin/org-node-teams-panel';
import { apiFetch } from '@/lib/api';

interface AttachedTeam {
  id: string;
  name: string;
  domain_scope: string | null;
}

interface OrgNodeDetail {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  parent_id: string | null;
  active: boolean;
  // Members and location grants are owned by their respective panels (each
  // panel fetches independently and refreshes after mutations). The detail
  // endpoint includes only the inline-rendered teams list.
  teams: AttachedTeam[];
}

export function OrganisationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [node, setNode] = useState<OrgNodeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await apiFetch<OrgNodeDetail>(`/org-nodes/${id}`);
      setNode(data);
      setName(data.name);
      setCode(data.code ?? '');
      setDescription(data.description ?? '');
      setParentId(data.parent_id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load organisation');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!id) return;
    setSaving(true);
    try {
      await apiFetch(`/org-nodes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          code: code.trim() || null,
          description: description.trim() || null,
          parent_id: parentId,
        }),
      });
      await load();
      toast.success('Saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!id) return;
    if (!confirm('Delete this organisation? Members and location grants will be removed. Children must be moved or deleted first.')) {
      return;
    }
    try {
      await apiFetch(`/org-nodes/${id}`, { method: 'DELETE' });
      toast.success('Deleted');
      navigate('/admin/organisations');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Cannot delete (does it have children?)');
    }
  };

  if (loading || !node) {
    return (
      <SettingsPageShell>
        <SettingsPageHeader backTo="/admin/organisations" title="Loading…" />
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        backTo="/admin/organisations"
        title={node.name}
        description={node.code ?? undefined}
      />
      <SettingsSection title="Details">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="d-name">Name</FieldLabel>
            <Input id="d-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="d-code">Code</FieldLabel>
            <Input id="d-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="d-description">Description</FieldLabel>
            <Textarea
              id="d-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="d-parent">Parent organisation</FieldLabel>
            <OrgNodeCombobox
              value={parentId}
              onChange={setParentId}
              filter={(n) => n.id !== node.id}
            />
          </Field>
        </FieldGroup>
        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Members"
        description="People whose primary organisation is this node. They inherit the location grants below."
      >
        <OrgNodeMembersPanel nodeId={node.id} />
      </SettingsSection>

      <SettingsSection
        title="Location grants"
        description="Sites and buildings every member of this organisation (and its descendants) can request for."
      >
        <OrgNodeGrantsPanel nodeId={node.id} />
      </SettingsSection>

      <SettingsSection
        title="Teams attached"
        description="Operational teams categorised under this organisation. Team membership does not grant locations."
      >
        <OrgNodeTeamsPanel teams={node.teams} onChanged={load} />
      </SettingsSection>

      <SettingsSection
        title="Danger zone"
        description="Deleting an organisation removes its memberships and location grants. Children must be moved or deleted first."
      >
        <div className="flex justify-end">
          <Button variant="destructive" onClick={remove}>
            Delete organisation
          </Button>
        </div>
      </SettingsSection>
    </SettingsPageShell>
  );
}
