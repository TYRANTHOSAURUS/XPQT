import { Link } from 'react-router-dom';
import { Mail } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatFullTimestamp, formatRelativeTime } from '@/lib/format';
import {
  KNOWN_EVENT_KINDS,
  useNotificationTemplates,
  type TemplateOverrideRow,
} from '@/api/notification-templates';

/**
 * Admin → Email templates index.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step G.
 *
 * Lists every event_kind the app knows how to send a notification for, with
 * EN + NL "Default / Customized" status. Click a row → per-event editor.
 *
 * Width: `default` (640px). The list is short — one row per event kind —
 * and Linear-style narrow column reads better than a sparse wide table.
 *
 * Empty-state copy stays product-honest: there ARE event kinds (the
 * KNOWN_EVENT_KINDS registry) — what may be empty is the override set.
 * The `data` array is the OVERRIDE rows; an empty array means every kind
 * shows "Default" status.
 */
export function NotificationTemplatesPage() {
  const { data: overrides, isLoading } = useNotificationTemplates();

  return (
    <SettingsPageShell width="default">
      <SettingsPageHeader
        backTo="/admin"
        title="Email templates"
        description="Tweak the subject line, button text, and intro paragraph for each notification. Defaults ship per locale — overrides apply only to the selected language."
      />

      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {!isLoading && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead className="w-[110px]">English</TableHead>
              <TableHead className="w-[110px]">Dutch</TableHead>
              <TableHead className="w-[160px]">Last updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {KNOWN_EVENT_KINDS.map((kind) => {
              const en = (overrides ?? []).find(
                (r) => r.event_kind === kind.kind && r.locale === 'en',
              );
              const nl = (overrides ?? []).find(
                (r) => r.event_kind === kind.kind && r.locale === 'nl',
              );
              const latest = pickLatest([en, nl]);

              return (
                <TableRow key={kind.kind}>
                  <TableCell className="font-medium">
                    <Link
                      to={`/admin/notification-templates/${encodeURIComponent(kind.kind)}`}
                      className="hover:underline underline-offset-2"
                    >
                      {kind.label}
                    </Link>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {kind.description}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge row={en ?? null} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge row={nl ?? null} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {latest ? (
                      <time
                        dateTime={latest.updated_at}
                        title={formatFullTimestamp(latest.updated_at)}
                      >
                        {formatRelativeTime(latest.updated_at)}
                      </time>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </SettingsPageShell>
  );
}

/**
 * "Customized" only when the row exists AND at least one override field
 * is non-null. A row with all-null fields = admin reviewed defaults but
 * didn't override anything → Default badge.
 */
function StatusBadge({ row }: { row: TemplateOverrideRow | null }) {
  const customized =
    !!row &&
    (!!row.subject_override ||
      !!row.cta_text_override ||
      !!row.body_intro_override);
  if (customized) {
    return <Badge variant="default">Customized</Badge>;
  }
  return (
    <Badge variant="secondary" className="gap-1">
      <Mail className="size-3" />
      Default
    </Badge>
  );
}

function pickLatest(rows: Array<TemplateOverrideRow | undefined>): TemplateOverrideRow | null {
  let latest: TemplateOverrideRow | null = null;
  for (const r of rows) {
    if (!r) continue;
    if (!latest || r.updated_at > latest.updated_at) latest = r;
  }
  return latest;
}
