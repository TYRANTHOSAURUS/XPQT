import { useEffect, useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  SettingsPageShell,
  SettingsPageHeader,
  SettingsSection,
  SettingsFooterActions,
} from '@/components/ui/settings-page';
import { useBranding, type Branding } from '@/hooks/use-branding';
import { toast } from 'sonner';

type LogoKind = 'light' | 'dark' | 'favicon';

const HEX_RE = /^#[0-9a-f]{6}$/i;

function LogoSlot({
  kind,
  label,
  hint,
  url,
  onUpload,
  onRemove,
  accept,
}: {
  kind: LogoKind;
  label: string;
  hint: string;
  url: string | null;
  onUpload: (file: File) => Promise<void>;
  onRemove: () => Promise<void>;
  accept: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const handlePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      await onUpload(file);
      toast.success(`${label} uploaded`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    try {
      await onRemove();
      toast.success(`${label} removed`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Remove failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-4 py-3 border-b last:border-b-0">
      <div className="w-24 h-16 bg-muted rounded flex items-center justify-center overflow-hidden shrink-0">
        {url ? (
          <img src={url} alt={label} className="max-w-full max-h-full object-contain" />
        ) : (
          <span className="text-xs text-muted-foreground">No {kind}</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">{label}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handlePick}
        className="hidden"
      />
      <Button variant="outline" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
        Upload
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy || !url}
        onClick={handleRemove}
        aria-label={`Remove ${label}`}
      >
        Remove
      </Button>
    </div>
  );
}

export function BrandingPage() {
  const { branding, loading, updateBranding, uploadLogo, removeLogo } = useBranding();

  const [primary, setPrimary] = useState(branding.primary_color);
  const [accent, setAccent] = useState(branding.accent_color);
  const [mode, setMode] = useState<Branding['theme_mode_default']>(branding.theme_mode_default);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPrimary(branding.primary_color);
    setAccent(branding.accent_color);
    setMode(branding.theme_mode_default);
  }, [branding.primary_color, branding.accent_color, branding.theme_mode_default]);

  const dirty =
    primary.toLowerCase() !== branding.primary_color.toLowerCase() ||
    accent.toLowerCase() !== branding.accent_color.toLowerCase() ||
    mode !== branding.theme_mode_default;

  const canSave = dirty && HEX_RE.test(primary) && HEX_RE.test(accent) && !saving;

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateBranding({
        primary_color: primary.toLowerCase(),
        accent_color: accent.toLowerCase(),
        theme_mode_default: mode,
      });
      toast.success('Branding saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setPrimary(branding.primary_color);
    setAccent(branding.accent_color);
    setMode(branding.theme_mode_default);
  };

  if (loading && !branding.primary_color) {
    return (
      <SettingsPageShell>
        <SettingsPageHeader title="Branding" description="Loading…" />
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        title="Branding"
        description="Logos, colors, and the default theme mode for your workspace."
      />

      <SettingsSection
        title="Logo assets"
        description="SVG, PNG, or WebP up to 1 MB. Favicon: SVG, PNG, or ICO up to 256 KB."
        density="tight"
      >
        <LogoSlot
          kind="light"
          label="Light mode logo"
          hint="Shown on light backgrounds (sidebar, login page)"
          url={branding.logo_light_url}
          onUpload={(f) => uploadLogo('light', f)}
          onRemove={() => removeLogo('light')}
          accept="image/svg+xml,image/png,image/webp"
        />
        <LogoSlot
          kind="dark"
          label="Dark mode logo"
          hint="Shown on dark backgrounds"
          url={branding.logo_dark_url}
          onUpload={(f) => uploadLogo('dark', f)}
          onRemove={() => removeLogo('dark')}
          accept="image/svg+xml,image/png,image/webp"
        />
        <LogoSlot
          kind="favicon"
          label="Favicon"
          hint="Shown in the browser tab (32×32 recommended)"
          url={branding.favicon_url}
          onUpload={(f) => uploadLogo('favicon', f)}
          onRemove={() => removeLogo('favicon')}
          accept="image/svg+xml,image/png,image/x-icon"
        />
      </SettingsSection>

      <SettingsSection
        title="Colors"
        description="Changes take effect on save and apply across the app."
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="primary-color">Primary</FieldLabel>
            <div className="flex items-center gap-3">
              <input
                id="primary-color-picker"
                type="color"
                value={HEX_RE.test(primary) ? primary : '#000000'}
                onChange={(e) => setPrimary(e.target.value)}
                className="w-10 h-10 rounded border cursor-pointer shrink-0"
                aria-label="Primary color picker"
              />
              <Input
                id="primary-color"
                value={primary}
                onChange={(e) => setPrimary(e.target.value)}
                className="w-32 font-mono"
                aria-invalid={!HEX_RE.test(primary)}
              />
            </div>
            <FieldDescription>The main brand color used for primary buttons and accents.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="accent-color">Accent</FieldLabel>
            <div className="flex items-center gap-3">
              <input
                id="accent-color-picker"
                type="color"
                value={HEX_RE.test(accent) ? accent : '#000000'}
                onChange={(e) => setAccent(e.target.value)}
                className="w-10 h-10 rounded border cursor-pointer shrink-0"
                aria-label="Accent color picker"
              />
              <Input
                id="accent-color"
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
                className="w-32 font-mono"
                aria-invalid={!HEX_RE.test(accent)}
              />
            </div>
            <FieldDescription>Used for badges and secondary highlights.</FieldDescription>
          </Field>
        </FieldGroup>
        <div className="rounded border bg-muted/30 p-4 flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted-foreground mr-2">Preview (saved values):</span>
          <Button size="sm">Primary button</Button>
          <Button size="sm" variant="secondary">Secondary</Button>
          <span
            className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
            style={{ backgroundColor: branding.accent_color, color: '#fff' }}
          >
            Accent
          </span>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Default theme mode"
        description="Each user can override their own preference."
      >
        <RadioGroup
          value={mode}
          onValueChange={(v) => setMode(v as Branding['theme_mode_default'])}
          className="flex flex-col gap-2"
        >
          <Field orientation="horizontal">
            <RadioGroupItem value="light" id="mode-light" />
            <FieldLabel className="font-normal" htmlFor="mode-light">Light</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem value="dark" id="mode-dark" />
            <FieldLabel className="font-normal" htmlFor="mode-dark">Dark</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem value="system" id="mode-system" />
            <FieldLabel className="font-normal" htmlFor="mode-system">System (follow user OS)</FieldLabel>
          </Field>
        </RadioGroup>
      </SettingsSection>

      <SettingsFooterActions
        primary={{
          label: 'Save changes',
          onClick: handleSave,
          loading: saving,
          disabled: !canSave,
        }}
        secondary={{
          label: 'Discard',
          onClick: handleDiscard,
          disabled: !dirty || saving,
        }}
      />
    </SettingsPageShell>
  );
}
