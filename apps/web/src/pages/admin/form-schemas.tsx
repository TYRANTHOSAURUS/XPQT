import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import { cn } from '@/lib/utils';
import { useFormSchemas, configEntityKeys } from '@/api/config-entities';
import { apiFetch } from '@/lib/api';
import type { FormField } from '@/components/admin/form-builder/premade-fields';

interface FormSchemaRow {
  id: string;
  display_name: string;
  status?: string;
  current_version?: { definition: { fields: FormField[] } } | null;
}

export function FormSchemasPage() {
  const { data, isLoading } = useFormSchemas() as {
    data: FormSchemaRow[] | undefined;
    isLoading: boolean;
  };
  const [createOpen, setCreateOpen] = useState(false);

  const isEmpty = !isLoading && (data?.length ?? 0) === 0;

  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        backTo="/admin"
        title="Form schemas"
        description="Reusable intake forms. Bind a schema to a request type so the portal renders these fields when employees submit a request."
        actions={
          <Button className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New form schema
          </Button>
        }
      />

      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {!isLoading && data && data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-[120px]">Fields</TableHead>
              <TableHead className="w-[120px]">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((schema) => {
              const fieldCount = schema.current_version?.definition?.fields?.length ?? 0;
              return (
                <TableRow key={schema.id}>
                  <TableCell className="font-medium">
                    <Link
                      to={`/admin/form-schemas/${schema.id}`}
                      className="hover:underline underline-offset-2"
                    >
                      {schema.display_name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {fieldCount} {fieldCount === 1 ? 'field' : 'fields'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={schema.status === 'active' ? 'default' : 'secondary'} className="capitalize">
                      {schema.status ?? 'draft'}
                    </Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {isEmpty && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <FileText className="size-10 text-muted-foreground" />
          <div className="text-sm font-medium">No form schemas yet</div>
          <p className="max-w-sm text-sm text-muted-foreground">
            Create a schema to collect structured information from employees when they submit a request.
            Each schema can be reused across multiple request types.
          </p>
          <Button className={cn(buttonVariants({ variant: 'default' }), 'gap-1.5')} onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New form schema
          </Button>
        </div>
      )}

      <CreateFormSchemaDialog open={createOpen} onOpenChange={setCreateOpen} />
    </SettingsPageShell>
  );
}

interface CreateFormSchemaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function CreateFormSchemaDialog({ open, onOpenChange }: CreateFormSchemaDialogProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const reset = () => setName('');

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const entity = await apiFetch<{ id: string }>('/config-entities', {
        method: 'POST',
        body: JSON.stringify({
          config_type: 'form_schema',
          slug,
          display_name: trimmed,
          definition: { fields: [] },
        }),
      });
      await apiFetch(`/config-entities/${entity.id}/publish`, { method: 'POST' });
      qc.invalidateQueries({ queryKey: configEntityKeys.all });
      reset();
      onOpenChange(false);
      navigate(`/admin/form-schemas/${entity.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create form schema');
    } finally {
      setCreating(false);
    }
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
          <DialogTitle>New form schema</DialogTitle>
          <DialogDescription>
            Give this schema a name. You'll add fields on the next screen.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="fs-create-name">Name</FieldLabel>
            <Input
              id="fs-create-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. New laptop request"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) handleCreate();
              }}
            />
            <FieldDescription>Shown to admins when binding the schema to a request type.</FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!name.trim() || creating}>
            {creating ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
