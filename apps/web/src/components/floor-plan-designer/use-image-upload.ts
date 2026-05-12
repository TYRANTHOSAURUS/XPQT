import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { toastError } from '@/lib/toast';

const BUCKET = 'floor-plans';
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_EDGE = 4096;
const SIGNED_URL_TTL_SECONDS = 3600;

export interface ImageUploadResult {
  path: string;
  previewUrl: string | null;
  widthPx: number;
  heightPx: number;
}

export function useImageUpload(tenantId: string, floorSpaceId: string) {
  const [uploading, setUploading] = useState(false);

  async function upload(file: File): Promise<ImageUploadResult | null> {
    if (file.size > MAX_BYTES) {
      toastError('Image too large', { description: 'Max 10 MB.' });
      return null;
    }

    setUploading(true);
    try {
      // Validate dimensions
      const bitmap = await createImageBitmap(file);
      const widthPx = bitmap.width;
      const heightPx = bitmap.height;
      bitmap.close();

      if (Math.max(widthPx, heightPx) > MAX_EDGE) {
        toastError('Image too large', {
          description: `Long edge must be ≤ ${MAX_EDGE}px. Got ${Math.max(widthPx, heightPx)}px.`,
        });
        return null;
      }

      const ext = file.name.split('.').pop() ?? 'png';
      const sha = await fileSha256(file);
      const path = `${tenantId}/${floorSpaceId}/${sha}.${ext}`;

      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true });
      if (upErr) throw upErr;

      // Return a short-lived signed URL for the designer's immediate preview.
      // The backend stores the path (not the URL) and re-signs on every GET.
      const { data: signed } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

      return { path, previewUrl: signed?.signedUrl ?? null, widthPx, heightPx };
    } catch (err) {
      toastError("Couldn't upload image", { error: err });
      return null;
    } finally {
      setUploading(false);
    }
  }

  return { upload, uploading };
}

async function fileSha256(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
