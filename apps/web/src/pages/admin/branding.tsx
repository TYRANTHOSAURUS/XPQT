import { useEffect, useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
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

// Defaults match the baked-in light/dark surface tokens in apps/web/src/index.css.
// When the admin clicks "Customize" on a null field, the picker seeds with these
// so they have a sensible starting point to nudge from.
const DEFAULT_BG_LIGHT = '#ffffff';
const DEFAULT_BG_DARK = '#1a1a1f';
const DEFAULT_SB_LIGHT = '#fafafa';
const DEFAULT_SB_DARK = '#1e1e24';

function SurfaceColorField({
  id,
  label,
  seed,
  value,
  onChange,
  onReset,
}: {
  id: string;
  label: string;
  seed: string;
  value: string | null;
  onChange: (next: string) => void;
  onReset: () => void;
}) {
  const hexValid = value === null ? true : HEX_RE.test(value);

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {value === null ? (
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center px-2 py-1 rounded-md text-xs bg-muted text-muted-foreground">
            Default
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(seed)}
          >
            Customize
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <input
            id={`${id}-picker`}
            type="color"
            value={hexValid ? value : '#000000'}
            onChange={(e) => onChange(e.target.value)}
            className="w-10 h-10 rounded border cursor-pointer shrink-0"
            aria-label={`${label} color picker`}
          />
          <Input
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-32 font-mono"
            aria-invalid={!hexValid}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onReset}
          >
            Use default
          </Button>
        </div>
      )}
    </Field>
  );
}

export function BrandingPage() {
  const { branding, loading, updateBranding, uploadLogo, removeLogo } = useBranding();

  const [primary, setPrimary] = useState(branding.primary_color);
  const [accent, setAccent] = useState(branding.accent_color);
  const [mode, setMode] = useState<Branding['theme_mode_default']>(branding.theme_mode_default);
  const [bgLight, setBgLight] = useState<string | null>(branding.background_light);
  const [bgDark,  setBgDark]  = useState<string | null>(branding.background_dark);
  const [sbLight, setSbLight] = useState<string | null>(branding.sidebar_light);
  const [sbDark,  setSbDark]  = useState<string | null>(branding.sidebar_dark);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPrimary(branding.primary_color);
    setAccent(branding.accent_color);
    setMode(branding.theme_mode_default);
    setBgLight(branding.background_light);
    setBgDark(branding.background_dark);
    setSbLight(branding.sidebar_light);
    setSbDark(branding.sidebar_dark);
  }, [
    branding.primary_color,
    branding.accent_color,
    branding.theme_mode_default,
    branding.background_light,
    branding.background_dark,
    branding.sidebar_light,
    branding.sidebar_dark,
  ]);

  const surfaceEqual = (local: string | null, server: string | null) =>
    (local?.toLowerCase() ?? null) === (server?.toLowerCase() ?? null);

  const dirty =
    primary.toLowerCase() !== branding.primary_color.toLowerCase() ||
    accent.toLowerCase() !== branding.accent_color.toLowerCase() ||
    mode !== branding.theme_mode_default ||
    !surfaceEqual(bgLight, branding.background_light) ||
    !surfaceEqual(bgDark,  branding.background_dark) ||
    !surfaceEqual(sbLight, branding.sidebar_light) ||
    !surfaceEqual(sbDark,  branding.sidebar_dark);

  const surfaceValid = (v: string | null) => v === null || HEX_RE.test(v);

  const canSave =
    dirty &&
    HEX_RE.test(primary) &&
    HEX_RE.test(accent) &&
    surfaceValid(bgLight) &&
    surfaceValid(bgDark) &&
    surfaceValid(sbLight) &&
    surfaceValid(sbDark) &&
    !saving;

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateBranding({
        primary_color: primary.toLowerCase(),
        accent_color:  accent.toLowerCase(),
        theme_mode_default: mode,
        background_light: bgLight?.toLowerCase() ?? null,
        background_dark:  bgDark?.toLowerCase()  ?? null,
        sidebar_light:    sbLight?.toLowerCase() ?? null,
        sidebar_dark:     sbDark?.toLowerCase()  ?? null,
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
    setBgLight(branding.background_light);
    setBgDark(branding.background_dark);
    setSbLight(branding.sidebar_light);
    setSbDark(branding.sidebar_dark);
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
        title="Surfaces"
        description="Optionally override the page background and sidepanel colors per theme mode. Foreground, border, and hover tones are derived automatically."
      >
        <FieldGroup>
          <FieldSet>
            <FieldLegend>Page background</FieldLegend>
            <FieldDescription>The main canvas color behind content.</FieldDescription>
            <FieldGroup>
              <SurfaceColorField
                id="bg-light"
                label="Light mode"
                seed={DEFAULT_BG_LIGHT}
                value={bgLight}
                onChange={setBgLight}
                onReset={() => setBgLight(null)}
              />
              <SurfaceColorField
                id="bg-dark"
                label="Dark mode"
                seed={DEFAULT_BG_DARK}
                value={bgDark}
                onChange={setBgDark}
                onReset={() => setBgDark(null)}
              />
            </FieldGroup>
          </FieldSet>
          <FieldSeparator />
          <FieldSet>
            <FieldLegend>Sidepanel</FieldLegend>
            <FieldDescription>The left navigation surface.</FieldDescription>
            <FieldGroup>
              <SurfaceColorField
                id="sb-light"
                label="Light mode"
                seed={DEFAULT_SB_LIGHT}
                value={sbLight}
                onChange={setSbLight}
                onReset={() => setSbLight(null)}
              />
              <SurfaceColorField
                id="sb-dark"
                label="Dark mode"
                seed={DEFAULT_SB_DARK}
                value={sbDark}
                onChange={setSbDark}
                onReset={() => setSbDark(null)}
              />
            </FieldGroup>
          </FieldSet>
        </FieldGroup>
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
