import { useState } from 'react';
import { Lock, ShieldAlert, Plus, ExternalLink } from 'lucide-react';
import {
  SettingsPageShell,
  SettingsPageHeader,
} from '@/components/ui/settings-page';
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowValue,
} from '@/components/ui/settings-row';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import { toastUpdated, toastError, toastSaved } from '@/lib/toast';
import {
  describeCategory,
  describeLegalBasis,
  useLegalHolds,
  usePlaceLegalHold,
  useReleaseLegalHold,
  useRetentionList,
  useUpdateRetention,
  useDsrList,
  type LegalHold,
  type RetentionSetting,
} from '@/api/gdpr';

export function PrivacyAdminPage() {
  const retention = useRetentionList();
  const holds = useLegalHolds(false);
  const dsrs = useDsrList();

  const [editingCategory, setEditingCategory] = useState<RetentionSetting | null>(null);
  const [placingHold, setPlacingHold] = useState(false);
  const [releasingHold, setReleasingHold] = useState<LegalHold | null>(null);

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/admin"
        title="Privacy & data"
        description="Per-category retention, legal holds, and data subject requests under GDPR Articles 15-22."
      />

      {/* ============================================================ */}
      {/* Section: Privacy notice & residency                          */}
      {/* ============================================================ */}
      <SettingsGroup
        title="Privacy notice & residency"
        description="Public-facing legal pointers your tenants can configure."
      >
        <div className="rounded-md border border-border/60 bg-card overflow-hidden">
          <SettingsRow label="Data residency" description="Hosting region for personal data.">
            <SettingsRowValue>Frankfurt (EU) — Supabase managed</SettingsRowValue>
          </SettingsRow>
          <div className="h-px bg-border/60" />
          <SettingsRow
            label="Sub-processors"
            description="Third parties that process tenant data."
          >
            <a
              href="/legal/sub-processors"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-foreground hover:underline"
            >
              View list
              <ExternalLink className="size-3.5" />
            </a>
          </SettingsRow>
        </div>
      </SettingsGroup>

      {/* ============================================================ */}
      {/* Section: Retention policies                                  */}
      {/* ============================================================ */}
      <SettingsGroup
        title="Retention policies"
        description="How long each category of personal data is kept before anonymization or deletion. Click a row to change retention or capture the LIA (Legitimate Interest Assessment)."
      >
        {retention.isLoading && (
          <div className="text-sm text-muted-foreground">Loading…</div>
        )}
        {retention.data && retention.data.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead className="w-[140px]">Retention</TableHead>
                <TableHead className="w-[120px]">Cap</TableHead>
                <TableHead className="w-[180px]">Legal basis</TableHead>
                <TableHead className="w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {retention.data.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer hover:bg-muted/40"
                  onClick={() => setEditingCategory(row)}
                >
                  <TableCell>
                    <div className="font-medium text-sm">{describeCategory(row.data_category)}</div>
                    <div className="text-xs text-muted-foreground">{row.data_category}</div>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {row.retention_days === 0 ? (
                      <span className="text-muted-foreground">not warehoused</span>
                    ) : (
                      `${row.retention_days} d`
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {row.cap_retention_days === null ? '—' : `${row.cap_retention_days} d`}
                  </TableCell>
                  <TableCell className="text-sm">{describeLegalBasis(row.legal_basis)}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm">Edit</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SettingsGroup>

      {/* ============================================================ */}
      {/* Section: Legal holds                                         */}
      {/* ============================================================ */}
      <SettingsGroup
        title="Legal holds"
        description="Active holds pause anonymization and erasure for the named subject, category, or tenant. Place a hold during litigation or regulatory inquiry."
      >
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setPlacingHold(true)} className="gap-1.5">
            <Plus className="size-4" /> Place hold
          </Button>
        </div>
        {holds.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {holds.data && holds.data.length === 0 && (
          <div className="rounded-md border border-dashed border-border/60 bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
            No active legal holds.
          </div>
        )}
        {holds.data && holds.data.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">Type</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="w-[140px]">Placed</TableHead>
                <TableHead className="w-[120px]">Expires</TableHead>
                <TableHead className="w-[120px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {holds.data.map((hold) => (
                <TableRow key={hold.id}>
                  <TableCell>
                    <Badge variant={hold.hold_type === 'tenant_wide' ? 'destructive' : 'secondary'}>
                      <Lock className="size-3 mr-1" />
                      {hold.hold_type.replace('_', ' ')}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {hold.subject_person_id ?? hold.data_category ?? 'all data'}
                  </TableCell>
                  <TableCell className="text-sm">{hold.reason}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <time dateTime={hold.initiated_at} title={formatFullTimestamp(hold.initiated_at)}>
                      {formatRelativeTime(hold.initiated_at)}
                    </time>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {hold.expires_at ? (
                      <time dateTime={hold.expires_at} title={formatFullTimestamp(hold.expires_at)}>
                        {formatRelativeTime(hold.expires_at)}
                      </time>
                    ) : (
                      'manual release'
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => setReleasingHold(hold)}>
                      Release
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SettingsGroup>

      {/* ============================================================ */}
      {/* Section: Data subject requests                                */}
      {/* ============================================================ */}
      <SettingsGroup
        title="Data subject requests"
        description="Right of access (Art. 15) and right of erasure (Art. 17) requests. Initiate per-person via the persons admin page."
      >
        {dsrs.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {dsrs.data && dsrs.data.length === 0 && (
          <div className="rounded-md border border-dashed border-border/60 bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
            No data subject requests in the last 200 events.
          </div>
        )}
        {dsrs.data && dsrs.data.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">Type</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead className="w-[140px]">Status</TableHead>
                <TableHead className="w-[160px]">Initiated</TableHead>
                <TableHead className="w-[160px]">Completed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dsrs.data.map((dsr) => (
                <TableRow key={dsr.id}>
                  <TableCell className="capitalize">{dsr.request_type}</TableCell>
                  <TableCell className="font-mono text-xs">{dsr.subject_person_id}</TableCell>
                  <TableCell>
                    <DsrStatusBadge status={dsr.status} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <time dateTime={dsr.initiated_at} title={formatFullTimestamp(dsr.initiated_at)}>
                      {formatRelativeTime(dsr.initiated_at)}
                    </time>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {dsr.completed_at ? (
                      <time dateTime={dsr.completed_at} title={formatFullTimestamp(dsr.completed_at)}>
                        {formatRelativeTime(dsr.completed_at)}
                      </time>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SettingsGroup>

      {/* dialogs */}
      {editingCategory && (
        <RetentionEditDialog
          row={editingCategory}
          onClose={() => setEditingCategory(null)}
        />
      )}
      {placingHold && (
        <PlaceHoldDialog
          categories={retention.data ?? []}
          onClose={() => setPlacingHold(false)}
        />
      )}
      {releasingHold && (
        <ReleaseHoldDialog
          hold={releasingHold}
          onClose={() => setReleasingHold(null)}
        />
      )}
    </SettingsPageShell>
  );
}

// ---------------------------------------------------------------------
// Retention edit dialog
// ---------------------------------------------------------------------

function RetentionEditDialog({ row, onClose }: { row: RetentionSetting; onClose: () => void }) {
  const [retentionDays, setRetentionDays] = useState(String(row.retention_days));
  const [liaText, setLiaText] = useState(row.lia_text ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const update = useUpdateRetention(row.data_category);
  const isHardCap = row.cap_retention_days !== null;
  const dirty =
    Number(retentionDays) !== row.retention_days ||
    (liaText !== (row.lia_text ?? ''));

  async function onSave() {
    setError(null);
    const days = Number(retentionDays);
    if (Number.isNaN(days) || days < 0) {
      setError('Retention must be a non-negative number.');
      return;
    }
    if (isHardCap && days > (row.cap_retention_days ?? Infinity)) {
      setError(`Cap is ${row.cap_retention_days} days. Contact support for legal exceptions.`);
      return;
    }
    if (reason.trim().length < 8) {
      setError('Reason is required (at least 8 characters).');
      return;
    }
    try {
      await update.mutateAsync({
        retention_days: days,
        lia_text: liaText.trim() || null,
        reason: reason.trim(),
      });
      toastUpdated('Retention');
      onClose();
    } catch (err) {
      toastError('Couldn\'t save retention', { error: err, retry: onSave });
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{describeCategory(row.data_category)}</DialogTitle>
          <DialogDescription>
            Category <code className="chip">{row.data_category}</code> · {describeLegalBasis(row.legal_basis)}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <FieldSet>
            <FieldLegend>Retention window</FieldLegend>
            <Field>
              <FieldLabel htmlFor="retention-days">Retention (days)</FieldLabel>
              <Input
                id="retention-days"
                type="number"
                min={0}
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value)}
              />
              <FieldDescription>
                {row.cap_retention_days === null
                  ? 'No cap — legal-obligation retention; usually 7 years for accounting.'
                  : `Hard cap: ${row.cap_retention_days} days.`}
                {' '}Set to 0 to opt out of warehousing this category.
              </FieldDescription>
            </Field>
          </FieldSet>

          <FieldSeparator />

          <FieldSet>
            <FieldLegend>Legitimate Interest Assessment</FieldLegend>
            <FieldDescription>
              Required when extending past the system default. Document the assessed
              interest, balance against subject rights, and the safeguards in place.
            </FieldDescription>
            <Field>
              <FieldLabel htmlFor="lia-text">LIA text</FieldLabel>
              <Textarea
                id="lia-text"
                rows={5}
                value={liaText}
                onChange={(e) => setLiaText(e.target.value)}
                placeholder="Describe the legitimate interest, balancing test, and safeguards…"
              />
            </Field>
          </FieldSet>

          <FieldSeparator />

          <Field>
            <FieldLabel htmlFor="reason">Reason for change</FieldLabel>
            <Input
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Captured in the audit log"
            />
            <FieldDescription>Required ({'≥'}8 characters).</FieldDescription>
          </Field>

          {error && <FieldError errors={[{ message: error }]} />}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={onSave} disabled={!dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------
// Place hold dialog
// ---------------------------------------------------------------------

function PlaceHoldDialog({
  categories,
  onClose,
}: {
  categories: RetentionSetting[];
  onClose: () => void;
}) {
  const place = usePlaceLegalHold();
  const [holdType, setHoldType] = useState<'person' | 'category' | 'tenant_wide'>('person');
  const [subjectPersonId, setSubjectPersonId] = useState('');
  const [dataCategory, setDataCategory] = useState('');
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onPlace() {
    setError(null);
    if (reason.trim().length < 8) {
      setError('Reason is required (at least 8 characters).');
      return;
    }
    if (holdType === 'person' && !subjectPersonId.trim()) {
      setError('Subject person id is required for a person hold.');
      return;
    }
    if (holdType === 'category' && !dataCategory) {
      setError('Data category is required for a category hold.');
      return;
    }
    try {
      await place.mutateAsync({
        hold_type: holdType,
        subject_person_id: holdType === 'person' ? subjectPersonId.trim() : undefined,
        data_category: holdType === 'category' ? dataCategory : undefined,
        reason: reason.trim(),
        expires_at: expiresAt || undefined,
      });
      toastSaved('Legal hold');
      onClose();
    } catch (err) {
      toastError('Couldn\'t place hold', { error: err, retry: onPlace });
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-amber-600" />
            Place legal hold
          </DialogTitle>
          <DialogDescription>
            Pauses anonymization and erasure for the chosen scope until released.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="hold-type">Hold type</FieldLabel>
            <Select value={holdType} onValueChange={(v) => setHoldType(v as typeof holdType)}>
              <SelectTrigger id="hold-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="person">Person — pauses one subject's data</SelectItem>
                <SelectItem value="category">Category — pauses one category for all subjects</SelectItem>
                <SelectItem value="tenant_wide">Tenant-wide — pauses all retention activity</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {holdType === 'person' && (
            <Field>
              <FieldLabel htmlFor="subject-person-id">Subject person id (UUID)</FieldLabel>
              <Input
                id="subject-person-id"
                value={subjectPersonId}
                onChange={(e) => setSubjectPersonId(e.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </Field>
          )}

          {holdType === 'category' && (
            <Field>
              <FieldLabel htmlFor="data-category">Data category</FieldLabel>
              <Select value={dataCategory} onValueChange={(v) => setDataCategory(v ?? '')}>
                <SelectTrigger id="data-category">
                  <SelectValue placeholder="Select a category…" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.data_category} value={c.data_category}>
                      {describeCategory(c.data_category)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          <Field>
            <FieldLabel htmlFor="reason">Reason</FieldLabel>
            <Textarea
              id="reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reference the matter / case / regulator inquiry"
            />
            <FieldDescription>Captured in the audit log. Required (at least 8 chars).</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="expires-at">Expires at (optional)</FieldLabel>
            <Input
              id="expires-at"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            <FieldDescription>Leave blank for manual release.</FieldDescription>
          </Field>

          {error && <FieldError errors={[{ message: error }]} />}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={onPlace} disabled={place.isPending}>
            {place.isPending ? 'Placing…' : 'Place hold'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------
// Release hold dialog
// ---------------------------------------------------------------------

function ReleaseHoldDialog({ hold, onClose }: { hold: LegalHold; onClose: () => void }) {
  const release = useReleaseLegalHold();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onRelease() {
    setError(null);
    if (reason.trim().length < 8) {
      setError('Reason is required (at least 8 characters).');
      return;
    }
    try {
      await release.mutateAsync({ id: hold.id, reason: reason.trim() });
      toastUpdated('Legal hold released');
      onClose();
    } catch (err) {
      toastError('Couldn\'t release hold', { error: err, retry: onRelease });
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Release legal hold</DialogTitle>
          <DialogDescription>
            Retention will resume for the affected scope on the next nightly run.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="release-reason">Release reason</FieldLabel>
            <Textarea
              id="release-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Matter closed; regulator confirmed end of inquiry"
            />
          </Field>
          {error && <FieldError errors={[{ message: error }]} />}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={onRelease} disabled={release.isPending}>
            {release.isPending ? 'Releasing…' : 'Release'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------

function DsrStatusBadge({ status }: { status: string }) {
  const variant: 'default' | 'secondary' | 'destructive' | 'outline' =
    status === 'completed' ? 'default'
    : status === 'denied' ? 'destructive'
    : status === 'partial' ? 'outline'
    : 'secondary';
  return <Badge variant={variant} className="capitalize">{status.replace('_', ' ')}</Badge>;
}
