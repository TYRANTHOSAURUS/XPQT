import { useState } from 'react';
import { Link } from 'react-router-dom';
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
import { useNavigate } from 'react-router-dom';
import { useCostCenters, useCreateCostCenter, type CostCenter } from '@/api/cost-centers';
import { toastCreated, toastError } from '@/lib/toast';

/**
 * /admin/cost-centers — index page.
 *
 * The Linear-style list of decisions for tenant-scoped cost centers.
 * Code uniqueness is enforced per-tenant by the schema; the create dialog
 * surfaces 23505 conflicts as a friendly inline error rather than an
 * untranslated server message.
 */
export function CostCentersPage() {
  const { data, isLoading } = useCostCenters();
  const [creating, setCreating] = useState(false);

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        backTo="/admin"
        title="Cost centers"
        description="Tenant-scoped GL chargeback codes. Bundles route to a cost center and approval rules can fan out to its default approver."
        actions={
          <Button onClick={() => setCreating(true)} className="gap-1.5">
            <Plus className="size-4" /> New cost center
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
              <TableHead className="w-[140px]">Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-[120px] text-right">Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((cc) => (
              <CostCenterRow key={cc.id} cc={cc} />
            ))}
          </TableBody>
        </Table>
      )}

      <CreateDialog open={creating} onOpenChange={setCreating} />
    </SettingsPageShell>
  );
}

function CostCenterRow({ cc }: { cc: CostCenter }) {
  return (
    <TableRow className="cursor-default">
      <TableCell className="font-mono text-xs tabular-nums">
        <Link to={`/admin/cost-centers/${cc.id}`} className="hover:underline">
          {cc.code}
        </Link>
      </TableCell>
      <TableCell>
        <Link to={`/admin/cost-centers/${cc.id}`} className="hover:underline">
          {cc.name}
        </Link>
        {cc.description && (
          <span className="ml-2 text-xs text-muted-foreground">{cc.description}</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <Badge
          variant="outline"
          className={cn(
            'h-5 border-transparent text-[10px] font-medium',
            cc.active
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {cc.active ? 'Active' : 'Inactive'}
        </Badge>
      </TableCell>
    </TableRow>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">No cost centers yet</h3>
        <p className="max-w-sm text-xs text-muted-foreground">
          Cost centers tag bundles for GL chargeback and route approvals to their default approver.
          Create one to enable the cost-center approver target on service rules.
        </p>
      </div>
      <Button onClick={onCreate} size="sm" className="gap-1.5">
        <Plus className="size-3.5" /> New cost center
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
  const create = useCreateCostCenter();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!code.trim() || !name.trim()) {
      setError('Code and name are required.');
      return;
    }
    try {
      const cc = await create.mutateAsync({
        code: code.trim(),
        name: name.trim(),
        description: description.trim() || null,
      });
      toastCreated('Cost center', { onView: () => navigate(`/admin/cost-centers/${cc.id}`) });
      onOpenChange(false);
      setCode('');
      setName('');
      setDescription('');
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Create failed';
      setError(message);
      toastError("Couldn't create cost center", { error: err });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New cost center</DialogTitle>
          <DialogDescription>
            Pick a short, stable code (e.g. <code className="chip">FIN-EU-01</code>). You can rename
            and refine details after creation.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="cc-code">Code</FieldLabel>
            <Input
              id="cc-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={32}
              placeholder="FIN-EU-01"
              autoFocus
            />
            <FieldDescription>Unique per tenant. Up to 32 characters.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="cc-name">Name</FieldLabel>
            <Input
              id="cc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="EMEA finance"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="cc-description">Description</FieldLabel>
            <Input
              id="cc-description"
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
            {create.isPending ? 'Creating…' : 'Create cost center'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type { CostCenter };
