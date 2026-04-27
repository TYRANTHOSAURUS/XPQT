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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  useCreateServiceRule,
  useServiceRuleTemplates,
  useServiceRules,
  type ServiceRule,
  type ServiceRuleEffect,
  type ServiceRuleTargetKind,
  type ServiceRuleTemplate,
} from '@/api/service-rules';
import { Sparkles } from 'lucide-react';
import { toastCreated, toastError } from '@/lib/toast';

const TARGET_KIND_LABEL: Record<ServiceRuleTargetKind, string> = {
  catalog_item: 'Catalog item',
  menu: 'Menu',
  catalog_category: 'Category',
  tenant: 'Tenant-wide',
};

const EFFECT_LABEL: Record<ServiceRuleEffect, string> = {
  deny: 'Deny',
  require_approval: 'Require approval',
  allow_override: 'Allow override',
  warn: 'Warn',
  allow: 'Allow',
};

/**
 * /admin/booking-services/rules — service rule index.
 *
 * Mirrors /admin/room-booking-rules but trimmed: predicate-template editor
 * is a follow-up; v1 ships create-with-name and admins fill in
 * applies_when on the detail page directly.
 */
export function ServiceRulesPage() {
  const { data, isLoading } = useServiceRules();
  const [creating, setCreating] = useState(false);

  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        backTo="/admin/booking-services"
        title="Service rules"
        description="Govern who can order what, when, and what triggers approval. Mirrors the room-booking rule engine, scoped to catalog items + menus."
        actions={
          <Button onClick={() => setCreating(true)} className="gap-1.5">
            <Plus className="size-4" /> New rule
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
              <TableHead className="w-[140px]">Scope</TableHead>
              <TableHead className="w-[160px]">Effect</TableHead>
              <TableHead className="w-[80px] text-right tabular-nums">Priority</TableHead>
              <TableHead className="w-[80px] text-right">Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((r) => (
              <RuleRow key={r.id} rule={r} />
            ))}
          </TableBody>
        </Table>
      )}

      <CreateDialog open={creating} onOpenChange={setCreating} />
    </SettingsPageShell>
  );
}

function RuleRow({ rule }: { rule: ServiceRule }) {
  return (
    <TableRow className="cursor-default">
      <TableCell>
        <Link
          to={`/admin/booking-services/rules/${rule.id}`}
          className="hover:underline"
        >
          {rule.name}
        </Link>
        {rule.description && (
          <span className="ml-2 text-xs text-muted-foreground">{rule.description}</span>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {TARGET_KIND_LABEL[rule.target_kind]}
      </TableCell>
      <TableCell>
        <EffectBadge effect={rule.effect} />
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {rule.priority}
      </TableCell>
      <TableCell className="text-right">
        <Badge
          variant="outline"
          className={cn(
            'h-5 border-transparent text-[10px] font-medium',
            rule.active
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {rule.active ? 'Active' : 'Inactive'}
        </Badge>
      </TableCell>
    </TableRow>
  );
}

function EffectBadge({ effect }: { effect: ServiceRuleEffect }) {
  const tone: Record<ServiceRuleEffect, string> = {
    deny: 'bg-destructive/15 text-destructive',
    require_approval: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    allow_override: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
    warn: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400',
    allow: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  };
  return (
    <Badge
      variant="outline"
      className={cn('h-5 border-transparent text-[10px] font-medium', tone[effect])}
    >
      {EFFECT_LABEL[effect]}
    </Badge>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">No service rules yet</h3>
        <p className="max-w-md text-xs text-muted-foreground">
          Without rules, every service line goes through with no approval. Common starters: a
          cost-threshold approval, an external-vendor approval over a threshold, or a role-restricted
          premium item.
        </p>
      </div>
      <Button onClick={onCreate} size="sm" className="gap-1.5">
        <Plus className="size-3.5" /> New rule
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
  const create = useCreateServiceRule();
  const { data: templates } = useServiceRuleTemplates();
  const [name, setName] = useState('');
  const [targetKind, setTargetKind] = useState<ServiceRuleTargetKind>('tenant');
  const [effect, setEffect] = useState<ServiceRuleEffect>('require_approval');
  const [appliesWhen, setAppliesWhen] = useState<Record<string, unknown>>({});
  const [appliedTemplateId, setAppliedTemplateId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleApplyTemplate = (template: ServiceRuleTemplate) => {
    if (appliedTemplateId === template.id) {
      // Toggle off — clear back to defaults.
      setAppliedTemplateId(null);
      setAppliesWhen({});
      return;
    }
    setAppliedTemplateId(template.id);
    setName(template.name);
    setEffect(template.effect_default);
    // Use the template's predicate as a starting point; admins refine on
    // the detail page (replace `$.threshold` placeholders, etc.).
    setAppliesWhen(template.applies_when_template);
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    try {
      const r = await create.mutateAsync({
        name: name.trim(),
        target_kind: targetKind,
        target_id: null,
        effect,
        applies_when: appliesWhen,
        priority: 100,
        active: false, // start inactive — admins activate after wiring up the predicate
        template_id: appliedTemplateId,
      });
      toastCreated('Service rule', {
        onView: () => navigate(`/admin/booking-services/rules/${r.id}`),
      });
      onOpenChange(false);
      setName('');
      setAppliesWhen({});
      setAppliedTemplateId(null);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Create failed';
      setError(message);
      toastError("Couldn't create service rule", { error: err });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New service rule</DialogTitle>
          <DialogDescription>
            Start from a template or pick a name + scope + effect. The rule starts inactive so it
            doesn't fire while you're still setting it up.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          {(templates?.length ?? 0) > 0 && (
            <Field>
              <FieldLabel>Start from template</FieldLabel>
              <FieldDescription>
                Pre-fills name + effect + a predicate skeleton with{' '}
                <code className="chip">$.params</code> placeholders to fill in on the detail page.
              </FieldDescription>
              <div className="flex flex-wrap gap-1.5">
                {(templates ?? []).map((t) => {
                  const selected = appliedTemplateId === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => handleApplyTemplate(t)}
                      className={
                        selected
                          ? 'inline-flex items-center gap-1 rounded-full border border-primary bg-primary/10 px-2.5 py-1 text-xs text-primary'
                          : 'inline-flex items-center gap-1 rounded-full border border-input bg-card px-2.5 py-1 text-xs hover:bg-accent/40'
                      }
                      title={t.description}
                    >
                      <Sparkles className="size-3" />
                      {t.name}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="sr-name">Name</FieldLabel>
            <Input
              id="sr-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="External vendor approval"
              autoFocus
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="sr-target-kind">Scope</FieldLabel>
            <Select
              value={targetKind}
              onValueChange={(v) => setTargetKind(v as ServiceRuleTargetKind)}
            >
              <SelectTrigger id="sr-target-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tenant">Tenant-wide</SelectItem>
                <SelectItem value="catalog_category">Catalog category</SelectItem>
                <SelectItem value="menu">Specific menu</SelectItem>
                <SelectItem value="catalog_item">Specific item</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>
              Pick the rule's target on the detail page after creation.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="sr-effect">Effect</FieldLabel>
            <Select value={effect} onValueChange={(v) => setEffect(v as ServiceRuleEffect)}>
              <SelectTrigger id="sr-effect">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="require_approval">Require approval</SelectItem>
                <SelectItem value="deny">Deny</SelectItem>
                <SelectItem value="warn">Warn</SelectItem>
                <SelectItem value="allow_override">Allow override</SelectItem>
                <SelectItem value="allow">Allow</SelectItem>
              </SelectContent>
            </Select>
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
            {create.isPending ? 'Creating…' : 'Create rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
