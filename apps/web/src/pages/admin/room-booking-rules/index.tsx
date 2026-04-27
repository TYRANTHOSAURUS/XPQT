import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Sparkles } from 'lucide-react';
import { toast, toastCreated, toastError } from '@/lib/toast';
import { Button, buttonVariants } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import {
  useCreateRuleFromTemplate,
  useRoomBookingRuleTemplates,
  useRoomBookingRules,
  useUpdateRoomBookingRule,
  type RoomBookingRule,
  type RuleTemplate,
} from '@/api/room-booking-rules';
import { RuleRowEffectBadge } from './components/rule-row-effect-badge';
import { RuleScopeSummary } from './components/rule-scope-summary';
import { RuleTemplatesGrid } from './components/rule-templates-grid';
import {
  RuleTemplateEditorDialog,
  type RuleTemplateEditorResult,
} from './components/rule-template-editor-dialog';

export function RoomBookingRulesPage() {
  const { data, isLoading } = useRoomBookingRules();
  const { data: templates } = useRoomBookingRuleTemplates();

  const [editorOpen, setEditorOpen] = useState(false);
  const [seedTemplate, setSeedTemplate] = useState<RuleTemplate | null>(null);

  const isEmpty = !isLoading && (data?.length ?? 0) === 0;

  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        backTo="/admin"
        title="Room booking rules"
        description="Govern who can book what, when, and what triggers approval."
        actions={
          <Button
            className="gap-1.5"
            onClick={() => {
              setSeedTemplate(null);
              setEditorOpen(true);
            }}
          >
            <Plus className="size-4" />
            New rule
          </Button>
        }
      />

      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {!isLoading && data && data.length > 0 && <RulesTable rules={data} />}

      {isEmpty && (
        <EmptyState
          templates={templates ?? []}
          onPick={(tpl) => {
            setSeedTemplate(tpl);
            setEditorOpen(true);
          }}
          onBlankNew={() => {
            setSeedTemplate(null);
            setEditorOpen(true);
          }}
        />
      )}

      <CreateRuleDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        seedTemplate={seedTemplate}
      />
    </SettingsPageShell>
  );
}

/* -------------------------------------------------------------------------- */
/* Table                                                                       */
/* -------------------------------------------------------------------------- */

function RulesTable({ rules }: { rules: RoomBookingRule[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Scope</TableHead>
          <TableHead className="w-[140px]">Effect</TableHead>
          <TableHead className="w-[160px]">Last modified</TableHead>
          <TableHead className="w-[80px] text-right">Active</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((rule) => (
          <RuleRow key={rule.id} rule={rule} />
        ))}
      </TableBody>
    </Table>
  );
}

function RuleRow({ rule }: { rule: RoomBookingRule }) {
  const update = useUpdateRoomBookingRule(rule.id);

  return (
    <TableRow>
      <TableCell className="font-medium">
        <Link
          to={`/admin/room-booking-rules/${rule.id}`}
          className="hover:underline underline-offset-2"
        >
          {rule.name}
        </Link>
        {rule.description && (
          <div className="mt-0.5 text-xs text-muted-foreground line-clamp-1">{rule.description}</div>
        )}
      </TableCell>
      <TableCell>
        <RuleScopeSummary
          target_scope={rule.target_scope}
          target_id={rule.target_id}
        />
      </TableCell>
      <TableCell>
        <RuleRowEffectBadge effect={rule.effect} />
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        <time dateTime={rule.updated_at} title={formatFullTimestamp(rule.updated_at)}>
          {formatRelativeTime(rule.updated_at)}
        </time>
      </TableCell>
      <TableCell className="text-right">
        <Switch
          checked={rule.active}
          onCheckedChange={(next) =>
            update.mutate(
              { active: next },
              {
                onError: (err) => toastError("Couldn't save rule", { error: err }),
              },
            )
          }
          // Stop the row link from intercepting clicks on the switch.
          onClick={(e) => e.stopPropagation()}
        />
      </TableCell>
    </TableRow>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty state                                                                 */
/* -------------------------------------------------------------------------- */

interface EmptyStateProps {
  templates: RuleTemplate[];
  onPick: (template: RuleTemplate) => void;
  onBlankNew: () => void;
}

function EmptyState({ templates, onPick, onBlankNew }: EmptyStateProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <Sparkles className="size-10 text-muted-foreground" />
        <div className="text-sm font-medium">No rules yet</div>
        <p className="max-w-md text-sm text-muted-foreground">
          Pick a starter template below to define a room policy in seconds, or build one from scratch
          with the raw predicate editor.
        </p>
        <Button
          className={cn(buttonVariants({ variant: 'outline' }), 'gap-1.5')}
          onClick={onBlankNew}
        >
          <Plus className="size-4" />
          Blank rule
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Starter templates
        </div>
        <RuleTemplatesGrid templates={templates} onPick={onPick} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Create dialog                                                               */
/* -------------------------------------------------------------------------- */

interface CreateRuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seedTemplate: RuleTemplate | null;
}

function CreateRuleDialog({ open, onOpenChange, seedTemplate }: CreateRuleDialogProps) {
  const navigate = useNavigate();
  const fromTemplate = useCreateRuleFromTemplate();

  const initial = useMemo(
    () => (seedTemplate ? { template_id: seedTemplate.id, params: seedDefaultParams(seedTemplate) } : null),
    [seedTemplate],
  );

  const handleSave = (result: RuleTemplateEditorResult) => {
    if (!result.fromTemplate) {
      // Raw-only path: we don't have a "create from raw" mutation; this UX is
      // template-first. Inform admin and bail.
      toast.message('Pick a starter template to create a rule', {
        description: 'Raw predicates are editable on the rule detail page after creation.',
      });
      return;
    }
    fromTemplate.mutate(
      {
        template_id: result.fromTemplate.template_id,
        params: result.fromTemplate.params,
        target_scope: 'tenant',
      },
      {
        onSuccess: (rule) => {
          toastCreated('Rule', { onView: () => navigate(`/admin/room-booking-rules/${rule.id}`) });
          onOpenChange(false);
          navigate(`/admin/room-booking-rules/${rule.id}`);
        },
        onError: (err) => toastError("Couldn't create rule", { error: err, retry: () => handleSave(result) }),
      },
    );
  };

  return (
    <RuleTemplateEditorDialog
      open={open}
      onOpenChange={onOpenChange}
      initialPredicate={undefined}
      initialTemplate={initial}
      mode="create"
      onSave={handleSave}
    />
  );
}

function seedDefaultParams(template: RuleTemplate): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of template.paramSpecs) {
    if (spec.default !== undefined) out[spec.key] = spec.default;
  }
  return out;
}
