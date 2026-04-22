import { AlertTriangle, Clock, Cog, FileStack, Users } from 'lucide-react';
import type { ReclassifyImpactDto } from '@/hooks/use-reclassify';

export function ReclassifyImpactPanel({ impact }: { impact: ReclassifyImpactDto }) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Changing request type to{' '}
        <span className="font-medium text-foreground">{impact.ticket.new_request_type.name}</span>{' '}
        will apply the following changes:
      </p>

      <section>
        <header className="flex items-center gap-2 text-sm font-medium">
          <Cog className="size-4" /> Workflow
        </header>
        <div className="mt-2 space-y-1 text-sm text-muted-foreground pl-6">
          {impact.workflow.current_instance ? (
            <p>
              Cancel: &quot;{impact.workflow.current_instance.definition_name}&quot;{' '}
              (at step: {impact.workflow.current_instance.current_step})
            </p>
          ) : (
            <p>No active workflow on this ticket.</p>
          )}
          {impact.workflow.new_definition ? (
            <p>Start: &quot;{impact.workflow.new_definition.name}&quot;</p>
          ) : (
            <p className="italic">
              New request type has no workflow — ticket will have no active workflow afterward.
            </p>
          )}
        </div>
      </section>

      <section>
        <header className="flex items-center gap-2 text-sm font-medium">
          <Users className="size-4" /> Assignment
        </header>
        <div className="mt-2 space-y-1 text-sm text-muted-foreground pl-6">
          <p>Was: {formatAssignment(impact.routing.current_assignment)}</p>
          <p>New: {formatNewDecision(impact.routing.new_decision)}</p>
          {impact.routing.current_user_will_become_watcher && impact.routing.current_assignment.user && (
            <p>{impact.routing.current_assignment.user.name} will be added as a watcher.</p>
          )}
        </div>
      </section>

      <section>
        <header className="flex items-center gap-2 text-sm font-medium">
          <Clock className="size-4" /> SLA
        </header>
        <div className="mt-2 space-y-1 text-sm text-muted-foreground pl-6">
          {impact.sla.active_timers.length > 0 ? (
            <p>
              Stop {impact.sla.active_timers.length} active timer(s) (
              {impact.sla.active_timers
                .map((t) => `${t.metric_name} elapsed ${t.elapsed_minutes}m`)
                .join(', ')}
              ).
            </p>
          ) : (
            <p>No active SLA timers to stop.</p>
          )}
          {impact.sla.new_policy ? (
            <div>
              <p>Start new timers on &quot;{impact.sla.new_policy.name}&quot;:</p>
              <ul className="list-disc pl-6">
                {impact.sla.new_policy.metrics.map((m) => (
                  <li key={m.name}>
                    {m.name}: {m.target_minutes}m
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="italic">
              New request type has no SLA policy — no new timers will start.
            </p>
          )}
        </div>
      </section>

      <section>
        <header className="flex items-center gap-2 text-sm font-medium">
          <FileStack className="size-4" /> Child work orders (
          {impact.children.length} will be closed)
        </header>
        <div className="mt-2 space-y-1 text-sm text-muted-foreground pl-6">
          {impact.children.length === 0 ? (
            <p>No child work orders.</p>
          ) : (
            <ul className="space-y-1">
              {impact.children.map((c) => (
                <li key={c.id} className="flex items-center gap-2">
                  {c.is_in_progress ? (
                    <AlertTriangle className="size-3.5 text-amber-600 flex-shrink-0" />
                  ) : (
                    <span className="size-3.5 flex-shrink-0" />
                  )}
                  <span className="font-medium text-foreground">{c.title}</span>
                  {c.assignee && (
                    <span className="text-xs">— {c.assignee.name}</span>
                  )}
                  {c.is_in_progress && (
                    <span className="text-xs text-amber-700 font-medium">IN PROGRESS</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function formatAssignment(a: ReclassifyImpactDto['routing']['current_assignment']): string {
  const parts: string[] = [];
  if (a.team) parts.push(a.team.name);
  if (a.user) parts.push(a.user.name);
  if (a.vendor) parts.push(a.vendor.name);
  return parts.length > 0 ? parts.join(' → ') : '(unassigned)';
}

function formatNewDecision(d: ReclassifyImpactDto['routing']['new_decision']): string {
  const parts: string[] = [];
  if (d.team) parts.push(d.team.name);
  if (d.user) parts.push(d.user.name);
  if (d.vendor) parts.push(d.vendor.name);
  return parts.length > 0 ? parts.join(' → ') : '(unassigned)';
}
