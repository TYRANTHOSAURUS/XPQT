import { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { usePublishAnnouncement, type Announcement } from '@/api/portal-announcements';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  locationId: string;
  locationName: string;
  editing?: Announcement | null;
}

export function AnnouncementDialog({ open, onOpenChange, locationId, locationName, editing }: Props) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [expires, setExpires] = useState('');
  const publish = usePublishAnnouncement();

  useEffect(() => {
    setTitle(editing?.title ?? '');
    setBody(editing?.body ?? '');
    setExpires(editing?.expires_at?.slice(0, 10) ?? '');
  }, [editing, open]);

  const submit = async () => {
    if (!title.trim() || !body.trim()) return;
    try {
      await publish.mutateAsync({
        location_id: locationId,
        title: title.trim(),
        body: body.trim(),
        expires_at: expires ? new Date(expires).toISOString() : null,
      });
      toast.success('Announcement published');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Publish failed');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit' : 'Publish'} announcement — {locationName}</DialogTitle>
          <DialogDescription>Shown on the portal home until it expires. One active per location.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="ann-title">Title</FieldLabel>
            <Input id="ann-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
          </Field>
          <Field>
            <FieldLabel htmlFor="ann-body">Body</FieldLabel>
            <Textarea id="ann-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000} rows={4} />
          </Field>
          <Field>
            <FieldLabel htmlFor="ann-expires">Expires (optional)</FieldLabel>
            <Input id="ann-expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
            <FieldDescription>Leave blank to keep it active until manually unpublished.</FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!title.trim() || !body.trim() || publish.isPending}>
            {publish.isPending ? 'Publishing…' : 'Publish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
