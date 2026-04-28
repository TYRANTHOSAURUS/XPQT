import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { SettingsRow, SettingsRowValue } from '@/components/ui/settings-row';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toastSuccess, toastError } from '@/lib/toast';
import {
  useInitiateAccessRequest,
  useInitiateErasureRequest,
} from '@/api/gdpr';

interface Props {
  /** Person id whose data should be acted on. Null when subject is a user with no linked person. */
  personId: string | null;
  /** Display name used in confirm copy. */
  subjectName: string;
}

export function DsrActionsCard({ personId, subjectName }: Props) {
  const navigate = useNavigate();
  const [confirmExport, setConfirmExport] = useState(false);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [eraseReason, setEraseReason] = useState('');

  const accessReq = useInitiateAccessRequest();
  const erasureReq = useInitiateErasureRequest();

  if (!personId) {
    return (
      <SettingsRow
        label="Data subject requests"
        description="Data subject requests act on the underlying person record. Link a person to this user to enable export and erasure."
      >
        <SettingsRowValue>
          <span className="text-xs text-muted-foreground">Not available — no linked person</span>
        </SettingsRowValue>
      </SettingsRow>
    );
  }

  return (
    <>
      <SettingsRow
        label="Request data export"
        description={`Generates a downloadable archive of every record we hold for ${subjectName}. Fulfilled inline; available on the Privacy page.`}
      >
        <SettingsRowValue>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmExport(true)}
            disabled={accessReq.isPending}
          >
            <Download className="size-4" />
            {accessReq.isPending ? 'Requesting…' : 'Request export'}
          </Button>
        </SettingsRowValue>
      </SettingsRow>

      <SettingsRow
        label="Initiate erasure"
        description="Anonymizes personal data subject to legal hold and retention windows. Irreversible after the 7-day restore window."
      >
        <SettingsRowValue>
          <Button variant="destructive" size="sm" onClick={() => setEraseOpen(true)}>
            <Trash2 className="size-4" />
            Initiate erasure
          </Button>
        </SettingsRowValue>
      </SettingsRow>

      <ConfirmDialog
        open={confirmExport}
        onOpenChange={setConfirmExport}
        title={`Request data export for ${subjectName}?`}
        description="An archive of all data we hold will be generated. You can find it on the Privacy page once ready."
        confirmLabel="Request export"
        onConfirm={async () => {
          try {
            await accessReq.mutateAsync({ personId });
            toastSuccess('Data export requested', {
              description: 'Track progress on the Privacy page.',
              action: { label: 'Open privacy', onClick: () => navigate('/admin/privacy') },
            });
          } catch (err) {
            toastError("Couldn't start export", { error: err });
          }
        }}
      />

      <Dialog
        open={eraseOpen}
        onOpenChange={(o) => {
          setEraseOpen(o);
          if (!o) setEraseReason('');
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Initiate erasure for {subjectName}</DialogTitle>
            <DialogDescription>
              Anonymizes personal data. Records on legal hold are skipped; everything else is
              replaced with anonymized values. A 7-day restore window applies.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="erase-reason">Reason</FieldLabel>
              <Textarea
                id="erase-reason"
                value={eraseReason}
                onChange={(e) => setEraseReason(e.target.value)}
                placeholder="e.g. Right to erasure request submitted by the data subject on 2026-04-28."
                rows={3}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEraseOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!eraseReason.trim() || erasureReq.isPending}
              onClick={async () => {
                try {
                  await erasureReq.mutateAsync({ personId, reason: eraseReason.trim() });
                  toastSuccess('Erasure initiated', {
                    description: 'A 7-day restore window applies. Track on Privacy.',
                    action: { label: 'Open privacy', onClick: () => navigate('/admin/privacy') },
                  });
                  setEraseOpen(false);
                  setEraseReason('');
                } catch (err) {
                  toastError("Couldn't initiate erasure", { error: err });
                }
              }}
            >
              Initiate erasure
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
