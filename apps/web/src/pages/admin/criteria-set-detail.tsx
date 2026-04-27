import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toastError, toastRemoved, toastSaved } from '@/lib/toast';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowValue,
} from '@/components/ui/settings-row';
import { cn } from '@/lib/utils';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import {
  useCriteriaSet,
  useDeleteCriteriaSet,
  usePreviewCriteriaExpression,
  useUpdateCriteriaSet,
  type CriteriaPreviewResult,
  type CriteriaSet,
  type CriteriaSetUpsertBody,
} from '@/api/criteria-sets';
import {
  countLeaves,
  describeExpression,
  expressionDepth,
  MAX_DEPTH,
} from '@/components/admin/criteria-set-expression';
import { CriteriaSetExpressionDialog } from '@/components/admin/criteria-set-expression-dialog';

export function CriteriaSetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = useCriteriaSet(id);

  if (isLoading) {
    return (
      <SettingsPageShell width="wide">
        <SettingsPageHeader backTo="/admin/criteria-sets" title="Loading…" />
      </SettingsPageShell>
    );
  }

  if (!data || !id) {
    return (
      <SettingsPageShell width="wide">
        <SettingsPageHeader
          backTo="/admin/criteria-sets"
          title="Criteria set not found"
          description="It may have been deleted."
        />
      </SettingsPageShell>
    );
  }

  return <CriteriaSetDetailBody criteriaSet={data} onDeleted={() => navigate('/admin/criteria-sets')} />;
}

interface BodyProps {
  criteriaSet: CriteriaSet;
  onDeleted: () => void;
}

function CriteriaSetDetailBody({ criteriaSet, onDeleted }: BodyProps) {
  const update = useUpdateCriteriaSet(criteriaSet.id);

  const save = (patch: Partial<CriteriaSetUpsertBody>, opts: { silent?: boolean } = {}) => {
    update.mutate(patch, {
      onSuccess: () => toastSaved('Criteria set', { silent: opts.silent }),
      onError: (err) => toastError("Couldn't save criteria set", { error: err, retry: () => save(patch, opts) }),
    });
  };

  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        backTo="/admin/criteria-sets"
        title={criteriaSet.name}
        description="Reusable audience rule over person attributes. Bound from request type audience, conditional form variants, or on-behalf lists."
        actions={
          <Badge variant={criteriaSet.active ? 'default' : 'secondary'}>
            {criteriaSet.active ? 'active' : 'inactive'}
          </Badge>
        }
      />

      <IdentityGroup criteriaSet={criteriaSet} save={save} />
      <ExpressionGroup criteriaSet={criteriaSet} save={save} />
      <PreviewGroup criteriaSet={criteriaSet} />
      <DangerGroup criteriaSetId={criteriaSet.id} name={criteriaSet.name} onDeleted={onDeleted} />
    </SettingsPageShell>
  );
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

interface GroupProps {
  criteriaSet: CriteriaSet;
  save: (patch: Partial<CriteriaSetUpsertBody>, opts?: { silent?: boolean }) => void;
}

function IdentityGroup({ criteriaSet, save }: GroupProps) {
  const [name, setName] = useState(criteriaSet.name);
  const [description, setDescription] = useState(criteriaSet.description ?? '');

  useEffect(() => setName(criteriaSet.name), [criteriaSet.name]);
  useEffect(() => setDescription(criteriaSet.description ?? ''), [criteriaSet.description]);

  useDebouncedSave(name, (v) => {
    if (v.trim() && v.trim() !== criteriaSet.name) save({ name: v.trim() }, { silent: true });
  });

  useDebouncedSave(description, (v) => {
    const next = v.trim() || null;
    const current = criteriaSet.description ?? null;
    if (next !== current) save({ description: next }, { silent: true });
  });

  return (
    <SettingsGroup title="Identity">
      <SettingsRow label="Name" description="Shown in audience and on-behalf pickers.">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-[260px]"
        />
      </SettingsRow>
      <SettingsRow label="Description" description="Short admin-facing note.">
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-[260px]"
          placeholder="Optional"
        />
      </SettingsRow>
      <SettingsRow
        label="Active"
        description="When inactive, bindings that reference this set are ignored by the resolver."
      >
        <Switch
          checked={criteriaSet.active}
          onCheckedChange={(next) => save({ active: next })}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* Expression                                                                 */
/* -------------------------------------------------------------------------- */

function ExpressionGroup({ criteriaSet, save }: GroupProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const summary = useMemo(() => describeExpression(criteriaSet.expression), [criteriaSet.expression]);
  const depth = useMemo(() => expressionDepth(criteriaSet.expression), [criteriaSet.expression]);
  const leaves = useMemo(() => countLeaves(criteriaSet.expression), [criteriaSet.expression]);

  return (
    <SettingsGroup
      title="Expression"
      description="The rule evaluated against each person's attributes. Persons who match are included."
    >
      <SettingsRow
        label="Rule"
        description={summary || 'No conditions yet.'}
        onClick={() => setDialogOpen(true)}
      >
        <SettingsRowValue>Edit</SettingsRowValue>
      </SettingsRow>
      <SettingsRow label="Conditions" description="Total leaf rules in the expression.">
        <SettingsRowValue>{leaves}</SettingsRowValue>
      </SettingsRow>
      <SettingsRow label="Nesting depth" description={`Max allowed is ${MAX_DEPTH}.`}>
        <SettingsRowValue>
          {depth} / {MAX_DEPTH}
        </SettingsRowValue>
      </SettingsRow>

      <CriteriaSetExpressionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        value={criteriaSet.expression}
        onSave={(next) => {
          save({ expression: next });
          setDialogOpen(false);
        }}
      />
    </SettingsGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

function PreviewGroup({ criteriaSet }: { criteriaSet: CriteriaSet }) {
  const preview = usePreviewCriteriaExpression(10);
  const [result, setResult] = useState<CriteriaPreviewResult | null>(null);

  const run = () => {
    preview.mutate(criteriaSet.expression, {
      onSuccess: (res) => setResult(res),
      onError: (err) => toastError("Couldn't preview criteria", { error: err, retry: run }),
    });
  };

  const remaining = result ? Math.max(0, result.count - result.sample.length) : 0;

  return (
    <SettingsGroup
      title="Preview"
      description="Evaluate the current expression against every active person in the tenant."
    >
      <SettingsRow
        label="Matches"
        description={
          result
            ? `${result.count} ${result.count === 1 ? 'person matches' : 'persons match'} right now.`
            : 'Run a live count of everyone this rule currently includes.'
        }
      >
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={run}
          disabled={preview.isPending}
        >
          <RefreshCw className={cn('size-3.5', preview.isPending && 'animate-spin')} />
          {preview.isPending ? 'Running…' : 'Refresh'}
        </Button>
      </SettingsRow>
      {result && result.sample.length > 0 && (
        <div className="flex flex-col">
          <div className="px-4 py-2 text-xs font-medium text-muted-foreground">
            Showing {result.sample.length} of {result.count}
          </div>
          <ul className="flex flex-col divide-y">
            {result.sample.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2">
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium truncate">
                    {`${p.first_name} ${p.last_name}`.trim() || p.id}
                  </span>
                  {p.email && (
                    <span className="text-xs text-muted-foreground truncate">{p.email}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {p.primary_org && (
                    <Badge variant="outline" className="font-normal">
                      {p.primary_org.code ?? p.primary_org.name ?? '—'}
                    </Badge>
                  )}
                  {p.type && (
                    <span className="text-xs text-muted-foreground">{p.type}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {remaining > 0 && (
            <Link
              to={`/admin/criteria-sets/${criteriaSet.id}/matches`}
              className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-muted/40 transition-colors"
            >
              <span className="font-medium">Show all {result.count} matches</span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                +{remaining} more
                <ArrowRight className="size-3.5" />
              </span>
            </Link>
          )}
        </div>
      )}
    </SettingsGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* Danger zone                                                                */
/* -------------------------------------------------------------------------- */

interface DangerProps {
  criteriaSetId: string;
  name: string;
  onDeleted: () => void;
}

function DangerGroup({ criteriaSetId, name, onDeleted }: DangerProps) {
  const del = useDeleteCriteriaSet();
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <SettingsGroup title="Danger zone">
      <SettingsRow
        label="Delete criteria set"
        description="Deactivates the set and removes it from audience and on-behalf pickers. Existing bindings that reference it become inert until re-bound."
      >
        <Button
          variant="outline"
          size="sm"
          className={cn(buttonVariants({ variant: 'destructive' }), 'h-8 px-3')}
          onClick={() => setConfirmOpen(true)}
        >
          Delete
        </Button>
      </SettingsRow>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete "${name}"?`}
        description="The set will be deactivated and hidden from pickers. Bindings that reference it will be ignored until you pick a replacement."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await del.mutateAsync(criteriaSetId);
          toastRemoved('Criteria set', { verb: 'deleted' });
          onDeleted();
        }}
      />
    </SettingsGroup>
  );
}
