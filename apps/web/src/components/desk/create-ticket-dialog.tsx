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
import { toast } from 'sonner';
import { PersonCombobox, type Person } from '@/components/person-combobox';
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

  const requestTypeId = selectedRT?.id ?? '';

  useEffect(() => {
    if (!selectedRT?.form_schema_id) { setFormFields([]); setFormValues({}); return; }
    let cancelled = false;
    apiFetch<FormSchemaEntity>(`/config-entities/${selectedRT.form_schema_id}`)
      .then((entity) => {
        if (cancelled) return;
        setFormFields(entity.current_version?.definition?.fields ?? []);
        setFormValues({});
      })
      .catch(() => { if (!cancelled) setFormFields([]); });
    return () => { cancelled = true; };
  }, [selectedRT]);

  const handleSubmit = async () => {
    if (!title.trim() || !requesterId) return;
    if (selectedRT?.asset_required && !assetId) return;
    if (selectedRT?.location_required && !locationId) return;
    const missing = validateRequired(formFields, formValues);
    if (missing) {
      toast.error(`"${missing.label}" is required`);
      return;
    }
    const { bound, form_data } = splitFormData(formFields, formValues);
    setSubmitting(true);
    try {
      const res = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Request failed: ${res.status}`);
      }
      setTitle(''); setDescription(''); setPriority('medium');
      setSelectedRT(null); setSelectedRequester(null); setRequesterId('');
      setSourceChannel('phone'); setAssetId(null); setLocationId(null);
      setFormFields([]); setFormValues({});
      setOpen(false);
      onCreated?.();
      toast.success('Ticket created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create ticket');
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
            <PersonCombobox
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

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!title.trim() || !requesterId || submitting}>
            <Send className="h-4 w-4 mr-2" />
            {submitting ? 'Creating...' : 'Create Ticket'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
