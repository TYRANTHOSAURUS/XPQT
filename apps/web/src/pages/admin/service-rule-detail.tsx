import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowValue,
} from '@/components/ui/settings-row';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import {
  useDeleteServiceRule,
  useServiceRule,
  useUpdateServiceRule,
} from '@/api/service-rules';
import type { ServiceRuleEffect, ServiceRuleTargetKind } from '@/api/service-rules';
import { toastError, toastRemoved } from '@/lib/toast';

/**
 * /admin/booking-services/rules/:id — auto-saving rule editor.
 *
 * Sections:
 *   - Identity: name, description, active
 *   - Scope: target_kind + target_id (free-form UUID for v1; richer pickers
 *     land in a follow-up so admins can search by item / menu / category)
 *   - Behaviour: effect, denial_message, priority
 *   - Predicate: free-form JSON. Backend validates with PredicateEngineService
 *     so admins see structural errors immediately on save.
 *   - Danger zone: delete
 *
 * The JSON editor is a simple textarea with parse-on-blur; rich predicate
 * editing (and template-driven param specs) is sub-project 5+ work.
 */
export function ServiceRuleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = useServiceRule(id ?? '');
  const update = useUpdateServiceRule();
  const remove = useDeleteServiceRule();

  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Local state — re-seeded from server on row change.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [denialMessage, setDenialMessage] = useState('');
  const [priority, setPriority] = useState('100');
  const [targetId, setTargetId] = useState('');
  const [predicateText, setPredicateText] = useState('{}');
  const [predicateError, setPredicateError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setName(data.name);
    setDescription(data.description ?? '');
    setDenialMessage(data.denial_message ?? '');
    setPriority(String(data.priority));
    setTargetId(data.target_id ?? '');
    setPredicateText(JSON.stringify(data.applies_when ?? {}, null, 2));
    setPredicateError(null);
  }, [data?.id, data?.applies_when, data?.target_id, data?.priority, data?.name, data?.description, data?.denial_message]);

  const persist = (
    patch: Parameters<typeof update.mutateAsync>[0]['patch'],
  ) => {
    if (!id) return;
    update.mutate(
      { id, patch },
      {
        onError: (err: unknown) => {
          toastError("Couldn't save rule", { error: err });
        },
      },
    );
  };

  // Debounce text inputs.
  useDebouncedSave(name, (next) => {
    if (data && next !== data.name && next.trim().length > 0) persist({ name: next.trim() });
  });
  useDebouncedSave(description, (next) => {
    if (!data) return;
    const normalised = next.trim() || null;
    if (normalised !== (data.description ?? null)) persist({ description: normalised });
  });
  useDebouncedSave(denialMessage, (next) => {
    if (!data) return;
    const normalised = next.trim() || null;
    if (normalised !== (data.denial_message ?? null)) persist({ denial_message: normalised });
  });
  useDebouncedSave(priority, (next) => {
    if (!data) return;
    const parsed = Math.max(0, Math.floor(Number(next)));
    if (Number.isFinite(parsed) && parsed !== data.priority) persist({ priority: parsed });
  });
  useDebouncedSave(targetId, (next) => {
    if (!data) return;
    if (data.target_kind === 'tenant') return;
    const normalised = next.trim() || null;
    if (normalised !== (data.target_id ?? null)) persist({ target_id: normalised });
  });

  const handlePredicateBlur = () => {
    if (!data) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(predicateText);
    } catch (err) {
      setPredicateError(`Invalid JSON: ${(err as Error).message}`);
      return;
    }
    setPredicateError(null);
    if (JSON.stringify(parsed) === JSON.stringify(data.applies_when)) return;
    persist({ applies_when: parsed });
  };

  if (isLoading) {
    return (
      <SettingsPageShell width="wide">
        <SettingsPageHeader backTo="/admin/booking-services/rules" title="Loading…" />
      </SettingsPageShell>
    );
  }

  if (!data) {
    return (
      <SettingsPageShell width="wide">
        <SettingsPageHeader
          backTo="/admin/booking-services/rules"
          title="Not found"
          description="This rule may have been deleted."
        />
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        backTo="/admin/booking-services/rules"
        title={data.name}
        description={data.description ?? 'Service rule'}
        actions={
          <Badge
            variant="outline"
            className={
              data.active
                ? 'h-5 border-transparent bg-emerald-500/15 text-[10px] font-medium text-emerald-700 dark:text-emerald-400'
                : 'h-5 border-transparent bg-muted text-[10px] font-medium text-muted-foreground'
            }
          >
            {data.active ? 'Active' : 'Inactive'}
          </Badge>
        }
      />

      <SettingsGroup title="Identity">
        <SettingsRow label="Name" description="Shown to admins in the rules list.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 max-w-md"
          />
        </SettingsRow>
        <SettingsRow label="Description" description="Optional context for other admins.">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="—"
            className="h-8 max-w-md"
          />
        </SettingsRow>
        <SettingsRow
          label="Active"
          description="Inactive rules don't fire — useful while you're still composing the predicate."
        >
          <Switch
            checked={data.active}
            onCheckedChange={(checked) => persist({ active: checked })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Scope"
        description="What does this rule target? More-specific kinds win over less-specific (item > menu > category > tenant)."
      >
        <SettingsRow label="Kind">
          <SettingsRowValue>
            <Select
              value={data.target_kind}
              onValueChange={(v) =>
                persist({
                  target_kind: v as ServiceRuleTargetKind,
                  target_id: v === 'tenant' ? null : data.target_id,
                })
              }
            >
              <SelectTrigger className="h-8 w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tenant">Tenant-wide</SelectItem>
                <SelectItem value="catalog_category">Catalog category</SelectItem>
                <SelectItem value="menu">Specific menu</SelectItem>
                <SelectItem value="catalog_item">Specific item</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRowValue>
        </SettingsRow>
        {data.target_kind !== 'tenant' && (
          <SettingsRow
            label="Target ID"
            description={
              data.target_kind === 'catalog_category'
                ? 'Category name (e.g. food_and_drinks).'
                : 'UUID of the target item or menu. Pickers land in a follow-up.'
            }
          >
            <Input
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              placeholder={data.target_kind === 'catalog_category' ? 'food_and_drinks' : '00000000-0000-0000-0000-000000000000'}
              className="h-8 max-w-md font-mono text-xs"
            />
          </SettingsRow>
        )}
      </SettingsGroup>

      <SettingsGroup title="Behaviour">
        <SettingsRow label="Effect">
          <SettingsRowValue>
            <Select
              value={data.effect}
              onValueChange={(v) => persist({ effect: v as ServiceRuleEffect })}
            >
              <SelectTrigger className="h-8 w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="deny">Deny</SelectItem>
                <SelectItem value="require_approval">Require approval</SelectItem>
                <SelectItem value="allow_override">Allow override</SelectItem>
                <SelectItem value="warn">Warn</SelectItem>
                <SelectItem value="allow">Allow</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow
          label="Message"
          description="Shown to the user when the rule fires (deny / warn) or to the approver as the reason."
        >
          <Input
            value={denialMessage}
            onChange={(e) => setDenialMessage(e.target.value)}
            placeholder="—"
            className="h-8 max-w-md"
          />
        </SettingsRow>
        <SettingsRow
          label="Priority"
          description="Higher wins within the same scope bucket. Default 100."
        >
          <Input
            type="number"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="h-8 w-24 text-center tabular-nums"
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Predicate (applies_when)"
        description='Free-form JSON. Empty = always fires for the matching scope. The backend validates against the predicate engine grammar and returns a clear error on save.'
      >
        <div className="px-4 py-3 space-y-2">
          <Textarea
            value={predicateText}
            onChange={(e) => setPredicateText(e.target.value)}
            onBlur={handlePredicateBlur}
            spellCheck={false}
            className="font-mono text-xs"
            rows={8}
          />
          {predicateError && (
            <p role="alert" className="text-xs text-destructive">
              {predicateError}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">
            Saves on blur. Examples in{' '}
            <a
              href="/docs/superpowers/specs/2026-04-26-linked-services-design.md#41-composite-booking-flow-room--services"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              the design doc
            </a>
            .
          </p>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Danger zone">
        <SettingsRow
          label="Delete rule"
          description="Hard delete. Existing approvals already issued by this rule keep their reasons; new bookings simply won't trigger."
        >
          <Button
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setConfirmingDelete(true)}
            disabled={remove.isPending}
          >
            <Trash2 className="mr-1.5 size-3.5" /> Delete
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete rule "${data.name}"?`}
        description="The rule stops firing on new bookings immediately. Existing approvals keep their reasons. This cannot be undone."
        confirmLabel="Delete rule"
        destructive
        onConfirm={async () => {
          if (!id) return;
          try {
            await remove.mutateAsync(id);
            toastRemoved('Service rule');
            navigate('/admin/booking-services/rules');
          } catch (err) {
            toastError("Couldn't delete service rule", { error: err });
          }
        }}
      />
    </SettingsPageShell>
  );
}
