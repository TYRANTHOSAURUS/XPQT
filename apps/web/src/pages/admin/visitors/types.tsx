/**
 * /admin/visitors/types — index page for visitor type templates.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.2, §11
 * Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md slice 9 task 9.1
 *
 * Follows the canonical "Index + detail shape" from CLAUDE.md:
 *  - SettingsPageShell (default width — only 4 columns on this page).
 *  - Table: name (linked) → key → requires_approval → allow_walk_up → active.
 *  - "+ New type" → lightweight Dialog → POST → navigate to detail.
 *  - No action column — actions live on detail.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, UserPlus } from 'lucide-react';
import { toastCreated, toastError } from '@/lib/toast';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
} from '@/components/ui/settings-page';
import { cn } from '@/lib/utils';
import {
  useAdminVisitorTypes,
  useCreateVisitorType,
} from '@/api/visitors/admin';
import type { VisitorType } from '@/api/visitors';

export function AdminVisitorTypesPage() {
  const { data, isLoading } = useAdminVisitorTypes();
  const [createOpen, setCreateOpen] = useState(false);

  const isEmpty = !isLoading && (data?.length ?? 0) === 0;

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        backTo="/admin"
        title="Visitor types"
        description="Configure visitor type templates and per-type rules — approval, walk-up, and default visit length."
        actions={
          <Button className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New type
          </Button>
        }
      />

      {isLoading && (
        <div className="text-sm text-muted-foreground">Loading…</div>
      )}

      {!isLoading && data && data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead className="w-[140px]">Approval</TableHead>
              <TableHead className="w-[120px]">Walk-up</TableHead>
              <TableHead className="w-[100px]">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((vt: VisitorType) => (
              <TableRow key={vt.id}>
                <TableCell className="font-medium">
                  <Link
                    to={`/admin/visitors/types/${vt.id}`}
                    className="hover:underline underline-offset-2"
                  >
                    {vt.display_name}
                  </Link>
                  {vt.description && (
                    <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                      {vt.description}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  <code className="chip text-xs">{vt.type_key}</code>
                </TableCell>
                <TableCell className="text-sm">
                  {vt.requires_approval ? 'Required' : 'Not required'}
                </TableCell>
                <TableCell className="text-sm">
                  {vt.allow_walk_up ? 'Allowed' : 'Pre-invite only'}
                </TableCell>
                <TableCell>
                  <Badge variant={vt.active ? 'default' : 'secondary'}>
                    {vt.active ? 'active' : 'inactive'}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {isEmpty && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <UserPlus className="size-10 text-muted-foreground" />
          <div className="text-sm font-medium">No visitor types yet</div>
          <p className="max-w-sm text-sm text-muted-foreground">
            Visitor types control approval, walk-up, and default visit length
            on every invite. Six defaults are seeded for new tenants — add
            custom types here.
          </p>
          <Button
            className={cn(
              buttonVariants({ variant: 'default' }),
              'gap-1.5',
            )}
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-4" />
            New type
          </Button>
        </div>
      )}

      <CreateVisitorTypeDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </SettingsPageShell>
  );
}

interface CreateProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function CreateVisitorTypeDialog({ open, onOpenChange }: CreateProps) {
  const [displayName, setDisplayName] = useState('');
  const [typeKey, setTypeKey] = useState('');
  const [description, setDescription] = useState('');
  const create = useCreateVisitorType();
  const navigate = useNavigate();

  const reset = () => {
    setDisplayName('');
    setTypeKey('');
    setDescription('');
  };

  // Auto-generate type_key from display_name (lowercase, underscores).
  // Admins can still edit it before submit.
  const handleNameChange = (value: string) => {
    setDisplayName(value);
    if (!typeKey || typeKey === slugify(displayName)) {
      setTypeKey(slugify(value));
    }
  };

  const handleCreate = () => {
    const trimmedName = displayName.trim();
    const trimmedKey = typeKey.trim();
    if (!trimmedName || !trimmedKey) return;
    create.mutate(
      {
        display_name: trimmedName,
        type_key: trimmedKey,
        description: description.trim() || undefined,
      },
      {
        onSuccess: (vt) => {
          reset();
          onOpenChange(false);
          toastCreated('Visitor type', {
            onView: () => navigate(`/admin/visitors/types/${vt.id}`),
          });
          navigate(`/admin/visitors/types/${vt.id}`);
        },
        onError: (err) =>
          toastError("Couldn't create visitor type", { error: err }),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>New visitor type</DialogTitle>
          <DialogDescription>
            Give it a name and a stable key. You'll configure approval and
            walk-up rules on the next screen.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="vt-create-name">Display name</FieldLabel>
            <Input
              id="vt-create-name"
              value={displayName}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Auditor"
              autoFocus
            />
            <FieldDescription>
              Shown to hosts in the invite form's type dropdown.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="vt-create-key">Type key</FieldLabel>
            <Input
              id="vt-create-key"
              value={typeKey}
              onChange={(e) => setTypeKey(slugify(e.target.value))}
              placeholder="auditor"
            />
            <FieldDescription>
              Lowercase, digits, underscore. Used in API payloads and audit
              logs. Cannot be changed after create.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="vt-create-desc">Description</FieldLabel>
            <Input
              id="vt-create-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional admin-facing note"
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={
              !displayName.trim() || !typeKey.trim() || create.isPending
            }
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}
