import { useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useUploadPortalHero } from '@/api/portal-appearance';
import { toastError, toastSuccess } from '@/lib/toast';

interface Props {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  locationId: string;
  locationName: string;
  currentUrl: string | null;
}

export function PortalHeroUploadDialog({ open, onOpenChange, locationId, locationName, currentUrl }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const upload = useUploadPortalHero();

  const preview = file ? URL.createObjectURL(file) : currentUrl;

  const handleSubmit = async () => {
    if (!file) return;
    try {
      await upload.mutateAsync({ location_id: locationId, file });
      toastSuccess('Hero uploaded');
      onOpenChange(false);
      setFile(null);
    } catch (err) {
      toastError("Couldn't upload hero", { error: err, retry: handleSubmit });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload hero — {locationName}</DialogTitle>
          <DialogDescription>
            Recommended 2400 × 800 px. JPG/PNG/WebP, max 2 MB. An overlay gradient is applied automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="aspect-[3/1] w-full overflow-hidden rounded-md border bg-muted">
          {preview ? (
            <img src={preview} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              No image
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <Button variant="outline" onClick={() => inputRef.current?.click()}>
            Choose file
          </Button>
          {file && <span className="text-sm text-muted-foreground truncate">{file.name}</span>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!file || upload.isPending} onClick={handleSubmit}>
            {upload.isPending ? 'Uploading…' : 'Upload'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
