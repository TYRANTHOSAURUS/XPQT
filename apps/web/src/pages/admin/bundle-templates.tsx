import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import { cn } from '@/lib/utils';
import {
  useBundleTemplates,
  useCreateBundleTemplate,
  type BundleTemplate,
} from '@/api/bundle-templates';
import { toastCreated, toastError } from '@/lib/toast';

/**
 * /admin/bundle-templates — index page.
 *
 * Templates are pre-filled composite booking shapes. They appear as a chip
 * row above the time picker on /portal/rooms; picking one hydrates the
 * booking-confirm dialog with editable defaults.
 *
 * Active flag drives chip-row visibility — inactive templates stay assignable
 * to existing bundles (template_id FK) but disappear from the picker.
 */
export function BundleTemplatesPage() {
  const { data, isLoading } = useBundleTemplates();
  const [creating, setCreating] = useState(false);

  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        backTo="/admin"
        title="Bundle templates"
        description="Pre-filled meeting + service combinations users pick from the chip row above the room picker."
        actions={
          <Button onClick={() => setCreating(true)} className="gap-1.5">
            <Plus className="size-4" /> New template
          </Button>
        }
      />

      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {!isLoading && (data?.length ?? 0) === 0 && (
        <EmptyState onCreate={() => setCreating(true)} />
      )}

      {!isLoading && data && data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-[120px] tabular-nums">Services</TableHead>
              <TableHead className="w-[140px] tabular-nums">Default duration</TableHead>
              <TableHead className="w-[120px] text-right">Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((t) => (
              <TemplateRow key={t.id} template={t} />
            ))}
          </TableBody>
        </Table>
      )}

      <CreateDialog open={creating} onOpenChange={setCreating} />
    </SettingsPageShell>
  );
}

function TemplateRow({ template }: { template: BundleTemplate }) {
  const services = template.payload?.services?.length ?? 0;
  const duration = template.payload?.default_duration_minutes;
  return (
    <TableRow className="cursor-default">
      <TableCell>
        <Link to={`/admin/bundle-templates/${template.id}`} className="hover:underline">
          {template.name}
        </Link>
        {template.description && (
          <span className="ml-2 text-xs text-muted-foreground">{template.description}</span>
        )}
      </TableCell>
      <TableCell className="tabular-nums text-muted-foreground">
        {services > 0 ? `${services} line${services === 1 ? '' : 's'}` : '—'}
      </TableCell>
      <TableCell className="tabular-nums text-muted-foreground">
        {duration != null ? `${duration} min` : '—'}
      </TableCell>
      <TableCell className="text-right">
        <Badge
          variant="outline"
          className={cn(
            'h-5 border-transparent text-[10px] font-medium',
            template.active
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {template.active ? 'Active' : 'Inactive'}
        </Badge>
      </TableCell>
    </TableRow>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">No templates yet</h3>
        <p className="max-w-md text-xs text-muted-foreground">
          Templates pre-fill the booking dialog with a room shape + a set of services. Common ones
          to seed: <span className="font-mono">Executive lunch</span>,{' '}
          <span className="font-mono">All-hands</span>, <span className="font-mono">Daily standup</span>.
        </p>
      </div>
      <Button onClick={onCreate} size="sm" className="gap-1.5">
        <Plus className="size-3.5" /> New template
      </Button>
    </div>
  );
}

function CreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const navigate = useNavigate();
  const create = useCreateBundleTemplate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    try {
      const t = await create.mutateAsync({
        name: name.trim(),
        description: description.trim() || null,
        active: true,
        payload: {},
      });
      toastCreated('Bundle template', { onView: () => navigate(`/admin/bundle-templates/${t.id}`) });
      onOpenChange(false);
      setName('');
      setDescription('');
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Create failed';
      setError(message);
      toastError("Couldn't create bundle template", { error: err });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New bundle template</DialogTitle>
          <DialogDescription>
            Start with a name. Configure room criteria + services on the next screen.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="bt-name">Name</FieldLabel>
            <Input
              id="bt-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Executive lunch"
              autoFocus
            />
            <FieldDescription>Shown to users as the chip label.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="bt-description">Description</FieldLabel>
            <Input
              id="bt-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </Field>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create template'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
