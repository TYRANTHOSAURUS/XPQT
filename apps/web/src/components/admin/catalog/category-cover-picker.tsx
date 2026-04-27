import { useRef, useState } from 'react';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api';
import { Plus } from 'lucide-react';
import { toastError, toastSuccess } from '@/lib/toast';
import { cn } from '@/lib/utils';

const PLATFORM_DEFAULTS: { token: string; className: string; label: string }[] = [
  { token: 'platform:cover-1', className: 'bg-gradient-to-br from-blue-500/70 to-indigo-700', label: 'Blue' },
  { token: 'platform:cover-2', className: 'bg-gradient-to-br from-purple-500/70 to-violet-700', label: 'Purple' },
  { token: 'platform:cover-3', className: 'bg-gradient-to-br from-emerald-500/70 to-teal-700', label: 'Green' },
  { token: 'platform:cover-4', className: 'bg-gradient-to-br from-orange-500/70 to-amber-700', label: 'Orange' },
];

export function CoverPreview({
  url,
  iconFallback,
  className,
}: {
  url: string | null;
  iconFallback: React.ReactNode;
  className?: string;
}) {
  if (!url) {
    return (
      <div className={cn('flex items-center justify-center bg-gradient-to-br from-primary/20 to-primary/5 text-primary', className)}>
        {iconFallback}
      </div>
    );
  }
  const platform = PLATFORM_DEFAULTS.find((p) => p.token === url);
  if (platform) {
    return <div className={cn(platform.className, className)} />;
  }
  return <img src={url} alt="" className={cn('object-cover', className)} />;
}

interface Props {
  categoryId: string | null;
  categoryName: string;
  coverSource: 'image' | 'icon';
  coverImageUrl: string | null;
  icon: string | null;
  onChange: (next: { cover_source: 'image' | 'icon'; cover_image_url: string | null }) => void;
}

export function CategoryCoverPicker({
  categoryId,
  categoryName,
  coverSource,
  coverImageUrl,
  icon,
  onChange,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleUpload = async (file: File) => {
    if (!categoryId) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiFetch<{ cover_image_url: string }>(
        `/service-catalog/categories/${categoryId}/cover`,
        { method: 'POST', body: form },
      );
      onChange({ cover_source: 'image', cover_image_url: res.cover_image_url });
      toastSuccess('Cover uploaded');
    } catch (err) {
      toastError("Couldn't upload cover", { error: err, retry: () => handleUpload(file) });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Field>
        <FieldLabel>Visual</FieldLabel>
        <RadioGroup
          value={coverSource}
          onValueChange={(v: 'image' | 'icon') =>
            onChange({ cover_source: v, cover_image_url: coverImageUrl })
          }
          className="flex gap-4"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem id="cs-image" value="image" />
            <Label htmlFor="cs-image" className="font-normal">Cover image</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="cs-icon" value="icon" />
            <Label htmlFor="cs-icon" className="font-normal">Icon only</Label>
          </div>
        </RadioGroup>
        <FieldDescription>How this category appears on the portal home.</FieldDescription>
      </Field>

      {coverSource === 'image' && (
        <Field>
          <FieldLabel>Cover</FieldLabel>
          <div className="grid grid-cols-5 gap-2">
            {PLATFORM_DEFAULTS.map((d) => (
              <button
                key={d.token}
                type="button"
                onClick={() => onChange({ cover_source: 'image', cover_image_url: d.token })}
                className={cn(
                  'aspect-[2/1] overflow-hidden rounded-md border-2',
                  coverImageUrl === d.token ? 'border-ring' : 'border-transparent',
                )}
                aria-label={d.label}
              >
                <div className={cn(d.className, 'h-full w-full')} />
              </button>
            ))}
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading || !categoryId}
              title={!categoryId ? 'Save the category first to upload a custom cover.' : undefined}
              className={cn(
                'aspect-[2/1] flex items-center justify-center rounded-md border-2 border-dashed',
                'text-muted-foreground hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed',
              )}
              aria-label="Upload custom cover"
            >
              <Plus className="size-5" />
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUpload(f);
              }}
            />
          </div>
          <FieldDescription>
            Pick a default or upload a custom image (recommended 1200 × 600 px).
          </FieldDescription>
        </Field>
      )}

      {/* Live preview */}
      <div className="rounded-md border bg-muted/30 p-3">
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2 font-semibold">
          Preview on the portal home
        </div>
        <div className="w-48 overflow-hidden rounded-md border bg-card">
          <CoverPreview
            url={coverSource === 'image' ? coverImageUrl : null}
            iconFallback={<span className="text-2xl">{iconEmoji(icon)}</span>}
            className="aspect-[2.1/1] w-full"
          />
          <div className="p-3">
            <div className="text-sm font-semibold">{categoryName || 'Category name'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function iconEmoji(icon: string | null): string {
  switch (icon) {
    case 'Monitor':      return '🖥️';
    case 'Wrench':       return '🔧';
    case 'MapPin':       return '📍';
    case 'Users':        return '👥';
    case 'Utensils':     return '🍽️';
    case 'ShieldCheck':  return '🛡️';
    case 'CalendarDays': return '📅';
    default:             return '❓';
  }
}
