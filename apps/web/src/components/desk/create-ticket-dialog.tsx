import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, Send } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toastCreated, toastError } from '@/lib/toast';
import { PersonPicker, type Person } from '@/components/person-picker';
import { AssetCombobox } from '@/components/asset-combobox';
import { LocationCombobox } from '@/components/location-combobox';
import { RequestTypePicker, type RequestType } from '@/components/request-type-picker';
import { apiFetch } from '@/lib/api';
import { DynamicFormFields } from '@/components/form-renderer/dynamic-form-fields';
import { splitFormData, validateRequired } from '@/lib/form-submission';
import type { FormField } from '@/components/admin/form-builder/premade-fields';

interface FormSchemaEntity {
  id: string;
  current_version?: { definition: { fields: FormField[] } } | null;
}

export function CreateTicketDialog({ onCreated }: { onCreated?: () => void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [requesterId, setRequesterId] = useState('');
  const [selectedRequester, setSelectedRequester] = useState<Person | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [selectedRT, setSelectedRT] = useState<RequestType | null>(null);
  const [sourceChannel, setSourceChannel] = useState('phone');
  const [assetId, setAssetId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [formFields, setFormFields] = useState<FormField[]>([]);
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [missingFieldLabel, setMissingFieldLabel] = useState<string | null>(null);

  const requestTypeId = selectedRT?.id ?? '';

  useEffect(() => {
    if (!selectedRT?.id) { setFormFields([]); setFormValues({}); return; }
    let cancelled = false;
    // Default form schema now lives on request_type_form_variants
    // (criteria_set_id IS NULL). The desk create path picks the default —
    // audience-conditional variants are a portal concern (we don't have a
    // real requester persona here at create time).
    (async () => {
      try {
        const variants = await apiFetch<Array<{
          criteria_set_id: string | null; form_schema_id: string; active: boolean;
        }>>(`/request-types/${selectedRT.id}/form-variants`);
        const def = variants.find((v) => v.criteria_set_id === null && v.active);
        if (!def) { if (!cancelled) { setFormFields([]); setFormValues({}); } return; }
        const entity = await apiFetch<FormSchemaEntity>(`/config-entities/${def.form_schema_id}`);
        if (cancelled) return;
        setFormFields(entity.current_version?.definition?.fields ?? []);
        setFormValues({});
      } catch {
        if (!cancelled) setFormFields([]);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedRT]);

  const requiredAssetMissing = !!selectedRT?.asset_required && !assetId;
  const requiredLocationMissing = !!selectedRT?.location_required && !locationId;
  const canSubmit =
    title.trim().length > 0 &&
    !!requesterId &&
    !requiredAssetMissing &&
    !requiredLocationMissing &&
    !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const missing = validateRequired(formFields, formValues);
    if (missing) {
      setMissingFieldLabel(missing.label);
      return;
    }
    setMissingFieldLabel(null);
    const { bound, form_data } = splitFormData(formFields, formValues);
    setSubmitting(true);
    try {
      const created = await apiFetch<{ id: string }>('/tickets', {
        method: 'POST',
        body: JSON.stringify({
          title,
          description,
          priority,
          ticket_type_id: requestTypeId || undefined,
          requester_person_id: requesterId,
          source_channel: sourceChannel,
          asset_id: assetId ?? undefined,
          location_id: locationId ?? undefined,
          ...bound,
          form_data: Object.keys(form_data).length > 0 ? form_data : undefined,
        }),
      });
      setTitle(''); setDescription(''); setPriority('medium');
      setSelectedRT(null); setSelectedRequester(null); setRequesterId('');
      setSourceChannel('phone'); setAssetId(null); setLocationId(null);
      setFormFields([]); setFormValues({});
      setOpen(false);
      onCreated?.();
      toastCreated('Ticket', { onView: () => navigate(`/desk/tickets/${created.id}`) });
    } catch (err) {
      toastError("Couldn't create ticket", { error: err, retry: handleSubmit });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" className="gap-2" />}>
        <Plus className="h-4 w-4" /> New Ticket
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Ticket</DialogTitle>
          <DialogDescription>Create a ticket on behalf of an employee</DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="new-ticket-requester">Requester</FieldLabel>
            <PersonPicker
              value={requesterId}
              onChange={setRequesterId}
              onSelect={setSelectedRequester}
              placeholder="Search by name or email..."
            />
            {selectedRequester && (
              <FieldDescription>
                {selectedRequester.email}
                {selectedRequester.department ? ` · ${selectedRequester.department}` : ''}
              </FieldDescription>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor="new-ticket-source">Source</FieldLabel>
            <Select value={sourceChannel} onValueChange={(v) => setSourceChannel(v ?? 'phone')}>
              <SelectTrigger id="new-ticket-source"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="phone">Phone call</SelectItem>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="walk_in">Walk-in</SelectItem>
                <SelectItem value="portal">Portal</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="new-ticket-type">Request Type</FieldLabel>
            <RequestTypePicker
              id="new-ticket-type"
              value={requestTypeId}
              onChange={(_, rt) => setSelectedRT(rt)}
            />
          </Field>

          {selectedRT?.requires_asset && (
            <Field>
              <FieldLabel htmlFor="new-ticket-asset">
                Asset
                {selectedRT.asset_required && <span className="text-destructive ml-1">*</span>}
              </FieldLabel>
              <AssetCombobox
                value={assetId}
                onChange={(id, asset) => {
                  setAssetId(id);
                  if (asset?.assigned_space_id) setLocationId(asset.assigned_space_id);
                }}
                assetTypeFilter={selectedRT.asset_type_filter}
              />
            </Field>
          )}

          {selectedRT?.requires_location && (
            <Field>
              <FieldLabel htmlFor="new-ticket-location">
                Location
                {selectedRT.location_required && <span className="text-destructive ml-1">*</span>}
              </FieldLabel>
              <LocationCombobox value={locationId} onChange={setLocationId} />
            </Field>
          )}

          <Field>
            <FieldLabel htmlFor="new-ticket-title">Title</FieldLabel>
            <Input
              id="new-ticket-title"
              placeholder="Brief summary..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="new-ticket-description">Description</FieldLabel>
            <Textarea
              id="new-ticket-description"
              placeholder="Details from the employee..."
              className="min-h-[100px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="new-ticket-priority">Priority</FieldLabel>
            <Select value={priority} onValueChange={(v) => setPriority(v ?? 'medium')}>
              <SelectTrigger id="new-ticket-priority"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <DynamicFormFields
            fields={formFields}
            values={formValues}
            onChange={(id, v) => setFormValues((prev) => ({ ...prev, [id]: v }))}
          />
        </FieldGroup>

        {missingFieldLabel && (
          <p className="text-sm text-destructive" role="alert">
            "{missingFieldLabel}" is required.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            <Send className="h-4 w-4 mr-2" />
            {submitting ? 'Creating...' : 'Create Ticket'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
