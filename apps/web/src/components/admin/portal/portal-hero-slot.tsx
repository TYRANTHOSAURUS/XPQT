import { useState } from 'react';
import { SettingsRow } from '@/components/ui/settings-row';
import { Button } from '@/components/ui/button';
import { PortalHeroUploadDialog } from './portal-hero-upload-dialog';
import { useRemovePortalHero } from '@/api/portal-appearance';
import { toast } from 'sonner';

interface Props {
  locationId: string;
  locationName: string;
  currentUrl: string | null;
}

export function PortalHeroSlot({ locationId, locationName, currentUrl }: Props) {
  const [open, setOpen] = useState(false);
  const remove = useRemovePortalHero();

  const handleRemove = async () => {
    try {
      await remove.mutateAsync(locationId);
      toast.success('Hero removed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Remove failed');
    }
  };

  return (
    <>
      <SettingsRow
        label={`Hero — ${locationName}`}
        description={
          currentUrl
            ? 'Uploaded. Click to replace.'
            : 'Not uploaded — using default gradient with your logo.'
        }
      >
        <div className="flex items-center gap-3">
          {currentUrl ? (
            <img src={currentUrl} alt="" className="h-10 w-20 rounded border object-cover" />
          ) : (
            <div className="h-10 w-20 rounded border border-dashed bg-muted" aria-hidden />
          )}
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            {currentUrl ? 'Replace' : 'Upload'}
          </Button>
          {currentUrl && (
            <Button variant="ghost" size="sm" onClick={handleRemove} disabled={remove.isPending}>
              Remove
            </Button>
          )}
        </div>
      </SettingsRow>
      <PortalHeroUploadDialog
        open={open}
        onOpenChange={setOpen}
        locationId={locationId}
        locationName={locationName}
        currentUrl={currentUrl}
      />
    </>
  );
}
