import { useEffect, useMemo, useState } from 'react';
import { Download, FileText, Send, RefreshCw, Eye } from 'lucide-react';
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowValue,
} from '@/components/ui/settings-row';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field';
import { useUpsertVendor, type Vendor, type VendorFulfillmentMode } from '@/api/vendors';
import {
  useDailyListHistory,
  useDailyListPreview,
  useDailyListRegenerate,
  useDailyListResend,
  type DailyListHistoryItem,
  type DailyListPayload,
  type ServiceType,
} from '@/api/daily-list';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import { toastError, toastSuccess, toastSaved } from '@/lib/toast';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import { apiFetch } from '@/lib/api';

/**
 * Vendor Fulfillment configuration + daily-list history.
 * Spec §9 (`/admin/vendors/:id` Fulfillment tab).
 *
 * Hides daily-list settings + history when fulfillment_mode is 'portal'
 * (vendor only operates via the portal, no printed list).
 */
export function VendorFulfillmentSection({ vendor }: { vendor: Vendor }) {
  const upsert = useUpsertVendor();
  const [mode, setMode] = useState<VendorFulfillmentMode>(vendor.fulfillment_mode ?? 'portal');
  const [dlEmail, setDlEmail] = useState(vendor.daglijst_email ?? '');
  const [language, setLanguage] = useState(vendor.daglijst_language ?? 'nl');
  const [cutoffStrategy, setCutoffStrategy] = useState<'offset' | 'clock'>(
    vendor.daglijst_send_clock_time ? 'clock' : 'offset',
  );
  const [offsetMinutes, setOffsetMinutes] = useState(
    String(vendor.daglijst_cutoff_offset_minutes ?? 180),
  );
  const [clockTime, setClockTime] = useState(vendor.daglijst_send_clock_time ?? '07:00');

  const showDailyList = mode === 'paper_only' || mode === 'hybrid';

  /* Mode change is the structural decision — write immediately so the
     downstream sections show/hide consistently. */
  const handleModeChange = (next: VendorFulfillmentMode) => {
    setMode(next);
    upsert.mutate(
      { id: vendor.id, payload: { name: vendor.name, fulfillment_mode: next } },
      {
        onSuccess: () => toastSaved('Fulfillment mode'),
        onError: (err) => toastError("Couldn't save fulfillment mode", { error: err }),
      },
    );
  };

  /* Per-field auto-save with debounce — same pattern as the Identity
     section above. Email is the only validated field at the API layer
     (BadRequest if empty AND mode != portal); we let the server reject
     and surface the toast. */
  useDebouncedSave(dlEmail, (v) => {
    if (v === (vendor.daglijst_email ?? '')) return;
    upsert.mutate({
      id: vendor.id,
      payload: { name: vendor.name, daglijst_email: v.trim() || null },
    });
  });

  const handleLanguageChange = (next: 'nl' | 'fr' | 'en' | 'de') => {
    setLanguage(next);
    upsert.mutate({
      id: vendor.id,
      payload: { name: vendor.name, daglijst_language: next },
    });
  };

  const handleCutoffStrategyChange = (next: 'offset' | 'clock') => {
    setCutoffStrategy(next);
    /* Persist exactly one of (offset_minutes, clock_time) to satisfy the
       XOR DB check — null the unused mode's column. */
    upsert.mutate({
      id: vendor.id,
      payload: {
        name: vendor.name,
        daglijst_cutoff_offset_minutes: next === 'offset' ? Number(offsetMinutes) : null,
        daglijst_send_clock_time:        next === 'clock'  ? clockTime          : null,
      },
    });
  };

  useDebouncedSave(offsetMinutes, (v) => {
    if (cutoffStrategy !== 'offset') return;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return;
    if (n === (vendor.daglijst_cutoff_offset_minutes ?? -1)) return;
    upsert.mutate({
      id: vendor.id,
      payload: { name: vendor.name, daglijst_cutoff_offset_minutes: n },
    });
  });

  useDebouncedSave(clockTime, (v) => {
    if (cutoffStrategy !== 'clock') return;
    if (!/^\d{2}:\d{2}$/.test(v)) return;
    if (v === (vendor.daglijst_send_clock_time ?? '')) return;
    upsert.mutate({
      id: vendor.id,
      payload: { name: vendor.name, daglijst_send_clock_time: v },
    });
  });

  return (
    <>
      <SettingsGroup
        title="Fulfillment mode"
        description="How does this vendor receive work? Pick paper-only when they don't use software; portal for full self-service; hybrid when they do both."
      >
        <SettingsRow label="Mode">
          <SettingsRowValue>
            <Select value={mode} onValueChange={(v) => handleModeChange(v as VendorFulfillmentMode)}>
              <SelectTrigger className="h-8 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="portal">Portal only</SelectItem>
                <SelectItem value="paper_only">Paper only</SelectItem>
                <SelectItem value="hybrid">Hybrid</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRowValue>
        </SettingsRow>
      </SettingsGroup>

      {showDailyList ? (
        <>
          <SettingsGroup
            title="Daily list (daglijst)"
            description="Printed list of orders emailed to the vendor at the cutoff time. Uses the vendor's local Europe/Amsterdam clock."
          >
            <SettingsRow label="Recipient email" description="Where to send the daily list PDF.">
              <SettingsRowValue>
                <Input
                  type="email"
                  value={dlEmail}
                  onChange={(e) => setDlEmail(e.target.value)}
                  className="h-8 w-72"
                  placeholder="kitchen@vendor.example"
                  aria-label="Daily list recipient email"
                />
              </SettingsRowValue>
            </SettingsRow>
            <SettingsRow label="Language">
              <SettingsRowValue>
                <Select value={language ?? 'nl'} onValueChange={(v) => handleLanguageChange(v as 'nl' | 'fr' | 'en' | 'de')}>
                  <SelectTrigger className="h-8 w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="nl">Nederlands</SelectItem>
                    <SelectItem value="fr">Français</SelectItem>
                    <SelectItem value="en">English</SelectItem>
                    <SelectItem value="de">Deutsch</SelectItem>
                  </SelectContent>
                </Select>
              </SettingsRowValue>
            </SettingsRow>
            <SettingsRow
              label="Cutoff strategy"
              description="When to send the list each day."
            >
              <SettingsRowValue>
                <div className="flex items-center gap-2">
                  <Select value={cutoffStrategy} onValueChange={(v) => handleCutoffStrategyChange(v as 'offset' | 'clock')}>
                    <SelectTrigger className="h-8 w-56">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="offset">N hours before earliest delivery</SelectItem>
                      <SelectItem value="clock">Daily at fixed clock time</SelectItem>
                    </SelectContent>
                  </Select>
                  {cutoffStrategy === 'offset' ? (
                    <Input
                      type="number"
                      value={offsetMinutes}
                      onChange={(e) => setOffsetMinutes(e.target.value)}
                      className="h-8 w-20"
                      min={30}
                      max={1440}
                      step={30}
                      aria-label="Cutoff offset minutes"
                    />
                  ) : (
                    <Input
                      type="time"
                      value={clockTime}
                      onChange={(e) => setClockTime(e.target.value)}
                      className="h-8 w-28"
                      aria-label="Cutoff clock time"
                    />
                  )}
                  <span className="text-xs text-muted-foreground">
                    {cutoffStrategy === 'offset' ? 'min before earliest delivery' : 'NL local'}
                  </span>
                </div>
              </SettingsRowValue>
            </SettingsRow>
          </SettingsGroup>

          <DailyListHistorySection vendor={vendor} />
        </>
      ) : null}
    </>
  );
}

// =====================================================================
// History + actions
// =====================================================================

function DailyListHistorySection({ vendor }: { vendor: Vendor }) {
  const { data: history, isLoading } = useDailyListHistory(vendor.id);
  const [previewOpen, setPreviewOpen] = useState(false);
  const regenerate = useDailyListRegenerate();

  return (
    <SettingsGroup
      title="Daily list history"
      description="Last 30 days. Each row is one (date, building, service-type, version) bucket."
    >
      <SettingsRow label="Preview today's list" description="Assemble what would be sent at the next cutoff. Read-only.">
        <SettingsRowValue>
          <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
            <Eye className="size-3.5" />
            Preview
          </Button>
        </SettingsRowValue>
      </SettingsRow>

      <SettingsRow
        label="Regenerate now"
        description="Mints a new version (v_n+1) and emails it. Use after late changes."
      >
        <SettingsRowValue>
          <Button
            variant="outline"
            size="sm"
            disabled={regenerate.isPending}
            onClick={() => {
              const today = new Date().toISOString().slice(0, 10);
              regenerate.mutate(
                {
                  vendorId: vendor.id,
                  listDate: today,
                  buildingId: null,
                  serviceType: 'catering',
                },
                {
                  onSuccess: (r) => {
                    if (r.send.status === 'sent') {
                      toastSuccess(`v${r.row.version} sent to ${r.row.recipient_email ?? 'vendor'}`);
                    } else if (r.send.status === 'lease_revoked') {
                      toastSuccess(`v${r.row.version} sent (deduped by another worker)`);
                    } else {
                      toastSuccess(`v${r.row.version} ${r.send.status.replace(/_/g, ' ')}`);
                    }
                  },
                  onError: (err) => {
                    /* `list_cancelled` code is the empty-bucket short-circuit;
                       toast a less-alarming message. */
                    const msg = err instanceof Error ? err.message : String(err);
                    if (/list_cancelled/.test(msg)) {
                      toastSuccess('No live lines for this bucket — nothing to send.');
                    } else {
                      toastError("Couldn't regenerate", { error: err });
                    }
                  },
                },
              );
            }}
          >
            <RefreshCw className={regenerate.isPending ? 'size-3.5 animate-spin' : 'size-3.5'} />
            Regenerate v{(history?.[0]?.version ?? 0) + 1}
          </Button>
        </SettingsRowValue>
      </SettingsRow>

      <div className="px-4 py-3">
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading history…</p>
        ) : history && history.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Building</TableHead>
                <TableHead>Service</TableHead>
                <TableHead className="text-right">Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((row) => (
                <HistoryRow key={row.id} row={row} vendorId={vendor.id} />
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-xs text-muted-foreground">
            No daily lists generated yet. The scheduler will create one at the next cutoff.
          </p>
        )}
      </div>

      <PreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        vendor={vendor}
      />
    </SettingsGroup>
  );
}

function HistoryRow({ row, vendorId }: { row: DailyListHistoryItem; vendorId: string }) {
  const resend = useDailyListResend();
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const r = await apiFetch<{ url: string; expiresAt: string }>(
        `/admin/vendors/${vendorId}/daily-list/${row.id}/download`,
      );
      window.open(r.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      toastError("Couldn't download PDF", { error: err });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <TableRow>
      <TableCell className="font-medium tabular-nums">{row.list_date}</TableCell>
      <TableCell>{row.building_name ?? <span className="text-muted-foreground">All</span>}</TableCell>
      <TableCell className="capitalize">{row.service_type.replace(/_/g, ' ')}</TableCell>
      <TableCell className="text-right tabular-nums">v{row.version}</TableCell>
      <TableCell>
        <StatusBadge status={row.email_status} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {row.sent_at ? (
          <time
            dateTime={row.sent_at}
            title={formatFullTimestamp(row.sent_at)}
          >
            {formatRelativeTime(row.sent_at)}
          </time>
        ) : '—'}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {row.total_lines ?? '—'}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDownload}
            disabled={downloading}
            aria-label="Download PDF"
          >
            <Download className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={resend.isPending}
            onClick={() =>
              resend.mutate(
                { vendorId, daglijstId: row.id, force: true },
                {
                  onSuccess: () => toastSuccess('Resent'),
                  onError: (err) => toastError("Couldn't resend", { error: err }),
                },
              )
            }
            aria-label="Resend"
          >
            <Send className="size-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function StatusBadge({ status }: { status: DailyListHistoryItem['email_status'] }) {
  const variant = useMemo<'default' | 'outline' | 'secondary' | 'destructive'>(() => {
    if (status === 'sent' || status === 'delivered') return 'default';
    if (status === 'failed' || status === 'bounced') return 'destructive';
    if (status === 'sending' || status === 'queued') return 'secondary';
    return 'outline';
  }, [status]);
  return (
    <Badge variant={variant} className="text-[10px] uppercase tracking-wider">
      {status?.replace(/_/g, ' ') ?? '—'}
    </Badge>
  );
}

function PreviewDialog({
  open,
  onOpenChange,
  vendor,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  vendor: Vendor;
}) {
  const preview = useDailyListPreview();
  const [listDate, setListDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [serviceType, setServiceType] = useState<ServiceType>('catering');
  const [payload, setPayload] = useState<DailyListPayload | null>(null);

  useEffect(() => {
    if (!open) {
      setPayload(null);
      return;
    }
    preview.mutate(
      { vendorId: vendor.id, listDate, buildingId: null, serviceType },
      {
        onSuccess: setPayload,
        onError: (err) => toastError("Couldn't preview", { error: err }),
      },
    );
  }, [open, listDate, serviceType, vendor.id]);  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Preview daily list — {vendor.name}</DialogTitle>
          <DialogDescription>
            Read-only assembly of what would be sent. Nothing is recorded.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="preview-date">Date</FieldLabel>
            <Input
              id="preview-date"
              type="date"
              value={listDate}
              onChange={(e) => setListDate(e.target.value)}
              className="h-8 w-44"
            />
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="preview-service">Service</FieldLabel>
            <Select value={serviceType} onValueChange={(v) => v && setServiceType(v as ServiceType)}>
              <SelectTrigger id="preview-service" className="h-8 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="catering">Catering</SelectItem>
                <SelectItem value="av_equipment">AV equipment</SelectItem>
                <SelectItem value="supplies">Supplies</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <FieldDescription>
            Empty bucket = "no orders to print" (nothing sent at the cutoff).
          </FieldDescription>
        </FieldGroup>

        {preview.isPending ? (
          <p className="text-xs text-muted-foreground py-4 text-center">Assembling…</p>
        ) : payload ? (
          <div className="rounded-lg border bg-muted/40 px-3 py-2 max-h-80 overflow-auto">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium">
                {payload.list_date} · {payload.total_lines} lines · {payload.total_quantity} units
              </span>
              <FileText className="size-3.5 text-muted-foreground" />
            </div>
            <ul className="space-y-1 text-xs">
              {payload.lines.length === 0 ? (
                <li className="text-muted-foreground italic">No live lines for this bucket.</li>
              ) : (
                payload.lines.map((line) => (
                  <li key={line.line_id} className="flex justify-between gap-3">
                    <span className="truncate">
                      <span className="font-medium tabular-nums">{line.quantity}× </span>
                      {line.catalog_item_name}
                      {line.delivery_location_name ? (
                        <span className="text-muted-foreground"> · {line.delivery_location_name}</span>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {line.delivery_time ?? '—'}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
