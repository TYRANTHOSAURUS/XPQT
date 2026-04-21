import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Field,
  FieldError,
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
import { DynamicFormFields } from '@/components/form-renderer/dynamic-form-fields';
import { splitFormData, validateRequired } from '@/lib/form-submission';
import type { FormField } from '@/components/admin/form-builder/premade-fields';
import { AssetCombobox } from '@/components/asset-combobox';
import { LocationCombobox } from '@/components/location-combobox';
import { RequestTypePicker } from '@/components/request-type-picker';

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
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [assetId, setAssetId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);

  const [searchParams] = useSearchParams();
  const preselectedType = searchParams.get('type') ?? '';

  const {
    control,
    handleSubmit,
    watch,
    register,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<SubmitFormValues>({
    resolver: zodResolver(submitSchema),
    defaultValues: { title: '', description: '', priority: 'medium', requestTypeId: preselectedType },
  });

  const requestTypeId = watch('requestTypeId');

  const { data: requestTypes } = useApi<RequestType[]>(
    `/request-types${categoryId ? `?domain=${categoryId}` : ''}`,
    [categoryId],
  );

  // Reflect a newly-arrived ?type=<id> query param (e.g. navigating between
  // catalog cards without unmounting this page) into the form state.
  useEffect(() => {
    if (preselectedType && preselectedType !== requestTypeId) {
      setValue('requestTypeId', preselectedType);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselectedType]);

  const selectedRT = requestTypes?.find((r) => r.id === requestTypeId);

  useEffect(() => {
    if (!requestTypeId || !requestTypes) { setFormFields([]); return; }
    const rt = requestTypes.find((r) => r.id === requestTypeId);
    if (!rt?.form_schema_id) { setFormFields([]); return; }
    apiFetch<FormSchemaEntity>(`/config-entities/${rt.form_schema_id}`)
      .then((entity) => {
        const fields = entity.current_version?.definition?.fields ?? [];
        setFormFields(fields);
        setValues({});
      })
      .catch(() => setFormFields([]));
  }, [requestTypeId, requestTypes]);

  const onSubmit = async (formValues: SubmitFormValues) => {
    const missing = validateRequired(formFields, values);
    if (missing) {
      toast.error(`"${missing.label}" is required`);
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

    const { bound, form_data } = splitFormData(formFields, values);

    try {
      await apiFetch('/tickets', {
        method: 'POST',
        body: JSON.stringify({
          title: formValues.title,
          description: formValues.description,
          priority: formValues.priority,
          ticket_type_id: formValues.requestTypeId || undefined,
          requester_person_id: person?.id,
          source_channel: 'portal',
          asset_id: assetId ?? undefined,
          location_id: locationId ?? undefined,
          ...bound,
          form_data: Object.keys(form_data).length > 0 ? form_data : undefined,
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
          <form onSubmit={handleSubmit(onSubmit)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="request-type">Request Type</FieldLabel>
                <Controller
                  control={control}
                  name="requestTypeId"
                  render={({ field }) => (
                    <RequestTypePicker
                      id="request-type"
                      value={field.value ?? ''}
                      onChange={(rtId) => field.onChange(rtId)}
                      rootCategoryId={categoryId ?? null}
                    />
                  )}
                />
              </Field>

              {selectedRT?.requires_asset && (
                <Field>
                  <FieldLabel htmlFor="portal-asset">
                    Asset
                    {selectedRT.asset_required && <span className="text-destructive ml-1">*</span>}
                  </FieldLabel>
                  <AssetCombobox
                    value={assetId}
                    onChange={(id, asset) => {
                      setAssetId(id);
                      if (asset?.assigned_space_id) setLocationId(asset.assigned_space_id);
                    }}
                    assetTypeFilter={selectedRT.asset_type_filter ?? []}
                  />
                </Field>
              )}

              {selectedRT?.requires_location && (
                <Field>
                  <FieldLabel htmlFor="portal-location">
                    Location
                    {selectedRT.location_required && <span className="text-destructive ml-1">*</span>}
                  </FieldLabel>
                  <LocationCombobox value={locationId} onChange={setLocationId} />
                </Field>
              )}

              <Field>
                <FieldLabel htmlFor="title">Title</FieldLabel>
                <Input
                  id="title"
                  placeholder="Brief summary of your request..."
                  aria-invalid={!!errors.title}
                  {...register('title')}
                />
                {errors.title && <FieldError>{errors.title.message}</FieldError>}
              </Field>

              <Field>
                <FieldLabel htmlFor="description">Description</FieldLabel>
                <Textarea
                  id="description"
                  placeholder="Provide details about your request..."
                  className="min-h-[120px]"
                  aria-invalid={!!errors.description}
                  {...register('description')}
                />
                {errors.description && <FieldError>{errors.description.message}</FieldError>}
              </Field>

              <Field>
                <FieldLabel htmlFor="priority">Priority</FieldLabel>
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
              </Field>

              <DynamicFormFields
                fields={formFields}
                values={values}
                onChange={(id, v) => setValues((prev) => ({ ...prev, [id]: v }))}
              />

              <div className="flex justify-end pt-2">
                <Button type="submit" disabled={isSubmitting}>
                  <Send className="h-4 w-4 mr-2" />
                  {isSubmitting ? 'Submitting...' : 'Submit Request'}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
