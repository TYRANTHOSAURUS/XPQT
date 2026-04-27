import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toastError, toastSaved } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
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
import { BusinessHoursPicker } from '@/components/admin/business-hours-picker';
import { SlaPauseReasonsDialog } from '@/components/admin/sla-pause-reasons-dialog';
import { SlaThresholdsDialog } from '@/components/admin/sla-thresholds-dialog';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import {
  useBusinessHoursCalendars,
  useSlaPolicies,
  useUpdateSlaPolicy,
  type SlaPolicy,
} from '@/api/sla-policies';

const PAUSE_REASON_LABELS: Record<string, string> = {
  requester: 'Requester',
  vendor: 'Vendor',
  scheduled_work: 'Scheduled work',
};

export function SlaPolicyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = useSlaPolicies();
  const policy = useMemo(() => (id ? data?.find((p) => p.id === id) : undefined), [data, id]);

  if (isLoading) {
    return (
      <SettingsPageShell>
        <SettingsPageHeader backTo="/admin/sla-policies" title="Loading…" />
      </SettingsPageShell>
    );
  }
  if (!policy) {
    return (
      <SettingsPageShell>
        <SettingsPageHeader
          backTo="/admin/sla-policies"
          title="Policy not found"
          description="This SLA policy may have been deleted."
        />
      </SettingsPageShell>
    );
  }

  return <SlaPolicyDetailBody policy={policy} onBack={() => navigate('/admin/sla-policies')} />;
}

interface BodyProps {
  policy: SlaPolicy;
  onBack: () => void;
}

function SlaPolicyDetailBody({ policy }: BodyProps) {
  const update = useUpdateSlaPolicy(policy.id);
  const save = (patch: Parameters<typeof update.mutate>[0], opts: { silent?: boolean } = {}) => {
    update.mutate(patch, {
      onSuccess: () => toastSaved('SLA policy', { silent: opts.silent }),
      onError: (err) => toastError("Couldn't save SLA policy", { error: err, retry: () => save(patch, opts) }),
    });
  };

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        backTo="/admin/sla-policies"
        title={policy.name}
        description="Targets apply when the policy is attached to a request type, team, or vendor."
        actions={
          <Badge variant={policy.active ? 'default' : 'secondary'}>
            {policy.active ? 'active' : 'disabled'}
          </Badge>
        }
      />

      <IdentityGroup policy={policy} save={save} />
      <TargetsGroup policy={policy} save={save} />
      <BehaviorGroup policy={policy} save={save} />
    </SettingsPageShell>
  );
}

function IdentityGroup({
  policy,
  save,
}: {
  policy: SlaPolicy;
  save: (patch: Parameters<ReturnType<typeof useUpdateSlaPolicy>['mutate']>[0], opts?: { silent?: boolean }) => void;
}) {
  const [name, setName] = useState(policy.name);
  useEffect(() => setName(policy.name), [policy.name]);
  useDebouncedSave(name, (v) => {
    if (v.trim() && v.trim() !== policy.name) save({ name: v.trim() }, { silent: true });
  });

  return (
    <SettingsGroup title="Identity">
      <SettingsRow label="Name" description="Shown everywhere this policy is referenced.">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="w-[260px]" />
      </SettingsRow>
      <SettingsRow label="Active" description="When off, new tickets won't attach this policy.">
        <Switch checked={policy.active} onCheckedChange={(next) => save({ active: next })} />
      </SettingsRow>
    </SettingsGroup>
  );
}

function TargetsGroup({
  policy,
  save,
}: {
  policy: SlaPolicy;
  save: (patch: Parameters<ReturnType<typeof useUpdateSlaPolicy>['mutate']>[0], opts?: { silent?: boolean }) => void;
}) {
  const [responseHours, setResponseHours] = useState(
    policy.response_time_minutes != null ? String(policy.response_time_minutes / 60) : '',
  );
  const [resolutionHours, setResolutionHours] = useState(
    policy.resolution_time_minutes != null ? String(policy.resolution_time_minutes / 60) : '',
  );

  useEffect(() => {
    setResponseHours(policy.response_time_minutes != null ? String(policy.response_time_minutes / 60) : '');
  }, [policy.response_time_minutes]);
  useEffect(() => {
    setResolutionHours(policy.resolution_time_minutes != null ? String(policy.resolution_time_minutes / 60) : '');
  }, [policy.resolution_time_minutes]);

  useDebouncedSave(responseHours, (v) => {
    const parsed = v === '' ? null : Math.round(parseFloat(v) * 60);
    if (parsed !== policy.response_time_minutes && !(parsed !== null && Number.isNaN(parsed))) {
      save({ response_time_minutes: parsed }, { silent: true });
    }
  });
  useDebouncedSave(resolutionHours, (v) => {
    const parsed = v === '' ? null : Math.round(parseFloat(v) * 60);
    if (parsed !== policy.resolution_time_minutes && !(parsed !== null && Number.isNaN(parsed))) {
      save({ resolution_time_minutes: parsed }, { silent: true });
    }
  });

  const { data: calendars } = useBusinessHoursCalendars();
  const calendar = calendars?.find((c) => c.id === policy.business_hours_calendar_id) ?? null;

  return (
    <SettingsGroup
      title="Targets"
      description="Time to acknowledge (response) and time to resolve. Measured in business hours when a calendar is set."
    >
      <SettingsRow label="Response target" description="Hours until an agent must acknowledge the ticket.">
        <div className="flex items-center gap-2">
          <Input
            type="number"
            step="0.5"
            className="w-[100px]"
            value={responseHours}
            onChange={(e) => setResponseHours(e.target.value)}
            placeholder="—"
          />
          <span className="text-xs text-muted-foreground">hours</span>
        </div>
      </SettingsRow>
      <SettingsRow label="Resolution target" description="Hours until the ticket must be resolved.">
        <div className="flex items-center gap-2">
          <Input
            type="number"
            step="0.5"
            className="w-[100px]"
            value={resolutionHours}
            onChange={(e) => setResolutionHours(e.target.value)}
            placeholder="—"
          />
          <span className="text-xs text-muted-foreground">hours</span>
        </div>
      </SettingsRow>
      <SettingsRow
        label="Business hours calendar"
        description="Timers only tick during these hours. Leave unset for 24/7."
      >
        <BusinessHoursPicker
          value={policy.business_hours_calendar_id}
          onChange={(id) => save({ business_hours_calendar_id: id })}
          placeholder={calendar ? calendar.name : 'Always on'}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

function BehaviorGroup({
  policy,
  save,
}: {
  policy: SlaPolicy;
  save: (patch: Parameters<ReturnType<typeof useUpdateSlaPolicy>['mutate']>[0], opts?: { silent?: boolean }) => void;
}) {
  const [pauseOpen, setPauseOpen] = useState(false);
  const [thresholdsOpen, setThresholdsOpen] = useState(false);
  const pauses = policy.pause_on_waiting_reasons ?? [];
  const thresholds = policy.escalation_thresholds ?? [];

  const pauseSummary =
    pauses.length === 0
      ? 'Never paused'
      : pauses.map((p) => PAUSE_REASON_LABELS[p] ?? p).join(', ');
  const thresholdSummary =
    thresholds.length === 0
      ? 'None'
      : `${thresholds.length} ${thresholds.length === 1 ? 'threshold' : 'thresholds'}`;

  return (
    <SettingsGroup title="Behavior" description="When the clock pauses and what fires as it approaches breach.">
      <SettingsRow
        label="Pause conditions"
        description="Waiting states that pause the SLA clock until they clear."
        onClick={() => setPauseOpen(true)}
      >
        <SettingsRowValue>{pauseSummary}</SettingsRowValue>
      </SettingsRow>
      <SettingsRow
        label="Escalation thresholds"
        description="Notify or reassign when a timer hits a percent of its target."
        onClick={() => setThresholdsOpen(true)}
      >
        <SettingsRowValue>{thresholdSummary}</SettingsRowValue>
      </SettingsRow>

      <SlaPauseReasonsDialog
        open={pauseOpen}
        onOpenChange={setPauseOpen}
        value={pauses}
        onSave={(next) => {
          save({ pause_on_waiting_reasons: next });
          setPauseOpen(false);
        }}
      />
      <SlaThresholdsDialog
        open={thresholdsOpen}
        onOpenChange={setThresholdsOpen}
        value={thresholds}
        onSave={(next) => {
          save({ escalation_thresholds: next });
          setThresholdsOpen(false);
        }}
      />
    </SettingsGroup>
  );
}
