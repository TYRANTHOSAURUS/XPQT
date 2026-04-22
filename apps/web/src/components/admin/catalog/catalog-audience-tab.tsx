import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Eye, EyeOff, Send, Ban, Users2, Sparkles, AlertCircle } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import type { ServiceItemDetail } from './catalog-service-sheet';

interface CriteriaSet { id: string; name: string; description: string | null }

export function CatalogAudienceTab({ detail }: { detail: ServiceItemDetail; onSaved: () => void }) {
  const { data: sets } = useApi<CriteriaSet[]>('/admin/criteria-sets', []);
  const setsById = useMemo(() => new Map((sets ?? []).map((s) => [s.id, s])), [sets]);

  const visibleAllow = detail.criteria.filter((c) => c.mode === 'visible_allow' && c.active);
  const visibleDeny = detail.criteria.filter((c) => c.mode === 'visible_deny' && c.active);
  const requestAllow = detail.criteria.filter((c) => c.mode === 'request_allow' && c.active);
  const requestDeny = detail.criteria.filter((c) => c.mode === 'request_deny' && c.active);

  const noRules =
    visibleAllow.length + visibleDeny.length + requestAllow.length + requestDeny.length === 0;

  return (
    <div className="space-y-5">
      {/* Hero pitch */}
      <div className="relative overflow-hidden rounded-xl p-5 bg-gradient-to-br from-purple-500/10 via-background to-transparent ring-1 ring-purple-500/20">
        <div className="flex items-start gap-3">
          <div className="size-9 rounded-lg bg-purple-500/10 text-purple-600 flex items-center justify-center">
            <Users2 className="size-4" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold">Audience targeting</h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-md">
              Control who sees this service (visible) and who can submit it (requestable).
              Rules combine: deny short-circuits, allow defaults to "everyone" when unset.
            </p>
          </div>
          <Badge variant="outline" className="text-[10px] bg-background">
            <Sparkles className="size-2.5 mr-1" /> requestable ⊆ visible
          </Badge>
        </div>
      </div>

      {noRules && (
        <div className="rounded-xl p-4 bg-muted/30 ring-1 ring-border text-center">
          <div className="text-sm font-medium">No audience rules configured</div>
          <div className="text-xs text-muted-foreground mt-1">
            This service is visible to every authorized employee. Bind a criteria set below to narrow.
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <RuleColumn
          title="Visibility"
          icon={<Eye className="size-3.5" />}
          allow={visibleAllow}
          deny={visibleDeny}
          setsById={setsById}
          allowIcon={<Eye className="size-3" />}
          denyIcon={<EyeOff className="size-3" />}
          allowLabel="Visible to"
          denyLabel="Hidden from"
        />
        <RuleColumn
          title="Requestability"
          icon={<Send className="size-3.5" />}
          allow={requestAllow}
          deny={requestDeny}
          setsById={setsById}
          allowIcon={<Send className="size-3" />}
          denyIcon={<Ban className="size-3" />}
          allowLabel="Can submit"
          denyLabel="Cannot submit"
        />
      </div>

      <div className="rounded-xl p-4 bg-gradient-to-r from-muted/20 to-transparent ring-1 ring-border">
        <div className="flex items-start gap-2">
          <AlertCircle className="size-4 mt-0.5 text-muted-foreground shrink-0" />
          <div className="flex-1 text-xs text-muted-foreground">
            Inline criteria authoring isn't in this Sheet yet — manage the rule library at{' '}
            <span className="text-foreground font-medium">Settings → Criteria sets</span> and re-open this tab to bind.
          </div>
          <Button variant="outline" size="sm" className="h-7 text-xs" disabled>
            Manage criteria →
          </Button>
        </div>
      </div>
    </div>
  );
}

function RuleColumn({
  title, icon, allow, deny, setsById, allowIcon, denyIcon, allowLabel, denyLabel,
}: {
  title: string;
  icon: React.ReactNode;
  allow: ServiceItemDetail['criteria'];
  deny: ServiceItemDetail['criteria'];
  setsById: Map<string, CriteriaSet>;
  allowIcon: React.ReactNode;
  denyIcon: React.ReactNode;
  allowLabel: string;
  denyLabel: string;
}) {
  return (
    <div className="rounded-xl ring-1 ring-border bg-background">
      <div className="px-3.5 py-2.5 border-b bg-muted/30 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </div>
      <div className="p-3.5 space-y-3">
        <RuleGroup label={allowLabel} rules={allow} setsById={setsById} icon={allowIcon} tone="emerald" />
        <RuleGroup label={denyLabel} rules={deny} setsById={setsById} icon={denyIcon} tone="rose" />
      </div>
    </div>
  );
}

function RuleGroup({
  label, rules, setsById, icon, tone,
}: {
  label: string;
  rules: ServiceItemDetail['criteria'];
  setsById: Map<string, CriteriaSet>;
  icon: React.ReactNode;
  tone: 'emerald' | 'rose';
}) {
  const toneClasses = tone === 'emerald'
    ? 'text-emerald-600 bg-emerald-500/10 ring-emerald-500/20'
    : 'text-rose-600 bg-rose-500/10 ring-rose-500/20';
  return (
    <div>
      <div className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ${toneClasses}`}>
        {icon}
        {label}
      </div>
      {rules.length === 0 ? (
        <div className="text-[11px] text-muted-foreground italic mt-1.5 pl-1">Default: everyone</div>
      ) : (
        <div className="mt-1.5 space-y-1">
          {rules.map((r) => (
            <div key={r.id} className="text-xs px-2 py-1.5 rounded bg-muted/30 ring-1 ring-border">
              {setsById.get(r.criteria_set_id)?.name ?? 'Unknown set'}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
