import { Link } from 'react-router-dom';
import {
  Target,
  Users,
  Wrench,
  Eye,
  CheckCircle2,
  Circle,
  ArrowRight,
} from 'lucide-react';
import { useApi } from '@/hooks/use-api';

interface Team { id: string }
interface RequestType { id: string; default_team_id: string | null; default_vendor_id: string | null }
interface RoutingRule { id: string; active: boolean }
interface LocationTeam { id: string }

interface Props {
  onOpenTab: (tab: string) => void;
}

/**
 * Landing view of the Routing Studio. Answers three questions a new admin
 * usually hasn't had answered anywhere else:
 *   1. What is routing vs. ownership vs. execution vs. visibility?
 *   2. Where is each of those configured?
 *   3. If my tenant is empty, where do I start?
 */
export function RoutingStudioOverview({ onOpenTab }: Props) {
  const { data: teams } = useApi<Team[]>('/teams', []);
  const { data: requestTypes } = useApi<RequestType[]>('/request-types', []);
  const { data: rules } = useApi<RoutingRule[]>('/routing-rules', []);
  const { data: mappings } = useApi<LocationTeam[]>('/location-teams', []);

  const teamsCount = (teams ?? []).length;
  const rtCount = (requestTypes ?? []).length;
  const rtWithDefaultCount = (requestTypes ?? []).filter(
    (rt) => rt.default_team_id || rt.default_vendor_id,
  ).length;
  const mappingCount = (mappings ?? []).length;
  const ruleCount = (rules ?? []).length;

  const checklist = [
    {
      done: teamsCount > 0,
      label: 'Create at least one team',
      hint: 'Teams are the assignment groups routing lands work on.',
      href: '/admin/teams',
      external: true,
    },
    {
      done: rtCount > 0,
      label: 'Create at least one request type',
      hint: 'Carries the domain, strategy, and defaults every ticket inherits.',
      href: '/admin/request-types',
      external: true,
    },
    {
      done: mappingCount > 0 || rtWithDefaultCount > 0,
      label: 'Configure at least one assignment',
      hint: 'Either a location mapping (Coverage tab) or a request-type default.',
      tab: 'coverage',
    },
    {
      done: ruleCount > 0,
      label: 'Add an override rule (optional)',
      hint: 'Priority-ordered overrides for urgent or domain-specific tickets.',
      tab: 'rules',
      optional: true,
    },
    {
      done: false, // Always shown as a "try it" prompt
      label: 'Try the simulator',
      hint: 'Pick a ticket shape and watch the resolver walk live.',
      tab: 'simulator',
      nudge: true,
    },
  ];

  const firstThreeDone = checklist.slice(0, 3).every((i) => i.done);

  return (
    <div className="flex flex-col gap-6">
      {/* Four-axis model map */}
      <section>
        <h2 className="mb-2 text-sm font-medium uppercase text-muted-foreground">
          The four axes of ticket handling
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <AxisCard
            icon={<Target className="size-4" />}
            title="Routing"
            herePill
            description="Given a ticket (request type, location, asset, priority), who gets assigned?"
            configuredAt="Configured here, in Routing Studio."
          />
          <AxisCard
            icon={<Users className="size-4" />}
            title="Ownership"
            description="Which team is accountable to the requester? (Usually the assigned team on the parent case.)"
            configuredAt={
              <Link to="/admin/teams" className="text-primary hover:underline">
                Teams page →
              </Link>
            }
          />
          <AxisCard
            icon={<Wrench className="size-4" />}
            title="Execution"
            description="Who actually does the work? For a single assignee it's the same as ownership; for multi-party work it's child work orders (vendors, sub-teams)."
            configuredAt="Created per ticket via Dispatch. No admin setup needed."
          />
          <AxisCard
            icon={<Eye className="size-4" />}
            title="Visibility"
            description="Who can read/write the ticket? Independent from routing — a ticket can be assigned to team A but visible to team B's members."
            configuredAt={
              <Link to="/admin/users" className="text-primary hover:underline">
                Users &amp; Roles →
              </Link>
            }
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Routing decides who <em>gets</em> a ticket. Ownership, execution, and visibility answer <em>different</em> questions and are configured elsewhere.
        </p>
      </section>

      {/* Start-here checklist */}
      <section>
        <h2 className="mb-2 text-sm font-medium uppercase text-muted-foreground">
          {firstThreeDone ? 'Next steps' : 'Start here'}
        </h2>
        <ol className="divide-y rounded-md border">
          {checklist.map((item, idx) => (
            <li key={idx} className="flex items-center gap-3 px-4 py-3">
              {item.nudge ? (
                <ArrowRight className="size-4 text-primary" />
              ) : item.done ? (
                <CheckCircle2 className="size-4 text-emerald-600" />
              ) : (
                <Circle className="size-4 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm">
                  {item.label}
                  {item.optional && <span className="ml-2 text-xs text-muted-foreground">(optional)</span>}
                </div>
                <div className="text-xs text-muted-foreground">{item.hint}</div>
              </div>
              <div className="shrink-0">
                {item.external ? (
                  <Link to={item.href} className="text-sm text-primary hover:underline">
                    Open →
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => item.tab && onOpenTab(item.tab)}
                    className="text-sm text-primary hover:underline"
                  >
                    Open →
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Glossary / vocabulary rescue */}
      <section>
        <h2 className="mb-2 text-sm font-medium uppercase text-muted-foreground">
          Vocabulary
        </h2>
        <dl className="grid grid-cols-1 gap-3 rounded-md border p-4 text-sm md:grid-cols-2">
          <div>
            <dt className="font-medium">Domain</dt>
            <dd className="text-muted-foreground text-xs">
              A ticket's subject area — <code>fm</code>, <code>it</code>, <code>catering</code>, <code>security</code>, etc. Same word means the same thing everywhere.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Scope</dt>
            <dd className="text-muted-foreground text-xs">
              A limit on where something applies: a team's domain scope (which domains it handles), a role's domain + location scope (where it grants permission).
            </dd>
          </div>
          <div>
            <dt className="font-medium">Location / space chain</dt>
            <dd className="text-muted-foreground text-xs">
              A space's parent path up to the root. The resolver walks this chain when looking for a location-based match.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Space group</dt>
            <dd className="text-muted-foreground text-xs">
              A flat set of unrelated spaces treated as one routing scope (e.g. Buildings A, C, F share one FM team).
            </dd>
          </div>
          <div>
            <dt className="font-medium">Domain fallback</dt>
            <dd className="text-muted-foreground text-xs">
              Chain of <code>domain → parent_domain</code> (e.g. <code>doors → fm</code>). When a specific-domain match misses, the resolver retries with each parent.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Chosen-by</dt>
            <dd className="text-muted-foreground text-xs">
              How the resolver reached its decision. Every trace entry is tagged (<code>rule</code>, <code>location_team</code>, <code>domain_fallback</code>…). Visible in the Audit tab.
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function AxisCard({
  icon,
  title,
  description,
  configuredAt,
  herePill,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  configuredAt: React.ReactNode;
  herePill?: boolean;
}) {
  return (
    <div className={`rounded-md border p-3 ${herePill ? 'border-primary/40 bg-primary/5' : ''}`}>
      <div className="mb-1 flex items-center gap-2">
        {icon}
        <span className="font-medium">{title}</span>
        {herePill && (
          <span className="rounded bg-primary/20 px-1.5 py-0.5 text-xs text-primary">
            you are here
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
      <p className="mt-2 text-xs">{configuredAt}</p>
    </div>
  );
}
