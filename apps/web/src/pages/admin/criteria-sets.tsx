import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Filter as FilterIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import { cn } from '@/lib/utils';
import {
  useCreateCriteriaSet,
  useCriteriaSets,
  type CriteriaSet,
} from '@/api/criteria-sets';
import { describeExpression } from '@/components/admin/criteria-set-expression';

export function CriteriaSetsPage() {
  const { data, isLoading } = useCriteriaSets();
  const [createOpen, setCreateOpen] = useState(false);

  const isEmpty = !isLoading && (data?.length ?? 0) === 0;

  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        title="Criteria sets"
        description="Reusable audience rules over person attributes. Bind them from request type audience, conditional form variants, or configured on-behalf lists."
        actions={
          <Button className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New criteria set
          </Button>
        }
      />

      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {!isLoading && data && data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Rule</TableHead>
              <TableHead className="w-[100px]">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((cs: CriteriaSet) => (
              <TableRow key={cs.id}>
                <TableCell className="font-medium">
                  <Link
                    to={`/admin/criteria-sets/${cs.id}`}
                    className="hover:underline underline-offset-2"
                  >
                    {cs.name}
                  </Link>
                  {cs.description && (
                    <div className="text-xs text-muted-foreground mt-0.5">{cs.description}</div>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground max-w-[360px] truncate">
                  {describeExpression(cs.expression) || '—'}
                </TableCell>
                <TableCell>
                  <Badge variant={cs.active ? 'default' : 'secondary'}>
                    {cs.active ? 'active' : 'inactive'}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {isEmpty && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <FilterIcon className="size-10 text-muted-foreground" />
          <div className="text-sm font-medium">No criteria sets yet</div>
          <p className="max-w-sm text-sm text-muted-foreground">
            Create one to bind audiences, conditional form variants, or on-behalf lists to a request type.
          </p>
          <Button className={cn(buttonVariants({ variant: 'default' }), 'gap-1.5')} onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New criteria set
          </Button>
        </div>
      )}

      <CreateCriteriaSetDialog open={createOpen} onOpenChange={setCreateOpen} />
    </SettingsPageShell>
  );
}

interface CreateProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function CreateCriteriaSetDialog({ open, onOpenChange }: CreateProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useCreateCriteriaSet();
  const navigate = useNavigate();

  const reset = () => {
    setName('');
    setDescription('');
  };

  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate(
      {
        name: trimmed,
        description: description.trim() || null,
        // Seed with "type is employee" so the backend validator accepts the
        // initial POST (it rejects empty `value`s only for list ops; scalar
        // eq is fine with any non-empty string). Admin immediately edits it
        // in the rule builder on the detail page.
        expression: { attr: 'type', op: 'eq', value: 'employee' },
        active: true,
      },
      {
        onSuccess: (cs) => {
          reset();
          onOpenChange(false);
          navigate(`/admin/criteria-sets/${cs.id}`);
        },
        onError: (err) => toast.error(err.message || 'Could not create criteria set'),
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
          <DialogTitle>New criteria set</DialogTitle>
          <DialogDescription>
            Give this audience rule a name. You'll build the expression on the next screen.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="cs-create-name">Name</FieldLabel>
            <Input
              id="cs-create-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Engineering employees"
              autoFocus
            />
            <FieldDescription>Unique per tenant. Shown in audience and on-behalf pickers.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="cs-create-desc">Description</FieldLabel>
            <Input
              id="cs-create-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional admin-facing note"
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!name.trim() || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
