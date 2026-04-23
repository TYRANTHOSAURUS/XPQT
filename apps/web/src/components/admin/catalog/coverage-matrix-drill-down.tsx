import { useMemo } from 'react';
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { SlidersHorizontal, ChevronRight } from 'lucide-react';
import type { ServiceItemDetail } from './catalog-service-panel';

/**
 * "Explain this row" drawer for the coverage matrix. Renders the three
 * layers the resolver walks for a given site — offering, scope override,
 * composed fulfillment — so admins can answer "why is this site doing X?"
 * without cross-referencing the override list manually.
 *
 * Data sources: the matrix row (already hydrated with names + sources) plus
 * the tab's detail (offerings + scope_overrides). No extra fetches.
 */

type SourceTag = 'override' | 'default' | 'override_unassigned' | 'none' | 'routing';

interface DimensionValue {
  id: string | null;
  name: string | null;
  source: SourceTag;
}

interface HandlerValue {
  kind: 'team' | 'vendor' | 'none' | null;
  id: string | null;
  name: string | null;
  source: SourceTag;
}

export interface MatrixRow {
  site: { id: string; name: string; type: 'site' | 'building'; parent_id: string | null };
  offered: boolean;
  offering: { scope_kind: 'tenant' | 'space' | 'space_group'; rule_id: string } | null;
  override_id: string | null;
  override_scope_kind: 'tenant' | 'space' | 'space_group' | null;
  override_precedence: string | null;
  handler: HandlerValue;
  workflow: DimensionValue;
  case_sla: DimensionValue;
  child_dispatch: DimensionValue;
  executor_sla: DimensionValue;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: MatrixRow | null;
  detail: ServiceItemDetail;
  onEditOverride: (overrideId: string) => void;
  onAddOverride: (siteId: string) => void;
  onToggleOffering: (siteId: string) => void;
  hasTenantOffering: boolean;
  directOffered: boolean;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="w-36 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function SourceLabel({ source, fallback }: { source: SourceTag; fallback?: string }) {
  const map: Record<SourceTag, string> = {
    override: 'override',
    override_unassigned: 'override · unassigned',
    default: 'request-type default',
    routing: 'routing chain',
    none: fallback ?? 'not set',
  };
  return (
    <Badge variant="outline" className="text-[10px] font-normal">{map[source]}</Badge>
  );
}

export function CoverageMatrixDrillDown({
  open,
  onOpenChange,
  row,
  detail,
  onEditOverride,
  onAddOverride,
  onToggleOffering,
  hasTenantOffering,
  directOffered,
}: Props) {
  // Derive the offering rule row (from detail) that the matrix picked, plus
  // the inheritance path if it was inherited from an ancestor. The matrix
  // backend returns scope_kind but not the offering's space_id; we resolve
  // it by matching rule_id in the tab's cached offering list.
  const offeringRule = useMemo(
    () => {
      if (!row?.offering) return null;
      return detail.offerings.find((o) => o.id === row.offering!.rule_id) ?? null;
    },
    [row, detail.offerings],
  );

  // The winning scope override (if any), looked up by id from the detail.
  const winningOverride = useMemo(
    () => {
      if (!row?.override_id) return null;
      return detail.scope_overrides.find((o) => o.id === row.override_id) ?? null;
    },
    [row, detail.scope_overrides],
  );

  if (!row) return null;

  const offeringSubtitle = (() => {
    if (!row.offered) return 'Not offered at this site.';
    if (!offeringRule) return 'Offered (rule details not cached).';
    if (offeringRule.scope_kind === 'tenant') return 'Offered tenant-wide.';
    if (offeringRule.scope_kind === 'space_group') return 'Offered via a space group membership.';
    if (offeringRule.space_id === row.site.id) return 'Directly offered at this site.';
    return 'Inherited from an ancestor space.';
  })();

  const overridePrecedenceLabel: Record<string, string> = {
    exact_space: 'exact space',
    ancestor_space: 'inherited from ancestor',
    space_group: 'via space group',
    tenant: 'tenant-wide',
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>
            {row.site.name}
            <span className="ml-2 text-xs font-normal text-muted-foreground capitalize">
              ({row.site.type})
            </span>
          </SheetTitle>
          <SheetDescription>
            How the resolver computes the effective fulfillment for {detail.name} at this site.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex flex-col gap-4">
          {/* Offering */}
          <section className="rounded-md border p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium">Offering</h3>
              <Badge variant={row.offered ? 'default' : 'outline'} className="text-[10px]">
                {row.offered ? 'offered' : 'not offered'}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mb-2">{offeringSubtitle}</p>
            {offeringRule && (
              <div className="flex flex-col gap-1.5">
                <Row label="Rule scope">
                  <span className="capitalize">{offeringRule.scope_kind.replace('_', ' ')}</span>
                </Row>
                {offeringRule.space_id && offeringRule.space_id !== row.site.id && (
                  <Row label="Anchored at">
                    <span className="font-mono text-xs">
                      {offeringRule.space_id.slice(0, 8)}…
                      <ChevronRight className="inline-block h-3 w-3 mx-1 text-muted-foreground" />
                      {row.site.id.slice(0, 8)}… ({row.site.name})
                    </span>
                  </Row>
                )}
                <Row label="Inherits">
                  <span>{offeringRule.inherit_to_descendants ? 'yes' : 'no'}</span>
                </Row>
                {(offeringRule.starts_at || offeringRule.ends_at) && (
                  <Row label="Active window">
                    <span className="font-mono text-xs">
                      {offeringRule.starts_at ?? '—'} → {offeringRule.ends_at ?? '∞'}
                    </span>
                  </Row>
                )}
              </div>
            )}
          </section>

          {/* Scope override */}
          <section className="rounded-md border p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium">Scope override</h3>
              {winningOverride ? (
                <Badge className="text-[10px] bg-amber-500/15 text-amber-900 dark:text-amber-200 border-amber-500/30">
                  {overridePrecedenceLabel[row.override_precedence ?? ''] ?? row.override_precedence}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">none</Badge>
              )}
            </div>
            {winningOverride ? (
              <div className="flex flex-col gap-1.5">
                <Row label="Scope">
                  <span className="capitalize">{winningOverride.scope_kind.replace('_', ' ')}</span>
                  {winningOverride.space_id && (
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      space {winningOverride.space_id.slice(0, 8)}
                    </span>
                  )}
                  {winningOverride.space_group_id && (
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      group {winningOverride.space_group_id.slice(0, 8)}
                    </span>
                  )}
                </Row>
                <Row label="Inherits">
                  <span>{winningOverride.inherit_to_descendants ? 'yes' : 'no'}</span>
                </Row>
                <Row label="Active">
                  <span>{winningOverride.active ? 'yes' : 'no'}</span>
                </Row>
                <Row label="Handler">
                  <span>
                    {winningOverride.handler_kind === 'none'
                      ? 'Explicit unassign'
                      : winningOverride.handler_kind === 'team'
                        ? `Team · ${winningOverride.handler_team_id?.slice(0, 8) ?? '—'}`
                        : winningOverride.handler_kind === 'vendor'
                          ? `Vendor · ${winningOverride.handler_vendor_id?.slice(0, 8) ?? '—'}`
                          : 'not overridden (falls through)'}
                  </span>
                </Row>
                <Row label="Workflow">
                  <span>{winningOverride.workflow_definition_id ? 'overridden' : '—'}</span>
                </Row>
                <Row label="Case SLA">
                  <span>{winningOverride.case_sla_policy_id ? 'overridden' : '—'}</span>
                </Row>
                <Row label="Executor SLA">
                  <span>{winningOverride.executor_sla_policy_id ? 'overridden' : '—'}</span>
                </Row>
                <Row label="Child dispatch">
                  <span>{winningOverride.child_dispatch_policy_entity_id ? 'overridden' : '—'}</span>
                </Row>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No scope override matches this site. The resolver uses the request-type defaults
                for every dimension.
              </p>
            )}
          </section>

          {/* Effective composition */}
          <section className="rounded-md border p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium">Effective fulfillment</h3>
              <span className="text-[10px] text-muted-foreground">what the resolver will use</span>
            </div>
            <div className="flex flex-col gap-2">
              <Row label="Handler">
                <div className="flex items-center gap-2">
                  <span>
                    {row.handler.kind === 'none'
                      ? 'Unassigned'
                      : row.handler.name
                        ?? (row.handler.id ? row.handler.id.slice(0, 8) : 'routing chain')}
                  </span>
                  <SourceLabel source={row.handler.source} />
                </div>
              </Row>
              <Separator />
              <Row label="Workflow">
                <div className="flex items-center gap-2">
                  <span>{row.workflow.name ?? (row.workflow.id ? row.workflow.id.slice(0, 8) : 'none')}</span>
                  <SourceLabel source={row.workflow.source} />
                </div>
              </Row>
              <Row label="Case SLA">
                <div className="flex items-center gap-2">
                  <span>{row.case_sla.name ?? (row.case_sla.id ? row.case_sla.id.slice(0, 8) : 'none')}</span>
                  <SourceLabel source={row.case_sla.source} />
                </div>
              </Row>
              <Row label="Child dispatch">
                <div className="flex items-center gap-2">
                  <span>{row.child_dispatch.name ?? (row.child_dispatch.id ? row.child_dispatch.id.slice(0, 8) : '—')}</span>
                  <SourceLabel source={row.child_dispatch.source} fallback="team / vendor default" />
                </div>
              </Row>
              <Row label="Executor SLA">
                <div className="flex items-center gap-2">
                  <span>{row.executor_sla.name ?? (row.executor_sla.id ? row.executor_sla.id.slice(0, 8) : '—')}</span>
                  <SourceLabel source={row.executor_sla.source} fallback="team / vendor default" />
                </div>
              </Row>
            </div>
          </section>
        </div>

        <SheetFooter className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-between">
          <div className="flex items-center gap-2">
            {row.override_id ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => { onEditOverride(row.override_id!); onOpenChange(false); }}
              >
                <SlidersHorizontal className="h-3 w-3 mr-1" />
                Edit override
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => { onAddOverride(row.site.id); onOpenChange(false); }}
              >
                <SlidersHorizontal className="h-3 w-3 mr-1" />
                Add override here
              </Button>
            )}
            {directOffered ? (
              <Button size="sm" variant="ghost" onClick={() => onToggleOffering(row.site.id)}>
                Remove direct offering
              </Button>
            ) : !hasTenantOffering && !row.offered ? (
              <Button size="sm" variant="ghost" onClick={() => onToggleOffering(row.site.id)}>
                Offer here
              </Button>
            ) : null}
          </div>
          <Button size="sm" variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
