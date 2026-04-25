import { useMemo, useState } from 'react';
import { History, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { cn } from '@/lib/utils';
import {
  useRestoreRoomBookingRuleVersion,
  useRoomBookingRuleVersions,
  type ChangeType,
  type RuleVersion,
} from '@/api/room-booking-rules';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';

interface RuleVersionHistoryProps {
  ruleId: string;
}

const CHANGE_LABEL: Record<ChangeType, string> = {
  create: 'Created',
  update: 'Updated',
  enable: 'Enabled',
  disable: 'Disabled',
  delete: 'Deleted',
};

/**
 * Versioned change feed for a rule. Each entry shows what fields changed
 * (best-effort diff render) and a "Restore" action that brings that version
 * back as the live version.
 */
export function RuleVersionHistory({ ruleId }: RuleVersionHistoryProps) {
  const { data, isLoading } = useRoomBookingRuleVersions(ruleId);
  const versions = useMemo(() => [...(data ?? [])].sort((a, b) => b.version_number - a.version_number), [data]);

  if (isLoading) {
    return <div className="text-xs text-muted-foreground">Loading history…</div>;
  }

  if (versions.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <History className="size-3.5" />
        No history yet.
      </div>
    );
  }

  return (
    <ul className="flex flex-col rounded-md border bg-card overflow-hidden divide-y">
      {versions.map((v, i) => (
        <VersionRow key={v.id} version={v} ruleId={ruleId} isLatest={i === 0} />
      ))}
    </ul>
  );
}

function VersionRow({
  version,
  ruleId,
  isLatest,
}: {
  version: RuleVersion;
  ruleId: string;
  isLatest: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const restore = useRestoreRoomBookingRuleVersion(ruleId);

  const diffEntries = useMemo(() => Object.entries(version.diff ?? {}), [version.diff]);

  return (
    <li className="flex flex-col">
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          className="flex flex-1 items-center gap-2 text-left"
          onClick={() => setOpen((p) => !p)}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <div className="flex flex-col">
            <span className="text-sm font-medium">
              v{version.version_number} · {CHANGE_LABEL[version.change_type] ?? version.change_type}
              {isLatest && (
                <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-[10px]">
                  current
                </Badge>
              )}
            </span>
            <span className="text-xs text-muted-foreground">
              <time dateTime={version.actor_at} title={formatFullTimestamp(version.actor_at)}>
                {formatRelativeTime(version.actor_at)}
              </time>
              {diffEntries.length > 0 && (
                <span className="ml-2">· {diffEntries.length} field{diffEntries.length === 1 ? '' : 's'} changed</span>
              )}
            </span>
          </div>
        </button>
        {!isLatest && (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => setRestoreOpen(true)}
          >
            <RotateCcw className="size-3.5" /> Restore
          </Button>
        )}
      </div>

      {open && diffEntries.length > 0 && (
        <div className="border-t bg-muted/20 px-3 py-2 text-xs">
          <ul className="flex flex-col gap-1.5">
            {diffEntries.map(([field, change]) => (
              <li key={field} className="flex flex-col gap-0.5">
                <span className="font-medium">{field}</span>
                <DiffBlock label="before" value={change.before} />
                <DiffBlock label="after" value={change.after} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
        title={`Restore v${version.version_number}?`}
        description="The current configuration will become a new version, then this older one is restored. You can revert again at any time."
        confirmLabel="Restore"
        onConfirm={async () => {
          try {
            await restore.mutateAsync(version.version_number);
            toast.success(`Restored v${version.version_number}`);
          } catch (err) {
            toast.error((err as Error).message || 'Restore failed');
            throw err;
          }
        }}
      />
    </li>
  );
}

function DiffBlock({ label, value }: { label: 'before' | 'after'; value: unknown }) {
  return (
    <div className="flex items-start gap-2">
      <span
        className={cn(
          'mt-0.5 inline-block w-12 shrink-0 text-[10px] font-medium uppercase',
          label === 'before' ? 'text-red-600/80' : 'text-emerald-600/80',
        )}
      >
        {label}
      </span>
      <code className="chip flex-1 break-all rounded-sm bg-background px-1.5 py-0.5">
        {formatDiffValue(value)}
      </code>
    </div>
  );
}

function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
