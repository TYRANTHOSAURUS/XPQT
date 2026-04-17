import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ArrowLeft, Send, CheckCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { useAuth } from '@/providers/auth-provider';
import { apiFetch } from '@/lib/api';
import { AssetCombobox } from '@/components/asset-combobox';
import { LocationCombobox } from '@/components/location-combobox';

interface RequestType {
  id: string;
  name: string;
  domain: string;
  form_schema_id: string | null;
  fulfillment_strategy?: 'asset' | 'location' | 'fixed' | 'auto';
  requires_asset?: boolean;
  asset_required?: boolean;
  asset_type_filter?: string[];
  requires_location?: boolean;
  location_required?: boolean;
}

interface FormField {
  id: string;
  label: string;
  type: string;
  required: boolean;
  placeholder?: string;
  help_text?: string;
  options?: string[];
}

interface FormSchemaEntity {
  id: string;
  current_version?: { definition: { fields: FormField[] } } | null;
}

const submitSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Title is too long'),
  description: z.string().max(5000, 'Description is too long').optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  requestTypeId: z.string().optional(),
});

type SubmitFormValues = z.infer<typeof submitSchema>;

export function SubmitRequestPage() {
  const navigate = useNavigate();
  const { categoryId } = useParams();
  const { person } = useAuth();
  const [submitted, setSubmitted] = useState(false);
  const [formFields, setFormFields] = useState<FormField[]>([]);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [assetId, setAssetId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);

  const {
    control,
    handleSubmit,
    watch,
    register,
    formState: { errors, isSubmitting },
  } = useForm<SubmitFormValues>({
    resolver: zodResolver(submitSchema),
    defaultValues: { title: '', description: '', priority: 'medium', requestTypeId: '' },
  });

  const requestTypeId = watch('requestTypeId');

  const { data: requestTypes } = useApi<RequestType[]>(
    `/request-types${categoryId ? `?domain=${categoryId}` : ''}`,
    [categoryId],
  );

  const selectedRT = requestTypes?.find((r) => r.id === requestTypeId);

  useEffect(() => {
    if (!requestTypeId || !requestTypes) { setFormFields([]); return; }
    const rt = requestTypes.find((r) => r.id === requestTypeId);
    if (!rt?.form_schema_id) { setFormFields([]); return; }
    apiFetch<FormSchemaEntity>(`/config-entities/${rt.form_schema_id}`)
      .then((entity) => {
        const fields = entity.current_version?.definition?.fields ?? [];
        setFormFields(fields);
        setFormData({});
      })
      .catch(() => setFormFields([]));
  }, [requestTypeId, requestTypes]);

  const onSubmit = async (values: SubmitFormValues) => {
    const missingRequired = formFields
      .filter((f) => f.required)
      .find((f) => !formData[f.id]?.toString().trim());
    if (missingRequired) {
      toast.error(`"${missingRequired.label}" is required`);
      return;
    }
    if (selectedRT?.asset_required && !assetId) {
      toast.error('Please select the affected asset');
      return;
    }
    if (selectedRT?.location_required && !locationId) {
      toast.error('Please select a location');
      return;
    }

    try {
      await apiFetch('/tickets', {
        method: 'POST',
        body: JSON.stringify({
          title: values.title,
          description: values.description,
          priority: values.priority,
          ticket_type_id: values.requestTypeId || undefined,
          requester_person_id: person?.id,
          source_channel: 'portal',
          asset_id: assetId ?? undefined,
          location_id: locationId ?? undefined,
          form_data: Object.keys(formData).length > 0 ? formData : undefined,
        }),
      });
      toast.success('Request submitted');
      setSubmitted(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit request');
    }
  };

  if (submitted) {
    return (
      <div className="max-w-lg mx-auto text-center py-16">
        <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4" />
        <h1 className="text-2xl font-bold">Request Submitted</h1>
        <p className="text-muted-foreground mt-2">
          Your request has been submitted and our team will get back to you shortly.
        </p>
        <div className="flex gap-3 justify-center mt-8">
          <Button variant="outline" onClick={() => navigate('/portal/my-requests')}>
            View My Requests
          </Button>
          <Button onClick={() => navigate('/portal')}>
            Submit Another
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <Button variant="ghost" className="mb-4 -ml-2" onClick={() => navigate(-1)}>
        <ArrowLeft className="h-4 w-4 mr-2" /> Back
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>Submit a Request</CardTitle>
          <CardDescription>Describe your issue or request and we'll route it to the right team</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
            {requestTypes && requestTypes.length > 0 && (
              <div className="grid gap-1.5">
                <Label htmlFor="request-type">Request Type</Label>
                <Controller
                  control={control}
                  name="requestTypeId"
                  render={({ field }) => (
                    <Select value={field.value ?? ''} onValueChange={(v) => field.onChange(v ?? '')}>
                      <SelectTrigger id="request-type">
                        <SelectValue placeholder="Select a request type..." />
                      </SelectTrigger>
                      <SelectContent>
                        {requestTypes.map((rt) => (
                          <SelectItem key={rt.id} value={rt.id}>{rt.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            )}

            {selectedRT?.requires_asset && (
              <div className="grid gap-1.5">
                <Label>
                  Asset
                  {selectedRT.asset_required && <span className="text-destructive ml-1">*</span>}
                </Label>
                <AssetCombobox
                  value={assetId}
                  onChange={(id, asset) => {
                    setAssetId(id);
                    if (asset?.assigned_space_id) setLocationId(asset.assigned_space_id);
                  }}
                  assetTypeFilter={selectedRT.asset_type_filter ?? []}
                />
              </div>
            )}

            {selectedRT?.requires_location && (
              <div className="grid gap-1.5">
                <Label>
                  Location
                  {selectedRT.location_required && <span className="text-destructive ml-1">*</span>}
                </Label>
                <LocationCombobox value={locationId} onChange={setLocationId} />
              </div>
            )}

            <div className="grid gap-1.5">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                placeholder="Brief summary of your request..."
                aria-invalid={!!errors.title}
                {...register('title')}
              />
              {errors.title && (
                <p className="text-xs text-destructive">{errors.title.message}</p>
              )}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                placeholder="Provide details about your request..."
                className="min-h-[120px]"
                aria-invalid={!!errors.description}
                {...register('description')}
              />
              {errors.description && (
                <p className="text-xs text-destructive">{errors.description.message}</p>
              )}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="priority">Priority</Label>
              <Controller
                control={control}
                name="priority"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={(v) => field.onChange((v ?? 'medium') as SubmitFormValues['priority'])}>
                    <SelectTrigger id="priority"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low — not urgent</SelectItem>
                      <SelectItem value="medium">Medium — normal priority</SelectItem>
                      <SelectItem value="high">High — needs attention soon</SelectItem>
                      <SelectItem value="critical">Critical — blocking my work</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            {formFields.map((field) => (
              <div key={field.id} className="grid gap-1.5">
                <Label htmlFor={`dyn-${field.id}`}>
                  {field.label}
                  {field.required && <span className="text-destructive ml-1">*</span>}
                </Label>
                {field.help_text && <p className="text-xs text-muted-foreground">{field.help_text}</p>}
                {(field.type === 'text' || field.type === 'number' || field.type === 'date' || field.type === 'datetime') && (
                  <Input
                    id={`dyn-${field.id}`}
                    type={field.type === 'datetime' ? 'datetime-local' : field.type}
                    placeholder={field.placeholder}
                    value={formData[field.id] ?? ''}
                    onChange={(e) => setFormData((prev) => ({ ...prev, [field.id]: e.target.value }))}
                  />
                )}
                {field.type === 'textarea' && (
                  <Textarea
                    id={`dyn-${field.id}`}
                    placeholder={field.placeholder}
                    value={formData[field.id] ?? ''}
                    onChange={(e) => setFormData((prev) => ({ ...prev, [field.id]: e.target.value }))}
                  />
                )}
                {(field.type === 'dropdown' || field.type === 'multi_select') && field.options && (
                  <Select
                    value={formData[field.id] ?? ''}
                    onValueChange={(v) => setFormData((prev) => ({ ...prev, [field.id]: v ?? '' }))}
                  >
                    <SelectTrigger id={`dyn-${field.id}`}><SelectValue placeholder={field.placeholder ?? 'Select...'} /></SelectTrigger>
                    <SelectContent>
                      {field.options.map((opt) => (
                        <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {field.type === 'checkbox' && (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`dyn-${field.id}`}
                      checked={formData[field.id] === 'true'}
                      onCheckedChange={(checked) =>
                        setFormData((prev) => ({ ...prev, [field.id]: String(checked === true) }))
                      }
                    />
                    <Label htmlFor={`dyn-${field.id}`} className="text-sm font-normal cursor-pointer">
                      {field.placeholder}
                    </Label>
                  </div>
                )}
              </div>
            ))}

            <div className="flex justify-end pt-2">
              <Button type="submit" disabled={isSubmitting}>
                <Send className="h-4 w-4 mr-2" />
                {isSubmitting ? 'Submitting...' : 'Submit Request'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
