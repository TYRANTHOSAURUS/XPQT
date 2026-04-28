import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  useServiceRules,
  type ServiceRule,
  type ServiceRuleEffect,
  type ServiceRuleTargetKind,
} from '@/api/service-rules';
import { ServiceRuleTemplateDialog } from './service-rules/components/service-rule-template-dialog';

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
  const navigate = useNavigate();
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

      <ServiceRuleTemplateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => navigate(`/admin/booking-services/rules/${id}`)}
      />
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

