import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toastError, toastRemoved, toastSaved, toastSuccess } from '@/lib/toast';
import { AlertTriangle, Copy, Plus, RotateCw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { PersonPicker } from '@/components/person-picker';
import { RequestTypePicker } from '@/components/request-type-picker';
import { WorkflowDefinitionPicker } from '@/components/admin/workflow-definition-picker';
import { WebhookRulesDialog } from '@/components/admin/webhook-rules-dialog';
import { WebhookKeyValueDialog } from '@/components/admin/webhook-keyvalue-dialog';
import { WebhookTestDialog } from '@/components/admin/webhook-test-dialog';
import { useRequestType } from '@/api/request-types';
import { usePerson } from '@/api/persons';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import { cn } from '@/lib/utils';
import {
  useDeleteWebhook,
  useRotateWebhookApiKey,
  useUpdateWebhook,
  useWebhooks,
  type Webhook,
} from '@/api/webhooks';

interface ValidationProblem {
  severity: 'error' | 'warning' | 'info';
  field?: string;
  message: string;
}

export function WebhookDetailPage() {
  const { id: webhookId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: webhooks, isLoading } = useWebhooks();
  const webhook = useMemo(
    () => (webhookId ? webhooks?.find((w) => w.id === webhookId) : undefined),
    [webhooks, webhookId],
  );

  if (isLoading) {
    return (
      <SettingsPageShell>
        <SettingsPageHeader backTo="/admin/webhooks" title="Loading…" />
      </SettingsPageShell>
    );
  }

  if (!webhook) {
    return (
      <SettingsPageShell>
        <SettingsPageHeader
          backTo="/admin/webhooks"
          title="Webhook not found"
          description="This webhook may have been deleted."
        />
      </SettingsPageShell>
    );
  }

  return <WebhookDetailBody webhook={webhook} onDeleted={() => navigate('/admin/webhooks')} />;
}

interface WebhookDetailBodyProps {
  webhook: Webhook;
  onDeleted: () => void;
}

function WebhookDetailBody({ webhook, onDeleted }: WebhookDetailBodyProps) {
  const update = useUpdateWebhook(webhook.id);
  const [problems, setProblems] = useState<ValidationProblem[]>([]);

  const save = (patch: Record<string, unknown>, opts: { silent?: boolean } = {}) => {
    update.mutate(patch, {
      onSuccess: (res) => {
        const next = (res as unknown as { validation?: { problems?: ValidationProblem[] } }).validation?.problems ?? [];
        setProblems(next);
        toastSaved('Webhook', { silent: opts.silent });
      },
      onError: (err) => toastError("Couldn't save webhook", { error: err, retry: () => save(patch, opts) }),
    });
  };

  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        backTo="/admin/webhooks"
        title={webhook.name}
        description="Send payloads to /webhooks/ingest with this webhook's API key."
        actions={
          <Badge variant={webhook.active ? 'default' : 'secondary'}>
            {webhook.active ? 'active' : 'disabled'}
          </Badge>
        }
      />

      {(errors.length > 0 || warnings.length > 0) && (
        <div className="rounded-md border bg-card p-4 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4 text-amber-600" />
            Configuration review
          </div>
          <ul className="text-sm text-muted-foreground flex flex-col gap-1">
            {errors.map((p, i) => (
              <li key={`err-${i}`}>
                <span className="text-red-600 font-medium">Error:</span> {p.message}
              </li>
            ))}
            {warnings.map((p, i) => (
              <li key={`warn-${i}`}>
                <span className="text-amber-600 font-medium">Warning:</span> {p.message}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Inbound events will 422 until errors are resolved.
          </p>
        </div>
      )}

      <IdentityGroup webhook={webhook} save={save} />
      <RoutingGroup webhook={webhook} save={save} />
      <MappingGroup webhook={webhook} save={save} />
      <OperationsGroup webhook={webhook} />
      <AuthGroup webhook={webhook} save={save} />
      <DangerGroup webhookId={webhook.id} onDeleted={onDeleted} />
    </SettingsPageShell>
  );
}

function IdentityGroup({
  webhook,
  save,
}: {
  webhook: Webhook;
  save: (patch: Record<string, unknown>, opts?: { silent?: boolean }) => void;
}) {
  const [name, setName] = useState(webhook.name);
  useEffect(() => setName(webhook.name), [webhook.name]);
  useDebouncedSave(name, (v) => {
    if (v.trim() && v.trim() !== webhook.name) save({ name: v.trim() }, { silent: true });
  });

  return (
    <SettingsGroup title="Identity">
      <SettingsRow label="Name" description="Used in the audit log and stamped on every ticket's source channel.">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-[260px]"
        />
      </SettingsRow>
      <SettingsRow label="Active" description="When off, all incoming requests return 403.">
        <Switch
          checked={webhook.active}
          onCheckedChange={(next) => save({ active: next })}
        />
      </SettingsRow>
      <SettingsRow
        label="Workflow override"
        description="When set, this workflow starts instead of the request type's own workflow."
      >
        <WorkflowDefinitionPicker
          value={webhook.workflow_id}
          onChange={(id) => save({ workflow_id: id })}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

function RoutingGroup({
  webhook,
  save,
}: {
  webhook: Webhook;
  save: (patch: Record<string, unknown>, opts?: { silent?: boolean }) => void;
}) {
  const [rulesOpen, setRulesOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { data: defaultRt } = useRequestType(webhook.default_request_type_id);

  return (
    <SettingsGroup
      title="Request type"
      description="Every payload must resolve to a request type. Routing, SLA, and workflow all branch from here."
    >
      <SettingsRow
        label="Default request type"
        description="Used when no rule matches and the payload doesn't set ticket_type_id."
        onClick={() => setPickerOpen(true)}
      >
        <SettingsRowValue>{defaultRt?.name ?? 'None'}</SettingsRowValue>
      </SettingsRow>
      <SettingsRow
        label="Rules"
        description="Condition-based routing to a specific request type. First match wins."
        onClick={() => setRulesOpen(true)}
      >
        <SettingsRowValue>
          {webhook.request_type_rules.length === 0
            ? 'No rules'
            : `${webhook.request_type_rules.length} ${webhook.request_type_rules.length === 1 ? 'rule' : 'rules'}`}
        </SettingsRowValue>
      </SettingsRow>

      <RequestTypePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        value={webhook.default_request_type_id ?? ''}
        onSave={(id) => {
          save({ default_request_type_id: id || null });
          setPickerOpen(false);
        }}
      />
      <WebhookRulesDialog
        open={rulesOpen}
        onOpenChange={setRulesOpen}
        value={webhook.request_type_rules}
        saving={false}
        onSave={(rules) => {
          save({ request_type_rules: rules });
          setRulesOpen(false);
        }}
      />
    </SettingsGroup>
  );
}

function MappingGroup({
  webhook,
  save,
}: {
  webhook: Webhook;
  save: (patch: Record<string, unknown>, opts?: { silent?: boolean }) => void;
}) {
  const { data: defaultRequester } = usePerson(webhook.default_requester_person_id);
  const [fieldMappingOpen, setFieldMappingOpen] = useState(false);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const [requesterPickerOpen, setRequesterPickerOpen] = useState(false);
  const [lookupOpen, setLookupOpen] = useState(false);

  const requesterLabel = defaultRequester
    ? `${defaultRequester.first_name ?? ''} ${defaultRequester.last_name ?? ''}`.trim() ||
      defaultRequester.email ||
      'Unknown'
    : 'None';

  const mappingCount = Object.keys(webhook.field_mapping ?? {}).length;
  const defaultsCount = Object.keys(webhook.ticket_defaults ?? {}).length;
  const lookupActive = !!webhook.requester_lookup;

  return (
    <SettingsGroup title="Payload mapping" description="How fields on the inbound payload become the ticket.">
      <SettingsRow
        label="Field mapping"
        description="Ticket field → JSONPath in the payload."
        onClick={() => setFieldMappingOpen(true)}
      >
        <SettingsRowValue>
          {mappingCount === 0 ? 'No fields' : `${mappingCount} ${mappingCount === 1 ? 'field' : 'fields'}`}
        </SettingsRowValue>
      </SettingsRow>
      <SettingsRow
        label="Ticket defaults"
        description="Fixed values applied when the field isn't in the mapping above."
        onClick={() => setDefaultsOpen(true)}
      >
        <SettingsRowValue>
          {defaultsCount === 0
            ? 'No defaults'
            : `${defaultsCount} ${defaultsCount === 1 ? 'default' : 'defaults'}`}
        </SettingsRowValue>
      </SettingsRow>
      <SettingsRow
        label="Default requester"
        description="Used when the payload has no requester mapping and email lookup misses."
        onClick={() => setRequesterPickerOpen(true)}
      >
        <SettingsRowValue>{requesterLabel}</SettingsRowValue>
      </SettingsRow>
      <SettingsRow
        label="Email lookup"
        description="Resolve a requester by looking up persons.email at ingest time."
        onClick={() => setLookupOpen(true)}
      >
        <SettingsRowValue>{lookupActive ? webhook.requester_lookup!.path : 'Off'}</SettingsRowValue>
      </SettingsRow>

      <WebhookKeyValueDialog
        open={fieldMappingOpen}
        onOpenChange={setFieldMappingOpen}
        title="Field mapping"
        description="Map a ticket field to a JSONPath. Supports $.a.b and $.items[0].name."
        keyLabel="Ticket field"
        valueLabel="JSONPath"
        keyPlaceholder="title"
        valuePlaceholder="$.issue.fields.summary"
        value={webhook.field_mapping ?? {}}
        onSave={(next) => {
          save({ field_mapping: next });
          setFieldMappingOpen(false);
        }}
      />
      <WebhookKeyValueDialog
        open={defaultsOpen}
        onOpenChange={setDefaultsOpen}
        title="Ticket defaults"
        description="Fixed values applied to every ticket when not present in field mapping."
        keyLabel="Ticket field"
        valueLabel="Value"
        keyPlaceholder="priority"
        valuePlaceholder="medium"
        value={Object.fromEntries(
          Object.entries(webhook.ticket_defaults ?? {}).map(([k, v]) => [k, String(v ?? '')]),
        )}
        onSave={(next) => {
          save({ ticket_defaults: next });
          setDefaultsOpen(false);
        }}
      />
      <RequesterPickerDialog
        open={requesterPickerOpen}
        onOpenChange={setRequesterPickerOpen}
        value={webhook.default_requester_person_id}
        onSave={(id) => {
          save({ default_requester_person_id: id });
          setRequesterPickerOpen(false);
        }}
      />
      <EmailLookupDialog
        open={lookupOpen}
        onOpenChange={setLookupOpen}
        value={webhook.requester_lookup}
        onSave={(next) => {
          save({ requester_lookup: next });
          setLookupOpen(false);
        }}
      />
    </SettingsGroup>
  );
}

function OperationsGroup({ webhook }: { webhook: Webhook }) {
  const [testOpen, setTestOpen] = useState(false);
  return (
    <SettingsGroup title="Operations" description="Validate the mapping and inspect real traffic.">
      <SettingsRow
        label="Test payload"
        description="Run mapping against a sample payload without creating a ticket."
        onClick={() => setTestOpen(true)}
      >
        <SettingsRowValue>Open</SettingsRowValue>
      </SettingsRow>
      <Link to={`/admin/webhooks/${webhook.id}/events`} className="contents">
        <SettingsRow
          label="Recent events"
          description="Last 30 days of accepted, deduplicated, rejected, and errored events."
          onClick={() => undefined}
        >
          <SettingsRowValue>View log</SettingsRowValue>
        </SettingsRow>
      </Link>

      <WebhookTestDialog open={testOpen} onOpenChange={setTestOpen} webhookId={webhook.id} />
    </SettingsGroup>
  );
}

function AuthGroup({
  webhook,
  save,
}: {
  webhook: Webhook;
  save: (patch: Record<string, unknown>, opts?: { silent?: boolean }) => void;
}) {
  const rotate = useRotateWebhookApiKey();
  const [rotatedKey, setRotatedKey] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rate, setRate] = useState(webhook.rate_limit_per_minute);
  useEffect(() => setRate(webhook.rate_limit_per_minute), [webhook.rate_limit_per_minute]);
  useDebouncedSave(rate, (v) => {
    const n = Number(v);
    if (!Number.isNaN(n) && n !== webhook.rate_limit_per_minute) {
      save({ rate_limit_per_minute: n }, { silent: true });
    }
  });

  const [allowlistOpen, setAllowlistOpen] = useState(false);

  return (
    <SettingsGroup title="Auth & limits">
      <SettingsRow
        label="API key"
        description="Rotation invalidates the current key immediately. Shown once."
      >
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setConfirmRotate(true)}
          disabled={rotate.isPending}
        >
          <RotateCw className="size-3.5" />
          Rotate
        </Button>
      </SettingsRow>
      <SettingsRow label="Rate limit" description="Max requests per minute from the source system.">
        <Input
          type="number"
          min={1}
          className="w-[110px]"
          value={rate}
          onChange={(e) => setRate(Number(e.target.value))}
        />
      </SettingsRow>
      <SettingsRow
        label="IP allowlist"
        description="Restrict to specific source IPs or CIDRs. Empty = open."
        onClick={() => setAllowlistOpen(true)}
      >
        <SettingsRowValue>
          {(webhook.allowed_cidrs ?? []).length === 0
            ? 'Open'
            : `${webhook.allowed_cidrs.length} ${webhook.allowed_cidrs.length === 1 ? 'address' : 'addresses'}`}
        </SettingsRowValue>
      </SettingsRow>

      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title="Rotate API key"
        description="The current key will stop working immediately. Copy the new key right after."
        confirmLabel="Rotate"
        onConfirm={async () => {
          const res = await rotate.mutateAsync(webhook.id);
          setRotatedKey(res.api_key);
        }}
      />

      <Dialog open={!!rotatedKey} onOpenChange={(next) => !next && setRotatedKey(null)}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>
              Copy this now — it won't be shown again. Paste it into the source system.
            </DialogDescription>
          </DialogHeader>
          {rotatedKey && (
            <div className="rounded-md bg-muted px-3 py-3 font-mono text-xs break-all select-all">
              {rotatedKey}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (rotatedKey) navigator.clipboard.writeText(rotatedKey);
                toastSuccess('API key copied');
              }}
            >
              <Copy className="size-4" /> Copy
            </Button>
            <Button onClick={() => setRotatedKey(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AllowlistDialog
        open={allowlistOpen}
        onOpenChange={setAllowlistOpen}
        value={webhook.allowed_cidrs ?? []}
        onSave={(next) => {
          save({ allowed_cidrs: next });
          setAllowlistOpen(false);
        }}
      />
    </SettingsGroup>
  );
}

function DangerGroup({ webhookId, onDeleted }: { webhookId: string; onDeleted: () => void }) {
  const del = useDeleteWebhook();
  const [open, setOpen] = useState(false);

  return (
    <SettingsGroup title="Danger zone">
      <SettingsRow
        label="Delete webhook"
        description="The external system will receive 401 on any future request. Cannot be undone."
      >
        <Button
          variant="outline"
          size="sm"
          className={cn(buttonVariants({ variant: 'destructive' }), 'h-8 px-3')}
          onClick={() => setOpen(true)}
        >
          Delete
        </Button>
      </SettingsRow>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete webhook"
        description="This cannot be undone. The external system will receive 401 on any future request."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await del.mutateAsync(webhookId);
          toastRemoved('Webhook', { verb: 'deleted' });
          onDeleted();
        }}
      />
    </SettingsGroup>
  );
}

// --- sub-dialogs local to this page ---

interface RequestTypePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onSave: (id: string) => void;
}

function RequestTypePickerDialog({ open, onOpenChange, value, onSave }: RequestTypePickerDialogProps) {
  const [current, setCurrent] = useState(value);
  useEffect(() => { if (open) setCurrent(value); }, [open, value]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Default request type</DialogTitle>
          <DialogDescription>
            The request type applied when no rule matches and the payload doesn't set ticket_type_id.
          </DialogDescription>
        </DialogHeader>
        <RequestTypePicker
          value={current}
          onChange={(id) => setCurrent(id)}
          placeholder="Select a request type…"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="ghost" onClick={() => onSave('')}>
            Clear
          </Button>
          <Button onClick={() => onSave(current)} disabled={!current}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RequesterPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string | null;
  onSave: (id: string | null) => void;
}

function RequesterPickerDialog({ open, onOpenChange, value, onSave }: RequesterPickerDialogProps) {
  const [current, setCurrent] = useState<string | null>(value);
  useEffect(() => { if (open) setCurrent(value); }, [open, value]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Default requester</DialogTitle>
          <DialogDescription>
            Pick the person recorded as the requester when the payload has no better source.
            Typically an "Integrations Bot" or a system user.
          </DialogDescription>
        </DialogHeader>
        <PersonPicker
          value={current}
          onChange={(id) => setCurrent(id)}
          placeholder="Pick a person…"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="ghost" onClick={() => onSave(null)}>
            Clear
          </Button>
          <Button onClick={() => onSave(current)} disabled={!current}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface EmailLookupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: Webhook['requester_lookup'];
  onSave: (next: Webhook['requester_lookup']) => void;
}

function EmailLookupDialog({ open, onOpenChange, value, onSave }: EmailLookupDialogProps) {
  const [enabled, setEnabled] = useState(!!value);
  const [path, setPath] = useState(value?.path ?? '$.reporter.email');
  useEffect(() => {
    if (!open) return;
    setEnabled(!!value);
    setPath(value?.path ?? '$.reporter.email');
  }, [open, value]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Email lookup</DialogTitle>
          <DialogDescription>
            Resolve a requester from an email in the payload. Used before falling back to the default
            requester.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <label className="flex items-center justify-between gap-3">
            <div className="flex flex-col">
              <span className="text-sm font-medium">Enabled</span>
              <span className="text-xs text-muted-foreground">Matches exact value against persons.email.</span>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </label>
          {enabled && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium" htmlFor="lookup-path">JSONPath</label>
              <Input
                id="lookup-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                className="font-mono text-xs"
                placeholder="$.reporter.email"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => onSave(enabled ? { path, strategy: 'exact_email' } : null)}
            disabled={enabled && !path.trim()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface AllowlistDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string[];
  onSave: (next: string[]) => void;
}

function AllowlistDialog({ open, onOpenChange, value, onSave }: AllowlistDialogProps) {
  const [rows, setRows] = useState<string[]>(value);
  useEffect(() => { if (open) setRows(value.length ? value : ['']); }, [open, value]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>IP allowlist</DialogTitle>
          <DialogDescription>
            One address or CIDR per row. Leave empty to accept requests from any IP.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                className="font-mono text-xs flex-1"
                placeholder="10.0.0.0/24"
                value={row}
                onChange={(e) => setRows((prev) => prev.map((r, j) => (j === i ? e.target.value : r)))}
              />
              <Button
                variant="ghost"
                size="sm"
                className="size-8"
                onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                disabled={rows.length === 1}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="self-start gap-1.5"
            onClick={() => setRows((prev) => [...prev, ''])}
          >
            <Plus className="size-3.5" />
            Add address
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => onSave(rows.map((r) => r.trim()).filter(Boolean))}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
