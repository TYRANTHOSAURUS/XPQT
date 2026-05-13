import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import { toastSaved } from '@/lib/toast';
import {
  KNOWN_EVENT_KINDS,
  useNotificationTemplate,
  useUpsertNotificationTemplate,
  type TemplateDetailResponse,
  type TemplateLocale,
  type TemplateOverrideRow,
} from '@/api/notification-templates';

/**
 * Admin → Email templates → :eventKind editor.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step G.
 *
 * Layout:
 *   - SettingsPageShell width="xwide" (per CLAUDE.md width enum — the page
 *     hosts EN + NL tabs side-by-side, each with three text fields and
 *     descriptions; default 640px columns it).
 *   - Top: SettingsPageHeader (back to /admin/notification-templates).
 *   - Body: shadcn Tabs ("English" | "Dutch"). Each tab renders a Field-based
 *     form per CLAUDE.md §Form composition (FieldGroup + Field + FieldLabel
 *     + Input/Textarea + FieldDescription).
 *   - Auto-save per field via useDebouncedSave (default 500ms debounce —
 *     identical to the webhook detail editor and other admin auto-save
 *     pages). Toast: `toastSaved('Template', { silent: true })` so the
 *     success path stays quiet — error path still toasts via
 *     withErrorHandling on the mutation hook.
 *   - "Reset" buttons clear individual fields back to default.
 *
 * Live preview pane: DEFERRED (see followup note in the Pull Request
 * description and `docs/follow-ups/b4a5-followups.md`). Real React Email
 * render in the browser bundles a non-trivial server-renderer; ship the
 * editor first and add preview as a follow-up.
 *
 * Save semantics:
 *   - Each per-field debounced save sends the FULL set of three fields
 *     for the locale (subject + cta + body_intro). The backend upsert
 *     overwrites every column it receives, so missing keys would clear
 *     unrelated fields. The auto-save closure captures the latest local
 *     draft for all three so unchanged fields stay intact.
 *   - Reset = same path with the field set to null (the controller
 *     accepts null explicitly).
 */
export function NotificationTemplateDetailPage() {
  const params = useParams<{ eventKind: string }>();
  const eventKind = params.eventKind ?? '';
  const knownKind = useMemo(
    () => KNOWN_EVENT_KINDS.find((k) => k.kind === eventKind),
    [eventKind],
  );
  const { data, isLoading } = useNotificationTemplate(eventKind);
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader
          backTo="/admin/notification-templates"
          title="Loading…"
        />
      </SettingsPageShell>
    );
  }

  if (!knownKind) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader
          backTo="/admin/notification-templates"
          title="Unknown event"
          description="This notification kind isn't registered in the editor."
          actions={
            <Button
              variant="outline"
              onClick={() => navigate('/admin/notification-templates')}
            >
              Back to templates
            </Button>
          }
        />
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/admin/notification-templates"
        title={knownKind.label}
        description={knownKind.description}
      />
      <DetailBody eventKind={eventKind} response={data} />
    </SettingsPageShell>
  );
}

function DetailBody({
  eventKind,
  response,
}: {
  eventKind: string;
  response: TemplateDetailResponse | undefined;
}) {
  // Two-column scaffold: left = editor, right = reserved for live preview
  // (deferred per b4a5-followups.md). Keeps the editor at a comfortable
  // 640px max even though the shell is xwide, so the form doesn't look
  // stretched today AND the preview pane drops in cleanly later.
  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Tabs defaultValue="en" className="w-full max-w-[640px]">
        <TabsList>
          <TabsTrigger value="en">English</TabsTrigger>
          <TabsTrigger value="nl">Dutch</TabsTrigger>
        </TabsList>
        <TabsContent value="en" className="pt-4">
          <LocaleEditor eventKind={eventKind} locale="en" row={response?.en ?? null} />
        </TabsContent>
        <TabsContent value="nl" className="pt-4">
          <LocaleEditor eventKind={eventKind} locale="nl" row={response?.nl ?? null} />
        </TabsContent>
      </Tabs>
      <aside className="hidden lg:flex flex-col gap-2 rounded-md border border-dashed bg-muted/30 p-6 text-sm text-muted-foreground">
        <div className="font-medium text-foreground">Live preview</div>
        <p>
          A rendered preview of the email body with your overrides applied
          will appear here in a future update.
        </p>
      </aside>
    </div>
  );
}

interface LocaleEditorProps {
  eventKind: string;
  locale: TemplateLocale;
  row: TemplateOverrideRow | null;
}

function LocaleEditor({ eventKind, locale, row }: LocaleEditorProps) {
  // Local draft state — initialized from the server row, kept in sync via
  // a `useEffect` on row changes (mutation invalidate refetches the row).
  const [subject, setSubject] = useState(row?.subject_override ?? '');
  const [ctaText, setCtaText] = useState(row?.cta_text_override ?? '');
  const [bodyIntro, setBodyIntro] = useState(row?.body_intro_override ?? '');

  useEffect(() => {
    setSubject(row?.subject_override ?? '');
    setCtaText(row?.cta_text_override ?? '');
    setBodyIntro(row?.body_intro_override ?? '');
  }, [row]);

  const upsert = useUpsertNotificationTemplate(eventKind);

  // Per-field debounced save. The save closure captures the LATEST values
  // for all three fields so the unchanged ones stay intact when one
  // changes (the backend's upsert overwrites every column it receives).
  // Empty strings are normalized to null server-side; we send the literal
  // value the admin typed and let the server clean it.
  const persist = (override: Partial<{ subject: string; cta: string; body: string }>) => {
    const subj = override.subject ?? subject;
    const cta = override.cta ?? ctaText;
    const body = override.body ?? bodyIntro;
    upsert.mutate(
      {
        locale,
        subject_override: subj,
        cta_text_override: cta,
        body_intro_override: body,
      },
      {
        onSuccess: () => toastSaved('Template', { silent: true }),
      },
    );
  };

  // Each useDebouncedSave fires after 500ms of no input. Skips the initial
  // mount so opening the page doesn't immediately PUT.
  useDebouncedSave(subject, (next) => {
    if (next === (row?.subject_override ?? '')) return;
    persist({ subject: next });
  });
  useDebouncedSave(ctaText, (next) => {
    if (next === (row?.cta_text_override ?? '')) return;
    persist({ cta: next });
  });
  useDebouncedSave(bodyIntro, (next) => {
    if (next === (row?.body_intro_override ?? '')) return;
    persist({ body: next });
  });

  const reset = (field: 'subject' | 'cta' | 'body') => {
    if (field === 'subject') setSubject('');
    if (field === 'cta') setCtaText('');
    if (field === 'body') setBodyIntro('');
    // Send null explicitly so the server clears the override.
    const next = {
      locale,
      subject_override: field === 'subject' ? null : subject,
      cta_text_override: field === 'cta' ? null : ctaText,
      body_intro_override: field === 'body' ? null : bodyIntro,
    };
    upsert.mutate(next, {
      onSuccess: () => toastSaved('Template', { silent: true }),
    });
  };

  const idPrefix = `tmpl-${locale}`;

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-subject`}>Subject line</FieldLabel>
        <Input
          id={`${idPrefix}-subject`}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Use the default subject"
          maxLength={200}
        />
        <FieldDescription className="flex items-center justify-between gap-2">
          <span>
            Replaces the email subject for this kind. Leave blank to use the
            default copy.
          </span>
          {row?.subject_override && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs shrink-0"
              onClick={() => reset('subject')}
              disabled={upsert.isPending}
            >
              Reset
            </Button>
          )}
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor={`${idPrefix}-cta`}>Call-to-action button</FieldLabel>
        <Input
          id={`${idPrefix}-cta`}
          value={ctaText}
          onChange={(e) => setCtaText(e.target.value)}
          placeholder="Use the default CTA label"
          maxLength={50}
          className="max-w-[320px]"
        />
        <FieldDescription className="flex items-center justify-between gap-2">
          <span>
            Text on the primary action button. Defaults: "Review request" /
            "Verzoek bekijken".
          </span>
          {row?.cta_text_override && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs shrink-0"
              onClick={() => reset('cta')}
              disabled={upsert.isPending}
            >
              Reset
            </Button>
          )}
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor={`${idPrefix}-body`}>Intro paragraph</FieldLabel>
        <Textarea
          id={`${idPrefix}-body`}
          value={bodyIntro}
          onChange={(e) => setBodyIntro(e.target.value)}
          placeholder="Use the default intro copy"
          rows={4}
        />
        <FieldDescription className="flex items-center justify-between gap-2">
          <span>
            Replaces the leading sentence inside the email body. Keep it short —
            the booking detail still renders below.
          </span>
          {row?.body_intro_override && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs shrink-0"
              onClick={() => reset('body')}
              disabled={upsert.isPending}
            >
              Reset
            </Button>
          )}
        </FieldDescription>
      </Field>
    </FieldGroup>
  );
}
