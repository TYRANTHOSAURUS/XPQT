import { ArrowRight, CircleSlash, Info } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface RoutingRule { id: string; active: boolean }
interface LocationTeam { id: string }
interface RequestType { id: string; default_team_id: string | null; default_vendor_id: string | null }

interface Props {
  onStepClick: (step: PipelineStep) => void;
}

export type PipelineStep = 'rules' | 'asset' | 'coverage' | 'defaults' | 'unassigned';

/**
 * Always-visible 5-step strip showing the resolver pipeline. The whole point
 * of "explainable routing" is that there IS an order; a new admin can't guess
 * it from a flat set of tabs. This strip makes the order and relative weight
 * of each step visible at a glance.
 *
 * Clicking a step jumps to the relevant editor tab.
 */
export function ResolverPipelineStrip({ onStepClick }: Props) {
  const { data: rules } = useApi<RoutingRule[]>('/routing-rules', []);
  const { data: mappings } = useApi<LocationTeam[]>('/location-teams', []);
  const { data: requestTypes } = useApi<RequestType[]>('/request-types', []);

  const rulesCount = (rules ?? []).filter((r) => r.active).length;
  const mappingsCount = (mappings ?? []).length;
  const defaultsCount = (requestTypes ?? []).filter(
    (rt) => rt.default_team_id || rt.default_vendor_id,
  ).length;

  const steps: Array<{
    id: PipelineStep;
    label: string;
    count: number | null;
    hint: string;
    tab: string;
  }> = [
    {
      id: 'rules',
      label: 'Rules',
      count: rulesCount,
      hint: 'Priority-ordered overrides. First active rule whose conditions all match wins — skips every later step.',
      tab: 'rules',
    },
    {
      id: 'asset',
      label: 'Asset',
      count: null,
      hint: 'Per-asset override (assets.override_*) then asset-type default (asset_types.default_*). Configured from the Assets admin page.',
      tab: 'mappings',
    },
    {
      id: 'coverage',
      label: 'Location',
      count: mappingsCount,
      hint: 'Walks (domain chain) × (space chain). Direct location_teams row wins, then space-group row, then parent space, then domain fallback.',
      tab: 'coverage',
    },
    {
      id: 'defaults',
      label: 'Default',
      count: defaultsCount,
      hint: 'Request type\'s default team/vendor when nothing above matched. Configured per request type.',
      tab: 'rules',
    },
    {
      id: 'unassigned',
      label: 'Unassigned',
      count: null,
      hint: 'Nothing matched. Ticket is created but sits in the unassigned queue for a human to triage.',
      tab: 'audit',
    },
  ];

  return (
    <div className="rounded-md border bg-muted/30 px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
        Resolver order
        <Tooltip>
          <TooltipTrigger asChild>
            <Info className="size-3 cursor-help" />
          </TooltipTrigger>
          <TooltipContent>First match wins. Each step is checked in order.</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex items-center gap-1 overflow-x-auto">
        {steps.map((step, i) => (
          <div key={step.id} className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="group flex min-w-0 items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-accent"
                  onClick={() => onStepClick(step.id)}
                >
                  {step.id === 'unassigned' && <CircleSlash className="size-3.5 text-muted-foreground" />}
                  <span className="font-medium">{step.label}</span>
                  {step.count !== null && (
                    <span
                      className={
                        step.count === 0
                          ? 'rounded bg-muted px-1.5 text-xs text-muted-foreground'
                          : 'rounded bg-primary/10 px-1.5 text-xs text-primary'
                      }
                    >
                      {step.count}
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{step.hint}</TooltipContent>
            </Tooltip>
            {i < steps.length - 1 && <ArrowRight className="size-3 text-muted-foreground" />}
          </div>
        ))}
      </div>
    </div>
  );
}
