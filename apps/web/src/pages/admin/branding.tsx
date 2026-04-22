import { useEffect, useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
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

  if (loading && !branding.primary_color) {
    return <div className="p-6 text-muted-foreground">Loading branding…</div>;
  }

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>Logo assets</CardTitle>
          <CardDescription>
            SVG, PNG, or WebP up to 1 MB. Favicon: SVG, PNG, or ICO up to 256 KB.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Colors</CardTitle>
          <CardDescription>Changes take effect on save and apply across the app.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Label htmlFor="primary-color" className="w-28 shrink-0">Primary</Label>
            <input
              id="primary-color-picker"
              type="color"
              value={HEX_RE.test(primary) ? primary : '#000000'}
              onChange={(e) => setPrimary(e.target.value)}
              className="w-10 h-10 rounded border cursor-pointer"
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
          <div className="flex items-center gap-3">
            <Label htmlFor="accent-color" className="w-28 shrink-0">Accent</Label>
            <input
              id="accent-color-picker"
              type="color"
              value={HEX_RE.test(accent) ? accent : '#000000'}
              onChange={(e) => setAccent(e.target.value)}
              className="w-10 h-10 rounded border cursor-pointer"
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
          <div className="rounded border p-4 flex flex-wrap items-center gap-3">
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Default theme mode</CardTitle>
          <CardDescription>Each user can override their own preference.</CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as Branding['theme_mode_default'])}
            className="flex gap-6"
          >
            <label className="flex items-center gap-2 cursor-pointer">
              <RadioGroupItem value="light" id="mode-light" />
              <span>Light</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <RadioGroupItem value="dark" id="mode-dark" />
              <span>Dark</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <RadioGroupItem value="system" id="mode-system" />
              <span>System</span>
            </label>
          </RadioGroup>
        </CardContent>
      </Card>

      <div className="sticky bottom-0 bg-background py-3 border-t flex justify-end gap-3">
        <Button
          variant="ghost"
          disabled={!dirty || saving}
          onClick={() => {
            setPrimary(branding.primary_color);
            setAccent(branding.accent_color);
            setMode(branding.theme_mode_default);
          }}
        >
          Discard
        </Button>
        <Button disabled={!canSave} onClick={handleSave}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
